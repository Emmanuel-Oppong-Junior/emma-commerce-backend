import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';
import {
  PromotionsService,
  PROMOTION_CUSTOMER_LIMIT_REACHED,
  PROMOTION_LIMIT_REACHED,
  PROMOTION_UNITS_SOLD_OUT,
} from './promotions.service';
import { CreatePromotionInput } from './dto/promotion.input';

const CREATED = new Date('2026-11-01T00:00:00.000Z');

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: 'promo1',
  name: 'Shoe sale',
  description: null,
  scope: 'PRODUCT',
  type: 'PERCENT',
  value: new Decimal(20),
  minimumSpend: null,
  minimumQuantity: null,
  startsAt: CREATED,
  endsAt: null,
  isActive: true,
  priority: 0,
  stackingGroup: 'default',
  exclusive: false,
  requiresCoupon: false,
  usageLimit: null,
  usedCount: 0,
  perCustomerLimit: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  variants: [],
  products: [{ id: 'prod1' }],
  categories: [],
  brands: [],
  rewardVariants: [],
  rewardProducts: [],
  rewardCategories: [],
  rewardBrands: [],
  shippingZones: [],
  tiers: [],
  buyQuantity: null,
  getQuantity: null,
  maxApplications: null,
  tierValueType: null,
  unitCap: null,
  unitsUsed: 0,
  customerGroups: [],
  couponCodes: [],
  ...overrides,
});

const code = (overrides: Record<string, unknown> = {}) => ({
  id: 'code1',
  code: 'SAVE10',
  promotionId: 'promo1',
  isActive: true,
  usageLimit: null,
  usedCount: 0,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...overrides,
});

/** The scalar fields of a promotion write (the mock keeps the stored targets). */
const withoutTargetWrites = (write: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(write).filter(([key]) => !['variants', 'products', 'categories', 'brands'].includes(key)),
  );

const createInput = (overrides: Partial<CreatePromotionInput> = {}): CreatePromotionInput =>
  ({
    name: 'Shoe sale',
    scope: 'PRODUCT',
    type: 'PERCENT',
    value: new Decimal(20),
    targetIds: ['prod1'],
    isActive: true,
    priority: 0,
    stackingGroup: 'default',
    exclusive: false,
    requiresCoupon: false,
    startsAt: CREATED,
    ...overrides,
  }) as CreatePromotionInput;

describe('PromotionsService', () => {
  let repository: Record<string, jest.Mock>;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: PromotionsService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockImplementation(async (data) => stored(withoutTargetWrites(data))),
      update: jest.fn().mockImplementation(async (_id, data) => stored(withoutTargetWrites(data))),
      delete: jest.fn().mockResolvedValue(stored()),
      findById: jest.fn().mockResolvedValue(stored()),
      findAll: jest.fn().mockResolvedValue([stored()]),
      countRedemptions: jest.fn().mockResolvedValue(0),
      missingTargets: jest.fn().mockResolvedValue([]),
      findCandidates: jest.fn().mockResolvedValue([]),
      countReservedByPromotion: jest.fn().mockResolvedValue({}),
      findCustomerGroupIds: jest.fn().mockResolvedValue([]),
      hasPriorOrder: jest.fn().mockResolvedValue(false),
      missingCustomerGroups: jest.fn().mockResolvedValue([]),
      missingShippingZones: jest.fn().mockResolvedValue([]),
      findCouponCode: jest.fn().mockResolvedValue(code()),
      findCouponCodeById: jest.fn().mockResolvedValue(code()),
      createCouponCode: jest.fn().mockImplementation(async (data) => code(data)),
      updateCouponCode: jest
        .fn()
        .mockImplementation(async (_id, data) => code({ ...data, code: data.code ?? 'SAVE10' })),
      deleteCouponCode: jest.fn().mockResolvedValue(code()),
      takePromotionUse: jest.fn().mockResolvedValue({ perCustomerLimit: null }),
      takePromotionUnits: jest.fn().mockResolvedValue(true),
      takeCouponCodeUse: jest.fn().mockResolvedValue(true),
      countReserved: jest.fn().mockResolvedValue(0),
      createRedemption: jest.fn(),
      releaseOrder: jest.fn().mockResolvedValue(1),
    };
    audit = createAuditServiceMock();
    service = new PromotionsService(repository as never, audit as never);
  });

  describe('audit trail', () => {
    it.each<[string, () => Promise<unknown>, object]>([
      [
        'createPromotion',
        () => service.create(createInput(), 'admin1'),
        { entity: 'Promotion', entityId: 'promo1', action: 'CREATE' },
      ],
      [
        'updatePromotion',
        () => service.update('promo1', { value: new Decimal(25) }, 'admin1'),
        {
          entity: 'Promotion',
          entityId: 'promo1',
          action: 'UPDATE',
          details: { changes: { value: { from: '20', to: '25' } } },
        },
      ],
      [
        'deletePromotion',
        () => service.delete('promo1', 'admin1'),
        { entity: 'Promotion', entityId: 'promo1', action: 'DELETE' },
      ],
      [
        'createCouponCode',
        () => service.createCouponCode({ promotionId: 'promo1', code: 'save10', isActive: true }, 'admin1'),
        { entity: 'CouponCode', entityId: 'code1', action: 'CREATE' },
      ],
      [
        'updateCouponCode',
        () => service.updateCouponCode('code1', { isActive: false }, 'admin1'),
        {
          entity: 'CouponCode',
          entityId: 'code1',
          action: 'UPDATE',
          details: { changes: { isActive: { from: true, to: false } } },
        },
      ],
      [
        'deleteCouponCode',
        () => service.deleteCouponCode('code1', 'admin1'),
        { entity: 'CouponCode', entityId: 'code1', action: 'DELETE' },
      ],
    ])('%s writes one audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      await act();

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin1', ...expected }), AUDIT_TX);
    });
  });

  describe('create', () => {
    it("connects the targets of the promotion's scope only", async () => {
      await service.create(createInput({ targetIds: ['prod1', 'prod1', 'prod2'] }), 'admin1');

      expect(repository.missingTargets).toHaveBeenCalledWith('PRODUCT', ['prod1', 'prod2']);
      const [data] = repository.create.mock.calls[0];
      expect(data.products).toEqual({ connect: [{ id: 'prod1' }, { id: 'prod2' }] });
      expect(data).not.toHaveProperty('variants');
      expect(data).not.toHaveProperty('targetIds');
    });

    it.each([
      ['a percentage above 100', createInput({ value: new Decimal(101) }), 'at most 100'],
      ['a fixed price on the cart', createInput({ scope: 'CART', type: 'FIXED_PRICE', targetIds: [] }), 'FIXED_PRICE'],
      ['targets on a cart promotion', createInput({ scope: 'CART', type: 'AMOUNT_OFF' }), 'takes no targetIds'],
      ['an end before the start', createInput({ endsAt: new Date(CREATED.getTime() - 1) }), 'endsAt'],
    ])('refuses %s', async (_case, input, message) => {
      await expect(service.create(input, 'admin1')).rejects.toThrow(BadRequestException);
      await expect(service.create(input, 'admin1')).rejects.toThrow(message);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('refuses unknown targets', async () => {
      repository.missingTargets.mockResolvedValue(['nope']);

      await expect(service.create(createInput({ targetIds: ['nope'] }), 'admin1')).rejects.toThrow(
        'Unknown PRODUCT target ids: nope',
      );
    });
  });

  describe('update', () => {
    it('checks the value against the stored type (a percentage stays at most 100)', async () => {
      await expect(service.update('promo1', { value: new Decimal(150) }, 'admin1')).rejects.toThrow('at most 100');
    });

    it('checks a new end against the stored start', async () => {
      await expect(service.update('promo1', { endsAt: new Date(CREATED.getTime() - 1000) }, 'admin1')).rejects.toThrow(
        'endsAt must be after startsAt',
      );
    });

    it('refuses a scope change without new targets, and replaces every target when given', async () => {
      await expect(service.update('promo1', { scope: 'CATEGORY' }, 'admin1')).rejects.toThrow('Give targetIds');

      await service.update('promo1', { scope: 'CATEGORY', targetIds: ['cat1'] }, 'admin1');
      const [, data] = repository.update.mock.calls[0];
      expect(data).toMatchObject({
        scope: 'CATEGORY',
        categories: { set: [{ id: 'cat1' }] },
        products: { set: [] },
        variants: { set: [] },
        brands: { set: [] },
      });
    });

    it('clears the targets with an empty list and leaves them alone when omitted', async () => {
      await service.update('promo1', { targetIds: [] }, 'admin1');
      await service.update('promo1', { name: 'Renamed' }, 'admin1');

      expect(repository.update.mock.calls[0][1]).toMatchObject({ products: { set: [] } });
      expect(repository.update.mock.calls[1][1]).not.toHaveProperty('products');
    });

    it('refuses null for a required field and an empty update', async () => {
      await expect(service.update('promo1', { name: null } as never, 'admin1')).rejects.toThrow('name cannot be null');
      await expect(service.update('promo1', {}, 'admin1')).rejects.toThrow('At least one field');
    });
  });

  it('refuses to delete a promotion or code orders have used', async () => {
    repository.countRedemptions.mockResolvedValue(2);

    await expect(service.delete('promo1', 'admin1')).rejects.toThrow(ConflictException);
    await expect(service.deleteCouponCode('code1', 'admin1')).rejects.toThrow(ConflictException);
    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.deleteCouponCode).not.toHaveBeenCalled();
  });

  it('stores coupon codes upper case and reports a taken code as CONFLICT', async () => {
    await service.createCouponCode({ promotionId: 'promo1', code: 'welcome10', isActive: true }, 'admin1');
    expect(repository.createCouponCode).toHaveBeenCalledWith(expect.objectContaining({ code: 'WELCOME10' }), AUDIT_TX);

    const { Prisma } = jest.requireActual('../generated/prisma/client');
    repository.createCouponCode.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );
    await expect(
      service.createCouponCode({ promotionId: 'promo1', code: 'welcome10', isActive: true }, 'admin1'),
    ).rejects.toThrow(new ConflictException('Coupon code "WELCOME10" already exists'));
  });

  describe('validateCouponCode', () => {
    it('tells the customer what the code unlocks, without limits or stacking internals', async () => {
      repository.findById.mockResolvedValue(
        stored({ scope: 'CART', products: [], requiresCoupon: true, usageLimit: 100, usedCount: 3, priority: 7 }),
      );

      const result = await service.validateCouponCode('save10', 'user1');

      expect(repository.findCouponCode).toHaveBeenCalledWith('SAVE10', undefined);
      expect(result).toEqual({
        code: 'SAVE10',
        promotion: { id: 'promo1', name: 'Shoe sale', description: null, endsAt: null },
        scope: 'CART',
        type: 'PERCENT',
        value: new Decimal(20),
        minimumSpend: null,
        minimumQuantity: null,
      });
    });

    it('fails with NOT_FOUND for an unknown code and BAD_REQUEST with the reason otherwise', async () => {
      repository.findCouponCode.mockResolvedValueOnce(null);
      await expect(service.validateCouponCode('nope', 'user1')).rejects.toThrow(NotFoundException);

      repository.findById.mockResolvedValue(stored({ perCustomerLimit: 1 }));
      repository.countReservedByPromotion.mockResolvedValue({ promo1: 1 });
      await expect(service.validateCouponCode('save10', 'user1')).rejects.toThrow(
        new BadRequestException('You have already used this coupon'),
      );
    });
  });

  describe('findForPricing', () => {
    it("reads the candidates (the code's promotion among them) and the customer's redemptions on the given client", async () => {
      const tx = { id: 'tx' };
      const now = new Date();
      repository.findCandidates.mockResolvedValue([stored()]);
      repository.countReservedByPromotion.mockResolvedValue({ promo1: 2 });
      const targets = { variantIds: ['v1'], productIds: ['prod1'], categoryIds: [], brandIds: [] };

      const facts = await service.findForPricing(targets, 'user1', 'save10', now, tx as never);

      expect(repository.findCouponCode).toHaveBeenCalledWith('SAVE10', tx);
      expect(repository.findCandidates).toHaveBeenCalledWith(targets, now, ['promo1'], tx);
      expect(repository.countReservedByPromotion).toHaveBeenCalledWith('user1', ['promo1'], tx);
      expect(facts.promotions).toEqual([expect.objectContaining({ id: 'promo1', targetIds: ['prod1'] })]);
      expect(facts.couponCode).toEqual(expect.objectContaining({ id: 'code1', promotionId: 'promo1' }));
      expect(facts.customer).toEqual({ redemptions: { promo1: 2 }, groupIds: [], hasPriorOrder: false });
    });
  });

  describe('reserveRedemptions', () => {
    const tx = { id: 'tx' } as never;
    const order = { orderId: 'order1', customerId: 'user1' };

    it('takes a use of each promotion in id order, of the code for the promotion it unlocked, and records each', async () => {
      await service.reserveRedemptions(tx, order, ['p2', 'p1', 'p2'], { id: 'code1', promotionId: 'p2' }, {});

      expect(repository.takePromotionUse.mock.calls.map((call) => call[1])).toEqual(['p1', 'p2']);
      expect(repository.takeCouponCodeUse).toHaveBeenCalledTimes(1);
      expect(repository.takeCouponCodeUse).toHaveBeenCalledWith(tx, 'code1');
      expect(repository.createRedemption.mock.calls.map((call) => call[1])).toEqual([
        { promotionId: 'p1', couponCodeId: null, ...order, units: 0 },
        { promotionId: 'p2', couponCodeId: 'code1', ...order, units: 0 },
      ]);
    });

    it('fails with CONFLICT PROMOTION_LIMIT_REACHED when the promotion or the code has no use left', async () => {
      repository.takePromotionUse.mockResolvedValueOnce(undefined);
      const noPromotionUse = await service
        .reserveRedemptions(tx, order, ['p1'], undefined, {})
        .catch((error: unknown) => error);
      repository.takeCouponCodeUse.mockResolvedValueOnce(false);
      const noCodeUse = await service
        .reserveRedemptions(tx, order, ['p1'], { id: 'code1', promotionId: 'p1' }, {})
        .catch((error: unknown) => error);

      for (const error of [noPromotionUse, noCodeUse]) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          extensions: { reason: PROMOTION_LIMIT_REACHED },
        });
      }
      expect(repository.createRedemption).not.toHaveBeenCalled();
    });

    it('counts the units each promotion reduced and records them on its redemption', async () => {
      await service.reserveRedemptions(tx, order, ['flash', 'cart'], undefined, { flash: 3 });

      expect(repository.takePromotionUnits).toHaveBeenCalledTimes(1);
      expect(repository.takePromotionUnits).toHaveBeenCalledWith(tx, 'flash', 3);
      expect(repository.createRedemption.mock.calls.map((call) => call[1])).toEqual([
        { promotionId: 'cart', couponCodeId: null, ...order, units: 0 },
        { promotionId: 'flash', couponCodeId: null, ...order, units: 3 },
      ]);
    });

    it('fails with CONFLICT PROMOTION_UNITS_SOLD_OUT when fewer units are left than the order reduced', async () => {
      repository.takePromotionUnits.mockResolvedValueOnce(false);

      const error = await service
        .reserveRedemptions(tx, order, ['flash'], undefined, { flash: 2 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        extensions: { reason: PROMOTION_UNITS_SOLD_OUT },
      });
      expect(repository.createRedemption).not.toHaveBeenCalled();
    });

    it("fails with CONFLICT PROMOTION_CUSTOMER_LIMIT_REACHED when the customer's RESERVED uses reach the limit", async () => {
      repository.takePromotionUse.mockResolvedValue({ perCustomerLimit: 1 });
      repository.countReserved.mockResolvedValue(1);

      const error = await service
        .reserveRedemptions(tx, order, ['p1'], undefined, {})
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        extensions: { reason: PROMOTION_CUSTOMER_LIMIT_REACHED },
      });
      expect(repository.countReserved).toHaveBeenCalledWith(tx, 'p1', 'user1');
      expect(repository.createRedemption).not.toHaveBeenCalled();
    });
  });

  it('releases the order redemptions on the given transaction', async () => {
    await service.releaseRedemptions({ id: 'tx' } as never, 'order1');

    expect(repository.releaseOrder).toHaveBeenCalledWith({ id: 'tx' }, 'order1');
  });
});
