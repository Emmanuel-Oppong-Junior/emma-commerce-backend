import { extractRequestedFieldsFromQuery, REDACTED, sanitizeVariables } from './useful-functions';
import { FieldNode, GraphQLResolveInfo, OperationDefinitionNode, parse } from 'graphql';

describe('sanitizeVariables', () => {
  it('redacts every value at any depth and keeps the keys', () => {
    const variables = {
      input: { email: 'kwame@test.local', password: 'Sup3rSecret!', address: { street: '12 Private Road' } },
      first: 20,
      ids: ['a', 'b'],
      flag: true,
      missing: null,
    };

    expect(sanitizeVariables(variables)).toEqual({
      input: { email: REDACTED, password: REDACTED, address: { street: REDACTED } },
      first: REDACTED,
      ids: [REDACTED, REDACTED],
      flag: REDACTED,
      missing: REDACTED,
    });
  });

  it('returns an empty object for no variables', () => {
    expect(sanitizeVariables({})).toEqual({});
  });
});

describe('extractRequestedFieldsFromQuery', () => {
  const infoFor = (query: string) => {
    const operation = parse(query).definitions[0] as OperationDefinitionNode;
    return { fieldNodes: [operation.selectionSet.selections[0] as FieldNode] } as unknown as GraphQLResolveInfo;
  };

  it('selects a Money column as one scalar, ignoring its { amount currency } sub-selection', () => {
    const select = extractRequestedFieldsFromQuery(infoFor('{ product { id price { amount currency } name } }'), {
      excludedFields: [],
      scalarFields: ['price'],
    });

    expect(select).toEqual({ id: true, price: true, name: true });
  });
});
