import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

const BEFORE = '20261205100000_purchasing';
const EXPAND = '20261207100000_delivery_rates';
const CONTRACT = '20261207100100_delivery_rates_contract';
const REPORT = join(__dirname, '../../scripts/reports/delivery-zones-migration-report.sql');
const backfill = () => migrationSqlFrom(EXPAND, '-- Backfill');

// Zones as P0-B.4 left them: messy spellings and a duplicate inside a zone, a blank, an accented city, and a city
// listed by two zones (the older keeps it).
const LEGACY_DATA = `
INSERT INTO "ShippingZone" ("id", "name", "cities", "fee", "createdAt", "updatedAt") VALUES
  ('z_accra', 'Greater Accra', ARRAY[' Accra ', 'accra', 'East-Legon', '   ', 'Tema'], 15, '2026-01-01', now()),
  ('z_coast', 'Coast', ARRAY['tema', 'Éjisu'], 20.50, '2026-02-01', now());
`;

describe('Delivery zones migration on legacy city lists (P5-A.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legacy: ScratchSchema;

  const snapshot = async () => ({
    areas: await legacy.query(`SELECT "zoneId", level::text, town, "matchKey" FROM "ZoneArea" ORDER BY "matchKey"`),
    rules: await legacy.query(
      `SELECT id, "zoneId", "serviceLevel"::text, "baseFee"::text, "isActive" FROM "RateRule" ORDER BY id`,
    ),
    report: await legacy.query(
      `SELECT "entityId", action, details->>'city' AS city, details->>'keptInZone' AS "keptInZone"
       FROM "AuditLog" WHERE entity = 'ZoneMigration' ORDER BY action, details->>'city'`,
    ),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    legacy = new ScratchSchema(prisma, 'legacy_delivery_zones');
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

  it('turns each city into a normalised town of the oldest zone listing it, and each fee into a STANDARD rule', async () => {
    expect(await snapshot()).toEqual({
      areas: [
        { zoneId: 'z_accra', level: 'TOWN', town: 'accra', matchKey: 'TOWN:accra' },
        { zoneId: 'z_accra', level: 'TOWN', town: 'east legon', matchKey: 'TOWN:east legon' },
        { zoneId: 'z_coast', level: 'TOWN', town: 'ejisu', matchKey: 'TOWN:ejisu' },
        { zoneId: 'z_accra', level: 'TOWN', town: 'tema', matchKey: 'TOWN:tema' },
      ],
      rules: [
        { id: 'z_accra_standard', zoneId: 'z_accra', serviceLevel: 'STANDARD', baseFee: '15.00', isActive: true },
        { id: 'z_coast_standard', zoneId: 'z_coast', serviceLevel: 'STANDARD', baseFee: '20.50', isActive: true },
      ],
      report: [
        { entityId: 'z_accra', action: 'CITY_BLANK_DROPPED', city: '   ', keptInZone: null },
        { entityId: 'z_coast', action: 'CITY_IN_OTHER_ZONE', city: 'tema', keptInZone: 'z_accra' },
      ],
    });
  });

  it('is safe to re-run, and the report reads what it wrote', async () => {
    const first = await snapshot();

    await legacy.exec(backfill());

    expect(await snapshot()).toEqual(first);
    await expect(legacy.exec(readFileSync(REPORT, 'utf8'))).resolves.toBeUndefined();
  });

  it('drops the city lists and flat fees once everything is copied, and refuses to before', async () => {
    await legacy.exec(`DELETE FROM "RateRule" WHERE id = 'z_coast_standard'`);
    await expect(legacy.exec(migrationSql(CONTRACT))).rejects.toThrow('not migrated yet');

    await legacy.exec(backfill());
    await legacy.exec(migrationSql(CONTRACT));

    const columns = await legacy.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'legacy_delivery_zones' AND table_name = 'ShippingZone' ORDER BY column_name`,
    );
    expect(columns.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(['cities']));
    expect(columns.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(['fee']));
  });
});
