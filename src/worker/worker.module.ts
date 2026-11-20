import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform.module';
import { CommonsModule } from '../commons/commons.module';
import { OrderModule } from '../order/order.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentModule } from '../payment/payment.module';
import { OutboxRelay } from '../outbox/outbox.relay';
import { ExpiredOrdersTask } from '../order/tasks/expired-orders.task';
import { LowStockTask } from '../inventory/tasks/low-stock.task';
import { PaymentReconciliationTask } from '../payment/tasks/payment-reconciliation.task';
import { WorkerHealthServer } from './worker-health.server';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { MaintenanceProcessor } from './maintenance.processor';

/**
 * Root module of the `ROLE=worker` process: the outbox relay, the repeatable-job schedules and the queue processors.
 * It has no GraphQL or HTTP API (only the health endpoints). Processors are registered here and nowhere else, so the
 * API never consumes jobs.
 */
@Module({
  imports: [PlatformModule, CommonsModule, OrderModule, InventoryModule, PaymentModule],
  providers: [
    OutboxRelay,
    WorkerHealthServer,
    ExpiredOrdersTask,
    LowStockTask,
    PaymentReconciliationTask,
    MaintenanceScheduler,
    MaintenanceProcessor,
  ],
})
export class WorkerModule {}
