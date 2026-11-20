import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AttributeDefinition } from '../generated/prisma/client';
import { ProductTypesService } from './product-types.service';
import { ProductTypeWithAttributes } from './product-types.repository';
import { AttributeDataTypeEnum } from './enums/attribute-data-type.enum';
import { AUDIT_TX, createAuditServiceMock, withoutUndefined } from '../../test/helpers/audit.helper';

const at = new Date('2026-11-20T00:00:00.000Z');

function attribute(overrides: Partial<AttributeDefinition> = {}): AttributeDefinition {
  return {
    id: 'attr-storage',
    productTypeId: 'type-phone',
    key: 'storage',
    label: 'Storage',
    dataType: 'NUMBER',
    unit: 'GB',
    isRequired: false,
    allowedValues: ['64', '128'],
    isVariantAxis: true,
    isFilterable: true,
    position: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function productType(overrides: Partial<ProductTypeWithAttributes> = {}): ProductTypeWithAttributes {
  return {
    id: 'type-phone',
    key: 'phone',
    name: 'Phone',
    description: null,
    isSystem: false,
    createdAt: at,
    updatedAt: at,
    attributes: [attribute()],
    ...overrides,
  };
}

describe('ProductTypesService', () => {
  let repository: Record<string, jest.Mock>;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: ProductTypesService;

  beforeEach(() => {
    repository = {
      findAll: jest.fn(),
      findById: jest.fn().mockResolvedValue(productType()),
      findAttributeById: jest.fn().mockResolvedValue(attribute()),
      countProducts: jest.fn().mockResolvedValue(0),
      create: jest
        .fn()
        .mockImplementation(async (data) => productType({ id: 'type-new', key: data.key, attributes: [] })),
      update: jest.fn().mockImplementation(async (id, data) => productType({ id, ...withoutUndefined(data) })),
      delete: jest.fn().mockResolvedValue(productType()),
      createAttribute: jest.fn().mockImplementation(async (data) => attribute({ id: 'attr-new', ...data })),
      updateAttribute: jest.fn().mockImplementation(async (id, data) => attribute({ id, ...withoutUndefined(data) })),
      deleteAttribute: jest.fn().mockResolvedValue(attribute()),
    };
    audit = createAuditServiceMock();
    service = new ProductTypesService(repository as never, audit as never);
  });

  const phoneStorage = {
    key: 'storage',
    label: 'Storage',
    dataType: AttributeDataTypeEnum.NUMBER,
    unit: 'GB',
    isRequired: false,
    isVariantAxis: true,
    isFilterable: true,
    position: 0,
  };

  describe('create', () => {
    it('creates the type with its attributes and audits it in the same transaction', async () => {
      await service.create({ key: 'phone', name: 'Phone', attributes: [phoneStorage] }, 'admin-1');

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'phone',
          attributes: { create: [expect.objectContaining({ key: 'storage', unit: 'GB', allowedValues: [] })] },
        }),
        AUDIT_TX,
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'ProductType', entityId: 'type-new', action: 'CREATE', userId: 'admin-1' }),
        AUDIT_TX,
      );
    });

    it('rejects repeated attribute keys', async () => {
      await expect(
        service.create({ key: 'phone', name: 'Phone', attributes: [phoneStorage, phoneStorage] }, 'admin-1'),
      ).rejects.toThrow(new BadRequestException('Attribute keys must be unique; repeated: storage'));
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  it('rejects an incoherent definition before writing (attribute-validation checkAttributeRule)', async () => {
    await expect(
      service.create(
        {
          key: 'shoe',
          name: 'Shoe',
          attributes: [{ ...phoneStorage, key: 'colour', dataType: AttributeDataTypeEnum.TEXT }],
        },
        'admin-1',
      ),
    ).rejects.toThrow(
      new BadRequestException('Invalid attribute definition "colour": only NUMBER attributes have a unit'),
    );
    await expect(service.updateAttribute('attr-storage', { allowedValues: ['64', 'lots'] }, 'admin-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.updateAttribute).not.toHaveBeenCalled();
  });

  it('trims allowed values before storing them', async () => {
    await service.addAttribute('type-phone', { ...phoneStorage, key: 'ram', allowedValues: [' 4 ', '8'] }, 'admin-1');

    expect(repository.createAttribute).toHaveBeenCalledWith(
      expect.objectContaining({ allowedValues: ['4', '8'] }),
      AUDIT_TX,
    );
  });

  describe('system types', () => {
    beforeEach(() => repository.findById.mockResolvedValue(productType({ key: 'apparel', isSystem: true })));

    it.each([
      ['update', () => service.update('type-phone', { name: 'Clothes' }, 'admin-1')],
      ['delete', () => service.delete('type-phone', 'admin-1')],
      ['addAttribute', () => service.addAttribute('type-phone', phoneStorage, 'admin-1')],
      ['updateAttribute', () => service.updateAttribute('attr-storage', { label: 'Size' }, 'admin-1')],
      ['removeAttribute', () => service.removeAttribute('attr-storage', 'admin-1')],
    ])('refuses %s', async (_name, call) => {
      await expect(call()).rejects.toThrow(
        new ConflictException('Product type "apparel" is a system type and cannot be changed'),
      );
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  it('reports an unknown type as NOT_FOUND', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.findOne('nope')).rejects.toThrow(NotFoundException);
  });

  describe('a type that products use', () => {
    beforeEach(() => repository.countProducts.mockResolvedValue(3));

    it('cannot be deleted', async () => {
      await expect(service.delete('type-phone', 'admin-1')).rejects.toThrow(
        new ConflictException('Product type "type-phone" is used by 3 product(s) and cannot be deleted'),
      );
    });

    it('takes an optional attribute but not a required one', async () => {
      await service.addAttribute('type-phone', { ...phoneStorage, key: 'ram' }, 'admin-1');

      await expect(
        service.addAttribute('type-phone', { ...phoneStorage, key: 'ram', isRequired: true }, 'admin-1'),
      ).rejects.toThrow(ConflictException);
      expect(repository.createAttribute).toHaveBeenCalledTimes(1);
    });

    it('allows relabelling, reordering and adding allowed values', async () => {
      await service.updateAttribute(
        'attr-storage',
        { label: 'Capacity', position: 2, isFilterable: false, allowedValues: ['64', '128', '256'] },
        'admin-1',
      );

      expect(repository.updateAttribute).toHaveBeenCalled();
    });

    it.each([
      ['made required', { isRequired: true }],
      ['unit changed', { unit: 'TB' }],
      ['allowed values narrowed', { allowedValues: ['128'] }],
    ])('refuses an attribute change that could invalidate stored values (%s)', async (reason, input) => {
      await expect(service.updateAttribute('attr-storage', input, 'admin-1')).rejects.toThrow(
        new ConflictException(
          `Product type "type-phone" is used by 3 product(s) and cannot be changed this way (${reason})`,
        ),
      );
      expect(repository.updateAttribute).not.toHaveBeenCalled();
    });

    it('treats restricting an open attribute to a list as narrowing', async () => {
      repository.findAttributeById.mockResolvedValue(attribute({ allowedValues: [] }));

      await expect(service.updateAttribute('attr-storage', { allowedValues: ['64'] }, 'admin-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('cannot lose an attribute', async () => {
      await expect(service.removeAttribute('attr-storage', 'admin-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('audit trail', () => {
    it('records attribute changes as before/after pairs', async () => {
      await service.updateAttribute('attr-storage', { label: 'Capacity' }, 'admin-1');

      expect(audit.log).toHaveBeenCalledWith(
        {
          entity: 'AttributeDefinition',
          entityId: 'attr-storage',
          action: 'UPDATE',
          userId: 'admin-1',
          details: { changes: { label: { from: 'Storage', to: 'Capacity' } } },
        },
        AUDIT_TX,
      );
    });

    it('records removed attributes and deleted types with their last values', async () => {
      await service.removeAttribute('attr-storage', 'admin-1');
      await service.delete('type-phone', 'admin-1');

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'AttributeDefinition', action: 'DELETE', details: expect.anything() }),
        AUDIT_TX,
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'ProductType',
          action: 'DELETE',
          details: { before: { key: 'phone', name: 'Phone', description: null } },
        }),
        AUDIT_TX,
      );
    });

    it('records renames', async () => {
      await service.update('type-phone', { name: 'Smartphone' }, 'admin-1');

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ details: { changes: { name: { from: 'Phone', to: 'Smartphone' } } } }),
        AUDIT_TX,
      );
    });
  });
});
