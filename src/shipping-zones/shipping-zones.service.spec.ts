import { BadRequestException, ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { ShippingZonesService } from './shipping-zones.service';
import { ShippingZonesRepository } from './shipping-zones.repository';
import { AddressesService } from '../addresses/addresses.service';

const fixedDate = new Date('2025-03-18T00:00:00.000Z');
const greaterAccra = {
  id: 'zone-accra',
  name: 'Greater Accra',
  cities: ['accra', 'tema'],
  fee: new Decimal('15'),
  isActive: true,
  createdAt: fixedDate,
  updatedAt: fixedDate,
};

describe('ShippingZonesService', () => {
  let repository: jest.Mocked<
    Pick<ShippingZonesRepository, 'create' | 'update' | 'findByCity' | 'findCoveringAnyCity' | 'findById'>
  >;
  let addressesService: jest.Mocked<Pick<AddressesService, 'getAddress'>>;
  let service: ShippingZonesService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockImplementation(async (data) => ({ ...greaterAccra, ...data })),
      update: jest.fn().mockImplementation(async (id, data) => ({ ...greaterAccra, id, ...data })),
      findByCity: jest.fn(),
      findCoveringAnyCity: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
    };
    addressesService = { getAddress: jest.fn() };
    service = new ShippingZonesService(repository as never, addressesService as never);
  });

  describe('getFeeForCity', () => {
    it('returns the fee of the zone covering the city', async () => {
      repository.findByCity.mockResolvedValue(greaterAccra);

      await expect(service.getFeeForCity('Accra')).resolves.toEqual(new Decimal('15'));
    });

    it('looks the city up case-insensitively, ignoring surrounding and repeated spaces', async () => {
      repository.findByCity.mockResolvedValue(greaterAccra);

      await service.getFeeForCity('  ACCRA   Central ');

      expect(repository.findByCity).toHaveBeenCalledWith('accra central');
    });

    it('rejects a city no active zone covers instead of charging nothing', async () => {
      repository.findByCity.mockResolvedValue(null);

      await expect(service.getFeeForCity('Tamale')).rejects.toThrow(
        new BadRequestException('Delivery is not available to city "Tamale": no active shipping zone covers it'),
      );
    });
  });

  describe('getFeeForAddress', () => {
    it('rejects a saved address whose city no zone covers', async () => {
      addressesService.getAddress.mockResolvedValue({ id: 'addr1', city: 'Tamale' } as never);
      repository.findByCity.mockResolvedValue(null);

      await expect(service.getFeeForAddress('addr1', 'user1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('create', () => {
    it('stores normalised, de-duplicated cities', async () => {
      await service.create({ name: 'Greater Accra', cities: [' Accra ', 'accra', 'East  Legon'], fee: 15 });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ cities: ['accra', 'east legon'] }));
    });

    it('rejects a city that another zone already covers', async () => {
      repository.findCoveringAnyCity.mockResolvedValue([greaterAccra]);

      await expect(service.create({ name: 'Coastal', cities: ['Tema', 'Ada'], fee: 20 })).rejects.toThrow(
        new ConflictException('Cities already covered by another shipping zone: "tema" (zone "Greater Accra")'),
      );
      expect(repository.findCoveringAnyCity).toHaveBeenCalledWith(['tema', 'ada'], undefined);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a blank city', async () => {
      await expect(service.create({ name: 'Blank', cities: ['Accra', '   '], fee: 5 })).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('checks overlap against every zone except the one being updated', async () => {
      await service.update('zone-accra', { cities: ['Accra', 'Tema', 'Kasoa'] });

      expect(repository.findCoveringAnyCity).toHaveBeenCalledWith(['accra', 'tema', 'kasoa'], 'zone-accra');
      expect(repository.update).toHaveBeenCalledWith('zone-accra', { cities: ['accra', 'tema', 'kasoa'] });
    });

    it('rejects moving a city into a zone when another zone covers it', async () => {
      repository.findCoveringAnyCity.mockResolvedValue([greaterAccra]);

      await expect(service.update('zone-coastal', { cities: ['Accra'] })).rejects.toThrow(ConflictException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('does not check overlap when the cities are unchanged', async () => {
      await service.update('zone-accra', { fee: 20 });

      expect(repository.findCoveringAnyCity).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith('zone-accra', { fee: 20 });
    });
  });
});
