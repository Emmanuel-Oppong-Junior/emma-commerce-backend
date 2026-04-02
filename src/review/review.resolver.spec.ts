import { Test, TestingModule } from '@nestjs/testing';
import { ReviewResolver } from './review.resolver';
import { ReviewService } from './review.service';
import { UsersLoader } from '../users/loaders/users.loader';
import { ProductsLoader } from '../products/loaders/products.loader';

describe('ReviewResolver', () => {
  let resolver: ReviewResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewResolver,
        { provide: ReviewService, useValue: {} },
        { provide: UsersLoader, useValue: { loader: { load: jest.fn() } } },
        { provide: ProductsLoader, useValue: { loader: { load: jest.fn() } } },
      ],
    }).compile();

    resolver = module.get<ReviewResolver>(ReviewResolver);
  });

  it('should be defined', () => {
    expect(resolver).toBeDefined();
  });
});
