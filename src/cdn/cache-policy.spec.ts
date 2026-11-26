import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema, isObjectType } from 'graphql';
import {
  CacheDecisionInput,
  PRIVATE_FIELDS,
  PUBLIC_ROOT_FIELDS,
  PUBLIC_TYPES,
  STALE_WHILE_REVALIDATE_SECONDS,
  UNCACHEABLE,
  cacheDecision,
} from './cache-policy';
import { TAGGED_TYPES } from './surrogate-keys';

const anonymousGet: CacheDecisionInput = {
  method: 'GET',
  hasAuthorization: false,
  operationType: 'query',
  policy: { maxAge: 60, scope: 'PUBLIC' },
  hasErrors: false,
  surrogateKeys: ['product:p1'],
};

describe('cacheDecision', () => {
  it('makes an anonymous GET query whose fields are all public cacheable, with its surrogate keys', () => {
    expect(cacheDecision(anonymousGet)).toEqual({
      cacheable: true,
      cacheControl: `public, max-age=60, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
      surrogateKeys: ['catalogue', 'product:p1'],
    });
  });

  it('uses the smallest max-age of the response', () => {
    expect(cacheDecision({ ...anonymousGet, policy: { maxAge: 15, scope: 'PUBLIC' } }).cacheControl).toMatch(
      /^public, max-age=15,/,
    );
  });

  it.each<[string, Partial<CacheDecisionInput>]>([
    ['a POST', { method: 'POST' }],
    ['a request with an Authorization header', { hasAuthorization: true }],
    ['a mutation', { operationType: 'mutation' }],
    ['a request that never resolved to an operation', { operationType: undefined }],
    ['a response with errors', { hasErrors: true }],
    ['a response with a max-age 0 field', { policy: null }],
    ['a response with a private field', { policy: { maxAge: 60, scope: 'PRIVATE' } }],
    ['a zero max-age', { policy: { maxAge: 0, scope: 'PUBLIC' } }],
  ])('never caches %s publicly', (_case, change) => {
    expect(cacheDecision({ ...anonymousGet, ...change })).toEqual({ cacheable: false, cacheControl: UNCACHEABLE });
  });
});

describe('cache hints', () => {
  const schema = buildSchema(readFileSync(join(__dirname, '..', '..', 'schema.gql'), 'utf8'));

  it('names only root queries that exist and are open to visitors', () => {
    const queries = schema.getQueryType()!.getFields();
    expect([...PUBLIC_ROOT_FIELDS.keys()].filter((name) => !queries[name])).toEqual([]);
  });

  it('names only object types that exist', () => {
    const missing = [...PUBLIC_TYPES, ...Object.keys(TAGGED_TYPES)].filter(
      (name) => !isObjectType(schema.getType(name)),
    );
    expect(missing).toEqual([]);
  });

  it('marks existing customer-specific fields private', () => {
    const missing = [...PRIVATE_FIELDS].filter((coordinate) => {
      const [type, field] = coordinate.split('.');
      const object = schema.getType(type);
      return !isObjectType(object) || !object.getFields()[field];
    });
    expect(missing).toEqual([]);
  });

  it('tags only types whose responses can be cached', () => {
    expect(Object.keys(TAGGED_TYPES).filter((name) => !PUBLIC_TYPES.has(name))).toEqual([]);
  });
});
