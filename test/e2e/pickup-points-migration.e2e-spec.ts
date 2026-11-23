import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

const BEFORE = '20261207110000_delivery_slots';
const EXPAND = '20261207120000_pickup_points';
const CONTRACT = '20261207120100_pickup_points_contract';
const REPORT = join(__dirname, '../../scripts/reports/pickup-points-migration-report.sql');

const LEGACY_DATA = `
INSERT INTO "PickupLocation" ("id", "name", "address", "city", "state", "country", "updatedAt") VALUES
  ('p_full', 'Osu', '1 Oxford St', 'Accra', 'Greater Accra Region', 'Ghana', now()),
  ('p_short', 'Tema', '2 Harbour Rd', 'Tema', 'GA', 'Ghana', now()),
  ('p_case', 'Ho', '3 Main St', 'Ho', ' volta ', 'Ghana', now()),
  ('p_old', 'Sunyani', '4 Market St', 'Sunyani', 'Brong Ahafo', 'Ghana', now());
`;

describe('Pickup points migration on free-text states (P5-E.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legacy: ScratchSchema;

  const snapshot = async () => ({
    regions: await legacy.query(`SELECT id, region::text FROM "PickupLocation" ORDER BY id`),
    report: await legacy.query(
      `SELECT "entityId", action, details->>'state' AS state FROM "AuditLog" WHERE entity = 'PickupMigration'`,
    ),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    legacy = new ScratchSchema(prisma, 'legacy_pickup_points');
  });

  beforeEach(async () => {
    await legacy.recreate();
    await legacy.migrateTo(BEFORE);
    await legacy.exec(LEGACY_DATA);
    await legacy.exec(migrationSql(EXPAND));
  });

  afterAll(async () => {
    await legacy.drop();
    await app.close();
  });

  it('maps region names and the GA abbreviation, and reports the rest without guessing', async () => {
    expect(await snapshot()).toEqual({
      regions: [
        { id: 'p_case', region: 'VOLTA' },
        { id: 'p_full', region: 'GREATER_ACCRA' },
        { id: 'p_old', region: null },
        { id: 'p_short', region: 'GREATER_ACCRA' },
      ],
      report: [{ entityId: 'p_old', action: 'STATE_NOT_MAPPED', state: 'Brong Ahafo' }],
    });
  });

  it('is safe to re-run, then drops state; the report still reads what it wrote', async () => {
    const first = await snapshot();
    await legacy.exec(migrationSqlFrom(EXPAND, '-- Backfill'));
    expect(await snapshot()).toEqual(first);

    await legacy.exec(migrationSql(CONTRACT));

    const columns = await legacy.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'legacy_pickup_points' AND table_name = 'PickupLocation'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('state');
    await expect(legacy.exec(readFileSync(REPORT, 'utf8'))).resolves.toBeUndefined();
  });

  it('refuses to drop state before the backfill has looked at every point', async () => {
    await legacy.exec(`DELETE FROM "AuditLog" WHERE entity = 'PickupMigration'`);

    await expect(legacy.exec(migrationSql(CONTRACT))).rejects.toThrow('not migrated yet');
  });
});
