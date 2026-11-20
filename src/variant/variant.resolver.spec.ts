import { VariantResolver } from './variant.resolver';

describe('VariantResolver', () => {
  const service = {
    getVariants: jest.fn(),
    getVariant: jest.fn(),
    createVariant: jest.fn(),
    updateVariant: jest.fn(),
    deleteVariant: jest.fn(),
  };
  const resolver = new VariantResolver(service as never);

  it('turns a page of variants into a connection', async () => {
    service.getVariants.mockResolvedValue({ nodes: [{ id: 'a' }, { id: 'b' }], totalCount: 7, hasNextPage: true });

    const connection = await resolver.getVariants({ first: 2, after: 'z' }, 'prod-1');

    expect(service.getVariants).toHaveBeenCalledWith({ first: 2, after: 'z' }, 'prod-1');
    expect(connection).toEqual({
      edges: [
        { cursor: 'a', node: { id: 'a' } },
        { cursor: 'b', node: { id: 'b' } },
      ],
      pageInfo: { pageSize: 2, hasNextPage: true, hasPreviousPage: true, totalCount: 7 },
    });
  });

  it('passes the variant id of an update input to the service', async () => {
    await resolver.updateVariant('admin-1', { id: 'v1', isActive: false });

    expect(service.updateVariant).toHaveBeenCalledWith('v1', { id: 'v1', isActive: false }, 'admin-1');
  });
});
