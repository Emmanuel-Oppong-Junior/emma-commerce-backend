import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { Prisma, PurchaseOrderStatus, StockMovement, StockMovementReason } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../commons/audit.service';
import { StockLedgerService } from '../../inventory/stock-ledger.service';
import { LotsService } from '../../inventory/lots/lots.service';
import { LotSpec } from '../../inventory/lots/lots';
import { SerialUnitsService } from '../../inventory/serials/serial-units.service';
import { VariantCostService } from '../cost/variant-cost.service';
import { canPurchaseOrderTransition, statusAfterReceipt } from './purchase-order-status';
import { PurchaseOrderLineDraft, purchaseOrderLinesProblem, receiptPlan } from './purchase-order-rules';
import { PurchaseOrderFilter, PurchaseOrdersRepository, PurchaseOrderView } from './purchase-orders.repository';

type Tx = Prisma.TransactionClient;

const S = PurchaseOrderStatus;
const MAX_PAGE_SIZE = 100;
const FINAL: readonly PurchaseOrderStatus[] = [S.RECEIVED, S.CLOSED, S.CANCELLED];

export interface NewPurchaseOrder {
  supplierId: string;
  locationId: string;
  expectedAt?: Date | null;
  note?: string | null;
  lines: PurchaseOrderLineDraft[];
}

export type PurchaseOrderChanges = Partial<NewPurchaseOrder>;

export interface ArrivingGoods {
  variantId: string;
  quantity: number;
  /** Lot-tracked variants: the lot the units go into (number and expiry) */
  lot?: LotSpec;
  /** Serial-tracked variants: one new serial per unit */
  serials?: string[];
}

export interface PurchaseOrderPage {
  nodes: PurchaseOrderView[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * Purchase orders (P4-E.1). A DRAFT's supplier, location and lines can change; sending freezes them (sentAt only: no
 * email to the supplier yet). Deliveries are received against a sent order, any number of times, each never above
 * what is outstanding: one PurchaseOrderReceipt per delivery, the units added at the order's location through the
 * stock ledger as RECEIPT movements (refType PurchaseOrder, with their unit cost), lot-tracked units into the lot
 * named and serial-tracked units under new serials, and the variant's weighted-average cost updated first. The order
 * row is locked for every change and each status move is conditional, so of two concurrent requests one gets
 * CONFLICT. Every change is audited.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly repository: PurchaseOrdersRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: StockLedgerService,
    private readonly lots: LotsService,
    private readonly serialUnits: SerialUnitsService,
    private readonly costs: VariantCostService,
  ) {}

  async findOne(id: string): Promise<PurchaseOrderView> {
    const order = await this.repository.findById(id);
    if (!order) throw new NotFoundException(`Purchase order "${id}" not found`);
    return order;
  }

  /** Purchase orders newest first, a page of at most 100 after the `after` cursor (a purchase order id). */
  async findMany(filter: PurchaseOrderFilter, first: number, after?: string): Promise<PurchaseOrderPage> {
    if (filter.createdFrom && filter.createdTo && filter.createdFrom >= filter.createdTo) {
      throw new BadRequestException('createdFrom must be before createdTo');
    }
    const take = Math.min(first, MAX_PAGE_SIZE);
    const [rows, totalCount] = await this.repository.findMany(filter, { take: take + 1, after });
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  /**
   * Creates a DRAFT for an active supplier and an active location, in the store currency.
   * @throws BadRequestException for invalid lines or an inactive supplier or location; NotFoundException for an
   *   unknown supplier, location or variant.
   */
  async create(input: NewPurchaseOrder, actorId: string): Promise<PurchaseOrderView> {
    this.assertLines(input.lines);
    return this.prisma.$transaction(async (tx) => {
      await this.assertSupplier(tx, input.supplierId);
      await this.assertLocation(tx, input.locationId);
      await this.assertVariants(tx, input.lines);
      const order = await this.repository.create(tx, {
        supplierId: input.supplierId,
        locationId: input.locationId,
        currency: await this.repository.storeCurrency(tx),
        expectedAt: input.expectedAt ?? null,
        note: input.note?.trim() || null,
        createdById: actorId,
        lines: input.lines,
      });
      await this.audit.log(
        {
          entity: 'PurchaseOrder',
          entityId: order.id,
          action: 'CREATE',
          userId: actorId,
          details: {
            reference: order.reference,
            supplierId: order.supplierId,
            locationId: order.locationId,
            lines: this.auditLines(input.lines),
          },
        },
        tx,
      );
      return order;
    });
  }

  /**
   * Edits an order. The expected date and note can change until the order is final; the supplier, location and lines
   * only while it is a DRAFT (lines given replace them all).
   * @throws ConflictException when the order is past the stage the change needs; as create for invalid values.
   */
  async update(id: string, changes: PurchaseOrderChanges, actorId: string): Promise<PurchaseOrderView> {
    if (changes.lines) this.assertLines(changes.lines);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockAndRead(tx, id);
      const draftOnly = changes.supplierId !== undefined || changes.locationId !== undefined || !!changes.lines;
      if (draftOnly && before.status !== S.DRAFT) {
        throw new ConflictException(
          `Purchase order ${before.reference} is ${before.status}: its supplier, location and lines are frozen once sent`,
        );
      }
      if (FINAL.includes(before.status)) {
        throw new ConflictException(`Purchase order ${before.reference} is ${before.status} and can no longer change`);
      }
      const data: Prisma.PurchaseOrderUncheckedUpdateInput = {};
      if (changes.supplierId !== undefined && changes.supplierId !== before.supplierId) {
        await this.assertSupplier(tx, changes.supplierId);
        data.supplierId = changes.supplierId;
      }
      if (changes.locationId !== undefined && changes.locationId !== before.locationId) {
        await this.assertLocation(tx, changes.locationId);
        data.locationId = changes.locationId;
      }
      if (changes.expectedAt !== undefined) data.expectedAt = changes.expectedAt;
      if (changes.note !== undefined) data.note = changes.note?.trim() || null;
      await this.repository.update(tx, id, data);
      if (changes.lines) {
        await this.assertVariants(tx, changes.lines);
        await this.repository.replaceLines(tx, id, changes.lines);
      }
      const after = await this.repository.findByIdOrThrow(tx, id);
      await this.audit.log(
        {
          entity: 'PurchaseOrder',
          entityId: id,
          action: 'UPDATE',
          userId: actorId,
          details: {
            ...(data.supplierId !== undefined && { supplierId: { from: before.supplierId, to: after.supplierId } }),
            ...(data.locationId !== undefined && { locationId: { from: before.locationId, to: after.locationId } }),
            ...(changes.expectedAt !== undefined && {
              expectedAt: {
                from: before.expectedAt?.toISOString() ?? null,
                to: after.expectedAt?.toISOString() ?? null,
              },
            }),
            ...(changes.note !== undefined && { note: { from: before.note, to: after.note } }),
            ...(changes.lines && {
              lines: {
                from: this.auditLines(
                  before.lines.map((l) => ({
                    variantId: l.variantId,
                    quantity: l.quantityOrdered,
                    unitCost: l.unitCost,
                  })),
                ),
                to: this.auditLines(changes.lines),
              },
            }),
          },
        },
        tx,
      );
      return after;
    });
  }

  /**
   * DRAFT -> SENT: records when it went to the supplier (nothing is emailed yet) and freezes the lines.
   * @throws ConflictException when not a draft; BadRequestException when the supplier or location became inactive.
   */
  async send(id: string, actorId: string): Promise<PurchaseOrderView> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockAndRead(tx, id);
      await this.assertSupplier(tx, order.supplierId);
      await this.assertLocation(tx, order.locationId);
      return this.move(tx, order, S.SENT, { sentById: actorId, sentAt: new Date() }, actorId);
    });
  }

  /** DRAFT or SENT -> CANCELLED, only while nothing has been received. */
  async cancel(id: string, actorId: string, reason?: string): Promise<PurchaseOrderView> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockAndRead(tx, id);
      const cancelReason = reason?.trim() || null;
      return this.move(
        tx,
        order,
        S.CANCELLED,
        { cancelledById: actorId, cancelledAt: new Date(), cancelReason },
        actorId,
        { ...(cancelReason && { reason: cancelReason }) },
      );
    });
  }

  /** PARTIALLY_RECEIVED -> CLOSED: the rest will not come; outstanding units are dropped, with the reason. */
  async close(id: string, reason: string, actorId: string): Promise<PurchaseOrderView> {
    const closeReason = reason.trim();
    if (!closeReason) throw new BadRequestException('Say why the rest of the order will not arrive');
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockAndRead(tx, id);
      return this.move(tx, order, S.CLOSED, { closedById: actorId, closedAt: new Date(), closeReason }, actorId, {
        reason: closeReason,
        shortfall: order.lines
          .filter((line) => line.quantityOutstanding > 0)
          .map((line) => ({ variantId: line.variantId, outstanding: line.quantityOutstanding })),
      });
    });
  }

  /**
   * Receives a delivery: per line the units arriving now (at most what is outstanding), into the order's location.
   * The order becomes RECEIVED once every line is complete, else PARTIALLY_RECEIVED.
   * @throws ConflictException when the order is not SENT or PARTIALLY_RECEIVED (possibly closed or cancelled by a
   *   concurrent request); BadRequestException for over-receipt, a line not on the order, a missing or unexpected lot
   *   or serials, or an inactive location.
   */
  async receive(id: string, arriving: ArrivingGoods[], actorId: string, note?: string): Promise<PurchaseOrderView> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockAndRead(tx, id);
      const plan = receiptPlan(order.status, order.lines, arriving);
      if (plan.refusal !== null) {
        throw plan.refusal === 'STATUS'
          ? new ConflictException(`Purchase order ${order.reference}: ${plan.problem}`)
          : new BadRequestException(plan.problem);
      }
      await this.assertLocation(tx, order.locationId);
      await this.costs.lockVariants(
        tx,
        plan.lines.map((planned) => planned.line.variantId),
      );
      const receipt = await this.repository.createReceipt(tx, {
        purchaseOrderId: id,
        receivedById: actorId,
        note: note?.trim() || undefined,
      });
      const goods = new Map(arriving.map((item) => [item.variantId, item]));
      const now = new Date();
      const audited: Prisma.InputJsonObject[] = [];
      const ordered = [...plan.lines].sort((a, b) => (a.line.variantId < b.line.variantId ? -1 : 1));
      for (const { line, quantity } of ordered) {
        const item = goods.get(line.variantId)!;
        const tracked = await this.lots.isTracked(tx, line.variantId);
        if (tracked && !item.lot) {
          throw new BadRequestException(
            `Variant "${line.variantId}" tracks lots: give the lot number and expiry of the units received`,
          );
        }
        if (!tracked && item.lot) {
          throw new BadRequestException(`Variant "${line.variantId}" does not track lots; leave the lot out`);
        }
        await this.costs.applyReceipt(tx, {
          variantId: line.variantId,
          quantity,
          unitCost: line.unitCost,
          receiptId: receipt.id,
          actorId,
        });
        const source = {
          refType: 'PurchaseOrder',
          refId: id,
          actorId,
          note: `Received on ${order.reference}`,
          unitCost: line.unitCost,
        };
        let movement: StockMovement;
        let lotId: string | null = null;
        if (item.lot) {
          const received = await this.lots.receiveIntoLot(
            tx,
            { variantId: line.variantId, quantity, lot: item.lot, locationId: order.locationId, source },
            now,
          );
          movement = received.movement;
          lotId = received.lot.id;
        } else {
          movement = await this.ledger.receive(
            tx,
            line.variantId,
            quantity,
            StockMovementReason.RECEIPT,
            source,
            order.locationId,
          );
        }
        const serials = await this.serialUnits.receive(
          tx,
          {
            variantId: line.variantId,
            quantity,
            serials: item.serials,
            source: { movementId: movement.id, actorId, refType: 'PurchaseOrder', refId: id },
          },
          order.locationId,
        );
        if (!(await this.repository.addReceived(tx, line.id, quantity))) {
          throw new ConflictException(`Line of variant "${line.variantId}" changed while it was being received`);
        }
        await this.repository.createReceiptLine(tx, {
          receiptId: receipt.id,
          lineId: line.id,
          quantity,
          unitCost: line.unitCost,
          lotId,
          movementId: movement.id,
        });
        audited.push({
          variantId: line.variantId,
          quantity,
          unitCost: line.unitCost.toFixed(4),
          ...(item.lot && { lotNumber: item.lot.lotNumber.trim() }),
          ...(serials.length > 0 && { serialCount: serials.length }),
        });
      }
      const after = await this.repository.findByIdOrThrow(tx, id);
      return this.move(tx, order, statusAfterReceipt(after.lines), {}, actorId, {
        receiptId: receipt.id,
        lines: audited,
      });
    });
  }

  private async lockAndRead(tx: Tx, id: string): Promise<PurchaseOrderView> {
    if (!(await this.repository.lock(tx, id))) throw new NotFoundException(`Purchase order "${id}" not found`);
    return this.repository.findByIdOrThrow(tx, id);
  }

  /** Moves the (locked) order from its current status to `to`, conditionally, and audits the change. */
  private async move(
    tx: Tx,
    order: PurchaseOrderView,
    to: PurchaseOrderStatus,
    stamp: Prisma.PurchaseOrderUncheckedUpdateManyInput,
    actorId: string,
    extra: Prisma.InputJsonObject = {},
  ): Promise<PurchaseOrderView> {
    if (!canPurchaseOrderTransition(order.status, to)) {
      throw new ConflictException(`Purchase order ${order.reference} is ${order.status}; it cannot become ${to}`);
    }
    if (!(await this.repository.transition(tx, order.id, order.status, to, stamp))) {
      throw new ConflictException(`Purchase order ${order.reference} changed status concurrently; reload it`);
    }
    await this.audit.log(
      {
        entity: 'PurchaseOrder',
        entityId: order.id,
        action: 'STATUS_CHANGE',
        userId: actorId,
        details: { from: order.status, to, ...extra },
      },
      tx,
    );
    return this.repository.findByIdOrThrow(tx, order.id);
  }

  private assertLines(lines: PurchaseOrderLineDraft[]): void {
    const problem = purchaseOrderLinesProblem(lines);
    if (problem) throw new BadRequestException(problem);
  }

  private async assertSupplier(tx: Tx, supplierId: string): Promise<void> {
    const supplier = await this.repository.findSupplier(tx, supplierId);
    if (!supplier) throw new NotFoundException(`Supplier "${supplierId}" not found`);
    if (!supplier.isActive) throw new BadRequestException(`Supplier "${supplier.name}" is inactive`);
  }

  private async assertLocation(tx: Tx, locationId: string): Promise<void> {
    const location = await this.repository.findLocation(tx, locationId);
    if (!location) throw new NotFoundException(`Stock location "${locationId}" not found`);
    if (!location.isActive) throw new BadRequestException(`Stock location "${location.name}" is inactive`);
  }

  private async assertVariants(tx: Tx, lines: PurchaseOrderLineDraft[]): Promise<void> {
    const ids = lines.map((line) => line.variantId);
    const known = new Set(await this.repository.existingVariantIds(tx, ids));
    const unknown = ids.find((variantId) => !known.has(variantId));
    if (unknown) throw new NotFoundException(`Variant "${unknown}" not found`);
  }

  private auditLines(lines: { variantId: string; quantity: number; unitCost: Decimal }[]): Prisma.InputJsonArray {
    return lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      unitCost: line.unitCost.toFixed(4),
    }));
  }
}
