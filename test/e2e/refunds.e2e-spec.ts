import { GatewayTimeoutException, INestApplication } from '@nestjs/common';
import { OrderStatus, PaymentStatus, ReturnStatus } from '../../src/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient, PaystackRequestRejected } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, takeOrderNumber } from '../helpers/db.helper';
import { seedDeliveredOrder } from '../helpers/returns.helper';

interface GqlResult {
  data?: Record<string, { id?: string; status: string } | null> | null;
  errors?: { message: string; extensions: { code: string } }[];
}

describe('Refunds (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;
  let orderCount = 0;
  let providerRefundCount = 0;

  const paystack = {
    createRefund: jest.fn(),
    verifyTransaction: jest.fn(async (reference: string) => ({
      reference,
      status: 'success',
      amount: 10000,
      currency: 'GHS',
    })),
  };
  const acceptRefunds = (delayMs = 0) =>
    paystack.createRefund.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      providerRefundCount += 1;
      return { id: `rf_${providerRefundCount}`, status: 'pending' };
    });

  const gql = async (query: string, token = adminToken): Promise<GqlResult> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body;
  const processRefund = (returnRequestId: string) =>
    gql(`mutation { refundReturn(input: { returnRequestId: "${returnRequestId}" }) { id status } }`);
  const processPendingRefund = (refundId: string, token = adminToken) =>
    gql(`mutation { processPendingRefund(refundId: "${refundId}") { id status } }`, token);
  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions.code;

  const createOrder = async (status: OrderStatus = OrderStatus.COMPLETED): Promise<string> => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        grandTotal: 100,
        currency: 'GHS',
        pricingVersion: 0,
        status,
        contactEmail: 'user@example.com',
        contactPhone: `+23324430${String(orderCount).padStart(4, '0')}`,
      },
    });
    return order.id;
  };

  /** A delivered order paid GHS 100 through Paystack with a return request in the given state. */
  const paidReturn = async (
    status: ReturnStatus = ReturnStatus.APPROVED,
    refundAmount: Decimal.Value | null = 100,
  ): Promise<{ orderId: string; returnId: string; reference: string }> => {
    const orderId = await createOrder();
    const { reference } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.CAPTURED });
    const returnRequest = await prisma.returnRequest.create({
      data: { orderId, userId: 'seed_user', reason: 'Arrived damaged', status, refundAmount },
    });
    return { orderId, returnId: returnRequest.id, reference };
  };

  const refundsOf = (orderId: string) =>
    prisma.refund.findMany({ where: { attempt: { intent: { orderId } } }, orderBy: { createdAt: 'asc' } });
  const returnStatusOf = async (returnId: string) =>
    (await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } })).status;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    acceptRefunds();
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('sends one Paystack refund for two concurrent processRefund calls and records its provider id', async () => {
    const { orderId, returnId, reference } = await paidReturn();
    acceptRefunds(300);

    const results = await Promise.all([processRefund(returnId), processRefund(returnId)]);

    const succeeded = results.filter((r) => !r.errors);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].data?.refundReturn?.status).toBe('REFUNDED');
    expect(codeOf(results.find((r) => r.errors)!)).toBe('CONFLICT');
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    expect(paystack.createRefund).toHaveBeenCalledWith({ transaction: reference, amount: 10000 });
    const refunds = await refundsOf(orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      status: 'PROCESSED',
      returnRequestId: returnId,
      idempotencyKey: `return:${returnId}`,
      providerRef: expect.stringMatching(/^rf_\d+$/),
    });
    expect(await returnStatusOf(returnId)).toBe('REFUNDED');

    const again = await processRefund(returnId);
    expect(codeOf(again)).toBe('BAD_REQUEST');
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
  });

  it('marks a refund Paystack refused as FAILED, keeps the return REFUND_PENDING, and a retry succeeds once', async () => {
    const { orderId, returnId } = await paidReturn(ReturnStatus.APPROVED, '40.50');
    paystack.createRefund.mockRejectedValueOnce(
      new PaystackRequestRejected('Paystack refund failed with HTTP 400: Refund processor unavailable'),
    );

    const refused = await processRefund(returnId);

    expect(codeOf(refused)).toBe('BAD_REQUEST');
    expect(refused.errors?.[0].message).toMatch(/Nothing was refunded/);
    const [failed] = await refundsOf(orderId);
    expect(failed).toMatchObject({ status: 'FAILED', providerRef: null });
    expect(failed.failureReason).toMatch(/Refund processor unavailable/);
    expect(await returnStatusOf(returnId)).toBe('REFUND_PENDING');

    const retried = await processRefund(returnId);
    const retriedAgain = await processRefund(returnId);

    expect(retried.errors).toBeUndefined();
    expect(retried.data?.refundReturn?.status).toBe('REFUNDED');
    expect(codeOf(retriedAgain)).toBe('BAD_REQUEST');
    expect(paystack.createRefund).toHaveBeenCalledTimes(2);
    expect(paystack.createRefund).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 4050 }));
    const refunds = await refundsOf(orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ id: failed.id, status: 'PROCESSED', failureReason: null });
  });

  it('leaves a refund with an unknown outcome SENDING and refuses to send it again', async () => {
    const { orderId, returnId } = await paidReturn();
    paystack.createRefund.mockRejectedValueOnce(new GatewayTimeoutException('Paystack refund did not answer'));

    const timedOut = await processRefund(returnId);
    const retried = await processRefund(returnId);
    const [refund] = await refundsOf(orderId);
    const viaAdmin = await processPendingRefund(refund.id);

    expect(timedOut.errors).toBeDefined();
    expect(codeOf(retried)).toBe('CONFLICT');
    expect(codeOf(viaAdmin)).toBe('CONFLICT');
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    expect(refund).toMatchObject({ status: 'SENDING' });
    expect(refund.failureReason).toMatch(/^Outcome unknown/);
    expect(await returnStatusOf(returnId)).toBe('REFUND_PENDING');
  });

  it('rejects a refund above the captured amount without calling Paystack or claiming the return', async () => {
    const { orderId, returnId } = await paidReturn(ReturnStatus.APPROVED, '100.01');

    const result = await processRefund(returnId);

    expect(codeOf(result)).toBe('BAD_REQUEST');
    expect(result.errors?.[0].message).toMatch(/exceeds the 100\.00 GHS still refundable/);
    expect(paystack.createRefund).not.toHaveBeenCalled();
    expect(await refundsOf(orderId)).toHaveLength(0);
    expect(await returnStatusOf(returnId)).toBe('APPROVED');
  });

  it('sends a queued auto-refund once, and then caps a return refund on the same payment', async () => {
    const orderId = await createOrder(OrderStatus.PLACED);
    const { reference } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.PENDING });
    await gql(`mutation { cancelOrder(orderId: "${orderId}") { id } }`, userToken);
    await gql(`mutation { verifyPayment(verifyPaymentInput: { reference: "${reference}" }) { id } }`, userToken);
    const [autoRefund] = await refundsOf(orderId);
    expect(autoRefund).toMatchObject({ status: 'PENDING', returnRequestId: null });

    const [sent, repeated] = [await processPendingRefund(autoRefund.id), await processPendingRefund(autoRefund.id)];

    expect(sent.errors).toBeUndefined();
    expect(sent.data?.processPendingRefund?.status).toBe('PROCESSED');
    expect(codeOf(repeated)).toBe('CONFLICT');
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    expect(paystack.createRefund).toHaveBeenCalledWith({ transaction: reference, amount: 10000 });

    const systemReturn = await prisma.returnRequest.create({
      data: {
        orderId,
        userId: 'seed_user',
        reason: 'Order cancelled after payment',
        status: ReturnStatus.APPROVED,
        refundAmount: 50,
      },
    });
    const capped = await processRefund(systemReturn.id);

    expect(codeOf(capped)).toBe('BAD_REQUEST');
    expect(capped.errors?.[0].message).toMatch(/exceeds the 0\.00 GHS still refundable/);
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    expect(await refundsOf(orderId)).toHaveLength(1);
    expect(await returnStatusOf(systemReturn.id)).toBe('APPROVED');
    const audit = await prisma.auditLog.findMany({ where: { entity: 'Refund', entityId: autoRefund.id } });
    expect(audit.map((row) => row.action).sort()).toEqual(['REFUND', 'STATUS_CHANGE']);
  });

  it('lets only admins send pending refunds and list refunds', async () => {
    const asUser = await processPendingRefund('any-refund', userToken);
    const listed = await gql('query { refunds(status: PROCESSED) { id status providerRef } }');

    expect(codeOf(asUser)).toBe('FORBIDDEN');
    expect(listed.errors).toBeUndefined();
    expect((listed.data?.refunds as unknown as { status: string }[]).every((r) => r.status === 'PROCESSED')).toBe(true);
  });

  it('applies only one of a concurrent approve and reject', async () => {
    const { orderId, itemIds } = await seedDeliveredOrder(prisma, {
      lines: [{ productId: 'seed_prod1', variantId: 'seed_var1', quantity: 1, unitPrice: 100 }],
    });
    const { id: returnId } = await prisma.returnRequest.create({
      data: {
        orderId,
        userId: 'seed_user',
        status: ReturnStatus.REQUESTED,
        lines: { create: { orderItemId: itemIds[0], quantity: 1, reason: 'DAMAGED' } },
      },
    });

    const [approve, reject] = await Promise.all([
      gql(`mutation { approveReturn(input: { returnRequestId: "${returnId}" }) { status } }`),
      gql(`mutation { rejectReturn(input: { returnRequestId: "${returnId}", reason: "No" }) { status } }`),
    ]);

    const winners = [approve, reject].filter((r) => !r.errors);
    expect(winners).toHaveLength(1);
    expect(['CONFLICT', 'BAD_REQUEST']).toContain(codeOf([approve, reject].find((r) => r.errors)!));
    const final = await returnStatusOf(returnId);
    expect(final).toBe(approve.errors ? 'REJECTED' : 'APPROVED');
    const audit = await prisma.auditLog.findMany({ where: { entity: 'ReturnRequest', entityId: returnId } });
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ from: 'REQUESTED', to: final });
  });
});
