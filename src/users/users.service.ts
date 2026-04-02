import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateUserInput } from './dto/create-user.input';
import { UpdateUserInput } from './dto/update-user.input';
import { HashingService } from '../iam/hashing/hashing.service';
import { Prisma, User } from '@prisma/client';
import { UserPaginateArgs } from './dto/user-paginate.args';
import { ChangeUserPasswordInput } from './dto/change-user-password.input';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly passwordService: HashingService,
  ) {}

  async createUserByCredentials(createUserInput: CreateUserInput) {
    const { password } = createUserInput;
    createUserInput.password = await this.passwordService.hash(password);
    return this.usersRepository.create(createUserInput);
  }

  async changePassword(id: string, input: ChangeUserPasswordInput): Promise<User> {
    const { oldPassword, newPassword } = input;
    const user = await this.findUserByIdOrThrow(id);
    const isOldPasswordValid = await this.passwordService.compare(oldPassword, user.password);
    if (!isOldPasswordValid) throw new ForbiddenException('Old password is incorrect');
    await this.compareNewPasswordToOld(newPassword, user.password);
    const hashedNewPassword = await this.passwordService.hash(newPassword);
    return this.usersRepository.update(id, { password: hashedNewPassword });
  }

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

  async findAll(filter: UserPaginateArgs) {
    const paginationOptions = this.buildPaginationOptions(filter);
    const whereClause = this.buildWhereClause(filter);

    const users = await this.usersRepository.findMany(paginationOptions, whereClause);
    const totalCount = await this.usersRepository.count(whereClause);
    return this.formatPaginatedResponse(users, totalCount, paginationOptions);
  }

  private buildPaginationOptions({ first, after, orderBy, orderInAsc }: UserPaginateArgs) {
    this.validatePaginationOrderingCriteria(orderBy);
    const pageSize = first;
    const hasCursor = !!after;
    return {
      take: pageSize,
      skip: hasCursor ? 1 : 0,
      cursor: hasCursor ? { id: after } : undefined,
      orderBy,
      orderInAsc,
    };
  }

  private validatePaginationOrderingCriteria(orderBy: string) {
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
      ...(email && {
        email: { contains: email, mode: 'insensitive' as const },
      }),
      ...(phoneNumber && { phoneNumber }),
      ...(role && { role }),
      ...(isActive !== undefined && { isActive }),
      ...(name && { name: { contains: name, mode: 'insensitive' as const } }),
      ...(createdAfter && { createdAt: { gte: createdAfter } }),
    };
  }

  private formatPaginatedResponse(users: User[], totalCount: number, { skip, take }: { take: number; skip: number }) {
    const lastUser = users[users.length - 1];
    const itemsFetched = skip + users.length;
    return {
      edges: users.map((user) => ({
        cursor: user.id,
        node: user,
      })),
      pageInfo: {
        pageSize: take,
        hasPreviousPage: skip > 0,
        hasNextPage: !!lastUser && totalCount > itemsFetched,
      },
    };
  }

  findOne(id: string) {
    return this.usersRepository.findById(id);
  }

  findUserByEmail(email: string) {
    return this.usersRepository.findByEmail(email);
  }

  findUserByProviderId(providerId: string) {
    return this.usersRepository.findByProviderId(providerId);
  }

  async update(id: string, updateUserInput: UpdateUserInput) {
    return this.usersRepository.update(id, updateUserInput);
  }

  private async compareNewPasswordToOld(newPassword: string, oldEncryptedPassword: string) {
    const result = await this.passwordService.compare(newPassword, oldEncryptedPassword);
    if (result) {
      throw new ForbiddenException('New password must be different from old password');
    }
  }

  async remove(id: string) {
    await this.findUserByIdOrThrow(id);
    return this.usersRepository.delete(id);
  }

  async archiveUser(id: string) {
    await this.findUserByIdOrThrow(id);
    return this.usersRepository.update(id, { isActive: false });
  }

  async deArchiveUser(id: string) {
    await this.findUserByIdOrThrow(id);
    return this.usersRepository.update(id, { isActive: true });
  }

  async getUserProfile(id: string) {
    return this.usersRepository.findWithRelations(id);
  }

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
}
