import { Test, TestingModule } from '@nestjs/testing';
import { TagService } from './tag.service';
import { TagRepository } from './tag.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Tag } from '@prisma/client';

const mockTagRepository = {
  findById: jest.fn(),
  findByName: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  connectProducts: jest.fn(),
  disconnectProducts: jest.fn(),
};

describe('TagService', () => {
  let service: TagService;
  let tagRepository: jest.Mocked<TagRepository>;

  const fixedDate = new Date('2025-03-18T00:00:00.000Z');
  const mockTag: Tag = {
    id: 'tag1',
    name: 'Summer',
    createdAt: fixedDate,
    updatedAt: fixedDate,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TagService, { provide: TagRepository, useValue: mockTagRepository }],
    }).compile();

    service = module.get<TagService>(TagService);
    tagRepository = module.get<TagRepository>(TagRepository) as jest.Mocked<TagRepository>;
    jest.resetAllMocks();
  });

  describe('createTag', () => {
    it('should create a tag successfully', async () => {
      mockTagRepository.findByName.mockResolvedValue(null);
      mockTagRepository.create.mockResolvedValue(mockTag);

      const result = await service.createTag('Summer');

      expect(tagRepository.findByName).toHaveBeenCalledWith('Summer');
      expect(tagRepository.create).toHaveBeenCalledWith('Summer');
      expect(result).toEqual(mockTag);
    });

    it('should throw BadRequestException if tag name already exists', async () => {
      mockTagRepository.findByName.mockResolvedValue(mockTag);

      await expect(service.createTag('Summer')).rejects.toThrow(
        new BadRequestException(`Tag name "Summer" is already in use`),
      );
      expect(tagRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('getTag', () => {
    it('should retrieve a tag by ID', async () => {
      mockTagRepository.findById.mockResolvedValue(mockTag);

      const result = await service.getTag('tag1');

      expect(tagRepository.findById).toHaveBeenCalledWith('tag1');
      expect(result).toEqual(mockTag);
    });

    it('should throw NotFoundException if tag does not exist', async () => {
      mockTagRepository.findById.mockResolvedValue(null);

      await expect(service.getTag('tag1')).rejects.toThrow(new NotFoundException(`Tag "tag1" not found`));
    });
  });

  describe('getAllTags', () => {
    it('should retrieve all tags', async () => {
      mockTagRepository.findAll.mockResolvedValue([mockTag]);

      const result = await service.getAllTags();

      expect(tagRepository.findAll).toHaveBeenCalled();
      expect(result).toEqual([mockTag]);
    });

    it('should return an empty array if no tags exist', async () => {
      mockTagRepository.findAll.mockResolvedValue([]);

      const result = await service.getAllTags();

      expect(result).toEqual([]);
    });
  });

  describe('updateTag', () => {
    it('should update a tag successfully', async () => {
      const updatedTag = { ...mockTag, name: 'Winter' };
      mockTagRepository.findById.mockResolvedValue(mockTag);
      mockTagRepository.findByName.mockResolvedValue(null);
      mockTagRepository.update.mockResolvedValue(updatedTag);

      const result = await service.updateTag('tag1', 'Winter');

      expect(tagRepository.update).toHaveBeenCalledWith('tag1', 'Winter');
      expect(result).toEqual(updatedTag);
    });

    it('should throw NotFoundException if tag does not exist', async () => {
      mockTagRepository.findById.mockResolvedValue(null);

      await expect(service.updateTag('tag1', 'Winter')).rejects.toThrow(new NotFoundException(`Tag "tag1" not found`));
      expect(tagRepository.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if new name is already in use', async () => {
      mockTagRepository.findById.mockResolvedValue(mockTag);
      mockTagRepository.findByName.mockResolvedValue({ id: 'tag2', name: 'Winter' });

      await expect(service.updateTag('tag1', 'Winter')).rejects.toThrow(
        new BadRequestException(`Tag name "Winter" is already in use`),
      );
      expect(tagRepository.update).not.toHaveBeenCalled();
    });

    it('should allow updating to the same name', async () => {
      const updatedTag = { ...mockTag, name: 'Summer' };
      mockTagRepository.findById.mockResolvedValue(mockTag);
      mockTagRepository.findByName.mockResolvedValue(mockTag); // same tag
      mockTagRepository.update.mockResolvedValue(updatedTag);

      const result = await service.updateTag('tag1', 'Summer');

      expect(tagRepository.update).toHaveBeenCalledWith('tag1', 'Summer');
      expect(result).toEqual(updatedTag);
    });
  });

  describe('deleteTag', () => {
    it('should delete a tag successfully', async () => {
      mockTagRepository.findById.mockResolvedValue(mockTag);
      mockTagRepository.delete.mockResolvedValue(mockTag);

      const result = await service.deleteTag('tag1');

      expect(tagRepository.delete).toHaveBeenCalledWith('tag1');
      expect(result).toEqual(mockTag);
    });

    it('should throw NotFoundException if tag does not exist', async () => {
      mockTagRepository.findById.mockResolvedValue(null);

      await expect(service.deleteTag('tag1')).rejects.toThrow(new NotFoundException(`Tag "tag1" not found`));
      expect(tagRepository.delete).not.toHaveBeenCalled();
    });
  });
});
