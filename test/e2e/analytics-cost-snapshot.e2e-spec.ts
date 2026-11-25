import { INestApplication } from '@nestjs/common';
import { FulfillmentType, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { PaymentRepository } from '../../src/payment/payment.repository';
import { decideVerification } from '../../src/payment/payment-verification';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, setStock, verifyPhoneForCod } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';
import { shipmentOf } from '../helpers/shipment.helper';

const BUYER = 'seed_user';

// P8-A: the sale's unit cost is snapshotted on the order line when its stock is consumed, and never changes after.
describe('Order line cost snapshot (P8-A, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentRepository;
  let adminToken: string;
  let addressId: string;
  let variantSeq = 0;

  const newVariant = async (costPrice: string | null): Promise<string> => {
    variantSeq += 1;
    const id = `cost_var_${variantSeq}`;
    await prisma.product.create({
      data: {
        id: `cost_prod_${variantSeq}`,
        name: `Cost item ${variantSeq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        variants: { create: { id, sku: `COST-${variantSeq}`, price: 10, basePrice: 10, costPrice } },
      },
    });
    await setStock(prisma, id, 20);
    return id;
  };

  const placeOrder = async (variantId: string, quantity: number, paymentMethod: PaymentMethod) => {
    const cart = await prisma.cart.upsert({ where: { userId: BUYER }, create: { userId: BUYER }, update: {} });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: variantId.replace('var', 'prod'), variantId, quantity },
    });
    return placeOrderFromCart(orders, BUYER, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: addressId,
      contactEmail: 'buyer@example.com',
      contactPhone: '+233244000000',
      paymentMethod,
    });
  };

  const lineCost = async (orderId: string) => {
    const [line] = await prisma.orderItem.findMany({ where: { orderId } });
    return { unitCost: line.unitCost?.toFixed(4) ?? null, recorded: line.costRecordedAt !== null };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    payments = app.get(PaymentRepository);
    await resetDb(prisma);
    await seedMinimal(prisma);
    const address = await prisma.address.create({
      data: {
        userId: BUYER,
        street: '1 Cost St',
        city: 'Accra',
        recipientName: 'Buyer',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        country: 'GH',
      },
    });
    addressId = address.id;
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('records the cost when the online payment is captured, not at placement, and keeps it after a cost change', async () => {
    const variantId = await newVariant('4.2500');
    const order = await placeOrder(variantId, 2, PaymentMethod.ONLINE);
    const atPlacement = await lineCost(order.id);

    const amount = Number(order.grandTotal);
    const { paymentId, reference } = await seedPaymentAttempt(prisma, { orderId: order.id, status: 'PENDING', amount });
    const verified = { reference, status: 'success', amount: amount * 100, currency: 'GHS' };
    await payments.settleAttempt(paymentId, verified, {}, (state) => decideVerification(state, verified));
    const afterPayment = await lineCost(order.id);
    await prisma.variant.update({ where: { id: variantId }, data: { costPrice: '9.9900' } });

    expect(atPlacement).toEqual({ unitCost: null, recorded: false });
    expect(afterPayment).toEqual({ unitCost: '4.2500', recorded: true });
    expect(await lineCost(order.id)).toEqual(afterPayment);
  });

  it('records the cost of a cash-on-delivery order when it is dispatched, not when packed', async () => {
    const variantId = await newVariant('3.0000');
    await verifyPhoneForCod(prisma, BUYER);
    const order = await placeOrder(variantId, 1, PaymentMethod.CASH_ON_DELIVERY);
    const move = async (status: string) => {
      const res = await gqlRequest(
        app,
        `mutation { updateShipmentStatus(input: { shipmentId: "${await shipmentOf(prisma, order.id)}", status: ${status} }) { status } }`,
        undefined,
        adminToken,
      ).expect(200);
      expect(res.body.errors).toBeUndefined();
    };

    await move('PACKED');
    const packed = await lineCost(order.id);
    await move('OUT_FOR_DELIVERY');

    expect(packed).toEqual({ unitCost: null, recorded: false });
    expect(await lineCost(order.id)).toEqual({ unitCost: '3.0000', recorded: true });
  });

  it('records an unknown cost as null once the sale happened, so margins report the line apart', async () => {
    const variantId = await newVariant(null);
    const order = await placeOrder(variantId, 1, PaymentMethod.ONLINE);
    const amount = Number(order.grandTotal);
    const { paymentId, reference } = await seedPaymentAttempt(prisma, { orderId: order.id, status: 'PENDING', amount });
    const verified = { reference, status: 'success', amount: amount * 100, currency: 'GHS' };

    await payments.settleAttempt(paymentId, verified, {}, (state) => decideVerification(state, verified));
    await prisma.variant.update({ where: { id: variantId }, data: { costPrice: '2.0000' } });

    expect(await lineCost(order.id)).toEqual({ unitCost: null, recorded: true });
  });
});
