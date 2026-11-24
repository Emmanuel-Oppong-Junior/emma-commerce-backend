import { Injectable } from '@nestjs/common';
import { Currency, Prisma, Store } from '../generated/prisma/client';
import { AuditService, fieldChanges } from '../commons/audit.service';
import { StoreRepository } from './store.repository';
import { UpdateStoreSettingsInput } from './dto/update-store-settings.input';

const AUDITED_STORE_FIELDS = [
  'legalName',
  'tradingName',
  'tin',
  'vatRegistered',
  'pricesIncludeTax',
  'supportEmail',
  'supportPhone',
  'returnWindowDays',
] as const satisfies readonly (keyof Store)[];

@Injectable()
export class StoreService {
  constructor(
    private readonly storeRepository: StoreRepository,
    private readonly auditService: AuditService,
  ) {}

  async getSettings(): Promise<Store> {
    return this.storeRepository.find();
  }

  /** The currency every price, charge and refund of this store is in. */
  async getCurrency(db?: Prisma.TransactionClient): Promise<Currency> {
    return this.storeRepository.findCurrency(db);
  }

  async updateSettings(input: UpdateStoreSettingsInput, actorId: string): Promise<Store> {
    const { after } = await this.auditService.record(
      async (tx) => {
        const before = await this.storeRepository.find(tx);
        return { before, after: await this.storeRepository.update(input, tx) };
      },
      ({ before, after }) => ({
        entity: 'Store',
        entityId: after.id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(before, after, AUDITED_STORE_FIELDS) },
      }),
    );
    return after;
  }
}
