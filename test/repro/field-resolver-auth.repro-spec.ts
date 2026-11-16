import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { GqlExecutionContext, GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { APP_GUARD } from '@nestjs/core';
import * as request from 'supertest';
import { ReviewResolver } from '../../src/review/review.resolver';
import { ReviewService } from '../../src/review/review.service';
import { UsersResolver } from '../../src/users/users.resolver';
import { UsersService } from '../../src/users/users.service';
import { UsersLoader } from '../../src/users/loaders/users.loader';
import { AddressesLoader } from '../../src/users/loaders/addresses.loader';
import { OrdersLoader } from '../../src/users/loaders/orders.loader';
import { ProductsLoader } from '../../src/products/loaders/products.loader';
import { AuthenticationGuard } from '../../src/iam/authentication/guards/authentication.guard';
import { AccessTokenGuard } from '../../src/iam/authentication/guards/access-token.guard';
import { RolesGuard } from '../../src/iam/authentication/guards/roles.guard';
import { REQUEST_USER_KEY } from '../../src/iam/iam.constants';

const reviewer = {
  id: 'reviewer-1',
  email: 'reviewer@test.local',
  name: 'Reviewer',
  phoneNumber: '0240000000',
  role: 'USER',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const reviewerAddress = {
  id: 'address-1',
  street: '12 Private Road',
  city: 'Accra',
  state: 'Greater Accra',
  zipCode: '00233',
  country: 'GH',
  userId: reviewer.id,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// SEC-01 / PRD-01 / USR-01: field resolvers run without guards because GraphQLModule sets no
// fieldResolverEnhancers. The same path is reachable anonymously through the public `product` query.
describe('Field-level authorisation (audit repro: SEC-01)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          context: ({ req }: { req: unknown }) => ({ req }),
        }),
      ],
      providers: [
        ReviewResolver,
        UsersResolver,
        {
          provide: ReviewService,
          useValue: {
            getProductReviews: async () => [
              { id: 'review-1', score: 5, comment: 'ok', productId: 'product-1', userId: reviewer.id, createdAt: new Date(), updatedAt: new Date() },
            ],
          },
        },
        { provide: UsersService, useValue: {} },
        { provide: UsersLoader, useValue: { loader: { load: async () => reviewer } } },
        { provide: AddressesLoader, useValue: { loader: { load: async () => [reviewerAddress] } } },
        { provide: OrdersLoader, useValue: { loader: { load: async () => [] } } },
        { provide: ProductsLoader, useValue: { loader: { load: async () => null } } },
        {
          provide: AccessTokenGuard,
          useValue: {
            canActivate: (context: never) => {
              const req = GqlExecutionContext.create(context).getContext().req;
              req[REQUEST_USER_KEY] = { id: 'other-customer', role: 'USER', isActive: true };
              return true;
            },
          },
        },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it("a customer cannot read another customer's saved addresses through review.user", async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: '{ productReviews(productId: "product-1") { id user { email addresses { street } } } }' });

    expect(JSON.stringify(response.body)).not.toContain(reviewerAddress.street);
  });
});
