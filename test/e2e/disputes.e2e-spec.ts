import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { createHmac } from 'crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as request from 'supertest';
import { PaymentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { clearQueues, createTestWorker } from '../helpers/worker.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, takeOrderNumber } from '../helpers/db.helper';

interface DisputeData {
  id: number;
  reference: string;
  status?: string;
  resolution?: string | null;
  dueAt?: string;
  updatedAt: string;
}

describe('Disputes and chargebacks (P3-E.2, e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let ownerToken: string;
  let managerToken: string;
  let customerToken: string;
  let orderCount = 0;

  const paystack = { createRefund: jest.fn(async () => ({ id: 'rf_1', status: 'pending' })) };

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  const errorOf = (res: { body: { errors?: { message: string; extensions: { code: string; reason?: string } }[] } }) =>
    res.body.errors?.[0] && { ...res.body.errors[0].extensions, message: res.body.errors[0].message };

  const sign = (raw: string) => createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex');
  const deliver = (raw: string) =>
    request(app.getHttpServer())
      .post('/payment/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sign(raw))
      .send(raw);
  const disputeBody = (event: string, data: DisputeData) =>
    JSON.stringify({
      event,
      data: {
        id: data.id,
        refund_amount: 10000,
        currency: 'GHS',
        status: data.status ?? 'awaiting-merchant-feedback',
        resolution: data.resolution ?? null,
        category: 'chargeback',
        transaction: { id: 4411, reference: data.reference, amount: 10000, currency: 'GHS', status: 'success' },
        customer: { email: 'buyer@example.com', phone: '+233244000000' },
        dueAt: data.dueAt ?? '2026-12-05T18:00:00.000Z',
        resolvedAt: null,
        createdAt: '2026-11-21T09:00:00.000Z',
        updatedAt: data.updatedAt,
      },
    });

  const capturedPayment = async () => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        grandTotal: 100,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: `+23324490${String(orderCount).padStart(4, '0')}`,
      },
    });
    const { paymentId, reference } = await seedPaymentAttempt(prisma, {
      orderId: order.id,
      status: PaymentStatus.CAPTURED,
    });
    return { orderId: order.id, paymentId, reference };
  };

  async function eventually<T>(read: () => Promise<T | null>, what: string): Promise<T> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  const disputeOf = (providerDisputeId: string) =>
    prisma.dispute.findFirst({
      where: { providerDisputeId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

  const DISPUTE = `{ id attemptId orderId provider providerDisputeId amount { amount currency } currency category reason
    status source evidenceDueAt openedAt resolvedAt createdById notes { authorId body } history { fromStatus toStatus source actorId note } }`;
  const recordDispute = (token: string, input: Record<string, unknown>) =>
    gql(`mutation ($input: RecordDisputeInput!) { recordDispute(input: $input) ${DISPUTE} }`, token, { input });
  const updateStatus = (token: string, input: Record<string, unknown>) =>
    gql(`mutation ($input: UpdateDisputeStatusInput!) { updateDisputeStatus(input: $input) ${DISPUTE} }`, token, {
      input,
    });
  const addNote = (token: string, input: Record<string, unknown>) =>
    gql(`mutation ($input: AddDisputeNoteInput!) { addDisputeNote(input: $input) ${DISPUTE} }`, token, { input });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await clearQueues(app);
    worker = await createTestWorker((builder) => builder.overrideProvider(PaystackClient).useValue(paystack));
    await resetDb(prisma);
    await seedMinimal(prisma);
    ownerToken = await signInSuperAdmin(app);
    managerToken = await signInAdmin(app);
    customerToken = await signInUser(app);
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await clearQueues(app);
    await worker.close();
    await resetDb(prisma);
    await app.close();
  });

  describe('Paystack dispute webhooks', () => {
    it('creates the dispute once from charge.dispute.create, stores no customer data and records the opened event', async () => {
      const { paymentId, orderId, reference } = await capturedPayment();
      const body = disputeBody('charge.dispute.create', { id: 9001, reference, updatedAt: '2026-11-21T09:00:00.000Z' });

      await deliver(body).expect(200);
      await deliver(body).expect(200);

      const dispute = await eventually(() => disputeOf('9001'), 'the dispute');
      expect(dispute).toMatchObject({
        attemptId: paymentId,
        orderId,
        provider: 'PAYSTACK',
        status: 'AWAITING_EVIDENCE',
        source: 'PROVIDER',
        currency: 'GHS',
        category: 'chargeback',
        evidenceDueAt: new Date('2026-12-05T18:00:00.000Z'),
      });
      expect(dispute.amount.toFixed(2)).toBe('100.00');
      expect(dispute.events).toEqual([
        expect.objectContaining({ fromStatus: null, toStatus: 'AWAITING_EVIDENCE', source: 'PROVIDER' }),
      ]);
      const stored = await prisma.webhookEvent.findMany({ where: { event: 'charge.dispute.create' } });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        reference,
        eventKey: 'charge.dispute.create:dispute:9001:2026-11-21T09:00:00.000Z',
      });
      expect(JSON.stringify(stored[0].payload)).not.toMatch(/buyer@example.com|\+233244000000/);
      await eventually(
        () => prisma.webhookEvent.findFirst({ where: { id: stored[0].id, processedAt: { not: null } } }),
        'the event processed',
      );
      expect(await prisma.dispute.count({ where: { providerDisputeId: '9001' } })).toBe(1);
      expect(
        await prisma.outboxEvent.findMany({ where: { type: 'payment.dispute_opened.v1', aggregateId: dispute.id } }),
      ).toHaveLength(1);
    });

    it('moves the dispute on remind (new due date) and resolve (WON), ignoring a reminder after the resolution', async () => {
      const { reference } = await capturedPayment();
      await deliver(
        disputeBody('charge.dispute.create', { id: 9002, reference, updatedAt: '2026-11-21T09:00:00.000Z' }),
      ).expect(200);
      await eventually(() => disputeOf('9002'), 'the dispute');

      await deliver(
        disputeBody('charge.dispute.remind', {
          id: 9002,
          reference,
          status: 'awaiting-bank-feedback',
          dueAt: '2026-12-08T18:00:00.000Z',
          updatedAt: '2026-11-25T09:00:00.000Z',
        }),
      ).expect(200);
      await eventually(
        async () => ((await disputeOf('9002'))?.status === 'UNDER_REVIEW' ? true : null),
        'UNDER_REVIEW',
      );
      expect((await disputeOf('9002'))?.evidenceDueAt).toEqual(new Date('2026-12-08T18:00:00.000Z'));

      await deliver(
        disputeBody('charge.dispute.resolve', {
          id: 9002,
          reference,
          status: 'resolved',
          resolution: 'declined',
          updatedAt: '2026-11-30T09:00:00.000Z',
        }),
      ).expect(200);
      const won = await eventually(
        async () => ((await disputeOf('9002'))?.status === 'WON' ? disputeOf('9002') : null),
        'WON',
      );
      expect(won?.resolvedAt).not.toBeNull();

      await deliver(
        disputeBody('charge.dispute.remind', { id: 9002, reference, updatedAt: '2026-12-01T09:00:00.000Z' }),
      ).expect(200);
      await eventually(
        () =>
          prisma.webhookEvent.findFirst({
            where: {
              eventKey: 'charge.dispute.remind:dispute:9002:2026-12-01T09:00:00.000Z',
              processedAt: { not: null },
            },
          }),
        'the late reminder processed',
      );
      const after = await disputeOf('9002');
      expect(after?.status).toBe('WON');
      expect(after?.events.map(({ fromStatus, toStatus }) => [fromStatus, toStatus])).toEqual([
        [null, 'AWAITING_EVIDENCE'],
        ['AWAITING_EVIDENCE', 'UNDER_REVIEW'],
        ['UNDER_REVIEW', 'WON'],
      ]);
    });

    it('refuses a signed dispute webhook without a transaction reference with 400, storing nothing', async () => {
      const raw = JSON.stringify({
        event: 'charge.dispute.create',
        data: { id: 9003, refund_amount: 100, currency: 'GHS' },
      });

      const res = await deliver(raw).expect(400);

      expect(res.body.message).toContain('no valid transaction reference');
      expect(await prisma.webhookEvent.count({ where: { eventKey: { contains: ':9003:' } } })).toBe(0);
    });
  });

  describe('staff', () => {
    it('lets a Manager record a dispute, add evidence notes and move it through the table, audited', async () => {
      const { paymentId } = await capturedPayment();

      const created = (
        await recordDispute(managerToken, {
          paymentId,
          amount: '40.00',
          category: 'fraud',
          reason: 'Card reported stolen',
        })
      ).body.data.recordDispute;
      expect(created).toMatchObject({
        attemptId: paymentId,
        provider: 'PAYSTACK',
        providerDisputeId: null,
        amount: { amount: '40.00', currency: 'GHS' },
        status: 'OPEN',
        source: 'STAFF',
        createdById: 'seed_admin',
        history: [{ fromStatus: null, toStatus: 'OPEN', source: 'STAFF', actorId: 'seed_admin', note: null }],
      });

      const noted = (await addNote(managerToken, { disputeId: created.id, body: 'Delivery photo and signature sent' }))
        .body.data.addDisputeNote;
      expect(noted.notes).toEqual([{ authorId: 'seed_admin', body: 'Delivery photo and signature sent' }]);

      const moved = (
        await updateStatus(managerToken, { disputeId: created.id, status: 'UNDER_REVIEW', note: 'Evidence submitted' })
      ).body.data.updateDisputeStatus;
      expect(moved.status).toBe('UNDER_REVIEW');
      expect(moved.history[1]).toEqual({
        fromStatus: 'OPEN',
        toStatus: 'UNDER_REVIEW',
        source: 'STAFF',
        actorId: 'seed_admin',
        note: 'Evidence submitted',
      });

      expect(errorOf(await updateStatus(managerToken, { disputeId: created.id, status: 'OPEN' }))?.code).toBe(
        'CONFLICT',
      );
      const audit = await prisma.auditLog.findMany({ where: { entity: 'Dispute', entityId: created.id } });
      expect(audit.map(({ action }) => action).sort()).toEqual(['CREATE', 'STATUS_CHANGE', 'UPDATE']);
      expect(
        await prisma.outboxEvent.count({ where: { type: 'payment.dispute_opened.v1', aggregateId: created.id } }),
      ).toBe(1);
    });

    it('refuses a dispute above the captured amount or on a payment that captured nothing', async () => {
      const { paymentId, orderId } = await capturedPayment();
      const { paymentId: pending } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.PENDING });

      expect(errorOf(await recordDispute(ownerToken, { paymentId, amount: '100.01' }))?.code).toBe('BAD_REQUEST');
      expect(errorOf(await recordDispute(ownerToken, { paymentId: pending, amount: '10.00' }))?.code).toBe('CONFLICT');
      expect(errorOf(await recordDispute(ownerToken, { paymentId: 'missing', amount: '10.00' }))?.code).toBe(
        'NOT_FOUND',
      );
    });

    it('refuses customers every dispute operation and lets payment.view staff read', async () => {
      const { paymentId } = await capturedPayment();
      const created = (await recordDispute(ownerToken, { paymentId, amount: '10.00' })).body.data.recordDispute;

      for (const operation of [
        `{ disputes ${DISPUTE} }`,
        `{ dispute(id: "${created.id}") ${DISPUTE} }`,
        `mutation { addDisputeNote(input: { disputeId: "${created.id}", body: "x" }) { id } }`,
        `mutation { updateDisputeStatus(input: { disputeId: "${created.id}", status: WON }) { id } }`,
        `mutation { recordDispute(input: { paymentId: "${paymentId}", amount: "1.00" }) { id } }`,
      ]) {
        expect(errorOf(await gql(operation, customerToken))?.code).toBe('FORBIDDEN');
      }
      const listed = (await gql(`{ disputes(paymentId: "${paymentId}") ${DISPUTE} }`, managerToken)).body.data.disputes;
      expect(listed.map(({ id }: { id: string }) => id)).toEqual([created.id]);
    });
  });

  describe('refunds', () => {
    it('refuses a refund while the payment has an open dispute (CONFLICT, PAYMENT_DISPUTED) and after a full chargeback', async () => {
      const { paymentId } = await capturedPayment();
      const refund = await prisma.refund.create({
        data: {
          attemptId: paymentId,
          amount: 30,
          currency: 'GHS',
          idempotencyKey: `manual:${paymentId}`,
          reason: 'OTHER',
        },
      });
      const dispute = (await recordDispute(managerToken, { paymentId, amount: '100.00' })).body.data.recordDispute;
      const send = () => gql(`mutation { processPendingRefund(refundId: "${refund.id}") { id status } }`, managerToken);

      expect(errorOf(await send())).toMatchObject({ code: 'CONFLICT', reason: 'PAYMENT_DISPUTED' });

      await updateStatus(managerToken, { disputeId: dispute.id, status: 'LOST' });
      expect(errorOf(await send())).toMatchObject({ code: 'CONFLICT', reason: 'PAYMENT_DISPUTED' });
      expect(paystack.createRefund).not.toHaveBeenCalled();
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('PENDING');
    });

    it('refuses refundOrder on a disputed payment before writing anything: no refund row, no refund audit entry', async () => {
      const { paymentId, orderId } = await capturedPayment();
      const dispute = (await recordDispute(managerToken, { paymentId, amount: '100.00' })).body.data.recordDispute;
      const refundAuditEntries = () => prisma.auditLog.count({ where: { entity: 'Refund' } });
      const auditsBefore = await refundAuditEntries();
      const refundOrder = (key: string) =>
        gql(`mutation ($input: RefundOrderInput!) { refundOrder(input: $input) { id status } }`, managerToken, {
          input: { orderId, amount: '30.00', reason: 'PRICE_ADJUSTMENT', idempotencyKey: key },
        });

      expect(errorOf(await refundOrder('disputed-open-0001'))).toMatchObject({
        code: 'CONFLICT',
        reason: 'PAYMENT_DISPUTED',
      });
      await updateStatus(managerToken, { disputeId: dispute.id, status: 'LOST' });
      expect(errorOf(await refundOrder('disputed-lost-0001'))).toMatchObject({
        code: 'CONFLICT',
        reason: 'PAYMENT_DISPUTED',
      });

      expect(await prisma.refund.count({ where: { attemptId: paymentId } })).toBe(0);
      expect(await refundAuditEntries()).toBe(auditsBefore);
      expect(paystack.createRefund).not.toHaveBeenCalled();
    });

    it('sends the refund once the dispute is WON', async () => {
      const { paymentId } = await capturedPayment();
      const refund = await prisma.refund.create({
        data: {
          attemptId: paymentId,
          amount: 30,
          currency: 'GHS',
          idempotencyKey: `manual:${paymentId}`,
          reason: 'OTHER',
        },
      });
      const dispute = (await recordDispute(managerToken, { paymentId, amount: '100.00' })).body.data.recordDispute;
      await updateStatus(managerToken, { disputeId: dispute.id, status: 'WON' });

      const sent = await gql(`mutation { processPendingRefund(refundId: "${refund.id}") { id status } }`, managerToken);

      expect(errorOf(sent)).toBeUndefined();
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    });
  });
});
