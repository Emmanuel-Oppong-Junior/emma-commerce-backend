import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { assertTestDatabaseUrl } from './helpers/test-database-guard';

const envTestPath = path.resolve(__dirname, '..', '.env.test');

if (!fs.existsSync(envTestPath)) {
  throw new Error(`Missing ${envTestPath}. Create it from .env.test.example before running e2e tests.`);
}

dotenv.config({ path: envTestPath, override: true });
assertTestDatabaseUrl(process.env.DATABASE_URL);
