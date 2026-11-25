import { Test, TestingModule } from '@nestjs/testing';
import { ReviewResolver } from './review.resolver';
import { ReviewService } from './review.service';
import { UsersLoader } from '../users/loaders/users.loader';
import { ProductsLoader } from '../products/loaders/products.loader';
import { Review } from './entities/review.entity';
import { ReviewPhotosLoader } from './review.loaders';

describe('ReviewResolver', () => {
  let resolver: ReviewResolver;
  const usersLoad = jest.fn();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewResolver,
        { provide: ReviewService, useValue: {} },
        { provide: UsersLoader, useValue: { loader: { load: usersLoad } } },
        { provide: ProductsLoader, useValue: { loader: { load: jest.fn() } } },
        { provide: ReviewPhotosLoader, useValue: { loader: { load: jest.fn() } } },
      ],
    }).compile();

    resolver = module.get<ReviewResolver>(ReviewResolver);
  });

  it('should be defined', () => {
    expect(resolver).toBeDefined();
  });

  it('exposes only the public profile of the reviewer', async () => {
    usersLoad.mockResolvedValue({
      id: 'user-1',
      name: 'Kwame Asante',
      email: 'kwame@test.local',
      phoneNumber: '0240000000',
    });

    const reviewer = await resolver.user({ userId: 'user-1' } as Review);

    expect(usersLoad).toHaveBeenCalledWith('user-1');
    expect(reviewer).toEqual({ displayName: 'Kwame A.' });
  });

  it('shows the store reply only once it has a body and a date', () => {
    const repliedAt = new Date('2026-12-01T10:00:00Z');

    expect(resolver.reply({ reply: 'Thank you', repliedAt } as Review)).toEqual({ body: 'Thank you', repliedAt });
    expect(resolver.reply({ reply: null, repliedAt: null } as Review)).toBeNull();
  });
});
