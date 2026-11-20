import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { Prisma } from '../generated/prisma/client';
import { VariantService } from './variant.service';
import { CreateVariantInput } from './dto/create-variant.input';
import { AUDIT_TX, createAuditServiceMock, withoutUndefined } from '../../test/helpers/audit.helper';

const at = new Date('2026-11-20T00:00:00.000Z');
const apparelAxes = [
  {
    id: 'attribute_apparel_size',
    productTypeId: 'product_type_apparel',
    key: 'size',
    label: 'Size',
    dataType: 'TEXT' as const,
    unit: null,
    isRequired: false,
    allowedValues: [],
    isVariantAxis: true,
    isFilterable: true,
    position: 0,
    createdAt: at,
    updatedAt: at,
  },
  {
    id: 'attribute_apparel_colour',
    productTypeId: 'product_type_apparel',
    key: 'colour',
    label: 'Colour',
    dataType: 'TEXT' as const,
    unit: null,
    isRequired: false,
    allowedValues: [],
    isVariantAxis: true,
    isFilterable: true,
    position: 1,
    createdAt: at,
    updatedAt: at,
  },
];
const shirt = {
  id: 'prod-shirt',
  name: 'Shirt',
  isTaxable: false,
  productType: { key: 'apparel', attributes: apparelAxes },
};
const existingVariant = {
  id: 'var-m-red',
  productId: 'prod-shirt',
  sku: 'SHIRT-M-RED',
  barcode: null,
  optionValues: { size: 'M', colour: 'Red' },
  optionsKey: 'colour=red|size=m',
  price: new Decimal('100.00'),
  basePrice: new Decimal('100.00'),
  isActive: true,
  discountId: null,
  product: { id: 'prod-shirt', name: 'Shirt' },
};

function input(overrides: Partial<CreateVariantInput> = {}): CreateVariantInput {
  return {
    productId: 'prod-shirt',
    optionValues: { size: 'L', colour: 'red' },
    basePrice: new Decimal('120.00'),
    quantity: 7,
    ...overrides,
  };
}

describe('VariantService', () => {
  let repository: Record<string, jest.Mock>;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let tax: { getTotalActiveRate: jest.Mock };
  let stockLedger: { receive: jest.Mock };
  let service: VariantService;

  beforeEach(() => {
    repository = {
      findProductForVariants: jest.fn().mockResolvedValue(shirt),
      findActiveWithOptions: jest.fn().mockResolvedValue(null),
      findBySkuOrBarcode: jest.fn().mockResolvedValue(null),
      discountExists: jest.fn().mockResolvedValue(true),
      create: jest.fn().mockImplementation(async (data) => ({ id: 'var-new', product: shirt, ...data })),
      findById: jest.fn().mockResolvedValue(existingVariant),
      findPage: jest.fn(),
      update: jest.fn().mockImplementation(async (id, data) => ({ ...existingVariant, id, ...withoutUndefined(data) })),
      countHistory: jest.fn().mockResolvedValue({ cartItems: 0, orderItems: 0, stockMovements: 0 }),
      countVariants: jest.fn().mockResolvedValue(2),
      delete: jest.fn().mockResolvedValue(existingVariant),
    };
    audit = createAuditServiceMock();
    tax = { getTotalActiveRate: jest.fn().mockResolvedValue(new Prisma.Decimal('0.2')) };
    stockLedger = { receive: jest.fn() };
    service = new VariantService(repository as never, audit as never, tax as never, stockLedger as never);
  });

  describe('createVariant', () => {
    it('stores validated, normalised option values with their canonical key and the base price as price', async () => {
      await service.createVariant(input({ optionValues: { size: ' L ', colour: 'Red' } }), 'admin-1');

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 'prod-shirt',
          optionValues: { size: 'L', colour: 'Red' },
          optionsKey: 'colour=red|size=l',
          basePrice: '120.00',
          price: '120.00',
        }),
        AUDIT_TX,
      );
      expect(tax.getTotalActiveRate).not.toHaveBeenCalled();
    });

    it('adds tax to the base price when the product is taxable (VAR-08)', async () => {
      repository.findProductForVariants.mockResolvedValue({ ...shirt, isTaxable: true });

      await service.createVariant(input({ basePrice: new Decimal('100.00') }), 'admin-1');

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ basePrice: '100.00', price: '120.00' }),
        AUDIT_TX,
      );
    });

    it('receives the opening stock as a RECEIPT in the same transaction (VAR-05)', async () => {
      await service.createVariant(input(), 'admin-1');

      expect(stockLedger.receive).toHaveBeenCalledWith(AUDIT_TX, 'var-new', 7, 'RECEIPT', {
        actorId: 'admin-1',
        note: 'Initial stock',
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'Variant', entityId: 'var-new', action: 'CREATE' }),
        AUDIT_TX,
      );
    });

    it('writes no stock movement for a variant created with no stock', async () => {
      await service.createVariant(input({ quantity: 0 }), 'admin-1');

      expect(stockLedger.receive).not.toHaveBeenCalled();
    });

    it("rejects option values the product type doesn't define", async () => {
      await expect(service.createVariant(input({ optionValues: { flavour: 'Mint' } }), 'admin-1')).rejects.toThrow(
        new BadRequestException(
          'Invalid option values for product type "apparel": flavour is not an attribute of this product type',
        ),
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('refuses an option combination an active variant already has', async () => {
      repository.findActiveWithOptions.mockResolvedValue(existingVariant);

      await expect(
        service.createVariant(input({ optionValues: { size: 'm', colour: 'RED' } }), 'admin-1'),
      ).rejects.toThrow(ConflictException);
      expect(repository.findActiveWithOptions).toHaveBeenCalledWith('prod-shirt', 'colour=red|size=m');
    });

    it('refuses a SKU or barcode another variant uses', async () => {
      repository.findBySkuOrBarcode.mockResolvedValue({ id: 'var-other', sku: 'SHIRT-L', barcode: null });

      await expect(service.createVariant(input({ sku: 'shirt-l' }), 'admin-1')).rejects.toThrow(
        new ConflictException('SKU "shirt-l" is already used by variant "var-other"'),
      );
    });

    it('rejects an unknown product or discount with NOT_FOUND', async () => {
      repository.discountExists.mockResolvedValue(false);
      await expect(service.createVariant(input({ discountId: 'nope' }), 'admin-1')).rejects.toThrow(
        new NotFoundException('Discount "nope" not found'),
      );

      repository.findProductForVariants.mockResolvedValue(null);
      await expect(service.createVariant(input(), 'admin-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('prepare', () => {
    it('refuses two new variants with the same combination', async () => {
      await expect(
        service.prepare(shirt, [input({ optionValues: { size: 'S' } }), input({ optionValues: { size: 's' } })]),
      ).rejects.toThrow(new BadRequestException('Two variants have the same options (size=s)'));
    });

    it('refuses a SKU repeated within the batch', async () => {
      await expect(
        service.prepare(shirt, [input({ optionValues: {}, sku: 'A-1' }), input({ sku: 'a-1' })]),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateVariant', () => {
    it('re-validates new option values and checks the new combination is free', async () => {
      await service.updateVariant(
        'var-m-red',
        { id: 'var-m-red', optionValues: { size: 'XL', colour: 'Red' } },
        'admin-1',
      );

      expect(repository.findActiveWithOptions).toHaveBeenCalledWith('prod-shirt', 'colour=red|size=xl', 'var-m-red');
      expect(repository.update).toHaveBeenCalledWith(
        'var-m-red',
        expect.objectContaining({ optionValues: { size: 'XL', colour: 'Red' }, optionsKey: 'colour=red|size=xl' }),
        AUDIT_TX,
      );
    });

    it('recomputes the selling price from a new base price', async () => {
      repository.findProductForVariants.mockResolvedValue({ ...shirt, isTaxable: true });

      await service.updateVariant('var-m-red', { id: 'var-m-red', basePrice: new Decimal('50') }, 'admin-1');

      expect(repository.update).toHaveBeenCalledWith(
        'var-m-red',
        expect.objectContaining({ basePrice: '50.00', price: '60.00' }),
        AUDIT_TX,
      );
    });

    it('refuses to reactivate an archived variant whose combination is taken again', async () => {
      repository.findById.mockResolvedValue({ ...existingVariant, isActive: false });
      repository.findActiveWithOptions.mockResolvedValue({ id: 'var-new-m-red' });

      await expect(service.updateVariant('var-m-red', { id: 'var-m-red', isActive: true }, 'admin-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('archives without a combination check and audits the change', async () => {
      await service.updateVariant('var-m-red', { id: 'var-m-red', isActive: false }, 'admin-1');

      expect(repository.findActiveWithOptions).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'UPDATE', details: { changes: { isActive: { from: true, to: false } } } }),
        AUDIT_TX,
      );
    });
  });

  describe('deleteVariant', () => {
    it.each([
      [{ cartItems: 0, orderItems: 2, stockMovements: 0 }, '2 order line(s)'],
      [{ cartItems: 1, orderItems: 0, stockMovements: 3 }, '1 cart line(s), 3 stock movement(s)'],
    ])('refuses with CONFLICT when history references it (VAR-07): %o', async (history, references) => {
      repository.countHistory.mockResolvedValue(history);

      await expect(service.deleteVariant('var-m-red', 'admin-1')).rejects.toThrow(
        new ConflictException(
          `Variant "var-m-red" is referenced by ${references}; archive it (isActive: false) instead of deleting it`,
        ),
      );
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it("refuses to delete a product's only variant", async () => {
      repository.countVariants.mockResolvedValue(1);

      await expect(service.deleteVariant('var-m-red', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('deletes an unreferenced variant, audited', async () => {
      await service.deleteVariant('var-m-red', 'admin-1');

      expect(repository.delete).toHaveBeenCalledWith('var-m-red', AUDIT_TX);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE' }), AUDIT_TX);
    });

    it('reports an unknown variant as NOT_FOUND', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.deleteVariant('nope', 'admin-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getVariants', () => {
    it('pages by id, one extra row telling whether another page follows', async () => {
      repository.findPage.mockResolvedValue([[{ id: 'a' }, { id: 'b' }, { id: 'c' }], 5]);

      const page = await service.getVariants({ first: 2, after: 'x' }, 'prod-shirt');

      expect(repository.findPage).toHaveBeenCalledWith(
        { productId: 'prod-shirt' },
        { take: 3, skip: 1, cursor: { id: 'x' } },
      );
      expect(page).toEqual({ nodes: [{ id: 'a' }, { id: 'b' }], totalCount: 5, hasNextPage: true });
    });
  });
});
