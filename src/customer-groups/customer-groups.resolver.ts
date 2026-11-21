import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../iam/authorization/policy.decorators';
import { staffWith } from '../iam/authorization/staff-permission.field-middleware';
import { CustomerGroupsService } from './customer-groups.service';
import { CustomerGroup, CustomerGroupMemberPage } from './entities/customer-group.entity';
import {
  CreateCustomerGroupInput,
  CustomerGroupMembersArgs,
  CustomerGroupMembersInput,
  UpdateCustomerGroupInput,
} from './dto/customer-group.input';

// Groups are customer segmentation, not promotion data (B2B price lists will use them too): their own permission.
@Resolver(() => CustomerGroup)
export class CustomerGroupsResolver {
  constructor(private readonly customerGroupsService: CustomerGroupsService) {}

  @RequirePermission('customer.group.manage')
  @Query(() => [CustomerGroup], { description: 'Admin: customer groups by name' })
  customerGroups() {
    return this.customerGroupsService.findAll();
  }

  @RequirePermission('customer.group.manage')
  @Query(() => CustomerGroup, { description: 'Admin: one customer group' })
  customerGroup(@Args('id', { type: () => ID }) id: string) {
    return this.customerGroupsService.findOne(id);
  }

  @ResolveField(() => CustomerGroupMemberPage, {
    description: 'The members, by user id',
    middleware: [staffWith('customer.group.manage')],
  })
  members(@Parent() group: CustomerGroup, @Args() { first, after }: CustomerGroupMembersArgs) {
    return this.customerGroupsService.getMembers(group.id, first, after);
  }

  @RequirePermission('customer.group.manage')
  @Mutation(() => CustomerGroup, { description: 'Admin: create a customer group' })
  createCustomerGroup(@ActiveUser('id') actorId: string, @Args('input') input: CreateCustomerGroupInput) {
    return this.customerGroupsService.create(input, actorId);
  }

  @RequirePermission('customer.group.manage')
  @Mutation(() => CustomerGroup, { description: 'Admin: rename or describe a customer group' })
  updateCustomerGroup(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateCustomerGroupInput,
  ) {
    return this.customerGroupsService.update(id, input, actorId);
  }

  @RequirePermission('customer.group.manage')
  @Mutation(() => CustomerGroup, {
    description: 'Admin: delete a customer group and its memberships (not while a promotion is limited to it)',
  })
  deleteCustomerGroup(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.customerGroupsService.delete(id, actorId);
  }

  @RequirePermission('customer.group.manage')
  @Mutation(() => CustomerGroup, { description: 'Admin: add customers to a group (members already in it are kept)' })
  addCustomerGroupMembers(@ActiveUser('id') actorId: string, @Args('input') input: CustomerGroupMembersInput) {
    return this.customerGroupsService.addMembers(input.groupId, input.userIds, actorId);
  }

  @RequirePermission('customer.group.manage')
  @Mutation(() => CustomerGroup, { description: 'Admin: remove customers from a group' })
  removeCustomerGroupMembers(@ActiveUser('id') actorId: string, @Args('input') input: CustomerGroupMembersInput) {
    return this.customerGroupsService.removeMembers(input.groupId, input.userIds, actorId);
  }
}
