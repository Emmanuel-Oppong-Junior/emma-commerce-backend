import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../src/prisma/prisma.service';

const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');

/** Migration folder names in the order Prisma applies them. */
export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

/** The part of a migration from the line starting with `marker` to the end, e.g. its re-runnable backfill. */
export function migrationSqlFrom(name: string, marker: string): string {
  const sql = migrationSql(name);
  const start = sql.indexOf(`\n${marker}`);
  if (start < 0) throw new Error(`No "${marker}" section in migration ${name}`);
  return sql.slice(start + 1);
}

/**
 * A scratch Postgres schema inside the test database, for running migrations against legacy data shapes that the
 * real schema no longer has. Every statement runs in its own transaction with search_path set to the scratch schema.
 */
export class ScratchSchema {
  constructor(
    private readonly prisma: PrismaService,
    readonly name: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid scratch schema name "${name}"`);
  }

  async recreate(): Promise<void> {
    await this.drop();
    await this.prisma.$executeRawUnsafe(`CREATE SCHEMA "${this.name}"`);
  }

  async drop(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${this.name}" CASCADE`);
  }

  /** Runs `sql` (several statements allowed, no parameters) against the scratch schema. */
  async exec(sql: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${this.name}"`);
      await tx.$executeRawUnsafe(sql);
    });
  }

  async query<T>(sql: string): Promise<T[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${this.name}"`);
      return tx.$queryRawUnsafe<T[]>(sql);
    });
  }

  /** Applies every migration up to and including `lastName`. */
  async migrateTo(lastName: string): Promise<void> {
    const names = migrationNames();
    if (!names.includes(lastName)) throw new Error(`No migration "${lastName}"`);
    for (const name of names) {
      await this.exec(migrationSql(name));
      if (name === lastName) return;
    }
  }
}
