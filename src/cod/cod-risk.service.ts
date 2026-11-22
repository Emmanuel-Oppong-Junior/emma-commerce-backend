import { Injectable } from '@nestjs/common';
import { CodBlacklistEntry, Prisma, ShippingZone } from '../generated/prisma/client';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { AppMetrics } from '../observability/metrics';
import { verifiedPhoneOf } from '../phone-verification/phone-otp';
import { blacklistKeyOf, checkoutBlacklistKeys, CodBlacklistTarget, DeliveryAddressFacts } from './cod-blacklist';
import {
  assertValidCodRiskSettings,
  codRefusal,
  codRefusalError,
  CodRiskSettings,
  CodUnavailableReason,
} from './cod-risk';
import { CodRiskRepository, StoreCodSettings } from './cod-risk.repository';

const CONTEXT = 'CodRisk';
const AUDITED_SETTINGS = ['maxOpenOrdersPerPhone', 'maxOrderTotal'] as const;
const AUDITED_BLACKLIST_FIELDS = ['kind', 'value', 'reason', 'createdById'] as const;

/** The checkout as the gates see it. */
export interface CodCheckout {
  grandTotal: Prisma.Decimal;
  /** Null for pickup. */
  shippingZoneId: string | null;
  /** The delivery address; null for pickup. */
  address: DeliveryAddressFacts | null;
  /** createOrder's contact phone (checkoutQuote has none). */
  contactPhone?: string;
}

export interface CodAvailability {
  available: boolean;
  reason: CodUnavailableReason | null;
  phoneVerified: boolean;
}

/**
 * Cash-on-delivery risk gates (P3-B.1/B.2): a verified phone, the blacklist, COD-enabled delivery zones, open COD
 * orders per verified phone and a cap on the grand total, all store settings the Owner edits.
 */
@Injectable()
export class CodRiskService {
  constructor(
    private readonly repository: CodRiskRepository,
    private readonly auditService: AuditService,
    private readonly metrics: AppMetrics,
    private readonly logger: LoggerService,
  ) {}

  /** checkoutQuote: whether the customer could pay this checkout on delivery, and if not the first gate refusing it. */
  async availability(userId: string, checkout: CodCheckout): Promise<CodAvailability> {
    const { reason, verifiedPhone } = await this.evaluate(userId, checkout);
    return { available: reason === null, reason, phoneVerified: verifiedPhone !== null };
  }

  /**
   * createOrder, inside its transaction: refuses a COD checkout a gate holds (BAD_REQUEST with reason
   * PHONE_NOT_VERIFIED, or COD_NOT_AVAILABLE and the gate as codReason) and returns the verified phone to record on the
   * order. The phone is locked first, so concurrent checkouts count each other's orders.
   */
  async assertCodAllowed(tx: Prisma.TransactionClient, userId: string, checkout: CodCheckout): Promise<string> {
    const user = await this.repository.findUserPhone(userId, tx);
    const phone = verifiedPhoneOf(user);
    if (phone) await this.repository.lockPhone(tx, phone);
    const { reason, verifiedPhone } = await this.evaluate(userId, checkout, tx);
    if (reason !== null || !verifiedPhone) {
      const refused = reason ?? CodUnavailableReason.PHONE_NOT_VERIFIED;
      this.metrics.recordCodGateRefusal(refused);
      this.logger.warn(`Cash on delivery refused | userId: ${userId} | gate: ${refused}`, CONTEXT);
      throw codRefusalError(refused);
    }
    return verifiedPhone;
  }

  async getSettings(): Promise<StoreCodSettings> {
    return this.repository.findSettings();
  }

  async updateSettings(update: Partial<CodRiskSettings>, actorId: string): Promise<StoreCodSettings> {
    assertValidCodRiskSettings(update);
    const { after } = await this.auditService.record(
      async (tx) => ({
        before: await this.repository.findSettings(tx),
        after: await this.repository.updateSettings(tx, update),
      }),
      ({ before, after: updated }) => ({
        entity: 'Store',
        entityId: updated.storeId,
        action: 'UPDATE',
        userId: actorId,
        details: { codRiskSettings: fieldChanges(before, updated, AUDITED_SETTINGS) },
      }),
    );
    return after;
  }

  async setZoneCod(zoneId: string, codEnabled: boolean, actorId: string): Promise<ShippingZone> {
    const { after } = await this.auditService.record(
      (tx) => this.repository.setZoneCod(tx, zoneId, codEnabled),
      ({ before, after: updated }) => ({
        entity: 'ShippingZone',
        entityId: zoneId,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(before, updated, ['codEnabled']) },
      }),
    );
    return after;
  }

  async blacklist(take: number): Promise<CodBlacklistEntry[]> {
    return this.repository.findBlacklist(take);
  }

  /** Adds a phone or address, normalised (CONFLICT when it is listed already). */
  async addToBlacklist(target: CodBlacklistTarget, reason: string, actorId: string): Promise<CodBlacklistEntry> {
    const key = blacklistKeyOf(target);
    return this.auditService.record(
      (tx) => this.repository.createBlacklistEntry(tx, key, reason, actorId),
      (entry) => ({
        entity: 'CodBlacklistEntry',
        entityId: entry.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(entry, AUDITED_BLACKLIST_FIELDS) },
      }),
    );
  }

  async removeFromBlacklist(id: string, actorId: string): Promise<CodBlacklistEntry> {
    return this.auditService.record(
      (tx) => this.repository.deleteBlacklistEntry(tx, id),
      (entry) => ({
        entity: 'CodBlacklistEntry',
        entityId: entry.id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(entry, AUDITED_BLACKLIST_FIELDS) },
      }),
    );
  }

  // Sequential reads: they may run on the caller's interactive transaction.
  private async evaluate(
    userId: string,
    checkout: CodCheckout,
    db?: Prisma.TransactionClient,
  ): Promise<{ reason: CodUnavailableReason | null; verifiedPhone: string | null }> {
    const settings = await this.repository.findSettings(db);
    const user = await this.repository.findUserPhone(userId, db);
    const verifiedPhone = verifiedPhoneOf(user);
    const keys = checkoutBlacklistKeys([user.phoneNumber, checkout.contactPhone], checkout.address);
    const facts = {
      storeOffersCod: settings.storeOffersCod,
      verifiedPhone,
      blacklisted: await this.repository.isBlacklisted(keys, db),
      zoneCodEnabled: checkout.shippingZoneId
        ? await this.repository.zoneCodEnabled(checkout.shippingZoneId, db)
        : null,
      openCodOrders: verifiedPhone ? await this.repository.countOpenCodOrders(verifiedPhone, userId, db) : 0,
      grandTotal: checkout.grandTotal,
    };
    return { reason: codRefusal(facts, settings), verifiedPhone };
  }
}
