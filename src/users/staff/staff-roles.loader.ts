import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { StaffRole } from '../../generated/prisma/client';
import { StaffRepository } from './staff.repository';

@Injectable({ scope: Scope.REQUEST })
export class StaffRolesLoader {
  constructor(private readonly staffRepository: StaffRepository) {}

  /** Batches staff role lookups by user ID (null for customers) when resolving User.staffRole on a list. */
  readonly loader = new DataLoader<string, StaffRole | null>(
    async (userIds: readonly string[]) => {
      const memberships = await this.staffRepository.findRolesOfUsers(userIds);
      const roleByUser = new Map(memberships.map((membership) => [membership.userId, membership.role]));
      return userIds.map((id) => roleByUser.get(id) ?? null);
    },
    { cache: false },
  );
}
