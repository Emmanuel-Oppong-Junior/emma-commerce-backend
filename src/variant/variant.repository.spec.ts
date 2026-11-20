import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { generateSku, VariantRepository } from './variant.repository';

function knownError(code: string, target?: string[]) {
  return new Prisma.PrismaClientKnownRequestError('failed', { code, clientVersion: 'test', meta: { target } });
}

describe('VariantRepository', () => {
  let prisma: { variant: Record<string, jest.Mock> };
  let repository: VariantRepository;

  beforeEach(() => {
    prisma = { variant: { create: jest.fn(), update: jest.fn(), delete: jest.fn() } };
    repository = new VariantRepository(prisma as never);
  });

  it('generates a SKU when none is given and keeps a given one', async () => {
    prisma.variant.create.mockResolvedValue({});

    await repository.create({ productId: 'p', price: '1.00' });
    await repository.create({ productId: 'p', price: '1.00', sku: 'MY-SKU' });

    expect(prisma.variant.create.mock.calls[0][0].data.sku).toMatch(/^SKU-[0-9A-F]{12}$/);
    expect(prisma.variant.create.mock.calls[1][0].data.sku).toBe('MY-SKU');
    expect(generateSku()).not.toBe(generateSku());
  });

  it.each([
    [['sku'], 'Another variant already uses this SKU'],
    [['barcode'], 'Another variant already uses this barcode'],
    [['productId', 'optionsKey'], 'The product already has an active variant with these options'],
  ])('turns a unique violation on %o into CONFLICT', async (target, message) => {
    prisma.variant.create.mockRejectedValue(knownError('P2002', target));

    await expect(repository.create({ productId: 'p', price: '1.00' })).rejects.toThrow(new ConflictException(message));
  });

  it('turns a missing row into NOT_FOUND on update and delete', async () => {
    prisma.variant.update.mockRejectedValue(knownError('P2025'));
    prisma.variant.delete.mockRejectedValue(knownError('P2025'));

    await expect(repository.update('v1', {})).rejects.toThrow(new NotFoundException('Variant "v1" not found'));
    await expect(repository.delete('v1')).rejects.toThrow(NotFoundException);
  });

  it('rethrows other errors', async () => {
    prisma.variant.delete.mockRejectedValue(new Error('boom'));

    await expect(repository.delete('v1')).rejects.toThrow('boom');
  });
});
