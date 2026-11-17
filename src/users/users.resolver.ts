import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { CreateUserInput } from './dto/create-user.input';
import { UpdateUserInput } from './dto/update-user.input';
import { UserConnection } from './entities/user-connection.entity';
import { UserPaginateArgs } from './dto/user-paginate.args';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role, User as UserRecord } from '@prisma/client';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { ChangeUserPasswordInput } from './dto/change-user-password.input';
import { AddressesLoader } from './loaders/addresses.loader';
import { OrdersLoader } from './loaders/orders.loader';
import { Address } from '../addresses/entities/address.entity';
import { Order } from '../order/entities/order.entity';
import { ownerOrAdmin } from '../iam/authorization/owner-or-admin.field-middleware';

const selfOrAdmin = ownerOrAdmin<User>((user) => user.id);

@Auth(AuthType.Bearer)
@Roles(Role.SUPER_ADMIN)
@Resolver(() => User)
export class UsersResolver {
  constructor(
    private readonly usersService: UsersService,
    private readonly addressesLoader: AddressesLoader,
    private readonly ordersLoader: OrdersLoader,
  ) {}

  @Mutation(() => User, {
    description: 'Create a new user with email and password',
  })
  createUser(@Args('createUserInput') createUserInput: CreateUserInput) {
    return this.usersService.createUserByCredentials(createUserInput);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => UserConnection, {
    name: 'users',
    description: 'Fetch a paginated list of users',
  })
  async usersConnection(@Args('filter', { type: () => UserPaginateArgs }) filter: UserPaginateArgs) {
    return this.usersService.findAll(filter);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => User, { name: 'userById', description: 'Fetch a user by ID' })
  findUserById(@Args('id', { type: () => String }) id: string) {
    return this.usersService.findOne(id);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => User, {
    name: 'userByEmail',
    description: 'Fetch a user by email',
  })
  findUserByEmail(@Args('email', { type: () => String }) email: string) {
    return this.usersService.findUserByEmail(email);
  }
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => User, {
    name: 'userByProviderId',
    description: 'Fetch a user by OAuth provider ID',
  })
  findUserByProviderId(@Args('providerId', { type: () => String }) providerId: string) {
    return this.usersService.findUserByProviderId(providerId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => User, {
    description:
      'Update an existing user (super admin accounts cannot be modified; admin accounts only by a super admin)',
  })
  updateUser(
    @Args('id', { type: () => String }) id: string,
    @Args('updateUserInput') updateUserInput: UpdateUserInput,
    @ActiveUser('role') actorRole: Role,
  ) {
    return this.usersService.adminUpdateUser(id, updateUserInput, actorRole);
  }

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
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

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
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

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => User, { description: 'Delete a user permanently' })
  removeUser(@Args('id', { type: () => String }) id: string, @ActiveUser('role') actorRole: Role) {
    return this.usersService.remove(id, actorRole);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => User, { description: 'Archive (soft delete) a user' })
  archiveUser(@Args('id', { type: () => String }) id: string, @ActiveUser('role') actorRole: Role) {
    return this.usersService.archiveUser(id, actorRole);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => User, { description: 'Restore an archived user' })
  deArchiveUser(@Args('id', { type: () => String }) id: string, @ActiveUser('role') actorRole: Role) {
    return this.usersService.deArchiveUser(id, actorRole);
  }

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
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
