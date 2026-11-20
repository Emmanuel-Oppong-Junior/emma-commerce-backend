import { Test, TestingModule } from '@nestjs/testing';
import { AddressesService } from './addresses.service';
import { AddressesRepository } from './addresses.repository';
import { NotFoundException } from '@nestjs/common';
import { Address } from '../generated/prisma/client';
import { UpdateAddressInput } from './dto/update-address.input';
import { GhanaRegion } from './enums/ghana-region.enum';

const mockAddressesRepository = {
  create: jest.fn(),
  findById: jest.fn(),
  findByUser: jest.fn(),
  findAll: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  countByUser: jest.fn(),
};

describe('AddressesService', () => {
  let service: AddressesService;
  let addressesRepository: jest.Mocked<AddressesRepository>;

  const mockUserId = 'user1';
  const fixedDate = new Date('2025-03-18T00:00:00.000Z');
  const mockAddress: Address = {
    id: 'addr1',
    recipientName: 'Ama Mensah',
    phone: '+233244123456',
    region: GhanaRegion.GREATER_ACCRA,
    street: '123 Main St',
    city: 'Accra',
    area: 'Osu',
    landmark: null,
    ghanaPostGps: 'GA-123-4567',
    latitude: null,
    longitude: null,
    zipCode: null,
    country: 'GH',
    userId: mockUserId,
    createdAt: fixedDate,
    updatedAt: fixedDate,
  };
  const mockAddressInput = {
    recipientName: 'Ama Mensah',
    phone: '+233244123456',
    region: GhanaRegion.GREATER_ACCRA,
    street: '123 Main St',
    city: 'Accra',
    country: 'GH',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AddressesService, { provide: AddressesRepository, useValue: mockAddressesRepository }],
    }).compile();

    service = module.get<AddressesService>(AddressesService);
    addressesRepository = module.get<AddressesRepository>(AddressesRepository) as jest.Mocked<AddressesRepository>;
    jest.resetAllMocks();
  });

  describe('createAddress', () => {
    it('should create an address successfully', async () => {
      mockAddressesRepository.countByUser.mockResolvedValue(0);
      mockAddressesRepository.create.mockResolvedValue(mockAddress);

      const result = await service.createAddress(mockUserId, mockAddressInput);

      expect(addressesRepository.countByUser).toHaveBeenCalledWith(mockUserId);
      expect(addressesRepository.create).toHaveBeenCalledWith({ ...mockAddressInput, userId: mockUserId });
      expect(result).toEqual(mockAddress);
    });

    it('stores country GH when the input leaves it out', async () => {
      mockAddressesRepository.countByUser.mockResolvedValue(0);
      mockAddressesRepository.create.mockResolvedValue(mockAddress);
      const withoutCountry = { ...mockAddressInput, country: undefined };

      await service.createAddress(mockUserId, withoutCountry);

      expect(addressesRepository.create).toHaveBeenCalledWith({ ...withoutCountry, country: 'GH', userId: mockUserId });
    });

    it('should throw BadRequestException when address limit is reached', async () => {
      mockAddressesRepository.countByUser.mockResolvedValue(10);

      await expect(service.createAddress(mockUserId, mockAddressInput)).rejects.toThrow(
        'You have reached the maximum of 10 saved addresses',
      );
    });
  });

  describe('getAddress', () => {
    it("should retrieve a user's address", async () => {
      mockAddressesRepository.findById.mockResolvedValue(mockAddress);

      const result = await service.getAddress(mockUserId, 'addr1');

      expect(addressesRepository.findById).toHaveBeenCalledWith('addr1');
      expect(result).toEqual(mockAddress);
    });

    it("should throw NotFoundException if address doesn't exist", async () => {
      mockAddressesRepository.findById.mockResolvedValue(null);

      await expect(service.getAddress(mockUserId, 'addr1')).rejects.toThrow(
        new NotFoundException(`Address "addr1" not found`),
      );
    });

    it('should throw NotFoundException if address belongs to another user', async () => {
      mockAddressesRepository.findById.mockResolvedValue({ ...mockAddress, userId: 'user2' });

      await expect(service.getAddress(mockUserId, 'addr1')).rejects.toThrow(
        new NotFoundException(`Address "addr1" not found`),
      );
    });
  });

  describe('getUserAddresses', () => {
    it('should retrieve all addresses for the user', async () => {
      mockAddressesRepository.findByUser.mockResolvedValue([mockAddress]);

      const result = await service.getUserAddresses(mockUserId);

      expect(addressesRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(result).toEqual([mockAddress]);
    });

    it('should return an empty array if no addresses exist', async () => {
      mockAddressesRepository.findByUser.mockResolvedValue([]);

      const result = await service.getUserAddresses(mockUserId);

      expect(result).toEqual([]);
    });
  });

  describe('getAllAddresses', () => {
    it('should retrieve all addresses when no userId is provided (SUPER_ADMIN)', async () => {
      mockAddressesRepository.findAll.mockResolvedValue([mockAddress]);

      const result = await service.getAllAddresses();

      expect(addressesRepository.findAll).toHaveBeenCalled();
      expect(result).toEqual([mockAddress]);
    });

    it('should retrieve only the specified user addresses when userId is provided (ADMIN)', async () => {
      mockAddressesRepository.findByUser.mockResolvedValue([mockAddress]);

      const result = await service.getAllAddresses(mockUserId);

      expect(addressesRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(addressesRepository.findAll).not.toHaveBeenCalled();
      expect(result).toEqual([mockAddress]);
    });
  });

  describe('updateAddress', () => {
    it('should update an address successfully', async () => {
      const updatedAddress = { ...mockAddress, street: '456 Elm St' };
      mockAddressesRepository.findById.mockResolvedValue(mockAddress);
      mockAddressesRepository.update.mockResolvedValue(updatedAddress);

      const result = await service.updateAddress(mockUserId, 'addr1', {
        street: '456 Elm St',
      } as UpdateAddressInput);

      expect(addressesRepository.findById).toHaveBeenCalledWith('addr1');
      expect(addressesRepository.update).toHaveBeenCalledWith('addr1', { street: '456 Elm St' });
      expect(result).toEqual(updatedAddress);
    });

    it("should throw NotFoundException if address doesn't exist", async () => {
      mockAddressesRepository.findById.mockResolvedValue(null);

      await expect(
        service.updateAddress(mockUserId, 'addr1', { street: '456 Elm St' } as UpdateAddressInput),
      ).rejects.toThrow(new NotFoundException(`Address "addr1" not found`));
    });
  });

  describe('deleteAddress', () => {
    it('should delete an address successfully', async () => {
      mockAddressesRepository.findById.mockResolvedValue(mockAddress);
      mockAddressesRepository.delete.mockResolvedValue(mockAddress);

      const result = await service.deleteAddress(mockUserId, 'addr1');

      expect(addressesRepository.findById).toHaveBeenCalledWith('addr1');
      expect(addressesRepository.delete).toHaveBeenCalledWith('addr1');
      expect(result).toEqual(mockAddress);
    });

    it("should throw NotFoundException if address doesn't exist", async () => {
      mockAddressesRepository.findById.mockResolvedValue(null);

      await expect(service.deleteAddress(mockUserId, 'addr1')).rejects.toThrow(
        new NotFoundException(`Address "addr1" not found`),
      );
    });
  });
});
