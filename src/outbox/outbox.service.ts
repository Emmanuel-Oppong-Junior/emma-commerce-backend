import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { DomainEvent, DomainEventType } from './domain-events';
import { currentCorrelation } from '../commons/correlation';

/** Writes domain events to the transactional outbox (ADR-0009). */
@Injectable()
export class OutboxService {
  /**
   * Records `event` in the caller's transaction, so it exists exactly when the state change it describes commits.
   * There is deliberately no default client: an event written outside the business transaction defeats the outbox.
   * The running request's id is stored with it, so the job the relay publishes carries it.
   * @returns the event id, which is also the id of the job the relay publishes.
   */
  async record<T extends DomainEventType>(tx: Prisma.TransactionClient, event: DomainEvent<T>): Promise<string> {
    const { id } = await tx.outboxEvent.create({
      data: {
        type: event.type,
        aggregateId: event.aggregateId,
        payload: event.payload as unknown as Prisma.InputJsonValue,
        requestId: currentCorrelation()?.requestId,
      },
      select: { id: true },
    });
    return id;
  }
}
