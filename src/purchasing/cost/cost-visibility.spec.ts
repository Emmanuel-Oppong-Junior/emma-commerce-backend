import { ForbiddenException } from '@nestjs/common';
import { MiddlewareContext } from '@nestjs/graphql';
import { GraphQLResolveInfo } from 'graphql';
import { COST_VIEWERS_ONLY } from './cost-visibility';
import { CUSTOMER_ACCESS, StaffAccess, staffAccessFor } from '../../iam/authorization/staff-access';
import { accessWith, MANAGER_ACCESS, OWNER_ACCESS } from '../../../test/helpers/staff.helper';

describe('cost visibility', () => {
  const [middleware] = COST_VIEWERS_ONLY.middleware;
  const info = { parentType: { name: 'Variant' }, fieldName: 'costPrice' } as unknown as GraphQLResolveInfo;
  const read = (access: StaffAccess) => {
    const next = jest.fn().mockResolvedValue('12.5000');
    const ctx = { source: {}, args: {}, context: { req: { access } }, info };
    return { result: () => middleware(ctx as unknown as MiddlewareContext, next), next };
  };
  const clerk = staffAccessFor({
    key: 'INVENTORY_CLERK',
    permissions: ['inventory.view', 'purchasing.view', 'purchasing.receive'],
    mfaRequired: false,
  });

  it('is nullable, so a hidden cost does not void its parent', () => {
    expect(COST_VIEWERS_ONLY.nullable).toBe(true);
  });

  it.each([
    ['the Owner', OWNER_ACCESS],
    ['the Manager', MANAGER_ACCESS],
    ['any role holding inventory.cost.view', accessWith('inventory.cost.view')],
  ])('shows costs to %s', async (_who, access) => {
    await expect(read(access).result()).resolves.toBe('12.5000');
  });

  it.each([
    ['an inventory clerk (purchasing.view and purchasing.receive only)', clerk],
    ['a purchasing manager without inventory.cost.view', accessWith('purchasing.manage', 'purchasing.view')],
    ['a customer', CUSTOMER_ACCESS],
  ])('hides costs from %s', (_who, access) => {
    const { result, next } = read(access);

    expect(result).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });
});
