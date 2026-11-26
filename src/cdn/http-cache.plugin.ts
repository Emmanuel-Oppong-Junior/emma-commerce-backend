import { ApolloServerPlugin } from '@apollo/server';
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl';
import type { Response } from 'express';
import { GraphQLResolveInfo, getNamedType, getNullableType, isListType } from 'graphql';
import {
  CATALOGUE_MAX_AGE_SECONDS,
  PRIVATE_FIELDS,
  PUBLIC_ROOT_FIELDS,
  PUBLIC_TYPES,
  cacheDecision,
} from './cache-policy';
import { familyKey, isTaggedType, objectKey } from './surrogate-keys';

export const SURROGATE_KEY_HEADER = 'surrogate-key';
export const CACHE_TAG_HEADER = 'cache-tag';

interface CacheHint {
  maxAge?: number;
  scope?: 'PUBLIC' | 'PRIVATE';
}

// Apollo's cache-control plugin adds this to info (the type lives in a package this repo does not depend on).
type InfoWithCacheControl = GraphQLResolveInfo & { cacheControl?: { setCacheHint(hint: CacheHint): void } };

/**
 * HTTP caching for anonymous catalogue reads: cache hints from cache-policy.ts on top of Apollo's cache-control
 * plugin, `Cache-Control` from cacheDecision, and the surrogate keys of what the response shows. The hints apply to
 * every request (so the overall policy is right); keys are only collected for requests that could be public.
 */
export function httpCachePlugins(): ApolloServerPlugin[] {
  // Apollo calls willResolveField in reverse plugin order: listed after ours, the cache-control plugin sets
  // info.cacheControl before our hook uses it. Headers are ours to set.
  return [httpCachePlugin(), ApolloServerPluginCacheControl({ defaultMaxAge: 0, calculateHttpHeaders: false })];
}

function httpCachePlugin(): ApolloServerPlugin<{ res?: Response }> {
  return {
    async requestDidStart({ request }) {
      const hasAuthorization = request.http?.headers.get('authorization') !== undefined;
      const mayBePublic = request.http?.method === 'GET' && !hasAuthorization;
      const keys = new Set<string>();
      return {
        async executionDidStart() {
          return {
            willResolveField({ source, info }) {
              applyCacheHint(info);
              if (!mayBePublic) return;
              collectKeys(keys, source, info);
              if (info.path.prev) return;
              return (_error, result) => {
                const type = getNamedType(info.returnType);
                if (result == null && isTaggedType(type.name)) keys.add(familyKey(type.name));
              };
            },
          };
        },
        async willSendResponse({ response, overallCachePolicy, operation, contextValue }) {
          const decision = cacheDecision({
            method: request.http?.method,
            hasAuthorization,
            operationType: operation?.operation,
            policy: overallCachePolicy.policyIfCacheable(),
            hasErrors: response.body.kind !== 'single' || (response.body.singleResult.errors?.length ?? 0) > 0,
            surrogateKeys: keys,
          });
          response.http.headers.set('cache-control', decision.cacheControl);
          if (!decision.cacheable) return;
          response.http.headers.set(SURROGATE_KEY_HEADER, decision.surrogateKeys.join(' '));
          response.http.headers.set(CACHE_TAG_HEADER, decision.surrogateKeys.join(','));
          // Through Express, so the CORS middleware's `Vary: Origin` is kept (Apollo's headers overwrite).
          contextValue.res?.vary('Authorization');
        },
      };
    },
  };
}

function applyCacheHint(info: InfoWithCacheControl): void {
  if (!info.cacheControl) throw new Error('Apollo cache-control plugin is not installed before httpCachePlugin');
  const coordinate = `${info.parentType.name}.${info.fieldName}`;
  if (PRIVATE_FIELDS.has(coordinate)) {
    info.cacheControl.setCacheHint({ scope: 'PRIVATE' });
  } else if (!info.path.prev) {
    if (isPublicRootField(info)) info.cacheControl.setCacheHint({ maxAge: CATALOGUE_MAX_AGE_SECONDS, scope: 'PUBLIC' });
  } else if (PUBLIC_TYPES.has(getNamedType(info.returnType).name)) {
    info.cacheControl.setCacheHint({ maxAge: CATALOGUE_MAX_AGE_SECONDS });
  }
}

function collectKeys(keys: Set<string>, source: unknown, info: GraphQLResolveInfo): void {
  const parent = info.parentType.name;
  if (isTaggedType(parent)) keys.add(objectKey(parent, (source as { id?: unknown } | null)?.id));
  if (!info.path.prev && isPublicRootField(info)) {
    for (const key of PUBLIC_ROOT_FIELDS.get(info.fieldName) ?? []) keys.add(key);
  }
  const returned = getNamedType(info.returnType);
  if (isListType(getNullableType(info.returnType)) && isTaggedType(returned.name)) keys.add(familyKey(returned.name));
}

function isPublicRootField(info: GraphQLResolveInfo): boolean {
  return info.parentType.name === 'Query' && PUBLIC_ROOT_FIELDS.has(info.fieldName);
}
