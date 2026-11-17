import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrdersService } from '../order.service';
import { LoggerService } from '../../commons/logger.service';

const ORDER_EXPIRY_HOURS = 1;

@Injectable()
export class ExpiredOrdersTask {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cancelAbandonedOrders(): Promise<void> {
    this.logger.log(`Running expired orders cleanup | threshold: ${ORDER_EXPIRY_HOURS}h`, 'ExpiredOrdersTask');

    const cancelled = await this.ordersService.expireAbandonedOrders(ORDER_EXPIRY_HOURS);

    if (cancelled === null) {
      this.logger.log('Skipped: another instance is already expiring orders', 'ExpiredOrdersTask');
    } else if (cancelled > 0) {
      this.logger.warn(
        `Expired orders cancelled: ${cancelled} order(s) exceeded ${ORDER_EXPIRY_HOURS}h without payment`,
        'ExpiredOrdersTask',
      );
    } else {
      this.logger.log('No expired orders found', 'ExpiredOrdersTask');
    }
  }
}
