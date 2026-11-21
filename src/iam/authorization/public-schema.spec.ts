import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  RESOLVER_NAME_METADATA,
  RESOLVER_TYPE_METADATA,
} from '@nestjs/graphql';
import { getNamedType, GraphQLNamedType, GraphQLSchema, isObjectType, isInterfaceType, isUnionType } from 'graphql';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_TYPE_KEY } from '../authentication/decorators/auth.decorator';
import { AuthType } from '../authentication/enums/auth-type.enum';

const SRC_DIR = join(__dirname, '..', '..');
const PRIVATE_TYPES = ['User'];

type ClassRef = { prototype: object; name: string };

async function loadResolverClasses(): Promise<ClassRef[]> {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.resolver.ts'));
  const modules: Record<string, unknown>[] = await Promise.all(files.map((file) => import(join(SRC_DIR, file))));
  return modules.flatMap((exports) =>
    Object.values(exports).filter(
      (value): value is ClassRef => typeof value === 'function' && value.name.endsWith('Resolver'),
    ),
  );
}

function publicRootFields(resolvers: ClassRef[]): { root: 'Query' | 'Mutation'; field: string }[] {
  return resolvers.flatMap((cls) => {
    const classAuth: AuthType[] | undefined = Reflect.getMetadata(AUTH_TYPE_KEY, cls);
    return Object.getOwnPropertyNames(cls.prototype).flatMap((key) => {
      const method = (cls.prototype as Record<string, unknown>)[key];
      if (typeof method !== 'function') return [];
      const root = Reflect.getMetadata(RESOLVER_TYPE_METADATA, method);
      if (root !== 'Query' && root !== 'Mutation') return [];
      const auth: AuthType[] | undefined = Reflect.getMetadata(AUTH_TYPE_KEY, method) ?? classAuth;
      if (!auth?.includes(AuthType.None) && !auth?.includes(AuthType.Optional)) return [];
      return [{ root, field: Reflect.getMetadata(RESOLVER_NAME_METADATA, method) ?? key }];
    });
  });
}

function pathsToTypes(schema: GraphQLSchema, root: 'Query' | 'Mutation', field: string, targets: string[]): string[] {
  const rootObject = root === 'Query' ? schema.getQueryType() : schema.getMutationType();
  const rootField = rootObject?.getFields()[field];
  if (!rootField) throw new Error(`Public root field ${root}.${field} is missing from the built schema`);
  const start = `${root}.${field}`;
  const rootType = getNamedType(rootField.type);
  const seen = new Map<string, string>([[rootType.name, start]]);
  const queue: GraphQLNamedType[] = [rootType];
  const found: string[] = [];
  while (queue.length > 0) {
    const type = queue.shift()!;
    const path = seen.get(type.name)!;
    if (targets.includes(type.name)) found.push(`${path} -> ${type.name}`);
    const children =
      isObjectType(type) || isInterfaceType(type)
        ? Object.values(type.getFields()).map((f) => [f.name, getNamedType(f.type)] as const)
        : isUnionType(type)
          ? type.getTypes().map((t) => [t.name, t] as const)
          : [];
    for (const [name, child] of children) {
      if (!seen.has(child.name)) {
        seen.set(child.name, `${path}.${name}`);
        queue.push(child);
      }
    }
  }
  return found;
}

describe('Public GraphQL surface', () => {
  let schema: GraphQLSchema;
  let publicFields: { root: 'Query' | 'Mutation'; field: string }[];

  beforeAll(async () => {
    const resolvers = await loadResolverClasses();
    publicFields = publicRootFields(resolvers);
    const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });
    await app.init();
    schema = await app
      .get(GraphQLSchemaFactory)
      .create(resolvers as unknown as Parameters<GraphQLSchemaFactory['create']>[0]);
    await app.close();
  });

  it('finds the public entry points it is meant to check', () => {
    expect(publicFields).toEqual(expect.arrayContaining([{ root: 'Query', field: 'product' }]));
  });

  it(`never reaches ${PRIVATE_TYPES.join(', ')} from an @Auth(None) query or mutation`, () => {
    const leaks = publicFields.flatMap(({ root, field }) => pathsToTypes(schema, root, field, PRIVATE_TYPES));

    expect(leaks).toEqual([]);
  });
});
