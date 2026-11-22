import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform.module';
import { CommonsModule } from '../commons/commons.module';
import { OrderModule } from '../order/order.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentModule } from '../payment/payment.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxRelay } from '../outbox/outbox.relay';
import { ExpiredOrdersTask } from '../order/tasks/expired-orders.task';
import { PaymentReconciliationTask } from '../payment/tasks/payment-reconciliation.task';
import { StockReconciliationTask } from '../inventory/tasks/stock-reconciliation.task';
import { LowStockDigestTask } from '../inventory/tasks/low-stock-digest.task';
import { WorkerHealthServer } from './worker-health.server';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { MaintenanceProcessor } from './maintenance.processor';
import { QueueMetrics } from './queue-metrics';
import { NotificationsProcessor } from '../notifications/notifications.processor';
import { PaymentWebhookProcessor } from '../payment/payment-webhook.processor';

/**
 * Root module of the `ROLE=worker` process: the outbox relay, the repeatable-job schedules and the queue processors.
 * It has no GraphQL or HTTP API (only the health endpoints). Processors are registered here and nowhere else, so the
 * API never consumes jobs.
 */
@Module({
  imports: [PlatformModule, CommonsModule, OrderModule, InventoryModule, PaymentModule, NotificationsModule],
  providers: [
    OutboxRelay,
    WorkerHealthServer,
    ExpiredOrdersTask,
    PaymentReconciliationTask,
    StockReconciliationTask,
    LowStockDigestTask,
    MaintenanceScheduler,
    MaintenanceProcessor,
    NotificationsProcessor,
    PaymentWebhookProcessor,
    QueueMetrics,
  ],
})
export class WorkerModule {}
