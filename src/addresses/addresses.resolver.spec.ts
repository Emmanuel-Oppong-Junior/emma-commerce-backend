import { Test, TestingModule } from '@nestjs/testing';
import { AddressesResolver } from './addresses.resolver';
import { AddressesService } from './addresses.service';
import { Address } from './entities/address.entity';
import { CreateAddressInput } from './dto/create-address.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { UpdateAddressInput } from './dto/update-address.input';
import { GhanaRegion } from './enums/ghana-region.enum';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '../users/enums/role.enum';

describe('AddressesResolver', () => {
  let resolver: AddressesResolver;
  let addressesService: AddressesService;

  const mockAddressesService = {
    getAddress: jest.fn(),
    getUserAddresses: jest.fn(),
    getAllAddresses: jest.fn(),
    createAddress: jest.fn(),
    updateAddress: jest.fn(),
    deleteAddress: jest.fn(),
  };

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

  const mockCreateAddressInput: CreateAddressInput = {
    recipientName: 'Ama Mensah',
    phone: '+233244123456',
    region: GhanaRegion.GREATER_ACCRA,
    street: '123 Main St',
    city: 'Accra',
    country: 'GH',
  };

  const mockUpdateAddressInput = {
    street: '456 Elm St',
  } as UpdateAddressInput;

  const mockActiveUser = (id: string) => ({ id });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AddressesResolver, { provide: AddressesService, useValue: mockAddressesService }],
    })
      .overrideProvider(ActiveUser)
      .useValue(mockActiveUser)
      .compile();

    resolver = module.get<AddressesResolver>(AddressesResolver);
    addressesService = module.get<AddressesService>(AddressesService);
    jest.resetAllMocks();
  });

  describe('getAddress', () => {
    it('should retrieve a specific address for the user', async () => {
      mockAddressesService.getAddress.mockResolvedValue(mockAddress);

      const result = await resolver.getAddress(mockUserId, 'addr1');

      expect(addressesService.getAddress).toHaveBeenCalledWith(mockUserId, 'addr1');
      expect(result).toEqual(mockAddress);
    });
  });

  describe('getUserAddresses', () => {
    it('should retrieve all addresses for the user', async () => {
      mockAddressesService.getUserAddresses.mockResolvedValue([mockAddress]);

      const result = await resolver.getUserAddresses(mockUserId);

      expect(addressesService.getUserAddresses).toHaveBeenCalledWith(mockUserId);
      expect(result).toEqual([mockAddress]);
    });
  });

  describe('getAllAddresses', () => {
    it('should retrieve all addresses for super admin when userId is omitted', async () => {
      mockAddressesService.getAllAddresses.mockResolvedValue([mockAddress]);

      const result = await resolver.getAllAddresses(Role.SUPER_ADMIN);

      expect(addressesService.getAllAddresses).toHaveBeenCalledWith(undefined);
      expect(result).toEqual([mockAddress]);
    });

    it('should reject an admin who omits userId', async () => {
      await expect(resolver.getAllAddresses(Role.ADMIN)).rejects.toThrow(ForbiddenException);
      expect(addressesService.getAllAddresses).not.toHaveBeenCalled();
    });
  });

  describe('createAddress', () => {
    it('should create an address for the user', async () => {
      mockAddressesService.createAddress.mockResolvedValue(mockAddress);

      const result = await resolver.createAddress(mockUserId, mockCreateAddressInput);

      expect(addressesService.createAddress).toHaveBeenCalledWith(mockUserId, mockCreateAddressInput);
      expect(result).toEqual(mockAddress);
    });
  });

  describe('updateAddress', () => {
    it('should update an address for the user', async () => {
      const updatedAddress = { ...mockAddress, street: '456 Elm St' };
      mockAddressesService.updateAddress.mockResolvedValue(updatedAddress);

      const result = await resolver.updateAddress(mockUserId, 'addr1', mockUpdateAddressInput);

      expect(addressesService.updateAddress).toHaveBeenCalledWith(mockUserId, 'addr1', mockUpdateAddressInput);
      expect(result).toEqual(updatedAddress);
    });
  });

  describe('deleteAddress', () => {
    it('should delete an address for the user', async () => {
      mockAddressesService.deleteAddress.mockResolvedValue(mockAddress);

      const result = await resolver.deleteAddress(mockUserId, 'addr1');

      expect(addressesService.deleteAddress).toHaveBeenCalledWith(mockUserId, 'addr1');
      expect(result).toEqual(mockAddress);
    });
  });

  describe('role-based access', () => {
    it('should allow USER role to access getAddress', async () => {
      mockAddressesService.getAddress.mockResolvedValue(mockAddress);

      const result = await resolver.getAddress(mockUserId, 'addr1');

      expect(addressesService.getAddress).toHaveBeenCalled();
      expect(result).toEqual(mockAddress);
    });

    it('should allow ADMIN role to access getAllAddresses for a given user', async () => {
      mockAddressesService.getAllAddresses.mockResolvedValue([mockAddress]);

      const result = await resolver.getAllAddresses(Role.ADMIN, 'user1');

      expect(addressesService.getAllAddresses).toHaveBeenCalledWith('user1');
      expect(result).toEqual([mockAddress]);
    });
  });
});
