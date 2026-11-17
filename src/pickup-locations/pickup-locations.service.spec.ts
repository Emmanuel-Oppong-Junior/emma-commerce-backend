import { BadRequestException } from '@nestjs/common';
import { PickupLocationsService } from './pickup-locations.service';
import { PickupLocationsRepository } from './pickup-locations.repository';

const fixedDate = new Date('2025-03-18T00:00:00.000Z');
const osuStore = {
  id: 'pickup1',
  name: 'Osu Store',
  address: '12 Oxford St',
  city: 'Accra',
  state: 'Greater Accra',
  country: 'Ghana',
  isActive: true,
  createdAt: fixedDate,
  updatedAt: fixedDate,
};

describe('PickupLocationsService', () => {
  let repository: jest.Mocked<Pick<PickupLocationsRepository, 'findById'>>;
  let service: PickupLocationsService;

  beforeEach(() => {
    repository = { findById: jest.fn() };
    service = new PickupLocationsService(repository as never);
  });

  describe('findActiveById', () => {
    it('returns an active location', async () => {
      repository.findById.mockResolvedValue(osuStore);

      await expect(service.findActiveById('pickup1')).resolves.toEqual(osuStore);
    });

    it('rejects an unknown location as a bad request', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findActiveById('missing')).rejects.toThrow(
        new BadRequestException('Pickup location "missing" does not exist or is not active'),
      );
    });

    it('rejects an inactive location as a bad request', async () => {
      repository.findById.mockResolvedValue({ ...osuStore, isActive: false });

      await expect(service.findActiveById('pickup1')).rejects.toThrow(BadRequestException);
    });
  });
});
