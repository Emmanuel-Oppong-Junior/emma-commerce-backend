import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';

// P9-L: JIT compilation made each facet/search statement take 1-2 s; the app's sessions run without it.
describe('Database sessions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs every pooled connection with JIT off', async () => {
    const sessions = await Promise.all(
      Array.from({ length: 5 }, () => prisma.$queryRaw<{ jit: string }[]>`SELECT current_setting('jit') AS jit`),
    );

    expect(sessions.map(([row]) => row.jit)).toEqual(['off', 'off', 'off', 'off', 'off']);
  });
});
