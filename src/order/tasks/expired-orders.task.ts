import { Injectable } from '@nestjs/common';
import { OrdersService, UNPAID_ORDER_EXPIRY_HOURS } from '../order.service';
import { LoggerService } from '../../commons/logger.service';

@Injectable()
export class ExpiredOrdersTask {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly logger: LoggerService,
  ) {}

  async cancelAbandonedOrders(): Promise<void> {
    this.logger.log(`Running expired orders cleanup | threshold: ${UNPAID_ORDER_EXPIRY_HOURS}h`, 'ExpiredOrdersTask');

    const cancelled = await this.ordersService.expireAbandonedOrders(UNPAID_ORDER_EXPIRY_HOURS);

    if (cancelled === null) {
      this.logger.log('Skipped: another instance is already expiring orders', 'ExpiredOrdersTask');
    } else if (cancelled > 0) {
      this.logger.warn(
        `Expired orders cancelled: ${cancelled} order(s) exceeded ${UNPAID_ORDER_EXPIRY_HOURS}h without payment`,
        'ExpiredOrdersTask',
      );
    } else {
      this.logger.log('No expired orders found', 'ExpiredOrdersTask');
    }
  }
}
