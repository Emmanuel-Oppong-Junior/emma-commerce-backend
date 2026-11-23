import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockAdjustmentReason, StockTake, StockTakeStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../commons/audit.service';
import { StockLedgerRepository } from '../stock-ledger.repository';
import { StockLedgerService } from '../stock-ledger.service';
import { LotsService } from '../lots/lots.service';
import { LotQuantity } from '../lots/lots';
import { assertStockTakeTransition, stockTakeStatusesFrom } from './stock-take-status';
import { VarianceReport, varianceOf, varianceReport, variancesToPost } from './stock-take-variance';
import { StockTakeLineView, StockTakeListFilter, StockTakeRepository } from './stock-take.repository';
import { OpenStockTakeInput } from './dto/open-stock-take.input';
import { RecordStockTakeCountsInput } from './dto/record-stock-take-counts.input';
import { SerialUnitsService } from '../serials/serial-units.service';

type Tx = Prisma.TransactionClient;

export const STOCK_TAKE_ALREADY_OPEN = 'STOCK_TAKE_ALREADY_OPEN';
export const STOCK_TAKE_BELOW_RESERVED = 'STOCK_TAKE_BELOW_RESERVED';
export const STOCK_TAKE_NO_LOT = 'STOCK_TAKE_NO_LOT';
export const STOCK_TAKE_SERIAL_VARIANCE = 'STOCK_TAKE_SERIAL_VARIANCE';

const MAX_PAGE_SIZE = 200;
const MAX_REASON_LENGTH = 500;
// Long counts (thousands of lines) are opened and approved in one transaction each.
const LONG_TRANSACTION = { timeout: 60_000 };

export interface Page<T> {
  nodes: T[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * Stock-takes (P4-B.1): staff open a count session at a location, record counted quantities per variant and submit;
 * an approver posts every non-zero variance as an ADJUSTMENT (STOCK_TAKE) through the ledger in one transaction, or
 * cancels. Status moves are conditional updates on the session row, so a repeated approve or cancel changes nothing.
 * Counts stay per variant for lot-tracked variants too (P4-C.1): a shortage is drawn first expiry first out, a
 * surplus goes into the variant's latest-expiring lot.
 */
@Injectable()
export class StockTakeService {
  constructor(
    private readonly repository: StockTakeRepository,
    private readonly ledgerRepository: StockLedgerRepository,
    private readonly ledger: StockLedgerService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly lots: LotsService,
    private readonly serialUnits: SerialUnitsService,
  ) {}

  /**
   * Opens a session at a location (default: the store's default location) with one line per variant in scope and the
   * quantity expected on the shelf now.
   * @throws BadRequestException for both a category and variants, or nothing to count; NotFoundException for an
   * unknown location, category or variant; ConflictException (STOCK_TAKE_ALREADY_OPEN) when one is open there.
   */
  async open(input: OpenStockTakeInput, actorId: string): Promise<StockTake> {
    if (input.categoryId && input.variantIds) {
      throw new BadRequestException('Count either a category or a list of variants, not both');
    }
    const variantIds = input.variantIds && [...new Set(input.variantIds)];
    return this.prisma.$transaction(async (tx) => {
      const locationId = await this.resolveLocation(tx, input.locationId);
      const open = await this.repository.findOpenAt(tx, locationId);
      if (open) {
        throw new ConflictException({
          message: `Stock-take "${open.id}" is still open at this location: approve or cancel it first`,
          extensions: { reason: STOCK_TAKE_ALREADY_OPEN },
        });
      }
      if (input.categoryId && !(await this.repository.categoryExists(tx, input.categoryId))) {
        throw new NotFoundException(`Category "${input.categoryId}" not found`);
      }
      if (variantIds) {
        const found = new Set(await this.repository.existingVariantIds(tx, variantIds));
        const missing = variantIds.filter((id) => !found.has(id));
        if (missing.length > 0) throw new NotFoundException(`Variants not found: ${missing.join(', ')}`);
      }
      const lines = await this.repository.expectedStock(tx, locationId, { categoryId: input.categoryId, variantIds });
      if (lines.length === 0) throw new BadRequestException('There are no variants to count in this scope');
      const stockTake = await this.repository.create(
        tx,
        { locationId, categoryId: input.categoryId, note: input.note?.trim() || undefined, openedById: actorId },
        lines,
      );
      await this.audit.log(
        {
          entity: 'StockTake',
          entityId: stockTake.id,
          action: 'CREATE',
          userId: actorId,
          details: {
            locationId,
            scope: input.categoryId ? 'CATEGORY' : variantIds ? 'VARIANTS' : 'ALL',
            ...(input.categoryId && { categoryId: input.categoryId }),
            lineCount: lines.length,
          },
        },
        tx,
      );
      return stockTake;
    }, LONG_TRANSACTION);
  }

  /**
   * Records counted quantities on an OPEN session. Each line's expected quantity is read with its count, so stock
   * that moved since the session opened is no variance. Counting a line again replaces the earlier count.
   * @throws NotFoundException for an unknown session; ConflictException when it is no longer OPEN; BadRequestException
   * for a variant given twice or not in the session.
   */
  async recordCounts(input: RecordStockTakeCountsInput, actorId: string): Promise<StockTakeLineView[]> {
    const variantIds = input.counts.map((count) => count.variantId);
    const duplicate = variantIds.find((id, index) => variantIds.indexOf(id) !== index);
    if (duplicate) throw new BadRequestException(`Variant "${duplicate}" is counted twice`);
    await this.prisma.$transaction(async (tx) => {
      const session = await this.repository.lockSession(tx, input.stockTakeId, 'share');
      if (!session) throw this.notFound(input.stockTakeId);
      if (session.status !== StockTakeStatus.OPEN) {
        throw new ConflictException(`Stock-take "${input.stockTakeId}" is ${session.status}: counts are closed`);
      }
      const inSession = new Set(await this.repository.findLineVariantIds(tx, input.stockTakeId, variantIds));
      const outside = variantIds.filter((id) => !inSession.has(id));
      if (outside.length > 0) {
        throw new BadRequestException(`Not in this stock-take: ${outside.join(', ')}`);
      }
      const expected = new Map(
        (await this.repository.expectedStock(tx, session.locationId, { variantIds })).map((row) => [
          row.variantId,
          row.expected,
        ]),
      );
      for (const count of input.counts) {
        const expectedQuantity = expected.get(count.variantId);
        // Every line's variant exists (foreign key), so the query returns a row for each.
        if (expectedQuantity === undefined) throw new Error(`No expected stock for variant "${count.variantId}"`);
        await this.repository.recordCount(
          tx,
          input.stockTakeId,
          {
            variantId: count.variantId,
            countedQuantity: count.countedQuantity,
            expectedQuantity,
            variance: varianceOf(count.countedQuantity, expectedQuantity),
          },
          actorId,
        );
      }
      await this.audit.log(
        {
          entity: 'StockTake',
          entityId: input.stockTakeId,
          action: 'UPDATE',
          userId: actorId,
          details: { counts: input.counts.map(({ variantId, countedQuantity }) => ({ variantId, countedQuantity })) },
        },
        tx,
      );
    });
    return this.repository.linesOf(input.stockTakeId, variantIds);
  }

  /**
   * Closes counting: OPEN -> SUBMITTED, ready for an approver.
   * @throws NotFoundException; ConflictException when not OPEN; BadRequestException when nothing was counted.
   */
  async submit(id: string, actorId: string): Promise<StockTake> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.repository.lockSession(tx, id, 'update');
      if (!session) throw this.notFound(id);
      assertStockTakeTransition(id, session.status, StockTakeStatus.SUBMITTED);
      const counted = await this.repository.countedLines(tx, id);
      if (counted.length === 0) throw new BadRequestException('Count at least one variant before submitting');
      await this.move(tx, id, StockTakeStatus.SUBMITTED, { submittedById: actorId, submittedAt: new Date() });
      await this.auditStatus(tx, id, actorId, session.status, StockTakeStatus.SUBMITTED, {
        countedLines: counted.length,
      });
      return this.findOrFail(tx, id);
    });
  }

  /**
   * SUBMITTED -> APPROVED, posting each non-zero variance as an ADJUSTMENT (STOCK_TAKE, ref StockTake) in the same
   * transaction. The status move is claimed first, so a second approve gets CONFLICT and posts nothing.
   * @throws NotFoundException; ConflictException when not SUBMITTED, or (STOCK_TAKE_BELOW_RESERVED) when a shortage
   * would take on-hand stock below the units reserved for open orders, or (STOCK_TAKE_SERIAL_VARIANCE) when a
   * serial-tracked variant has a variance (nothing is posted then): a stock-take counts per variant and cannot say
   * which units are missing or new, so those are adjusted by serial (adjustVariantStock) and counted again.
   */
  async approve(id: string, actorId: string): Promise<StockTake> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.move(tx, id, StockTakeStatus.APPROVED, {
        approvedById: actorId,
        approvedAt: new Date(),
      });
      const posted: { variantId: string; variance: number; movementId: string }[] = [];
      const variances = variancesToPost(await this.repository.countedLines(tx, id));
      const serialised = await this.serialUnits.trackedVariantIds(
        tx,
        variances.map((line) => line.variantId),
      );
      if (serialised.length > 0) {
        throw new ConflictException({
          message:
            `Serial-tracked variants have a variance: ${serialised.join(', ')}. Cancel this stock-take, adjust them ` +
            'naming the serials written off or found (adjustVariantStock), then count them again',
          extensions: { reason: STOCK_TAKE_SERIAL_VARIANCE, variantIds: serialised },
        });
      }
      for (const line of variances) {
        const source = {
          actorId,
          adjustmentReason: StockAdjustmentReason.STOCK_TAKE,
          refType: 'StockTake',
          refId: id,
          note: `Stock-take ${id}`,
        };
        const movement = (await this.lots.isTracked(tx, line.variantId))
          ? ((
              await this.ledger.adjustLots(
                tx,
                line.variantId,
                session.locationId,
                line.variance,
                source,
                await this.surplusLots(tx, line),
              )
            )?.[0] ?? null)
          : await this.ledger.adjustAt(tx, line.variantId, session.locationId, line.variance, source);
        if (!movement) {
          const available = await this.ledger.availableAt(tx, line.variantId, session.locationId);
          throw new ConflictException({
            message:
              `Cannot post a variance of ${line.variance} for variant "${line.variantId}": only ${available} units ` +
              'are not reserved for open orders; recount it or cancel the stock-take',
            extensions: { reason: STOCK_TAKE_BELOW_RESERVED },
          });
        }
        await this.repository.setLineMovement(tx, id, line.variantId, movement.id);
        posted.push({ variantId: line.variantId, variance: line.variance, movementId: movement.id });
      }
      await this.auditStatus(tx, id, actorId, StockTakeStatus.SUBMITTED, StockTakeStatus.APPROVED, { posted });
      return this.findOrFail(tx, id);
    }, LONG_TRANSACTION);
  }

  /**
   * The lot a surplus of a lot-tracked variant goes into (undefined for a shortage, drawn by FEFO).
   * @throws ConflictException (STOCK_TAKE_NO_LOT) when the variant has never had a lot.
   */
  private async surplusLots(tx: Tx, line: { variantId: string; variance: number }): Promise<LotQuantity[] | undefined> {
    if (line.variance < 0) return undefined;
    const lot = await this.lots.surplusLot(tx, line.variantId);
    if (!lot) {
      throw new ConflictException({
        message:
          `Variant "${line.variantId}" tracks lots but has none to put the ${line.variance} extra units in: ` +
          'receive them with a lot number (restockVariant), recount it or cancel the stock-take',
        extensions: { reason: STOCK_TAKE_NO_LOT },
      });
    }
    return [{ lotId: lot.id, quantity: line.variance }];
  }

  /**
   * OPEN or SUBMITTED -> CANCELLED; no stock moves.
   * @throws NotFoundException; ConflictException once approved or cancelled.
   */
  async cancel(id: string, actorId: string, reason?: string): Promise<StockTake> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.repository.lockSession(tx, id, 'update');
      if (!session) throw this.notFound(id);
      assertStockTakeTransition(id, session.status, StockTakeStatus.CANCELLED);
      const why = reason?.trim() || null;
      if (why && why.length > MAX_REASON_LENGTH) {
        throw new BadRequestException(`The reason is limited to ${MAX_REASON_LENGTH} characters`);
      }
      await this.move(tx, id, StockTakeStatus.CANCELLED, {
        cancelledById: actorId,
        cancelledAt: new Date(),
        cancelReason: why,
      });
      await this.auditStatus(tx, id, actorId, session.status, StockTakeStatus.CANCELLED, { reason: why });
      return this.findOrFail(tx, id);
    });
  }

  async get(id: string): Promise<StockTake> {
    return this.findOrFail(this.prisma, id);
  }

  async list(filter: StockTakeListFilter, first: number, after?: string): Promise<Page<StockTake>> {
    const take = Math.min(first, MAX_PAGE_SIZE);
    const [rows, totalCount] = await this.repository.list(filter, { take: take + 1, after });
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  async lines(
    stockTakeId: string,
    filter: { counted?: boolean },
    first: number,
    after?: string,
  ): Promise<Page<StockTakeLineView>> {
    await this.findOrFail(this.prisma, stockTakeId);
    const take = Math.min(first, MAX_PAGE_SIZE);
    const [rows, totalCount] = await this.repository.lines(stockTakeId, filter, { take: take + 1, after });
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  async varianceReport(id: string): Promise<VarianceReport & { stockTake: StockTake }> {
    const stockTake = await this.findOrFail(this.prisma, id);
    return { stockTake, ...varianceReport(await this.repository.reportLines(id)) };
  }

  private async move(
    tx: Tx,
    id: string,
    to: StockTakeStatus,
    data: Prisma.StockTakeUpdateManyMutationInput,
  ): Promise<StockTake> {
    if (!(await this.repository.transition(tx, id, stockTakeStatusesFrom(to), to, data))) {
      const current = await this.findOrFail(tx, id);
      assertStockTakeTransition(id, current.status, to);
    }
    return this.findOrFail(tx, id);
  }

  private async findOrFail(db: Tx, id: string): Promise<StockTake> {
    const stockTake = await this.repository.find(db, id);
    if (!stockTake) throw this.notFound(id);
    return stockTake;
  }

  private notFound(id: string): NotFoundException {
    return new NotFoundException(`Stock-take "${id}" not found`);
  }

  private async resolveLocation(tx: Tx, locationId: string | undefined): Promise<string> {
    if (!locationId) return this.ledgerRepository.defaultLocationId(tx);
    const location = await this.ledgerRepository.findActiveLocation(tx, locationId);
    if (!location) throw new NotFoundException(`Stock location "${locationId}" not found or inactive`);
    return location.id;
  }

  private async auditStatus(
    tx: Tx,
    id: string,
    actorId: string,
    from: StockTakeStatus,
    to: StockTakeStatus,
    extra: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.audit.log(
      { entity: 'StockTake', entityId: id, action: 'STATUS_CHANGE', userId: actorId, details: { from, to, ...extra } },
      tx,
    );
  }
}
