import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockTransferStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../commons/audit.service';
import { StockLedgerService } from '../stock-ledger.service';
import { canTransferTransition, ReceivedLine, receiptOf, transferDraftProblem } from './stock-transfer-rules';
import { StockTransfersRepository, TransferFilter, TransferWithLines } from './stock-transfers.repository';
import { SerialUnitsService } from '../serials/serial-units.service';

type Tx = Prisma.TransactionClient;

const MAX_PAGE_SIZE = 100;

export interface NewTransfer {
  fromLocationId: string;
  toLocationId: string;
  lines: { variantId: string; quantity: number }[];
  note?: string;
}

/** The serials of a serial-tracked variant's units on a transfer line (P4-D.1). */
export interface LineSerials {
  variantId: string;
  serials: string[];
}

export interface StockTransferPage {
  nodes: TransferWithLines[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * Stock transfers between locations (P4-A.2), in two steps. Dispatch takes the units off the source's on-hand stock
 * (only what is available, so stock reserved for orders stays) with a TRANSFER movement per line; until received
 * they are in transit on the transfer lines, counted at neither location. Receipt adds what arrived to the
 * destination (TRANSFER movements) and records any shortfall on its line as a variance: the missing units already
 * left the source's books at dispatch, so no further movement is written for them. Each step claims the transfer
 * with a conditional status update, so of two concurrent dispatches or receipts one wins and the other gets CONFLICT.
 * Every step is audited.
 */
@Injectable()
export class StockTransfersService {
  constructor(
    private readonly repository: StockTransfersRepository,
    private readonly ledger: StockLedgerService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly serialUnits: SerialUnitsService,
  ) {}

  async findOne(id: string): Promise<TransferWithLines> {
    const transfer = await this.repository.findById(id);
    if (!transfer) throw new NotFoundException(`Stock transfer "${id}" not found`);
    return transfer;
  }

  /** Transfers newest first, a page of at most 100 after the `after` cursor (a transfer id). */
  async findMany(filter: TransferFilter, first: number, after?: string): Promise<StockTransferPage> {
    const take = Math.min(first, MAX_PAGE_SIZE);
    const [rows, totalCount] = await this.repository.findMany(filter, { take: take + 1, after });
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  /** Units dispatched and not yet received, per variant (only variants with some in transit). */
  async inTransit(variantIds?: string[]): Promise<{ variantId: string; quantity: number }[]> {
    return this.repository.inTransit(variantIds);
  }

  /**
   * Creates a DRAFT transfer between two active locations. No stock moves yet.
   * @throws BadRequestException for an invalid draft or an inactive location; NotFoundException for an unknown
   *   location or variant.
   */
  async create(input: NewTransfer, actorId: string): Promise<TransferWithLines> {
    const problem = transferDraftProblem(input.fromLocationId, input.toLocationId, input.lines);
    if (problem) throw new BadRequestException(problem);
    return this.prisma.$transaction(async (tx) => {
      for (const locationId of [input.fromLocationId, input.toLocationId]) {
        const location = await this.repository.findLocation(tx, locationId);
        if (!location) throw new NotFoundException(`Stock location "${locationId}" not found`);
        if (!location.isActive) throw new BadRequestException(`Stock location "${location.name}" is inactive`);
      }
      const variantIds = input.lines.map((line) => line.variantId);
      const known = new Set(await this.repository.existingVariantIds(tx, variantIds));
      const unknown = variantIds.find((id) => !known.has(id));
      if (unknown) throw new NotFoundException(`Variant "${unknown}" not found`);
      const transfer = await this.repository.create(tx, { ...input, createdById: actorId });
      await this.audit.log(
        {
          entity: 'StockTransfer',
          entityId: transfer.id,
          action: 'CREATE',
          userId: actorId,
          details: {
            fromLocationId: input.fromLocationId,
            toLocationId: input.toLocationId,
            lines: input.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
          },
        },
        tx,
      );
      return transfer;
    });
  }

  /**
   * DRAFT -> DISPATCHED: takes every line off the source's available stock, or nothing at all. A serial-tracked
   * variant's line names the units sent (`serials`, one per unit, each IN_STOCK at the source); they go IN_TRANSIT.
   * @throws BadRequestException when the source has too few units available for a line, or for serials of a variant
   *   not on the transfer; ConflictException when the transfer is not a draft (already dispatched, received or
   *   cancelled, possibly by a concurrent request).
   */
  async dispatch(id: string, actorId: string, serials: LineSerials[] = []): Promise<TransferWithLines> {
    const serialsByVariant = this.serialsByVariant(serials);
    return this.prisma.$transaction(async (tx) => {
      const transfer = await this.claim(tx, id, StockTransferStatus.DISPATCHED, {
        dispatchedById: actorId,
        dispatchedAt: new Date(),
      });
      for (const line of transfer.lines) {
        const movement = await this.ledger.transferOut(tx, line.variantId, transfer.fromLocationId, line.quantity, {
          refType: 'StockTransfer',
          refId: transfer.id,
          actorId,
        });
        if (!movement) {
          const available = await this.ledger.available(tx, line.variantId, transfer.fromLocationId);
          throw new BadRequestException(
            `Cannot dispatch ${line.quantity} of variant "${line.variantId}": only ${available} available at the source`,
          );
        }
        await this.serialUnits.dispatchTransfer(
          tx,
          {
            variantId: line.variantId,
            quantity: line.quantity,
            serials: serialsByVariant.get(line.variantId),
            source: { movementId: movement.id, actorId, refType: 'StockTransfer', refId: transfer.id },
          },
          transfer.fromLocationId,
        );
      }
      this.assertSerialsOnTransfer(serialsByVariant, transfer);
      await this.auditStatus(tx, transfer, StockTransferStatus.DRAFT, StockTransferStatus.DISPATCHED, actorId);
      return this.repository.findByIdOrThrow(tx, id);
    });
  }

  /**
   * DISPATCHED -> RECEIVED or PARTIALLY_RECEIVED: adds what arrived to the destination and records each shortfall
   * (with its required note) as the line's variance. A serial-tracked line received short names the units that
   * arrived (`serials`); its other units in transit are WRITTEN_OFF. A line received in full may omit them.
   * @throws BadRequestException for an invalid receipt; ConflictException when the transfer is not in transit.
   */
  async receive(
    id: string,
    received: (ReceivedLine & { serials?: string[] })[],
    actorId: string,
  ): Promise<TransferWithLines> {
    const serialsByVariant = this.serialsByVariant(
      received.flatMap((line) => (line.serials ? [{ variantId: line.variantId, serials: line.serials }] : [])),
    );
    return this.prisma.$transaction(async (tx) => {
      const current = await this.repository.findById(id, tx);
      if (!current) throw new NotFoundException(`Stock transfer "${id}" not found`);
      const outcome = receiptOf(current.lines, received);
      if (outcome.problem !== null) throw new BadRequestException(outcome.problem);
      const transfer = await this.claim(tx, id, outcome.status, { receivedById: actorId, receivedAt: new Date() });
      for (const line of outcome.lines) {
        await this.repository.recordReceipt(tx, transfer.id, line);
        const movement =
          line.receivedQuantity === 0
            ? null
            : await this.ledger.transferIn(tx, line.variantId, transfer.toLocationId, line.receivedQuantity, {
                refType: 'StockTransfer',
                refId: transfer.id,
                actorId,
                ...(line.variance > 0 && { note: `Short by ${line.variance}: ${line.varianceNote}` }),
              });
        await this.serialUnits.receiveTransfer(
          tx,
          { transferId: transfer.id, ...line, serials: serialsByVariant.get(line.variantId) },
          transfer.toLocationId,
          { movementId: movement?.id, actorId, refType: 'StockTransfer', refId: transfer.id },
        );
      }
      await this.auditStatus(tx, transfer, StockTransferStatus.DISPATCHED, outcome.status, actorId, {
        variances: outcome.lines
          .filter((line) => line.variance > 0)
          .map((line) => ({ variantId: line.variantId, variance: line.variance, note: line.varianceNote })),
      });
      return this.repository.findByIdOrThrow(tx, id);
    });
  }

  /**
   * DRAFT -> CANCELLED. A dispatched transfer cannot be cancelled: receive it (short if need be) and send the goods
   * back on a new transfer.
   */
  async cancel(id: string, actorId: string, reason?: string): Promise<TransferWithLines> {
    return this.prisma.$transaction(async (tx) => {
      const transfer = await this.claim(tx, id, StockTransferStatus.CANCELLED, {
        cancelledById: actorId,
        cancelledAt: new Date(),
      });
      await this.auditStatus(tx, transfer, StockTransferStatus.DRAFT, StockTransferStatus.CANCELLED, actorId, {
        ...(reason && { reason }),
      });
      return this.repository.findByIdOrThrow(tx, id);
    });
  }

  private serialsByVariant(lines: LineSerials[]): Map<string, string[]> {
    const byVariant = new Map(lines.map((line) => [line.variantId, line.serials]));
    if (byVariant.size !== lines.length) throw new BadRequestException("Name each variant's serials once");
    return byVariant;
  }

  private assertSerialsOnTransfer(serialsByVariant: Map<string, string[]>, transfer: TransferWithLines): void {
    const stranger = [...serialsByVariant.keys()].find((id) => !transfer.lines.some((line) => line.variantId === id));
    if (stranger) throw new BadRequestException(`Variant "${stranger}" is not on this transfer`);
  }

  /** Moves the transfer to `to` from the one status that leads there, only if it is still in that status. */
  private async claim(
    tx: Tx,
    id: string,
    to: StockTransferStatus,
    stamp: Prisma.StockTransferUpdateManyMutationInput,
  ): Promise<TransferWithLines> {
    const from = to === StockTransferStatus.DISPATCHED || to === StockTransferStatus.CANCELLED ? 'DRAFT' : 'DISPATCHED';
    if (!canTransferTransition(from, to)) throw new Error(`No transfer transition ${from} -> ${to}`);
    const claimed = await this.repository.transition(tx, id, from, to, stamp);
    if (!claimed) {
      const current = await this.repository.findById(id, tx);
      if (!current) throw new NotFoundException(`Stock transfer "${id}" not found`);
      throw new ConflictException(`Stock transfer "${id}" is ${current.status}; it cannot become ${to}`);
    }
    return this.repository.findByIdOrThrow(tx, id);
  }

  private async auditStatus(
    tx: Tx,
    transfer: TransferWithLines,
    from: StockTransferStatus,
    to: StockTransferStatus,
    actorId: string,
    extra: Record<string, Prisma.InputJsonValue> = {},
  ): Promise<void> {
    await this.audit.log(
      {
        entity: 'StockTransfer',
        entityId: transfer.id,
        action: 'STATUS_CHANGE',
        userId: actorId,
        details: { from, to, ...extra },
      },
      tx,
    );
  }
}
