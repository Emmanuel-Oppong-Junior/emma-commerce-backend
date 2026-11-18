import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { faker } from '@faker-js/faker';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set; the seeder needs a database to write to.');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
export { prisma, faker };
