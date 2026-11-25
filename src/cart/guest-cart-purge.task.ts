import { Injectable } from '@nestjs/common';
import { LoggerService } from '../commons/logger.service';
import { CartRepository } from './cart.repository';

const CONTEXT = 'GuestCartPurgeTask';

/**
 * Repeatable job (daily): deletes guest carts (P6-G.1) idle past their expiry, with their lines, so abandoned guest
 * carts neither pile up nor keep variants from being deleted. Expired tokens are refused already; this only cleans up.
 * One statement, so overlapping runs need no lock.
 */
@Injectable()
export class GuestCartPurgeTask {
  constructor(
    private readonly carts: CartRepository,
    private readonly logger: LoggerService,
  ) {}

  async purge(now = new Date()): Promise<number> {
    const deleted = await this.carts.deleteExpiredGuests(now);
    this.logger.log(`Expired guest carts deleted | count: ${deleted}`, CONTEXT);
    return deleted;
  }
}
