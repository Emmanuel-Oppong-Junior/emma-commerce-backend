import { INestApplication } from '@nestjs/common';
import { createValidationPipe } from '../src/commons/validation-pipe';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import * as request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { genSalt, hash } from 'bcrypt';
import { Role, User } from '../src/generated/prisma/client';
import { ThrottlerStorage } from '@nestjs/throttler';
import { prepareStaffAccounts, resetDb, setStock } from './helpers/db.helper';
import { signInWithPassword } from './helpers/auth.helper';

const noopThrottlerStorage = {
  increment: async () => ({ totalHits: 1, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
  storage: {},
};

export async function createTestApp(): Promise<{
  app: INestApplication;
  prisma: PrismaService;
}> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      AppModule,
      await ConfigModule.forRoot({
        envFilePath: '.env.test',
        isGlobal: true,
      }),
    ],
  })
    .overrideProvider(ThrottlerStorage)
    .useValue(noopThrottlerStorage)
    .compile();

  const app = moduleFixture.createNestApplication();
  const prisma = moduleFixture.get<PrismaService>(PrismaService);

  app.useGlobalPipes(createValidationPipe());

  await app.init();

  return { app, prisma };
}

export async function clearDatabase(prisma: PrismaService) {
  await resetDb(prisma);
}

export async function insertUserIntoDatabase(userData: User, prisma: PrismaService) {
  const salt = await genSalt();
  const hashPassword = (await hash(userData.password!, salt)) as string;
  const user = await prisma.user.create({
    data: { ...userData, password: hashPassword },
  });
  await prepareStaffAccounts(prisma);
  return user;
}

export function createSuperAdmin(prisma: PrismaService) {
  return insertUserIntoDatabase(
    {
      id: 'super_admin1',
      email: 'super_admin@example.com',
      password: 'SuperAdmin@123',
      name: 'Super Admin User',
      role: Role.SUPER_ADMIN,
    } as User,
    prisma,
  );
}

export function createAdmin(prisma: PrismaService) {
  return insertUserIntoDatabase(
    {
      id: 'admin1',
      email: 'admin@example.com',
      password: 'Admin@123',
      name: 'Admin User',
      role: Role.ADMIN,
    } as User,
    prisma,
  );
}

export function createUser(prisma: PrismaService) {
  return insertUserIntoDatabase(
    {
      id: 'user1',
      email: 'user@example.com',
      password: 'User@123',
      name: 'Regular User',
      role: Role.USER,
    } as User,
    prisma,
  );
}

export async function deleteUser(id: string, prisma: PrismaService) {
  await prisma.user.delete({ where: { id } });
}

export function graphqlRequest(app: INestApplication, query: string, variables?: any) {
  return request(app.getHttpServer()).post('/graphql').send({ query, variables }).set('Accept', 'application/json');
}

export async function getSuperAdminToken(app: INestApplication) {
  return (await signInWithPassword(app, 'super_admin@example.com', 'SuperAdmin@123')).accessToken;
}

export async function getAdminToken(app: INestApplication) {
  return (await signInWithPassword(app, 'admin@example.com', 'Admin@123')).accessToken;
}

export async function getUserToken(app: INestApplication) {
  const signInMutation = `
        mutation {
          signIn(input: { email: "user@example.com", password: "User@123" }) {
            accessToken
          }
        }
      `;
  const response = await graphqlRequest(app, signInMutation).expect(200);
  return response.body.data?.signIn?.accessToken;
}

export async function createCategory(prisma: PrismaService) {
  return prisma.category.create({
    data: {
      id: 'cat1',
      name: 'Electronics',
    },
  });
}

export async function createTag(prisma: PrismaService) {
  return prisma.tag.create({
    data: {
      id: 'tag1',
      name: 'Popular',
    },
  });
}

/**
 * Creates multiple product records in the database for the specified category.
 * the ids of the product created are prod1 and prod2, each with one default variant (var1, var2)
 * @param prisma - An instance of PrismaService used to interact with the database.
 * @param categoryId - The ID of the category to associate with the new products.
 * @returns A promise that resolves when the products have been created.
 */
export async function createProducts(prisma: PrismaService, categoryId: string) {
  await prisma.product.createMany({
    data: [
      {
        id: 'prod1',
        name: 'Laptop',
        images: ['laptop.jpg'],
        isActive: true,
        categoryId,
        createdAt: new Date('2025-01-01'),
      },
      {
        id: 'prod2',
        name: 'Phone',
        images: ['phone.jpg'],
        isActive: true,
        categoryId,
        createdAt: new Date('2025-01-02'),
      },
    ],
  });
  await prisma.variant.createMany({
    data: [
      { id: 'var1', productId: 'prod1', sku: 'LAP123', price: 999.99, basePrice: 999.99 },
      { id: 'var2', productId: 'prod2', sku: 'PHN123', price: 499.99, basePrice: 499.99 },
    ],
  });
  await setStock(prisma, 'var1', 50);
  await setStock(prisma, 'var2', 100);
}
