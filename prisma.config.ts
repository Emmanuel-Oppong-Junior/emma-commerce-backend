import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env itself. Variables already set (CI, Docker) win over the file.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seeders/main.ts',
  },
  // process.env rather than env(): `prisma generate` (Docker build, CI checks) runs without a database URL.
  datasource: { url: process.env.DATABASE_URL },
});
