import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Currency, Prisma, Supplier } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, fieldChanges, fieldValues } from '../../commons/audit.service';
import { CreateSupplierInput, UpdateSupplierInput } from './supplier.input';

type Tx = Prisma.TransactionClient;

const MAX_PAGE_SIZE = 100;
const AUDITED_FIELDS = [
  'name',
  'contactName',
  'phone',
  'email',
  'address',
  'notes',
  'currency',
  'isActive',
] as const satisfies readonly (keyof Supplier)[];

/** The key that makes supplier names unique ignoring case and spacing. */
export function supplierNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface SupplierPage {
  nodes: Supplier[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * Suppliers (P4-E.1): names unique per store ignoring case; paid in the store currency (the only one for now). A
 * supplier a purchase order refers to is deactivated, never deleted. Every change is audited.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findOne(id: string): Promise<Supplier> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException(`Supplier "${id}" not found`);
    return supplier;
  }

  /** Suppliers by name, a page of at most 100 after the `after` cursor (a supplier id). */
  async findMany(
    filter: { isActive?: boolean; search?: string },
    first: number,
    after?: string,
  ): Promise<SupplierPage> {
    const take = Math.min(first, MAX_PAGE_SIZE);
    const search = filter.search?.trim();
    const where: Prisma.SupplierWhereInput = {
      isActive: filter.isActive,
      ...(search && {
        OR: (['name', 'contactName', 'email', 'phone'] as const).map((field) => ({
          [field]: { contains: search, mode: 'insensitive' },
        })),
      }),
    };
    const [rows, totalCount] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: [{ nameKey: 'asc' }, { id: 'asc' }],
        take: take + 1,
        ...(after && { cursor: { id: after }, skip: 1 }),
      }),
      this.prisma.supplier.count({ where }),
    ]);
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  /** @throws ConflictException when the name is taken; BadRequestException for a currency other than the store's. */
  async create(input: CreateSupplierInput, actorId: string): Promise<Supplier> {
    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.findFirstOrThrow({
        where: { singleton: true },
        select: { id: true, currency: true },
      });
      this.assertCurrency(input.currency, store.currency);
      const name = input.name.trim();
      await this.assertNameFree(tx, store.id, name);
      const supplier = await tx.supplier.create({
        data: {
          storeId: store.id,
          name,
          nameKey: supplierNameKey(name),
          contactName: input.contactName?.trim() || null,
          phone: input.phone?.trim() || null,
          email: input.email?.trim() || null,
          address: input.address?.trim() || null,
          notes: input.notes?.trim() || null,
          currency: store.currency,
          isActive: input.isActive ?? true,
        },
      });
      await this.audit.log(
        {
          entity: 'Supplier',
          entityId: supplier.id,
          action: 'CREATE',
          userId: actorId,
          details: fieldValues(supplier, AUDITED_FIELDS),
        },
        tx,
      );
      return supplier;
    });
  }

  /** Changes the fields given (null clears an optional one; isActive false deactivates). */
  async update(id: string, input: UpdateSupplierInput, actorId: string): Promise<Supplier> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.supplier.findUnique({ where: { id } });
      if (!before) throw new NotFoundException(`Supplier "${id}" not found`);
      const store = await tx.store.findFirstOrThrow({ where: { singleton: true }, select: { currency: true } });
      this.assertCurrency(input.currency ?? undefined, store.currency);
      const data: Prisma.SupplierUpdateInput = {};
      if (input.name !== undefined && input.name !== null) {
        const name = input.name.trim();
        if (supplierNameKey(name) !== before.nameKey) await this.assertNameFree(tx, before.storeId, name);
        data.name = name;
        data.nameKey = supplierNameKey(name);
      }
      for (const field of ['contactName', 'phone', 'email', 'address', 'notes'] as const) {
        if (input[field] !== undefined) data[field] = input[field]?.trim() || null;
      }
      if (input.isActive !== undefined && input.isActive !== null) data.isActive = input.isActive;
      const after = await tx.supplier.update({ where: { id }, data });
      const changes = fieldChanges(before, after, AUDITED_FIELDS);
      if (Object.keys(changes).length > 0) {
        await this.audit.log(
          { entity: 'Supplier', entityId: id, action: 'UPDATE', userId: actorId, details: changes },
          tx,
        );
      }
      return after;
    });
  }

  /**
   * Deletes a supplier no purchase order refers to.
   * @throws ConflictException when one does: deactivate it instead.
   */
  async delete(id: string, actorId: string): Promise<Supplier> {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id } });
      if (!supplier) throw new NotFoundException(`Supplier "${id}" not found`);
      if ((await tx.purchaseOrder.count({ where: { supplierId: id } })) > 0) {
        throw new ConflictException(`Supplier "${supplier.name}" has purchase orders; deactivate it instead`);
      }
      await tx.supplier.delete({ where: { id } });
      await this.audit.log(
        {
          entity: 'Supplier',
          entityId: id,
          action: 'DELETE',
          userId: actorId,
          details: fieldValues(supplier, AUDITED_FIELDS),
        },
        tx,
      );
      return supplier;
    });
  }

  private assertCurrency(currency: Currency | undefined, storeCurrency: Currency): void {
    if (currency !== undefined && currency !== storeCurrency) {
      throw new BadRequestException(`Suppliers are paid in the store currency (${storeCurrency}) for now`);
    }
  }

  private async assertNameFree(tx: Tx, storeId: string, name: string): Promise<void> {
    const taken = await tx.supplier.findUnique({
      where: { storeId_nameKey: { storeId, nameKey: supplierNameKey(name) } },
      select: { name: true },
    });
    if (taken) throw new ConflictException(`A supplier named "${taken.name}" already exists`);
  }
}
