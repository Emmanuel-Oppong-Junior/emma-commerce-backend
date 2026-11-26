import { BadRequestException, ConflictException } from '@nestjs/common';
import { SlugsService } from './slugs.service';
import { PrismaService } from '../prisma/prisma.service';

describe('SlugsService.assertAvailable', () => {
  const findUnique = jest.fn();
  const prisma = { category: { findUnique } } as unknown as PrismaService;
  const service = new SlugsService(prisma);

  beforeEach(() => findUnique.mockReset());

  it('does nothing when no slug was sent', async () => {
    await service.assertAvailable('CATEGORY', undefined, 'c1');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses null: a slug can be changed, never removed', async () => {
    await expect(service.assertAvailable('CATEGORY', null, 'c1')).rejects.toThrow(BadRequestException);
  });

  it('allows a free slug and the entity keeping its own', async () => {
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'c1' });
    await expect(service.assertAvailable('CATEGORY', 'shoes')).resolves.toBeUndefined();
    await expect(service.assertAvailable('CATEGORY', 'shoes', 'c1')).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith({ where: { slug: 'shoes' }, select: { id: true } });
  });

  it("refuses another entity's slug with a CONFLICT naming the kind", async () => {
    findUnique.mockResolvedValue({ id: 'c2' });
    await expect(service.assertAvailable('CATEGORY', 'shoes', 'c1')).rejects.toThrow(
      new ConflictException('Slug "shoes" is already used by another category'),
    );
  });
});
