import { Test, TestingModule } from '@nestjs/testing';
import { VariantService } from './variant.service';
import { VariantRepository } from './variant.repository';
import { NotFoundException } from '@nestjs/common';
import { CreateVariantInput } from './dto/create-variant.input';
import { AuditService } from '../commons/audit.service';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';

describe('VariantService', () => {
  let service: VariantService;
  let variantRepository: VariantRepository;

  const mockVariantRepository = {
    findProductById: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    findByProduct: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  const mockAuditService = createAuditServiceMock();

  const mockProductId = 'prod1';
  const fixedDate = new Date('2025-03-18T00:00:00.000Z');
  const mockVariant = {
    id: 'var1',
    size: 'M',
    color: 'Blue',
    quantity: 50,
    price: 29.99,
    productId: mockProductId,
    discountId: undefined,
  };
  const mockVariantWithProduct = {
    ...mockVariant,
    product: { id: mockProductId, name: 'T-Shirt' },
  };
  const mockCreateVariantInput: CreateVariantInput = {
    size: 'M',
    color: 'Blue',
    quantity: 50,
    price: 29.99,
    productId: mockProductId,
    discountId: undefined,
  };
  const mockUpdateVariantInput = {
    size: 'L',
    id: 'var1',
  };
  const mockProduct = {
    id: mockProductId,
    name: 'T-Shirt',
    price: 19.99,
    quantity: 100,
    isActive: true,
    categoryId: 'cat1',
    createdAt: fixedDate,
    updatedAt: fixedDate,
    images: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantService,
        { provide: VariantRepository, useValue: mockVariantRepository },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<VariantService>(VariantService);
    variantRepository = module.get<VariantRepository>(VariantRepository);
    jest.resetAllMocks();
    Object.assign(mockAuditService, createAuditServiceMock());
  });

  describe('createVariant', () => {
    it('should create a variant successfully', async () => {
      // Arrange
      mockVariantRepository.findProductById.mockResolvedValue(mockProduct);
      mockVariantRepository.create.mockResolvedValue(mockVariantWithProduct);

      // Act
      const result = await service.createVariant(mockCreateVariantInput, 'admin1');

      // Assert
      expect(variantRepository.findProductById).toHaveBeenCalledWith(mockProductId);
      expect(variantRepository.create).toHaveBeenCalledWith(mockCreateVariantInput, AUDIT_TX);
      expect(result).toEqual(mockVariantWithProduct);
    });

    it('should throw NotFoundException if product doesn\u2019t exist', async () => {
      // Arrange
      mockVariantRepository.findProductById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.createVariant(mockCreateVariantInput, 'admin1')).rejects.toThrow(
        new NotFoundException(`Product "${mockProductId}" not found`),
      );
      expect(variantRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('getVariant', () => {
    it('should retrieve a variant with its product', async () => {
      // Arrange
      mockVariantRepository.findById.mockResolvedValue(mockVariantWithProduct);

      // Act
      const result = await service.getVariant('var1');

      // Assert
      expect(variantRepository.findById).toHaveBeenCalledWith('var1');
      expect(result).toEqual(mockVariantWithProduct);
    });

    it('should throw NotFoundException if variant doesn\u2019t exist', async () => {
      // Arrange
      mockVariantRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.getVariant('var1')).rejects.toThrow(new NotFoundException(`Variant "var1" not found`));
    });
  });

  describe('getProductVariants', () => {
    it('should retrieve all variants for a product', async () => {
      // Arrange
      mockVariantRepository.findProductById.mockResolvedValue(mockProduct);
      mockVariantRepository.findByProduct.mockResolvedValue([mockVariantWithProduct]);

      // Act
      const result = await service.getProductVariants(mockProductId);

      // Assert
      expect(variantRepository.findProductById).toHaveBeenCalledWith(mockProductId);
      expect(variantRepository.findByProduct).toHaveBeenCalledWith(mockProductId);
      expect(result).toEqual([mockVariantWithProduct]);
    });

    it('should throw NotFoundException if product doesn\u2019t exist', async () => {
      // Arrange
      mockVariantRepository.findProductById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.getProductVariants(mockProductId)).rejects.toThrow(
        new NotFoundException(`Product "${mockProductId}" not found`),
      );
      expect(variantRepository.findByProduct).not.toHaveBeenCalled();
    });
  });

  describe('getAllVariants', () => {
    it('should retrieve all variants', async () => {
      // Arrange
      mockVariantRepository.findAll.mockResolvedValue([mockVariant]);

      // Act
      const result = await service.getAllVariants();

      // Assert
      expect(variantRepository.findAll).toHaveBeenCalled();
      expect(result).toEqual([mockVariant]);
    });

    it('should return an empty array if no variants exist', async () => {
      // Arrange
      mockVariantRepository.findAll.mockResolvedValue([]);

      // Act
      const result = await service.getAllVariants();

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('updateVariant', () => {
    it('should update a variant successfully', async () => {
      // Arrange
      const updatedVariant = { ...mockVariantWithProduct, size: 'L' };
      mockVariantRepository.findById.mockResolvedValue(mockVariantWithProduct);
      mockVariantRepository.update.mockResolvedValue(updatedVariant);

      // Act
      const result = await service.updateVariant('var1', mockUpdateVariantInput, 'admin1');

      // Assert
      expect(variantRepository.findById).toHaveBeenCalledWith('var1');
      expect(variantRepository.update).toHaveBeenCalledWith('var1', mockUpdateVariantInput, AUDIT_TX);
      expect(result).toEqual(updatedVariant);
    });

    it('should throw NotFoundException if variant doesn\u2019t exist', async () => {
      // Arrange
      mockVariantRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.updateVariant('var1', mockUpdateVariantInput, 'admin1')).rejects.toThrow(
        new NotFoundException(`Variant "var1" not found`),
      );
      expect(variantRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteVariant', () => {
    it('should delete a variant successfully', async () => {
      // Arrange
      mockVariantRepository.findById.mockResolvedValue(mockVariantWithProduct);
      mockVariantRepository.delete.mockResolvedValue(mockVariant);

      // Act
      const result = await service.deleteVariant('var1', 'admin1');

      // Assert
      expect(variantRepository.findById).toHaveBeenCalledWith('var1');
      expect(variantRepository.delete).toHaveBeenCalledWith('var1', AUDIT_TX);
      expect(result).toEqual(mockVariant);
    });

    it('should throw NotFoundException if variant doesn\u2019t exist', async () => {
      // Arrange
      mockVariantRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.deleteVariant('var1', 'admin1')).rejects.toThrow(
        new NotFoundException(`Variant "var1" not found`),
      );
      expect(variantRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('audit trail', () => {
    it.each<[string, () => Promise<unknown>, object]>([
      [
        'createVariant',
        () => service.createVariant(mockCreateVariantInput, 'admin1'),
        { action: 'CREATE', details: { after: { productId: 'prod1', size: 'M', color: 'Blue', price: 29.99 } } },
      ],
      [
        'updateVariant',
        () => service.updateVariant('var1', { id: 'var1', price: 35 }, 'admin1'),
        { action: 'UPDATE', details: { changes: { price: { from: 29.99, to: 35 } } } },
      ],
      [
        'deleteVariant',
        () => service.deleteVariant('var1', 'admin1'),
        { action: 'DELETE', details: { before: { productId: 'prod1', size: 'M', color: 'Blue', price: 29.99 } } },
      ],
    ])('%s writes an audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      mockVariantRepository.findProductById.mockResolvedValue(mockProduct);
      mockVariantRepository.findById.mockResolvedValue(mockVariantWithProduct);
      mockVariantRepository.create.mockResolvedValue(mockVariantWithProduct);
      mockVariantRepository.update.mockImplementation(async (_id, data) => ({ ...mockVariantWithProduct, ...data }));
      mockVariantRepository.delete.mockResolvedValue(mockVariant);

      await act();

      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        { entity: 'Variant', entityId: 'var1', userId: 'admin1', ...expected },
        AUDIT_TX,
      );
    });
  });
});
