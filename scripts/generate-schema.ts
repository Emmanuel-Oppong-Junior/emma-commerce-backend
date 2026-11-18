import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { GRAPHQL_SDL_FILE_HEADER, GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { lexicographicSortSchema, printSchema } from 'graphql';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Builds schema.gql from the resolver classes alone, so CI needs no database or env (booting AppModule needs both).
// The output matches what the app writes at startup (autoSchemaFile with sortSchema).
async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? 'schema.gql');
  const src = resolve(__dirname, '..', 'src');
  const resolvers = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.resolver.ts'))
    .flatMap((file) =>
      Object.values(require(join(src, file)) as Record<string, unknown>).filter(
        (value) => typeof value === 'function' && (value as { name: string }).name.endsWith('Resolver'),
      ),
    );
  const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });
  await app.init();
  const schema = await app.get(GraphQLSchemaFactory).create(resolvers as never);
  await app.close();
  writeFileSync(out, GRAPHQL_SDL_FILE_HEADER + printSchema(lexicographicSortSchema(schema)));
  console.log(`Wrote ${out} from ${resolvers.length} resolvers`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
