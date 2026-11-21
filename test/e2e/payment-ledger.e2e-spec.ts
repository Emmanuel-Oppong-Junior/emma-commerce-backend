import { INestApplication } from '@nestjs/common';
import { PaymentProvider, PaymentStatus, Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, takeOrderNumber } from '../helpers/db.helper';

describe('Payment ledger schema (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orderCount = 0;

  const createOrder = async (): Promise<string> => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        grandTotal: 100,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: `+23324400${String(orderCount).padStart(4, '0')}`,
      },
    });
    return order.id;
  };

  // The pg driver adapter reports the trigger's restrict_violation (23001) as P2003 with a generic message; the
  // trigger's own text survives only in the driver error, which is what proves the trigger (not a foreign key) fired.
  const expectLedgerDeleteRejected = async (operation: Promise<unknown>) => {
    const error = await operation.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).meta).toMatchObject({
      driverAdapterError: {
        cause: { originalCode: '23001', originalMessage: expect.stringMatching(/financial records/) },
      },
    });
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('keeps every attempt of an order: a retry adds a second attempt under the same intent', async () => {
    const orderId = await createOrder();

    await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.FAILED, reference: `ref-a-${orderId}` });
    await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.PENDING, reference: `ref-b-${orderId}` });

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { orderId }, include: { attempts: true } });
    expect(intent.attempts.map((a) => a.status).sort()).toEqual([PaymentStatus.FAILED, PaymentStatus.PENDING]);
  });

  it('rejects a second attempt with the same provider reference', async () => {
    const first = await createOrder();
    const second = await createOrder();
    await seedPaymentAttempt(prisma, { orderId: first, status: PaymentStatus.PENDING, reference: 'shared-ref' });

    await expect(
      seedPaymentAttempt(prisma, { orderId: second, status: PaymentStatus.PENDING, reference: 'shared-ref' }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('stores a webhook event once per provider and event key', async () => {
    const event = {
      provider: PaymentProvider.PAYSTACK,
      eventKey: 'charge.success:ref-webhook',
      event: 'charge.success',
      reference: 'ref-webhook',
      payload: { event: 'charge.success' },
    };
    await prisma.webhookEvent.create({ data: event });

    await expect(prisma.webhookEvent.create({ data: event })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('records a refund once per idempotency key', async () => {
    const orderId = await createOrder();
    const { paymentId } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.CAPTURED });
    const refund = { attemptId: paymentId, amount: 40, idempotencyKey: `return-request:${orderId}` };
    await prisma.refund.create({ data: refund });

    await expect(prisma.refund.create({ data: refund })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses to delete an order that has payment history instead of cascading it away', async () => {
    const orderId = await createOrder();
    const { paymentId } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.CAPTURED });

    await expect(prisma.order.delete({ where: { id: orderId } })).rejects.toBeDefined();

    expect(await prisma.order.findUnique({ where: { id: orderId } })).not.toBeNull();
    expect(await prisma.paymentAttempt.findUnique({ where: { id: paymentId } })).not.toBeNull();
  });

  it('forbids hard-deleting ledger rows', async () => {
    const orderId = await createOrder();
    const { paymentId } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.CAPTURED });
    const refund = await prisma.refund.create({
      data: { attemptId: paymentId, amount: 10, idempotencyKey: `delete-test:${orderId}` },
    });
    const collection = await prisma.cashCollection.create({ data: { orderId, amount: 100 } });

    await expectLedgerDeleteRejected(prisma.refund.delete({ where: { id: refund.id } }));
    await expectLedgerDeleteRejected(prisma.cashCollection.delete({ where: { id: collection.id } }));
    await expectLedgerDeleteRejected(prisma.paymentAttempt.delete({ where: { id: paymentId } }));
    await expectLedgerDeleteRejected(prisma.paymentIntent.deleteMany({ where: { orderId } }));

    expect(await prisma.paymentAttempt.findUnique({ where: { id: paymentId } })).not.toBeNull();
  });

  it('no longer exposes the removePayment mutation', async () => {
    const adminToken = await signInAdmin(app);

    const res = await gqlRequest(app, `mutation { removePayment(id: "any") { id } }`, undefined, adminToken);

    expect(res.body.errors?.[0]?.message).toMatch(/Cannot query field "removePayment"/);
  });
});
