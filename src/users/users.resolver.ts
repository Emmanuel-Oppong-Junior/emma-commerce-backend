import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { CreateUserInput } from './dto/create-user.input';
import { UpdateUserInput } from './dto/update-user.input';
import { UserConnection } from './entities/user-connection.entity';
import { UserPaginateArgs } from './dto/user-paginate.args';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { User as UserRecord } from '../generated/prisma/client';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { ChangeUserPasswordInput } from './dto/change-user-password.input';
import { AddressesLoader } from './loaders/addresses.loader';
import { OrdersLoader } from './loaders/orders.loader';
import { Address } from '../addresses/entities/address.entity';
import { Order } from '../order/entities/order.entity';
import { ownerOrAdmin } from '../iam/authorization/owner-or-admin.field-middleware';
import { ActiveAccess, RequirePermission } from '../iam/authorization/policy.decorators';
import { StaffAccess } from '../iam/authorization/staff-access';

const selfOrAdmin = ownerOrAdmin<User>((user) => user.id);

@Auth(AuthType.Bearer)
@Resolver(() => User)
export class UsersResolver {
  constructor(
    private readonly usersService: UsersService,
    private readonly addressesLoader: AddressesLoader,
    private readonly ordersLoader: OrdersLoader,
  ) {}

  @RequirePermission('staff.manage')
  @Mutation(() => User, {
    description: 'Create a new user with email and password',
  })
  createUser(
    @Args('createUserInput') createUserInput: CreateUserInput,
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
  ) {
    return this.usersService.adminCreateUser(createUserInput, { id: actorId, access });
  }

  @RequirePermission('user.view')
  @Query(() => UserConnection, {
    name: 'users',
    description: 'Fetch a paginated list of users',
  })
  async usersConnection(@Args('filter', { type: () => UserPaginateArgs }) filter: UserPaginateArgs) {
    return this.usersService.findAll(filter);
  }

  @RequirePermission('user.view')
  @Query(() => User, { name: 'userById', description: 'Fetch a user by ID' })
  findUserById(@Args('id', { type: () => String }) id: string) {
    return this.usersService.findOne(id);
  }

  @RequirePermission('user.view')
  @Query(() => User, {
    name: 'userByEmail',
    description: 'Fetch a user by email',
  })
  findUserByEmail(@Args('email', { type: () => String }) email: string) {
    return this.usersService.findUserByEmail(email);
  }
  @RequirePermission('user.view')
  @Query(() => User, {
    name: 'userByProviderId',
    description: 'Fetch a user by OAuth provider ID',
  })
  findUserByProviderId(@Args('providerId', { type: () => String }) providerId: string) {
    return this.usersService.findUserByProviderId(providerId);
  }

  @RequirePermission('user.manage')
  @Mutation(() => User, {
    description:
      'Update an existing user (user.manage). Staff accounts also need staff.manage and every permission they hold; Owner accounts only by an Owner.',
  })
  updateUser(
    @Args('id', { type: () => String }) id: string,
    @Args('updateUserInput') updateUserInput: UpdateUserInput,
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
  ) {
    return this.usersService.adminUpdateUser(id, updateUserInput, { id: actorId, access });
  }

  @Mutation(() => User, {
    description:
      'Update user profile. Changing the email requires currentPassword; the new address is stored as pendingEmail and only replaces the email (signing the user out everywhere) once verified with verifyEmail.',
  })
  updateMyProfile(
    @ActiveUser('id') id: string,
    @Args('updateMyProfileInput') updateMyProfileInput: UpdateUserInput,
    @Args('currentPassword', {
      type: () => String,
      nullable: true,
      description: 'Current password; required when changing the email',
    })
    currentPassword?: string,
  ) {
    return this.usersService.update(id, updateMyProfileInput, currentPassword ?? undefined);
  }

  @Mutation(() => User, {
    description: 'Change the password of the active user',
  })
  async changeUserPassword(
    @ActiveUser('id') id: string,
    @Args('input', { type: () => ChangeUserPasswordInput })
    input: ChangeUserPasswordInput,
  ) {
    return this.usersService.changePassword(id, input);
  }

  @RequirePermission('user.manage')
  @Mutation(() => User, { description: 'Delete a user permanently' })
  removeUser(
    @Args('id', { type: () => String }) id: string,
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
  ) {
    return this.usersService.remove(id, { id: actorId, access });
  }

  @RequirePermission('user.manage')
  @Mutation(() => User, { description: 'Archive (soft delete) a user' })
  archiveUser(
    @Args('id', { type: () => String }) id: string,
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
  ) {
    return this.usersService.archiveUser(id, { id: actorId, access });
  }

  @RequirePermission('user.manage')
  @Mutation(() => User, { description: 'Restore an archived user' })
  deArchiveUser(
    @Args('id', { type: () => String }) id: string,
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
  ) {
    return this.usersService.deArchiveUser(id, { id: actorId, access });
  }

  @Query(() => User, {
    name: 'userProfile',
    description: "Fetch a user's profile with related data",
  })
  userProfile(@ActiveUser('id') id: string) {
    return this.usersService.findOne(id);
  }

  @ResolveField(() => Boolean, { middleware: [selfOrAdmin] })
  emailVerified(@Parent() user: UserRecord) {
    return user.emailVerifiedAt !== null && user.emailVerifiedAt !== undefined;
  }

  @ResolveField(() => [Address], { nullable: true, middleware: [selfOrAdmin] })
  async addresses(@Parent() user: User) {
    return this.addressesLoader.loader.load(user.id);
  }

  @ResolveField(() => [Order], { nullable: true, middleware: [selfOrAdmin] })
  async orders(@Parent() user: User) {
    return this.ordersLoader.loader.load(user.id);
  }
}
