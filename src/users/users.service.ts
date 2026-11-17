import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateUserInput } from './dto/create-user.input';
import { UpdateUserInput } from './dto/update-user.input';
import { HashingService } from '../iam/hashing/hashing.service';
import { Prisma, Role, User } from '@prisma/client';
import { UserPaginateArgs } from './dto/user-paginate.args';
import { ChangeUserPasswordInput } from './dto/change-user-password.input';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly passwordService: HashingService,
  ) {}

  /**
   * Creates a new user account using email and password credentials.
   * Hashes the password before persisting the record.
   * @param createUserInput - Registration data including email, name, and plaintext password.
   * @returns The created user record.
   */
  async createUserByCredentials(createUserInput: CreateUserInput) {
    if (createUserInput.role === Role.SUPER_ADMIN) {
      throw new ForbiddenException('Super admin accounts cannot be created through the API');
    }
    const { password } = createUserInput;
    createUserInput.password = await this.passwordService.hash(password!);
    return this.usersRepository.create(createUserInput);
  }

  /**
   * Changes the password for a user after verifying the current password.
   * @param id - The ID of the user.
   * @param input - Object containing the old password and the desired new password.
   * @returns The updated user record.
   * @throws ForbiddenException if the old password is incorrect or the new password matches the old one.
   */
  async changePassword(id: string, input: ChangeUserPasswordInput): Promise<User> {
    const { oldPassword, newPassword } = input;
    const user = await this.findUserByIdOrThrow(id);
    const isOldPasswordValid = await this.passwordService.compare(oldPassword, user.password ?? '');
    if (!isOldPasswordValid) throw new ForbiddenException('Old password is incorrect');
    await this.compareNewPasswordToOld(newPassword, user.password ?? '');
    const hashedNewPassword = await this.passwordService.hash(newPassword);
    return this.usersRepository.updateAndRevokeSessions(id, { password: hashedNewPassword });
  }

  /**
   * Creates a user via an OAuth provider, or links the provider to an existing account if the email already exists.
   * @param providerId - The unique identifier assigned by the OAuth provider.
   * @param provider - The OAuth provider name (e.g., "google", "facebook").
   * @param email - Optional email address from the provider.
   * @param name - Optional display name from the provider.
   * @param profilePicture - Optional profile picture URL from the provider.
   * @returns The created or existing user record.
   */
  async createUserByAuthProvider(
    providerId: string,
    provider: string,
    email?: string,
    name?: string,
    profilePicture?: string,
  ) {
    if (email) {
      const existingUser = await this.findUserByEmail(email);
      if (existingUser) {
        await this.usersRepository.createAuthProvider(existingUser.id, providerId, provider);
        return existingUser;
      }
    }
    return this.usersRepository.createWithAuthProvider(email, name, profilePicture, providerId, provider);
  }

  /**
   * Returns a paginated, filtered list of users.
   * @param filter - Pagination and filter arguments including cursor, page size, role, and search fields.
   * @returns Paginated user connection with edges and pageInfo.
   */
  async findAll(filter: UserPaginateArgs) {
    const paginationOptions = this.buildPaginationOptions(filter);
    const whereClause = this.buildWhereClause(filter);

    const [users, totalCount] = await Promise.all([
      this.usersRepository.findMany({ ...paginationOptions, take: (paginationOptions.take ?? 10) + 1 }, whereClause),
      this.usersRepository.count(whereClause),
    ]);

    return this.formatPaginatedResponse(users, paginationOptions, totalCount);
  }

  private buildPaginationOptions({ first, after, orderBy, orderInAsc }: UserPaginateArgs) {
    this.validatePaginationOrderingCriteria(orderBy);
    const pageSize = first;
    const hasCursor = !!after;
    return {
      take: pageSize,
      skip: hasCursor ? 1 : 0,
      cursor: hasCursor ? { id: after! } : undefined,
      orderBy,
      orderInAsc,
    };
  }

  private validatePaginationOrderingCriteria(orderBy: string | undefined) {
    const validOrderByFields = [
      'id',
      'name',
      'email',
      'password',
      'phoneNumber',
      'role',
      'isActive',
      'createdAt',
      'updatedAt',
      'lastLoginAt',
      'profilePicture',
    ];
    if (orderBy) {
      if (!validOrderByFields.includes(orderBy)) {
        throw new Error(`Invalid orderBy field: ${orderBy}. Must be one of: ${validOrderByFields.join(', ')}`);
      }
    }
  }

  private buildWhereClause(filter: UserPaginateArgs): Prisma.UserWhereInput {
    const { email, phoneNumber, role, isActive, name, createdAfter } = filter;
    return {
      role: { not: Role.SUPER_ADMIN, ...(role && { equals: role }) },
      ...(email && { email: { contains: email, mode: 'insensitive' as const } }),
      ...(phoneNumber && { phoneNumber }),
      ...(isActive !== undefined && { isActive }),
      ...(name && { name: { contains: name, mode: 'insensitive' as const } }),
      ...(createdAfter && { createdAt: { gte: createdAfter } }),
    };
  }

  private formatPaginatedResponse(users: User[], { skip, take }: { take: number; skip: number }, totalCount: number) {
    const pageSize = take;
    const hasNextPage = users.length > pageSize;
    const items = hasNextPage ? users.slice(0, pageSize) : users;
    return {
      edges: items.map((user) => ({
        cursor: user.id,
        node: user,
      })),
      pageInfo: {
        pageSize,
        hasPreviousPage: skip > 0,
        hasNextPage,
        totalCount,
      },
    };
  }

  /**
   * Retrieves a user by their ID.
   * @param id - The ID of the user.
   * @returns The user record, or null if not found.
   */
  findOne(id: string) {
    return this.usersRepository.findById(id);
  }

  /**
   * Retrieves a user by their email address.
   * @param email - The email address to look up.
   * @returns The user record, or null if not found.
   */
  findUserByEmail(email: string) {
    return this.usersRepository.findByEmail(email);
  }

  /**
   * Retrieves a user linked to a specific OAuth provider ID.
   * @param providerId - The provider-assigned unique identifier.
   * @returns The user record, or null if not found.
   */
  findUserByProviderId(providerId: string) {
    return this.usersRepository.findByProviderId(providerId);
  }

  /**
   * Updates profile fields for an existing user.
   * @param id - The ID of the user to update.
   * @param updateUserInput - Partial user data to apply.
   * @returns The updated user record.
   */
  async update(id: string, updateUserInput: UpdateUserInput) {
    if (!updateUserInput.email) return this.usersRepository.update(id, updateUserInput);
    const user = await this.findUserByIdOrThrow(id);
    return this.applyProfileUpdate(user, updateUserInput);
  }

  async adminUpdateUser(id: string, updateUserInput: UpdateUserInput, actorRole: Role) {
    const user = await this.findUserByIdOrThrow(id);
    this.ensureActorMayManage(user, actorRole, 'updated');
    return this.applyProfileUpdate(user, updateUserInput);
  }

  private applyProfileUpdate(user: User, updateUserInput: UpdateUserInput) {
    const emailChanges = !!updateUserInput.email && updateUserInput.email !== user.email;
    return emailChanges
      ? this.usersRepository.updateAndRevokeSessions(user.id, updateUserInput)
      : this.usersRepository.update(user.id, updateUserInput);
  }

  private async compareNewPasswordToOld(newPassword: string, oldEncryptedPassword: string) {
    const result = await this.passwordService.compare(newPassword, oldEncryptedPassword);
    if (result) {
      throw new ForbiddenException('New password must be different from old password');
    }
  }

  /**
   * Permanently deletes a user by ID.
   * @param id - The ID of the user to delete.
   * @param actorRole - Role of the caller; only a SUPER_ADMIN may act on ADMIN accounts.
   * @returns The deleted user record.
   * @throws NotFoundException if the user does not exist.
   */
  async remove(id: string, actorRole: Role) {
    const user = await this.findUserByIdOrThrow(id);
    this.ensureActorMayManage(user, actorRole, 'deleted');
    return this.usersRepository.delete(id);
  }

  /**
   * Deactivates a user account by setting isActive to false.
   * @param id - The ID of the user to archive.
   * @param actorRole - Role of the caller; only a SUPER_ADMIN may act on ADMIN accounts.
   * @returns The updated user record.
   * @throws NotFoundException if the user does not exist.
   */
  async archiveUser(id: string, actorRole: Role) {
    const user = await this.findUserByIdOrThrow(id);
    this.ensureActorMayManage(user, actorRole, 'archived');
    return this.usersRepository.updateAndRevokeSessions(id, { isActive: false });
  }

  /**
   * Reactivates a previously archived user account by setting isActive to true.
   * @param id - The ID of the user to restore.
   * @param actorRole - Role of the caller; only a SUPER_ADMIN may act on ADMIN accounts.
   * @returns The updated user record.
   * @throws NotFoundException if the user does not exist.
   */
  async deArchiveUser(id: string, actorRole: Role) {
    const user = await this.findUserByIdOrThrow(id);
    this.ensureActorMayManage(user, actorRole, 'restored');
    return this.usersRepository.update(id, { isActive: true });
  }

  /**
   * Retrieves a user's full profile including related entities (addresses, orders, etc.).
   * @param id - The ID of the user.
   * @returns The user record with all loaded relations.
   */
  async getUserProfile(id: string) {
    return this.usersRepository.findWithRelations(id);
  }

  /**
   * Updates the lastLoginAt timestamp for a user to the current time.
   * @param id - The ID of the user.
   * @returns The updated user record.
   */
  async updateLastLogin(id: string) {
    return this.usersRepository.update(id, { lastLoginAt: new Date() });
  }

  /**
   * Increments failed login attempts for a user.
   * Locks the account for 15 minutes once the threshold of 5 is reached.
   */
  async recordFailedLoginAttempt(user: User): Promise<void> {
    const newAttempts = (user.failedLoginAttempts ?? 0) + 1;
    const LOCKOUT_THRESHOLD = 5;
    const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
    await this.usersRepository.update(user.id, {
      failedLoginAttempts: newAttempts,
      ...(newAttempts >= LOCKOUT_THRESHOLD && {
        lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS),
      }),
    });
  }

  /**
   * Resets failed login attempts and removes any active lockout for a user.
   */
  async resetFailedLoginAttempts(userId: string): Promise<void> {
    await this.usersRepository.update(userId, { failedLoginAttempts: 0, lockedUntil: null });
  }

  private async findUserByIdOrThrow(id: string) {
    const user = await this.usersRepository.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private ensureActorMayManage(target: User, actorRole: Role, action: string): void {
    if (target.role === Role.SUPER_ADMIN) {
      throw new ForbiddenException(`Super admin accounts cannot be ${action}`);
    }
    if (target.role === Role.ADMIN && actorRole !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(`Admin accounts can only be ${action} by a super admin`);
    }
  }
}
