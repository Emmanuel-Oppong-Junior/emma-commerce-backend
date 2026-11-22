import { Injectable, NotFoundException } from '@nestjs/common';
import { CodBlacklistEntry, OrderStatus, PaymentMethod, Prisma, ShippingZone } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CodBlacklistKey } from './cod-blacklist';
import { CodRiskSettings } from './cod-risk';

/** Cash-on-delivery orders still to be delivered or cancelled. */
export const OPEN_COD_STATUSES: OrderStatus[] = [OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.IN_FULFILMENT];

export interface StoreCodSettings extends CodRiskSettings {
  storeId: string;
  storeOffersCod: boolean;
}

@Injectable()
export class CodRiskRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findSettings(db: Prisma.TransactionClient = this.prisma): Promise<StoreCodSettings> {
    const store = await db.store.findFirstOrThrow({
      where: { singleton: true },
      select: { id: true, cashOnDeliveryEnabled: true, codMaxOpenOrdersPerPhone: true, codMaxOrderTotal: true },
    });
    return {
      storeId: store.id,
      storeOffersCod: store.cashOnDeliveryEnabled,
      maxOpenOrdersPerPhone: store.codMaxOpenOrdersPerPhone,
      maxOrderTotal: store.codMaxOrderTotal,
    };
  }

  async updateSettings(tx: Prisma.TransactionClient, update: Partial<CodRiskSettings>): Promise<StoreCodSettings> {
    const { storeId } = await this.findSettings(tx);
    await tx.store.update({
      where: { id: storeId },
      data: { codMaxOpenOrdersPerPhone: update.maxOpenOrdersPerPhone, codMaxOrderTotal: update.maxOrderTotal },
    });
    return this.findSettings(tx);
  }

  async findUserPhone(userId: string, db: Prisma.TransactionClient = this.prisma) {
    return db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedNumber: true },
    });
  }

  /**
   * Serialises cash-on-delivery placements per verified phone until the transaction ends, so two checkouts cannot both
   * see room under the open-order cap.
   */
  async lockPhone(tx: Prisma.TransactionClient, phone: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`cod-phone:${phone}`}, 0))`;
  }

  /** Open COD orders placed under the phone, and the account's own (older orders did not record the phone). */
  async countOpenCodOrders(phone: string, userId: string, db: Prisma.TransactionClient = this.prisma): Promise<number> {
    return db.order.count({
      where: {
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        status: { in: OPEN_COD_STATUSES },
        deleted: false,
        OR: [{ codPhone: phone }, { userId }],
      },
    });
  }

  async isBlacklisted(keys: CodBlacklistKey[], db: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    if (keys.length === 0) return false;
    const match = await db.codBlacklistEntry.findFirst({
      where: { OR: keys.map(({ kind, value }) => ({ kind, value })) },
      select: { id: true },
    });
    return match !== null;
  }

  async zoneCodEnabled(zoneId: string, db: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    const zone = await db.shippingZone.findUniqueOrThrow({ where: { id: zoneId }, select: { codEnabled: true } });
    return zone.codEnabled;
  }

  async setZoneCod(
    tx: Prisma.TransactionClient,
    zoneId: string,
    codEnabled: boolean,
  ): Promise<{ before: ShippingZone; after: ShippingZone }> {
    const before = await tx.shippingZone.findUnique({ where: { id: zoneId } });
    if (!before) throw new NotFoundException(`Shipping zone "${zoneId}" not found`);
    const after = await tx.shippingZone.update({ where: { id: zoneId }, data: { codEnabled } });
    return { before, after };
  }

  async findBlacklist(take: number): Promise<CodBlacklistEntry[]> {
    return this.prisma.codBlacklistEntry.findMany({ orderBy: { createdAt: 'desc' }, take });
  }

  async createBlacklistEntry(
    tx: Prisma.TransactionClient,
    key: CodBlacklistKey,
    reason: string,
    createdById: string,
  ): Promise<CodBlacklistEntry> {
    return tx.codBlacklistEntry.create({ data: { ...key, reason, createdById } });
  }

  async deleteBlacklistEntry(tx: Prisma.TransactionClient, id: string): Promise<CodBlacklistEntry> {
    const entry = await tx.codBlacklistEntry.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException(`Blacklist entry "${id}" not found`);
    await tx.codBlacklistEntry.delete({ where: { id } });
    return entry;
  }
}
