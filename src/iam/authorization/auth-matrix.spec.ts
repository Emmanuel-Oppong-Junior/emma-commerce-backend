import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RESOLVER_NAME_METADATA, RESOLVER_TYPE_METADATA } from '@nestjs/graphql';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_TYPE_KEY } from '../authentication/decorators/auth.decorator';
import { AuthType } from '../authentication/enums/auth-type.enum';
import { CUSTOMER_ONLY_KEY, PERMISSIONS_KEY, STEP_UP_KEY, StepUpCondition } from './policy.decorators';

// The authorization matrix (ADR-0013): every GraphQL operation and REST route with its policy, from Nest metadata.
// A change to any policy changes the snapshot, so it is reviewed; run `npm test -- -u auth-matrix` to accept it.

const SRC_DIR = join(__dirname, '..', '..');

type ClassRef = { prototype: object; name: string };

interface MatrixRow {
  operation: string;
  policy: string;
  explicit: boolean;
}

async function loadClasses(suffix: string, nameSuffix: string): Promise<ClassRef[]> {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith(suffix));
  const modules: Record<string, unknown>[] = await Promise.all(files.map((file) => import(join(SRC_DIR, file))));
  return modules.flatMap((exports) =>
    Object.values(exports).filter(
      (value): value is ClassRef => typeof value === 'function' && value.name.endsWith(nameSuffix),
    ),
  );
}

function metadata<T>(key: string, method: object, cls: ClassRef): T | undefined {
  return Reflect.getMetadata(key, method) ?? Reflect.getMetadata(key, cls);
}

function policyOf(method: object, cls: ClassRef): Omit<MatrixRow, 'operation'> {
  const authTypes = metadata<AuthType[]>(AUTH_TYPE_KEY, method, cls);
  const permissions = metadata<string[]>(PERMISSIONS_KEY, method, cls);
  const customerOnly = metadata<boolean>(CUSTOMER_ONLY_KEY, method, cls);
  const stepUp = metadata<StepUpCondition | true>(STEP_UP_KEY, method, cls);
  const explicit = authTypes !== undefined || !!permissions?.length || !!customerOnly;
  const parts: string[] = [];
  if (authTypes?.includes(AuthType.None)) parts.push('public');
  else if (authTypes?.includes(AuthType.Optional)) parts.push('public, optional sign-in');
  else if (permissions?.length) parts.push(`permission: ${permissions.join(' + ')}`);
  else if (customerOnly) parts.push('customer only');
  else parts.push('authenticated');
  if (stepUp === true) parts.push('step-up');
  else if (stepUp) parts.push(`step-up when ${stepUp.label}`);
  return { policy: parts.join('; '), explicit };
}

function methodsOf(cls: ClassRef): [string, object][] {
  return Object.getOwnPropertyNames(cls.prototype)
    .filter((key) => key !== 'constructor')
    .map((key) => [key, (cls.prototype as Record<string, object>)[key]] as [string, object])
    .filter(([, method]) => typeof method === 'function');
}

function graphqlRows(resolvers: ClassRef[]): MatrixRow[] {
  return resolvers.flatMap((cls) =>
    methodsOf(cls).flatMap(([key, method]) => {
      const type = Reflect.getMetadata(RESOLVER_TYPE_METADATA, method);
      if (type !== 'Query' && type !== 'Mutation') return [];
      const name = Reflect.getMetadata(RESOLVER_NAME_METADATA, method) ?? key;
      return [{ operation: `${type} ${name}`, ...policyOf(method, cls) }];
    }),
  );
}

function joinPath(...segments: (string | undefined)[]): string {
  const path = segments
    .flatMap((segment) => (segment ?? '').split('/'))
    .filter(Boolean)
    .join('/');
  return `/${path}`;
}

function restRows(controllers: ClassRef[]): MatrixRow[] {
  return controllers.flatMap((cls) => {
    const base = Reflect.getMetadata(PATH_METADATA, cls) as string | undefined;
    return methodsOf(cls).flatMap(([, method]) => {
      const verb = Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod | undefined;
      if (verb === undefined) return [];
      const path = Reflect.getMetadata(PATH_METADATA, method) as string | undefined;
      return [{ operation: `REST ${RequestMethod[verb]} ${joinPath(base, path)}`, ...policyOf(method, cls) }];
    });
  });
}

describe('Authorization matrix', () => {
  let rows: MatrixRow[];

  beforeAll(async () => {
    const [resolvers, controllers] = await Promise.all([
      loadClasses('.resolver.ts', 'Resolver'),
      loadClasses('.controller.ts', 'Controller'),
    ]);
    rows = [...graphqlRows(resolvers), ...restRows(controllers)].sort((a, b) => a.operation.localeCompare(b.operation));
  });

  it('finds the operations it is meant to cover', () => {
    const operations = rows.map((row) => row.operation);

    expect(operations).toEqual(
      expect.arrayContaining([
        'Mutation signIn',
        'Query products',
        'Mutation processRefund',
        'REST POST /payment/webhook',
      ]),
    );
    expect(new Set(operations).size).toBe(operations.length);
  });

  it('gives every operation an explicit policy (@Auth, @RequirePermission or @CustomerOnly)', () => {
    expect(rows.filter((row) => !row.explicit).map((row) => row.operation)).toEqual([]);
  });

  it('matches the reviewed matrix', () => {
    const table = rows.map((row) => `${row.operation.padEnd(40)} ${row.policy}`).join('\n');

    expect(`\n${table}\n`).toMatchSnapshot();
  });
});
