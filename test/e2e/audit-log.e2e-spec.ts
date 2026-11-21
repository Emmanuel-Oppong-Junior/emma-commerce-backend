import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { AuditService } from '../../src/commons/audit.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt } from '../helpers/db.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';
import { quoteHashFor } from '../helpers/checkout.helper';

describe('Audit log for privileged mutations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;
  let superAdminToken: string;
  let adminId: string;
  let superAdminId: string;
  const paystack = { createRefund: jest.fn(async () => ({ id: 'rf_audit', status: 'pending' })) };

  const run = async (query: string, token: string) => {
    const res = await gqlRequest(app, query, undefined, token).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data;
  };
  const auditRows = (entity: string, entityId: string) =>
    prisma.auditLog.findMany({ where: { entity, entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
    superAdminToken = await signInSuperAdmin(app);
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } })).id;
    superAdminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'super_admin@example.com' } })).id;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('records who created an account with which role, and who archived it, without secrets', async () => {
    const created = await run(
      `mutation { createUser(createUserInput: { name: "audit staff", email: "audit-staff@example.com",
        password: "Staff@12345", role: ADMIN, isActive: true }) { id } }`,
      superAdminToken,
    );
    const userId = created.createUser.id;
    await run(`mutation { archiveUser(id: "${userId}") { id } }`, superAdminToken);

    const rows = await auditRows('User', userId);

    expect(rows.map(({ action, userId: actor, details }) => ({ action, actor, details }))).toEqual([
      { action: 'CREATE', actor: superAdminId, details: { role: 'ADMIN', isActive: true } },
      {
        action: 'ARCHIVE',
        actor: superAdminId,
        details: { role: 'ADMIN', changes: { isActive: { from: true, to: false } } },
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Staff@12345|\$2[aby]\$|audit-staff@example\.com/);
  });

  it('records the approval and the refund of a return with the admin, amounts and provider reference', async () => {
    const address = await run(
      `mutation { createAddress(input: { street: "1 Audit St", city: "Accra", recipientName: "Test Customer", phone: "0244000000", region: GREATER_ACCRA,
        zipCode: "00233", country: "GH" }) { id } }`,
      userToken,
    );
    await run('mutation { addToCart(input: { variantId: "seed_var1", quantity: 1 }) { id } }', userToken);
    const order = await run(
      `mutation { createOrder(input: { quoteHash: "${await quoteHashFor(app, userToken, { fulfillmentType: 'DELIVERY', shippingAddressId: address.createAddress.id })}", fulfillmentType: DELIVERY, shippingAddressId: "${address.createAddress.id}",
        contactEmail: "user@example.com", contactPhone: "+233244000000" }) { id } }`,
      userToken,
    );
    const orderId = order.createOrder.id;
    await seedPaymentAttempt(prisma, { orderId, status: 'CAPTURED', reference: `ref-${orderId}` });
    await prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED' } });
    const request = await run(
      `mutation { createReturnRequest(input: { orderId: "${orderId}", reason: "Arrived damaged" }) { id } }`,
      userToken,
    );
    const returnId = request.createReturnRequest.id;

    await run(
      `mutation { approveReturn(input: { returnRequestId: "${returnId}", refundAmount: "40.00" }) { status } }`,
      adminToken,
    );
    await run(`mutation { processRefund(returnRequestId: "${returnId}") { status } }`, adminToken);

    const refund = await prisma.refund.findUniqueOrThrow({ where: { returnRequestId: returnId } });
    const rows = await auditRows('ReturnRequest', returnId);
    expect(rows.map(({ action, userId: actor, details }) => ({ action, actor, details }))).toEqual([
      {
        action: 'STATUS_CHANGE',
        actor: adminId,
        details: { orderId, from: 'PENDING', to: 'APPROVED', refundAmount: '40' },
      },
      {
        action: 'STATUS_CHANGE',
        actor: adminId,
        details: { orderId, from: 'APPROVED', to: 'REFUND_PENDING', refundId: refund.id, amount: '40' },
      },
      {
        action: 'REFUND',
        actor: adminId,
        details: {
          orderId,
          from: 'REFUND_PENDING',
          to: 'REFUNDED',
          amount: '40',
          providerReference: `ref-${orderId}`,
          providerRefundId: 'rf_audit',
        },
      },
    ]);
    expect((await auditRows('Refund', refund.id)).map(({ action, userId: actor }) => ({ action, actor }))).toEqual([
      { action: 'STATUS_CHANGE', actor: adminId },
      { action: 'REFUND', actor: adminId },
    ]);
  });

  it('rolls the change back when its audit row cannot be written', async () => {
    const created = await run(
      'mutation { createPromotion(input: { name: "Audit sale", scope: CART, type: PERCENT, value: "10" }) { id } }',
      adminToken,
    );
    const promotionId = created.createPromotion.id;
    jest.spyOn(app.get(AuditService), 'log').mockRejectedValueOnce(new Error('audit insert failed'));

    const res = await gqlRequest(
      app,
      `mutation { updatePromotion(id: "${promotionId}", input: { value: "50" }) { id } }`,
      undefined,
      adminToken,
    ).expect(200);

    expect(res.body.errors).toBeDefined();
    const promotion = await prisma.promotion.findUniqueOrThrow({ where: { id: promotionId } });
    expect(promotion.value.toFixed(2)).toBe('10.00');
    expect((await auditRows('Promotion', promotionId)).map((row) => row.action)).toEqual(['CREATE']);
  });
});
