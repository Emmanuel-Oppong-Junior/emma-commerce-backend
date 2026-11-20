import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { User } from '../entities/user.entity';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { ActiveAccess, RequirePermission } from '../../iam/authorization/policy.decorators';
import { effectivePermissions, StaffAccess } from '../../iam/authorization/staff-access';
import { ownerOrAdmin } from '../../iam/authorization/owner-or-admin.field-middleware';
import { StaffService, toStaffRoleEntity } from './staff.service';
import { StaffRolesLoader } from './staff-roles.loader';
import { StaffMemberEntity, StaffPermissionEntity, StaffRoleEntity } from './entities/staff-role.entity';
import { CreateStaffRoleInput, UpdateStaffRoleInput } from './dto/staff-role.input';

const selfOrAdmin = ownerOrAdmin<User>((user) => user.id);

@Resolver(() => StaffRoleEntity)
export class StaffResolver {
  constructor(private readonly staffService: StaffService) {}

  @RequirePermission('staff.view')
  @Query(() => [StaffPermissionEntity], { description: 'The permission catalogue (staff.view)' })
  staffPermissions() {
    return this.staffService.permissions();
  }

  @RequirePermission('staff.view')
  @Query(() => [StaffRoleEntity], { description: 'System and custom staff roles with their permissions (staff.view)' })
  staffRoles() {
    return this.staffService.roles();
  }

  @RequirePermission('staff.view')
  @Query(() => [StaffMemberEntity], { description: 'Every staff member and their role (staff.view)' })
  staffMembers() {
    return this.staffService.members();
  }

  @RequirePermission('staff.manage')
  @Mutation(() => StaffMemberEntity, {
    description:
      'Give a user a staff role, replacing their current one (staff.manage). You may only assign a role whose permissions you all hold; only an Owner assigns or changes an Owner; the last Owner cannot be demoted. Audited.',
  })
  assignStaffRole(
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
    @Args('userId', { type: () => ID }) userId: string,
    @Args('roleKey') roleKey: string,
  ) {
    return this.staffService.assignRole({ id: actorId, access }, userId, roleKey);
  }

  @RequirePermission('staff.manage')
  @Mutation(() => User, {
    description:
      "Take away a user's staff role so they become a customer (staff.manage). Only an Owner removes an Owner; the last Owner cannot be removed. Audited.",
  })
  removeStaffRole(
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
    @Args('userId', { type: () => ID }) userId: string,
  ) {
    return this.staffService.removeRole({ id: actorId, access }, userId);
  }

  @RequirePermission('staff.manage')
  @Mutation(() => StaffRoleEntity, {
    description: 'Create a custom staff role from permissions you hold (staff.manage). Audited.',
  })
  createStaffRole(
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
    @Args('input') input: CreateStaffRoleInput,
  ) {
    return this.staffService.createRole({ id: actorId, access }, input);
  }

  @RequirePermission('staff.manage')
  @Mutation(() => StaffRoleEntity, {
    description:
      'Change a custom staff role (staff.manage); system roles are immutable. Applies to its holders on their next request. Audited.',
  })
  updateStaffRole(
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
    @Args('key') key: string,
    @Args('input') input: UpdateStaffRoleInput,
  ) {
    return this.staffService.updateRole({ id: actorId, access }, key, input);
  }
}

@Resolver(() => User)
export class UserStaffFieldsResolver {
  constructor(private readonly staffRolesLoader: StaffRolesLoader) {}

  @ResolveField(() => StaffRoleEntity, {
    nullable: true,
    description: 'Staff role in the store; null for customers (the user themself or user.view)',
    middleware: [selfOrAdmin],
  })
  async staffRole(@Parent() user: User) {
    const role = await this.staffRolesLoader.loader.load(user.id);
    return role && toStaffRoleEntity(role);
  }

  @ResolveField(() => [String], {
    description: 'Effective permissions from the staff role; empty for customers (the user themself or user.view)',
    middleware: [selfOrAdmin],
  })
  async permissions(@Parent() user: User) {
    const role = await this.staffRolesLoader.loader.load(user.id);
    return role ? effectivePermissions(role) : [];
  }
}
