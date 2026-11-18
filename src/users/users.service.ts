import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateUserInput } from './dto/create-user.input';
import { UpdateUserInput } from './dto/update-user.input';
import { HashingService } from '../iam/hashing/hashing.service';
import { Prisma, Role, User } from '../generated/prisma/client';
import { UserPaginateArgs } from './dto/user-paginate.args';
import { ChangeUserPasswordInput } from './dto/change-user-password.input';
import { UsersRepository } from './users.repository';
import { EmailVerificationService } from './email-verification.service';
import { AuditEntry, AuditService, fieldChanges } from '../commons/audit.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly passwordService: HashingService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates a new user account using email and password credentials.
   * Hashes the password before persisting the record.
   * @param createUserInput - Registration data including email, name, and plaintext password.
   * @returns The created user record.
   */
  async createUserByCredentials(createUserInput: CreateUserInput) {
    return this.usersRepository.create(await this.withHashedPassword(createUserInput));
  }

  /** Creates an account on behalf of an admin, recording who created it and with which role. */
  async adminCreateUser(createUserInput: CreateUserInput, actorId: string) {
    const data = await this.withHashedPassword(createUserInput);
    return this.auditService.record(
      (tx) => this.usersRepository.create(data, tx),
      (user) => ({
        entity: 'User',
        entityId: user.id,
        action: 'CREATE',
        userId: actorId,
        details: { role: user.role, isActive: user.isActive },
      }),
    );
  }

  private async withHashedPassword(createUserInput: CreateUserInput): Promise<CreateUserInput> {
    if (createUserInput.role === Role.SUPER_ADMIN) {
      throw new ForbiddenException('Super admin accounts cannot be created through the API');
    }
    const { password } = createUserInput;
    createUserInput.password = await this.passwordService.hash(password!);
    return createUserInput;
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
   * Creates a new user for a social identity that is not linked to any account yet.
   * Never attaches the identity to an existing account with the same email: local emails are not verified,
   * so anyone could have registered the address first and would then share the account with its owner.
   * @param providerId - The unique identifier assigned by the OAuth provider.
   * @param provider - The OAuth provider name (e.g., "Google", "Facebook").
   * @param email - The email address the provider vouches for.
   * @param emailVerified - Whether the provider asserts it verified that address; such accounts start verified.
   * @param name - Optional display name from the provider.
   * @param profilePicture - Optional profile picture URL from the provider.
   * @returns The created user record.
   * @throws ConflictException if an account with this email already exists.
   */
  async createUserByAuthProvider(
    providerId: string,
    provider: string,
    email: string,
    emailVerified: boolean,
    name?: string,
    profilePicture?: string,
  ) {
    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await this.findUserByEmail(normalizedEmail);
    if (existingUser) {
      throw new ConflictException(
        `An account with this email already exists. Sign in with your email and password, then link ${provider} from your account.`,
      );
    }
    return this.usersRepository.createWithAuthProvider(
      normalizedEmail,
      name,
      profilePicture,
      providerId,
      provider,
      emailVerified ? new Date() : null,
    );
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
   * Updates the signed-in user's own profile. A new email needs the current password and only takes effect once
   * the new address is verified; until then it is stored as `pendingEmail`.
   * @param id - The ID of the user to update.
   * @param updateUserInput - Partial user data to apply.
   * @param currentPassword - Required when the email changes.
   * @returns The updated user record.
   * @throws BadRequestException if the email changes without a current password, or the account has no password.
   * @throws ForbiddenException if the current password is wrong.
   * @throws ConflictException if another account already uses the new email.
   */
  async update(id: string, updateUserInput: UpdateUserInput, currentPassword?: string) {
    const { email, ...otherChanges } = updateUserInput;
    if (!email) return this.usersRepository.update(id, otherChanges);
    const user = await this.findUserByIdOrThrow(id);
    if (email === user.email) return this.usersRepository.update(id, otherChanges);
    await this.confirmPasswordForEmailChange(user, currentPassword);
    return this.emailVerificationService.requestEmailChange(user, email, otherChanges);
  }

  /**
   * Updates another user's profile as an admin. A new email goes through the same verification as a self-service
   * change (stored as `pendingEmail` until the new address is verified), without re-authentication.
   * @throws ForbiddenException if the actor may not manage the target account.
   * @throws ConflictException if another account already uses the new email.
   */
  async adminUpdateUser(id: string, updateUserInput: UpdateUserInput, actorRole: Role, actorId: string) {
    const user = await this.findUserByIdOrThrow(id);
    this.ensureActorMayManage(user, actorRole, 'updated');
    const { email, ...otherChanges } = updateUserInput;
    const newEmail = email && email !== user.email ? email : undefined;
    // Field names only: the values are personal data and stay out of the audit log.
    const fields = Object.entries({ ...otherChanges, email: newEmail })
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    return this.auditService.record(
      (tx) =>
        newEmail
          ? this.emailVerificationService.requestEmailChange(user, newEmail, otherChanges, tx)
          : this.usersRepository.update(user.id, otherChanges, tx),
      () => ({
        entity: 'User',
        entityId: user.id,
        action: 'UPDATE',
        userId: actorId,
        details: { fields, role: user.role, emailChangePending: !!newEmail },
      }),
    );
  }

  private async confirmPasswordForEmailChange(user: User, currentPassword: string | undefined) {
    if (!user.password) {
      throw new BadRequestException('Set a password (via forgotPassword) before changing your email');
    }
    if (!currentPassword) throw new BadRequestException('currentPassword is required to change your email');
    const isPasswordValid = await this.passwordService.compare(currentPassword, user.password);
    if (!isPasswordValid) throw new ForbiddenException('Current password is incorrect');
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
  async remove(id: string, actorRole: Role, actorId: string) {
    const user = await this.findUserByIdOrThrow(id);
    this.ensureActorMayManage(user, actorRole, 'deleted');
    return this.auditService.record(
      (tx) => this.usersRepository.delete(id, tx),
      () => ({
        entity: 'User',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: { role: user.role, isActive: user.isActive } },
      }),
    );
  }

  /**
   * Deactivates a user account by setting isActive to false.
   * @param id - The ID of the user to archive.
   * @param actorRole - Role of the caller; only a SUPER_ADMIN may act on ADMIN accounts.
   * @returns The updated user record.
   * @throws NotFoundException if the user does not exist.
   */
  async archiveUser(id: string, actorRole: Role, actorId: string) {
    const user = await this.findUserByIdOrThrow(id);
    this.ensureActorMayManage(user, actorRole, 'archived');
    return this.auditService.record(
      (tx) => this.usersRepository.updateAndRevokeSessions(id, { isActive: false }, tx),
      (archived) => this.activeFlagChange(user, archived, 'ARCHIVE', actorId),
    );
  }

  /**
   * Reactivates a previously archived user account by setting isActive to true.
   * @param id - The ID of the user to restore.
   * @param actorRole - Role of the caller; only a SUPER_ADMIN may act on ADMIN accounts.
   * @returns The updated user record.
   * @throws NotFoundException if the user does not exist.
   */
  async deArchiveUser(id: string, actorRole: Role, actorId: string) {
    const user = await this.findUserByIdOrThrow(id);
    this.ensureActorMayManage(user, actorRole, 'restored');
    return this.auditService.record(
      (tx) => this.usersRepository.update(id, { isActive: true }, tx),
      (restored) => this.activeFlagChange(user, restored, 'RESTORE', actorId),
    );
  }

  private activeFlagChange(before: User, after: User, action: 'ARCHIVE' | 'RESTORE', actorId: string): AuditEntry {
    return {
      entity: 'User',
      entityId: before.id,
      action,
      userId: actorId,
      details: { role: before.role, changes: fieldChanges(before, after, ['isActive']) },
    };
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
