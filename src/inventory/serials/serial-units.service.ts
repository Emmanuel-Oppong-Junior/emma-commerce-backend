import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SerialUnit, SerialUnitStatus } from '../../generated/prisma/client';
import { StockLedgerRepository } from '../stock-ledger.repository';
import { normaliseSerials } from './serial-format';
import {
  assignmentProblem,
  linesNotReadyToDispatch,
  serialCountProblem,
  trackSerialsChangeProblem,
  warrantyWindow,
} from './serial-rules';
import {
  SerialEventSource,
  SerialLookup,
  SerialTracking,
  SerialUnitsRepository,
  ShipmentLineFacts,
} from './serial-units.repository';

type Tx = Prisma.TransactionClient;

const S = SerialUnitStatus;

/** `extensions.reason` values of the errors serial checks fail with. */
export const SERIALS_REQUIRED = 'SERIALS_REQUIRED';
export const SERIAL_ALREADY_KNOWN = 'SERIAL_ALREADY_KNOWN';
export const SERIAL_NOT_AVAILABLE = 'SERIAL_NOT_AVAILABLE';
export const SERIALS_NOT_ASSIGNED = 'SERIALS_NOT_ASSIGNED';

/** A stock change of `quantity` units of a variant, naming the units by serial when its product tracks them. */
export interface SerialisedChange {
  variantId: string;
  quantity: number;
  serials?: readonly string[];
  source: SerialEventSource;
}

/**
 * Serial units (P4-D.1): one row per physical unit of a variant whose product tracks serials. Every stock path that
 * moves such a variant names its units here, on the caller's transaction and next to its stock movement, so per
 * location the units on the shelf keep matching the ledger. Untracked variants pass through untouched (and may not
 * name serials). Unit moves are conditional on the unit's status (and location), so two requests can never take the
 * same unit; every move writes a SerialUnitEvent.
 */
@Injectable()
export class SerialUnitsService {
  constructor(
    private readonly repository: SerialUnitsRepository,
    private readonly ledgerRepository: StockLedgerRepository,
  ) {}

  /**
   * New units received at a location (a delivery, a positive adjustment): exactly `quantity` serials, none known for
   * the variant yet. With `readmitWrittenOff` (FOUND or CORRECTION adjustments), a WRITTEN_OFF unit of the variant is
   * brought back instead of refused. Returns the stored serials (empty for an untracked variant).
   * @throws BadRequestException for a missing, miscounted or malformed serial, or serials on an untracked variant;
   * ConflictException (SERIAL_ALREADY_KNOWN) listing serials the variant already has.
   */
  async receive(
    tx: Tx,
    change: SerialisedChange,
    locationId: string,
    options: { readmitWrittenOff?: boolean } = {},
  ): Promise<string[]> {
    const serials = await this.serialsFor(tx, change);
    if (!serials) return [];
    const known = await this.repository.findBySerials(tx, change.variantId, serials);
    const refused = known.filter((unit) => !(options.readmitWrittenOff && unit.status === S.WRITTEN_OFF));
    if (refused.length > 0) {
      throw new ConflictException({
        message: `Serials already recorded for this variant: ${refused.map((unit) => unit.serial).join(', ')}`,
        extensions: { reason: SERIAL_ALREADY_KNOWN, serials: refused.map((unit) => unit.serial) },
      });
    }
    const knownSerials = new Set(known.map((unit) => unit.serial));
    const fresh = serials.filter((serial) => !knownSerials.has(serial));
    const created = await this.repository.createUnits(tx, change.variantId, locationId, fresh);
    const readmitted =
      known.length === 0
        ? []
        : await this.moveOrConflict(
            tx,
            known.map((unit) => unit.serial),
            change.variantId,
            { status: S.WRITTEN_OFF },
            { status: S.IN_STOCK, locationId },
          );
    await this.repository.insertEvents(tx, [
      ...created.map((unit) => this.event(unit, null, change.source)),
      ...readmitted.map((unit) => this.event(unit, S.WRITTEN_OFF, change.source)),
    ]);
    return serials;
  }

  /**
   * Units taken off a location's shelf for good (a negative adjustment): each must be IN_STOCK there (not assigned
   * to an order). They become WRITTEN_OFF.
   * @throws BadRequestException as receive; ConflictException (SERIAL_NOT_AVAILABLE) for a unit not in stock there.
   */
  async writeOff(tx: Tx, change: SerialisedChange, locationId: string): Promise<string[]> {
    const serials = await this.serialsFor(tx, change);
    if (!serials) return [];
    const moved = await this.moveOrConflict(
      tx,
      serials,
      change.variantId,
      { status: S.IN_STOCK, locationId },
      { status: S.WRITTEN_OFF, locationId: null },
    );
    await this.repository.insertEvents(
      tx,
      moved.map((unit) => this.event(unit, S.IN_STOCK, change.source)),
    );
    return serials;
  }

  /**
   * Units leaving `fromLocationId` on a stock transfer: each IN_STOCK there becomes IN_TRANSIT (the event references
   * the transfer, which is how receipt finds them).
   */
  async dispatchTransfer(tx: Tx, change: SerialisedChange, fromLocationId: string): Promise<string[]> {
    const serials = await this.serialsFor(tx, change);
    if (!serials) return [];
    const moved = await this.moveOrConflict(
      tx,
      serials,
      change.variantId,
      { status: S.IN_STOCK, locationId: fromLocationId },
      { status: S.IN_TRANSIT, locationId: null },
    );
    await this.repository.insertEvents(
      tx,
      moved.map((unit) => this.event(unit, S.IN_STOCK, change.source)),
    );
    return serials;
  }

  /**
   * A transfer line received at `toLocationId`: its units in transit arrive IN_STOCK there. A line received in full
   * may omit the serials; a short line names the `receivedQuantity` units that arrived, and the rest of its units in
   * transit are WRITTEN_OFF (missing; a FOUND adjustment brings one back).
   */
  async receiveTransfer(
    tx: Tx,
    line: { transferId: string; variantId: string; quantity: number; receivedQuantity: number; serials?: string[] },
    toLocationId: string,
    source: SerialEventSource,
  ): Promise<void> {
    const tracking = await this.trackingOrFail(tx, line.variantId);
    if (!tracking.trackSerials) {
      if (line.serials?.length) throw this.untracked(line.variantId);
      return;
    }
    const inTransit = await this.repository.findInTransit(tx, line.transferId, line.variantId);
    let arrived = inTransit.map((unit) => unit.serial);
    if (line.receivedQuantity === 0) {
      if (line.serials?.length) throw new BadRequestException('No unit arrived on this line: send no serials');
      arrived = [];
    } else if (line.serials !== undefined || line.receivedQuantity !== line.quantity) {
      arrived = this.normalise(tracking, line.receivedQuantity, line.serials);
      const travelling = new Set(inTransit.map((unit) => unit.serial));
      const strangers = arrived.filter((serial) => !travelling.has(serial));
      if (strangers.length > 0) {
        throw new BadRequestException(`Not in transit on this transfer: ${strangers.join(', ')}`);
      }
    }
    const arrivedSet = new Set(arrived);
    const missing = inTransit.filter((unit) => !arrivedSet.has(unit.serial)).map((unit) => unit.serial);
    const received = await this.moveOrConflict(
      tx,
      arrived,
      line.variantId,
      { status: S.IN_TRANSIT },
      { status: S.IN_STOCK, locationId: toLocationId },
    );
    const lost = await this.moveOrConflict(
      tx,
      missing,
      line.variantId,
      { status: S.IN_TRANSIT },
      { status: S.WRITTEN_OFF },
    );
    await this.repository.insertEvents(tx, [
      ...received.map((unit) => this.event(unit, S.IN_TRANSIT, source)),
      ...lost.map((unit) =>
        this.event(unit, S.IN_TRANSIT, { ...source, movementId: undefined, note: 'Missing on arrival' }),
      ),
    ]);
  }

  /**
   * Returned goods restocked at `locationId` under a return request: each serial must be a unit SOLD on
   * that order; it is back IN_STOCK (its sale and warranty cleared; the history keeps them).
   */
  async restockReturned(
    tx: Tx,
    change: SerialisedChange,
    returnRequestId: string,
    locationId: string,
  ): Promise<string[]> {
    const serials = await this.serialsFor(tx, change);
    if (!serials) return [];
    const orderId = await this.repository.findReturnRequestOrderId(tx, returnRequestId);
    if (!orderId) throw new NotFoundException(`Return request "${returnRequestId}" not found`);
    const moved = await this.moveOrConflict(
      tx,
      serials,
      change.variantId,
      { status: S.SOLD, orderItem: { orderId } },
      { ...this.backOnShelf(locationId) },
      'not sold on this order',
    );
    await this.repository.insertEvents(
      tx,
      moved.map((unit) => this.event(unit, S.SOLD, change.source)),
    );
    return serials;
  }

  /**
   * Assigns units to a serialised shipment line at pick (P5-B.1: per shipment, so an order line split across
   * shipments has each part's units named), at the order's location: each must be IN_STOCK there, and the shipment
   * line may not end up with more units than its quantity. The unit is tied to the order line and the shipment line.
   * Call with the order row locked.
   * @throws BadRequestException for a line whose product does not track serials, too many units or a bad serial;
   * ConflictException (SERIAL_NOT_AVAILABLE) for a unit not in stock there (e.g. another order took it first).
   */
  async assign(
    tx: Tx,
    shipmentItemId: string,
    rawSerials: readonly string[],
    source: SerialEventSource,
  ): Promise<string[]> {
    const line = await this.shipmentLineOrFail(tx, shipmentItemId);
    const tracking = await this.trackingOrFail(tx, line.variantId);
    if (!tracking.trackSerials) throw this.untracked(line.variantId);
    const serials = this.normalise(tracking, rawSerials.length, rawSerials);
    const problem = assignmentProblem(
      {
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        assigned: await this.repository.countAssigned(tx, shipmentItemId),
      },
      serials.length,
    );
    if (problem) throw new BadRequestException(problem);
    const locationId = await this.orderLocation(tx, line.orderId);
    const moved = await this.moveOrConflict(
      tx,
      serials,
      line.variantId,
      { status: S.IN_STOCK, locationId },
      { status: S.ASSIGNED, orderItemId: line.orderItemId, shipmentItemId },
    );
    await this.repository.insertEvents(
      tx,
      moved.map((unit) => this.event(unit, S.IN_STOCK, source)),
    );
    return serials;
  }

  /** Puts units assigned to the shipment line back IN_STOCK (still before dispatch). Call with the order row locked. */
  async unassign(
    tx: Tx,
    shipmentItemId: string,
    rawSerials: readonly string[],
    source: SerialEventSource,
  ): Promise<string[]> {
    const line = await this.shipmentLineOrFail(tx, shipmentItemId);
    const tracking = await this.trackingOrFail(tx, line.variantId);
    if (!tracking.trackSerials) throw this.untracked(line.variantId);
    const serials = this.normalise(tracking, rawSerials.length, rawSerials);
    const moved = await this.moveOrConflict(
      tx,
      serials,
      line.variantId,
      { status: S.ASSIGNED, shipmentItemId },
      { status: S.IN_STOCK, orderItemId: null, shipmentItemId: null },
      'not assigned to this shipment line',
    );
    await this.repository.insertEvents(
      tx,
      moved.map((unit) => this.event(unit, S.ASSIGNED, source)),
    );
    return serials;
  }

  /**
   * The shipment is being dispatched: refuses (BAD_REQUEST, SERIALS_NOT_ASSIGNED) unless every serialised line of the
   * shipment has exactly its quantity of units assigned, then marks them SOLD.
   */
  async dispatchShipment(tx: Tx, shipmentId: string, source: SerialEventSource): Promise<void> {
    const lines = await this.repository.findSerialisedShipmentLines(tx, shipmentId);
    const notReady = linesNotReadyToDispatch(lines);
    if (notReady.length > 0) {
      throw new BadRequestException({
        message:
          'Assign a serial to every unit before dispatch: ' +
          notReady
            .map((line) => `shipment line "${line.shipmentItemId}" has ${line.assigned} of ${line.quantity}`)
            .join('; '),
        extensions: {
          reason: SERIALS_NOT_ASSIGNED,
          lines: notReady.map(({ shipmentItemId, orderItemId, quantity, assigned }) => ({
            shipmentItemId,
            orderItemId,
            quantity,
            assigned,
          })),
        },
      });
    }
    if (lines.length === 0) return;
    const sold = await this.repository.moveUnits(
      tx,
      { status: S.ASSIGNED, shipmentItemId: { in: lines.map((line) => line.shipmentItemId) } },
      { status: S.SOLD, locationId: null, soldAt: new Date() },
    );
    await this.repository.insertEvents(
      tx,
      sold.map((unit) => this.event(unit, S.ASSIGNED, source)),
    );
  }

  /** The shipment was cancelled before dispatch: the units picked for it are IN_STOCK again at the order's location. */
  async releaseShipment(tx: Tx, shipmentId: string, source: SerialEventSource): Promise<void> {
    const units = await this.repository.findShipmentUnits(tx, shipmentId, S.ASSIGNED);
    if (units.length === 0) return;
    const orderId = await this.repository.findShipmentOrderId(tx, shipmentId);
    const moved = await this.repository.moveUnits(
      tx,
      { id: { in: units.map((unit) => unit.id) }, status: S.ASSIGNED },
      this.backOnShelf(await this.orderLocation(tx, orderId)),
    );
    await this.repository.insertEvents(
      tx,
      moved.map((unit) => this.event(unit, S.ASSIGNED, source)),
    );
  }

  /**
   * The order was cancelled or expired: units assigned to it, and units sold on it that came back with a returned
   * shipment, are IN_STOCK again at the order's location (its reservations are released to the same place).
   */
  async releaseOrder(tx: Tx, orderId: string, source: SerialEventSource): Promise<void> {
    const freed: { unit: SerialUnit; from: SerialUnitStatus }[] = [];
    for (const from of [S.ASSIGNED, S.SOLD]) {
      const units = await this.repository.findOrderUnits(tx, orderId, from);
      if (units.length === 0) continue;
      const locationId = await this.orderLocation(tx, orderId);
      const moved = await this.repository.moveUnits(
        tx,
        { id: { in: units.map((unit) => unit.id) }, status: from },
        this.backOnShelf(locationId),
      );
      freed.push(...moved.map((unit) => ({ unit, from })));
    }
    await this.repository.insertEvents(
      tx,
      freed.map(({ unit, from }) => this.event(unit, from, source)),
    );
  }

  /** The shipment was delivered (or collected) at `deliveredAt`: its sold units' warranty starts. */
  async startWarranty(tx: Tx, shipmentId: string, deliveredAt: Date): Promise<void> {
    for (const unit of await this.repository.findSoldUnitsForWarranty(tx, shipmentId)) {
      const window = warrantyWindow(deliveredAt, unit.warrantyMonths);
      if (window) await this.repository.setWarranty(tx, unit.id, window.startsAt, window.endsAt);
    }
  }

  /**
   * Refuses (BAD_REQUEST) a change of the product's trackSerials flag that would leave units unaccounted for (see
   * trackSerialsChangeProblem).
   */
  async assertTrackingChange(tx: Tx, productId: string, turnOn: boolean): Promise<void> {
    const problem = trackSerialsChangeProblem(turnOn, await this.repository.trackingFacts(tx, productId));
    if (problem) throw new BadRequestException(problem);
  }

  /** The variants among `variantIds` whose product tracks serials. */
  async trackedVariantIds(tx: Tx, variantIds: readonly string[]): Promise<string[]> {
    return variantIds.length === 0 ? [] : this.repository.trackedVariantIds(tx, variantIds);
  }

  /**
   * Units whose serial matches what staff typed, on any variant, with variant and order. The input is compared as
   * stored: upper case without spaces, with and without dashes (an IMEI is stored without them).
   */
  async lookup(serial: string): Promise<SerialLookup[]> {
    const compact = serial.replace(/\s+/g, '').toUpperCase();
    if (compact.length === 0) throw new BadRequestException('Give a serial to look up');
    return this.repository.lookup([...new Set([compact, compact.replace(/-/g, '')])]);
  }

  /**
   * A page of a variant's units by serial, optionally at one location, in the given statuses.
   * @throws NotFoundException for an unknown variant.
   */
  async listUnits(
    filter: { variantId: string; locationId?: string; statuses: readonly SerialUnitStatus[] },
    first: number,
    after?: string,
  ): Promise<{ nodes: SerialUnit[]; totalCount: number; hasNextPage: boolean }> {
    if (!(await this.repository.variantExists(filter.variantId))) {
      throw new NotFoundException(`Variant "${filter.variantId}" not found`);
    }
    const [rows, totalCount] = await this.repository.listUnits(filter, { take: first + 1, after });
    return { nodes: rows.slice(0, first), totalCount, hasNextPage: rows.length > first };
  }

  /** Units assigned to or sold on each order line, grouped by line in the order given. */
  async unitsOnOrderItems(orderItemIds: readonly string[]): Promise<SerialUnit[][]> {
    const units = await this.repository.findByOrderItems(orderItemIds);
    return orderItemIds.map((id) => units.filter((unit) => unit.orderItemId === id));
  }

  /** The variant's serial units for a stock change, normalised and counted, or null when it does not track them. */
  private async serialsFor(tx: Tx, change: SerialisedChange): Promise<string[] | null> {
    const tracking = await this.trackingOrFail(tx, change.variantId);
    if (!tracking.trackSerials) {
      if (change.serials?.length) throw this.untracked(change.variantId);
      return null;
    }
    return this.normalise(tracking, change.quantity, change.serials);
  }

  private normalise(tracking: SerialTracking, quantity: number, serials: readonly string[] | undefined): string[] {
    const countProblem = serialCountProblem(quantity, serials);
    if (countProblem) {
      throw new BadRequestException({ message: countProblem, extensions: { reason: SERIALS_REQUIRED } });
    }
    const normalised = normaliseSerials(serials!, tracking.serialFormat);
    if (!normalised.ok) throw new BadRequestException(normalised.problems.join('; '));
    return normalised.serials;
  }

  /**
   * Moves exactly the units with these serials that match `where`; when any does not (unknown, another status or
   * location, taken by a concurrent request), nothing is kept (the caller's transaction fails) and the CONFLICT lists
   * them.
   */
  private async moveOrConflict(
    tx: Tx,
    serials: readonly string[],
    variantId: string,
    where: Prisma.SerialUnitWhereInput,
    data: Prisma.SerialUnitUncheckedUpdateManyInput,
    why = 'not available',
  ): Promise<SerialUnit[]> {
    if (serials.length === 0) return [];
    const moved = await this.repository.moveUnits(tx, { ...where, variantId, serial: { in: [...serials] } }, data);
    if (moved.length !== serials.length) {
      const movedSerials = new Set(moved.map((unit) => unit.serial));
      const refused = serials.filter((serial) => !movedSerials.has(serial));
      throw new ConflictException({
        message: `Serials ${why}: ${refused.join(', ')}`,
        extensions: { reason: SERIAL_NOT_AVAILABLE, serials: refused },
      });
    }
    return moved;
  }

  private backOnShelf(locationId: string): Prisma.SerialUnitUncheckedUpdateManyInput {
    return {
      status: S.IN_STOCK,
      locationId,
      orderItemId: null,
      shipmentItemId: null,
      soldAt: null,
      warrantyStartsAt: null,
      warrantyEndsAt: null,
    };
  }

  private event(unit: SerialUnit, from: SerialUnitStatus | null, source: SerialEventSource) {
    return {
      serialUnitId: unit.id,
      from,
      to: unit.status,
      locationId: unit.locationId,
      orderItemId: unit.orderItemId,
      ...source,
    };
  }

  private async trackingOrFail(tx: Tx, variantId: string): Promise<SerialTracking> {
    const tracking = await this.repository.findTracking(tx, variantId);
    if (!tracking) throw new NotFoundException(`Variant "${variantId}" not found`);
    return tracking;
  }

  private async shipmentLineOrFail(tx: Tx, shipmentItemId: string): Promise<ShipmentLineFacts> {
    const line = await this.repository.findShipmentLine(tx, shipmentItemId);
    if (!line) throw new NotFoundException(`Shipment line "${shipmentItemId}" not found`);
    return line;
  }

  private async orderLocation(tx: Tx, orderId: string): Promise<string> {
    return (await this.repository.findOrderLocation(tx, orderId)) ?? this.ledgerRepository.defaultLocationId(tx);
  }

  private untracked(variantId: string): BadRequestException {
    return new BadRequestException(`Variant "${variantId}" does not track serial numbers: send no serials`);
  }
}
