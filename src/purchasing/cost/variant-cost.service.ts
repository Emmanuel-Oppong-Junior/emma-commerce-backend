import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { CostChange, CostChangeSource, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../commons/audit.service';
import { weightedAverageCost } from './weighted-average-cost';

type Tx = Prisma.TransactionClient;

const MAX_PAGE_SIZE = 100;

/** `extensions.reason` when a manual cost is refused because purchase orders already set the variant's cost. */
export const COST_FROM_PURCHASES = 'COST_FROM_PURCHASES';

export interface CostChangePage {
  nodes: CostChange[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * The weighted-average cost of each variant (P4-E.1), store-wide: units at every location are the same goods bought
 * at the same prices, and transfers between locations must not change their value. Only a purchase-order receipt or a
 * manual set changes it, each change recorded as an append-only CostChange; other stock-adding paths (restock,
 * returns, transfers, FOUND adjustments) carry no purchase price, so they leave it as it is. Cost never feeds selling
 * prices or the pricing engine.
 */
@Injectable()
export class VariantCostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Locks the variants' rows in id order (so concurrent receipts of the same variants never deadlock and never lose a
   * cost update) and returns their current costs. Call before any stock moves in the transaction.
   * @throws NotFoundException for an unknown variant.
   */
  async lockVariants(tx: Tx, variantIds: string[]): Promise<Map<string, Decimal | null>> {
    const ids = [...new Set(variantIds)].sort();
    const rows = await tx.$queryRaw<{ id: string; costPrice: Decimal | null }[]>`
      SELECT "id", "costPrice" FROM "Variant" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
    const costs = new Map(rows.map((row) => [row.id, row.costPrice]));
    const missing = ids.find((id) => !costs.has(id));
    if (missing) throw new NotFoundException(`Variant "${missing}" not found`);
    return costs;
  }

  /**
   * Folds `quantity` units bought at `unitCost` into the variant's weighted-average cost, on the receipt's transaction
   * with the variant row locked (lockVariants) and before the units are added to stock. Writes a CostChange when the
   * cost changes; returns the cost after.
   */
  async applyReceipt(
    tx: Tx,
    receipt: { variantId: string; quantity: number; unitCost: Decimal; receiptId: string; actorId: string },
  ): Promise<Decimal> {
    const variant = await tx.variant.findUniqueOrThrow({
      where: { id: receipt.variantId },
      select: { costPrice: true },
    });
    const onHand = await tx.stockLevel.aggregate({ where: { variantId: receipt.variantId }, _sum: { onHand: true } });
    const next = weightedAverageCost(variant.costPrice, onHand._sum.onHand ?? 0, receipt.quantity, receipt.unitCost);
    if (variant.costPrice?.eq(next)) return next;
    await this.record(tx, {
      variantId: receipt.variantId,
      oldValue: variant.costPrice,
      newValue: next,
      source: CostChangeSource.PURCHASE_ORDER,
      refType: 'PurchaseOrderReceipt',
      refId: receipt.receiptId,
      actorId: receipt.actorId,
    });
    return next;
  }

  /**
   * Sets the cost of a variant never bought through a purchase order (opening stock, goods bought before purchasing
   * existed). Audited, with its reason.
   * @throws NotFoundException; BadRequestException when purchase orders already set its cost (COST_FROM_PURCHASES) or
   *   the cost is already that value.
   */
  async setManually(variantId: string, cost: Decimal, reason: string, actorId: string): Promise<CostChange> {
    return this.prisma.$transaction(async (tx) => {
      const old = (await this.lockVariants(tx, [variantId])).get(variantId) ?? null;
      const fromPurchases = await tx.costChange.count({
        where: { variantId, source: CostChangeSource.PURCHASE_ORDER },
      });
      if (fromPurchases > 0) {
        throw new BadRequestException({
          message: `Variant "${variantId}" is costed from its purchase orders; its cost cannot be set by hand`,
          extensions: { reason: COST_FROM_PURCHASES },
        });
      }
      if (old?.eq(cost)) throw new BadRequestException(`Variant "${variantId}" already costs ${old.toFixed(4)}`);
      const change = await this.record(tx, {
        variantId,
        oldValue: old,
        newValue: cost,
        source: CostChangeSource.MANUAL,
        reason: reason.trim(),
        actorId,
      });
      await this.audit.log(
        {
          entity: 'Variant',
          entityId: variantId,
          action: 'UPDATE',
          userId: actorId,
          details: { costPrice: { from: old?.toFixed(4) ?? null, to: cost.toFixed(4) }, reason: reason.trim() },
        },
        tx,
      );
      return change;
    });
  }

  /** The variant's cost changes, newest first, a page of at most 100 after the `after` cursor (a change id). */
  async history(variantId: string, first: number, after?: string): Promise<CostChangePage> {
    const take = Math.min(first, MAX_PAGE_SIZE);
    const [rows, totalCount] = await Promise.all([
      this.prisma.costChange.findMany({
        where: { variantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(after && { cursor: { id: after }, skip: 1 }),
      }),
      this.prisma.costChange.count({ where: { variantId } }),
    ]);
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  /** Current costs of the variants (null = unknown), for the Variant.costPrice field. */
  async costPrices(variantIds: readonly string[]): Promise<Map<string, Decimal | null>> {
    const rows = await this.prisma.variant.findMany({
      where: { id: { in: [...variantIds] } },
      select: { id: true, costPrice: true },
    });
    return new Map(rows.map((row) => [row.id, row.costPrice]));
  }

  private async record(
    tx: Tx,
    change: Omit<Prisma.CostChangeUncheckedCreateInput, 'currency' | 'oldValue' | 'newValue'> & {
      oldValue: Decimal | null;
      newValue: Decimal;
    },
  ): Promise<CostChange> {
    await tx.variant.update({ where: { id: change.variantId }, data: { costPrice: change.newValue } });
    const store = await tx.store.findFirstOrThrow({ where: { singleton: true }, select: { currency: true } });
    return tx.costChange.create({ data: { ...change, currency: store.currency } });
  }
}
