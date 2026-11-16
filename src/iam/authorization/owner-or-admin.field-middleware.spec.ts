import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GraphQLModule, MiddlewareContext } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLResolveInfo } from 'graphql';
import * as request from 'supertest';
import { ownerOrAdmin } from './owner-or-admin.field-middleware';
import { UsersResolver } from '../../users/users.resolver';
import { UsersService } from '../../users/users.service';
import { AddressesLoader } from '../../users/loaders/addresses.loader';
import { OrdersLoader } from '../../users/loaders/orders.loader';

describe('ownerOrAdmin', () => {
  const middleware = ownerOrAdmin<{ ownerId: string }>((source) => source.ownerId);
  const info = { parentType: { name: 'User' }, fieldName: 'email' } as unknown as GraphQLResolveInfo;
  const run = (viewer: object | undefined) => {
    const next = jest.fn().mockResolvedValue('value');
    const ctx = { source: { ownerId: 'owner-1' }, args: {}, context: { req: { user: viewer } }, info };
    return { result: () => middleware(ctx as unknown as MiddlewareContext, next), next };
  };

  it.each([
    ['the owner', { id: 'owner-1', role: 'USER' }],
    ['an admin', { id: 'admin-1', role: 'ADMIN' }],
    ['a super admin', { id: 'root-1', role: 'SUPER_ADMIN' }],
  ])('lets %s read the field', async (_who, viewer) => {
    const { result, next } = run(viewer);

    await expect(result()).resolves.toBe('value');
    expect(next).toHaveBeenCalled();
  });

  it.each([
    ['another customer', { id: 'someone-else', role: 'USER' }],
    ['an anonymous caller', undefined],
  ])('forbids %s', (_who, viewer) => {
    const { result, next } = run(viewer);

    expect(result).toThrow(new ForbiddenException('Not allowed to read User.email'));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('User field authorization in a running schema', () => {
  let app: INestApplication;
  const target = { id: 'owner-1', name: 'Owner', email: 'owner@test.local', phoneNumber: '0240000000' };
  const address = { id: 'addr-1', street: '12 Private Road', city: 'Accra', userId: 'owner-1' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          context: ({ req }: { req: { headers: Record<string, string>; user?: object } }) => {
            const viewer = req.headers['x-test-viewer'];
            if (viewer) req.user = JSON.parse(viewer);
            return { req };
          },
        }),
      ],
      providers: [
        UsersResolver,
        { provide: UsersService, useValue: { findOne: async () => target } },
        { provide: AddressesLoader, useValue: { loader: { load: async () => [address] } } },
        { provide: OrdersLoader, useValue: { loader: { load: async () => [] } } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  const query = (viewer?: object) => {
    const req = request(app.getHttpServer()).post('/graphql');
    if (viewer) req.set('x-test-viewer', JSON.stringify(viewer));
    return req.send({ query: '{ userById(id: "owner-1") { id phoneNumber addresses { street } } }' });
  };

  it('returns the protected fields to the owner', async () => {
    const res = await query({ id: 'owner-1', role: 'USER' });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.userById).toEqual({
      id: 'owner-1',
      phoneNumber: '0240000000',
      addresses: [{ street: '12 Private Road' }],
    });
  });

  it('withholds phoneNumber and addresses from another customer', async () => {
    const res = await query({ id: 'someone-else', role: 'USER' });

    expect(res.body.data.userById).toEqual({ id: 'owner-1', phoneNumber: null, addresses: null });
    expect(res.body.errors.map((e: { path: string[] }) => e.path.join('.'))).toEqual(
      expect.arrayContaining(['userById.phoneNumber', 'userById.addresses']),
    );
    expect(res.body.errors.map((e: { extensions: { code: string } }) => e.extensions.code)).toEqual([
      'FORBIDDEN',
      'FORBIDDEN',
    ]);
  });

  it('withholds the email from an anonymous caller', async () => {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: '{ userById(id: "owner-1") { id email } }' });

    expect(JSON.stringify(res.body)).not.toContain('owner@test.local');
  });
});
