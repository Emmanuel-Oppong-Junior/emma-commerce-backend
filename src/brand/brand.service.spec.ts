import { Test, TestingModule } from '@nestjs/testing';
import { BrandService } from './brand.service';
import { BrandRepository } from './brand.repository';
import { CreateBrandInput } from './dto/create-brand.input';
import { UpdateBrandInput } from './dto/update-brand.input';
import { NotFoundException } from '@nestjs/common';
import { Brand } from '../generated/prisma/client';
import { SlugsService } from '../seo/slugs.service';

const mockSlugs = { assertAvailable: jest.fn() };

const mockBrandRepository = {
  create: jest.fn(),
  update: jest.fn(),
  findById: jest.fn(),
  findMany: jest.fn(),
  delete: jest.fn(),
};

describe('BrandService', () => {
  let brandService: BrandService;
  let brandRepository: jest.Mocked<BrandRepository>;

  const mockBrand: Brand = {
    id: 'brand1',
    name: 'Test Brand',
    description: 'Test Description',
    logo: 'test-logo.png',
    slug: 'test-brand',
    metaTitle: null,
    metaDescription: null,
    ogImageUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockCreateBrandInput: CreateBrandInput = {
    name: 'Test Brand',
    description: 'Test Description',
    logo: 'test-logo.png',
  };

  const mockUpdateBrandInput: UpdateBrandInput = {
    name: 'Updated Brand',
    description: 'Updated Description',
    logo: 'updated-logo.png',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrandService,
        { provide: BrandRepository, useValue: mockBrandRepository },
        { provide: SlugsService, useValue: mockSlugs },
      ],
    }).compile();

    brandService = module.get<BrandService>(BrandService);
    brandRepository = module.get<BrandRepository>(BrandRepository) as jest.Mocked<BrandRepository>;
    jest.clearAllMocks();
  });

  describe('createBrand', () => {
    it('should create a new brand and return it', async () => {
      mockBrandRepository.create.mockResolvedValue(mockBrand);

      const result = await brandService.createBrand(mockCreateBrandInput);

      expect(result).toEqual(mockBrand);
      expect(brandRepository.create).toHaveBeenCalledWith(mockCreateBrandInput);
    });
  });

  describe('updateBrand', () => {
    const id = 'brand1';

    it('should update an existing brand and return it', async () => {
      const updatedBrand = { ...mockBrand, ...mockUpdateBrandInput };
      mockBrandRepository.findById.mockResolvedValue(mockBrand);
      mockBrandRepository.update.mockResolvedValue(updatedBrand);

      const result = await brandService.updateBrand(id, mockUpdateBrandInput);

      expect(result).toEqual(updatedBrand);
      expect(brandRepository.findById).toHaveBeenCalledWith(id);
      expect(brandRepository.update).toHaveBeenCalledWith(id, mockUpdateBrandInput);
    });

    it('should throw NotFoundException if brand does not exist', async () => {
      mockBrandRepository.findById.mockResolvedValue(null);

      await expect(brandService.updateBrand(id, mockUpdateBrandInput)).rejects.toThrow(
        new NotFoundException(`Brand with ID ${id} not found`),
      );
      expect(brandRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('getBrandById', () => {
    it('should return a brand by ID', async () => {
      mockBrandRepository.findById.mockResolvedValue(mockBrand);

      const result = await brandService.getBrandById(mockBrand.id);

      expect(result).toEqual(mockBrand);
      expect(brandRepository.findById).toHaveBeenCalledWith(mockBrand.id);
    });

    it('should return null if brand does not exist', async () => {
      mockBrandRepository.findById.mockResolvedValue(null);

      const result = await brandService.getBrandById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getAllBrands', () => {
    it('should return a list of brands with default query options', async () => {
      const mockBrands = [mockBrand];
      mockBrandRepository.findMany.mockResolvedValue(mockBrands);

      const result = await brandService.getAllBrands();

      expect(result).toEqual(mockBrands);
      expect(brandRepository.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
    });

    it('should return a list of brands with requested fields', async () => {
      const mockBrands = [mockBrand];
      const requestedField = { name: true, description: true };
      mockBrandRepository.findMany.mockResolvedValue(mockBrands);

      const result = await brandService.getAllBrands(requestedField);

      expect(result).toEqual(mockBrands);
      expect(brandRepository.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        select: { ...requestedField, id: true },
      });
    });
  });

  describe('deleteBrand', () => {
    it('should delete a brand and return it', async () => {
      mockBrandRepository.findById.mockResolvedValue(mockBrand);
      mockBrandRepository.delete.mockResolvedValue(mockBrand);

      const result = await brandService.deleteBrand(mockBrand.id);

      expect(result).toEqual(mockBrand);
      expect(brandRepository.findById).toHaveBeenCalledWith(mockBrand.id);
      expect(brandRepository.delete).toHaveBeenCalledWith(mockBrand.id);
    });

    it('should throw NotFoundException if brand does not exist', async () => {
      mockBrandRepository.findById.mockResolvedValue(null);

      await expect(brandService.deleteBrand('nonexistent')).rejects.toThrow(
        new NotFoundException(`Brand with ID nonexistent not found`),
      );
      expect(brandRepository.delete).not.toHaveBeenCalled();
    });
  });
});
