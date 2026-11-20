import { ApolloServerPlugin } from '@apollo/server';
import { AppMetrics, GraphqlOperationSample, secondsSince } from './metrics';

/** Times each GraphQL operation (one sample per request, root operation only) and counts its errors by code. */
export function graphqlMetricsPlugin(metrics: AppMetrics): ApolloServerPlugin {
  return {
    async requestDidStart() {
      const start = performance.now();
      let operation: GraphqlOperationSample['operation'];
      return {
        async didResolveOperation({ operationName, operation: document }) {
          if (document) operation = { name: operationName, type: document.operation };
        },
        async willSendResponse({ response }) {
          // The formatted errors, so the codes are the ones the client saw.
          const errors = response.body.kind === 'single' ? response.body.singleResult.errors : undefined;
          const errorCodes = (errors ?? []).map((error) => {
            const code = error.extensions?.code;
            return typeof code === 'string' ? code : 'INTERNAL_SERVER_ERROR';
          });
          metrics.recordGraphqlOperation({ operation, errorCodes, seconds: secondsSince(start) });
        },
      };
    },
  };
}
