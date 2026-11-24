import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { RecentlyViewedRepository } from './recently-viewed.repository';
import { RECENTLY_VIEWED_LIMIT, RecentlyViewedService } from './recently-viewed.service';

describe('RecentlyViewedService', () => {
  let service: RecentlyViewedService;
  const tx = { tx: true };
  const calls: string[] = [];
  const repo = {
    transaction: jest.fn(),
    isPublicProduct: jest.fn(),
    lockUser: jest.fn(async () => void calls.push('lock')),
    upsert: jest.fn(async () => void calls.push('upsert')),
    prune: jest.fn(async () => {
      calls.push('prune');
      return 0;
    }),
    findPublicProducts: jest.fn(),
  };

  beforeEach(async () => {
    calls.length = 0;
    jest.clearAllMocks();
    repo.transaction.mockImplementation((work: (client: unknown) => unknown) => work(tx));
    repo.isPublicProduct.mockResolvedValue(true);
    const module = await Test.createTestingModule({
      providers: [RecentlyViewedService, { provide: RecentlyViewedRepository, useValue: repo }],
    }).compile();
    service = module.get(RecentlyViewedService);
  });

  it('upserts the view and prunes to the limit under the per-user lock, in one transaction', async () => {
    const viewedAt = new Date('2026-12-01T10:00:00Z');

    await expect(service.record('user1', 'prod1', viewedAt)).resolves.toBe(true);

    expect(calls).toEqual(['lock', 'upsert', 'prune']);
    expect(repo.lockUser).toHaveBeenCalledWith(tx, 'user1');
    expect(repo.upsert).toHaveBeenCalledWith(tx, 'user1', 'prod1', viewedAt);
    expect(repo.prune).toHaveBeenCalledWith(tx, 'user1', RECENTLY_VIEWED_LIMIT);
  });

  it('refuses a product that is not public and records nothing', async () => {
    repo.isPublicProduct.mockResolvedValue(false);

    await expect(service.record('user1', 'draft')).rejects.toThrow(NotFoundException);
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  it('lists the still-public products', async () => {
    repo.findPublicProducts.mockResolvedValue([{ id: 'prod1' }]);

    await expect(service.list('user1', 5)).resolves.toEqual([{ id: 'prod1' }]);
    expect(repo.findPublicProducts).toHaveBeenCalledWith('user1', 5);
  });
});
