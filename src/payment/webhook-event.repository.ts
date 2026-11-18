import { Injectable } from '@nestjs/common';
import { PaymentProvider, Prisma, WebhookEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface IncomingWebhookEvent {
  provider: PaymentProvider;
  eventKey: string;
  event: string;
  reference: string | null;
  payload: Prisma.InputJsonValue;
}

const LAST_ERROR_MAX_LENGTH = 500;

/** The webhook inbox: every verified delivery is stored once per provider and event key before it is processed. */
@Injectable()
export class WebhookEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Stores a delivery, or returns the row already stored under its key when this is a redelivery. */
  async record(incoming: IncomingWebhookEvent): Promise<{ created: boolean; event: WebhookEvent }> {
    try {
      const event = await this.prisma.webhookEvent.create({ data: incoming });
      return { created: true, event };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const event = await this.prisma.webhookEvent.findUniqueOrThrow({
        where: { provider_eventKey: { provider: incoming.provider, eventKey: incoming.eventKey } },
      });
      return { created: false, event };
    }
  }

  async markProcessed(id: string, attempts: number): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id, processedAt: null },
      data: { processedAt: new Date(), attempts: { increment: attempts }, lastError: null },
    });
  }

  async recordFailure(id: string, attempts: number, error: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id, processedAt: null },
      data: { attempts: { increment: attempts }, lastError: error.slice(0, LAST_ERROR_MAX_LENGTH) },
    });
  }
}
