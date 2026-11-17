import { BadRequestException } from '@nestjs/common';
import { PickupLocationsService } from './pickup-locations.service';
import { PickupLocationsRepository } from './pickup-locations.repository';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';

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
  let repository: jest.Mocked<Pick<PickupLocationsRepository, 'findById' | 'create' | 'update' | 'delete'>>;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: PickupLocationsService;

  beforeEach(() => {
    repository = {
      findById: jest.fn(),
      create: jest.fn().mockImplementation(async (data) => ({ ...osuStore, ...data })),
      update: jest.fn().mockImplementation(async (id, data) => ({ ...osuStore, id, ...data })),
      delete: jest.fn().mockResolvedValue(osuStore),
    };
    audit = createAuditServiceMock();
    service = new PickupLocationsService(repository as never, audit as never);
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

  describe('audit trail', () => {
    const osuValues = {
      name: 'Osu Store',
      address: '12 Oxford St',
      city: 'Accra',
      state: 'Greater Accra',
      country: 'Ghana',
      isActive: true,
    };

    beforeEach(() => repository.findById.mockResolvedValue(osuStore));

    it.each<[string, () => Promise<unknown>, object]>([
      [
        'create',
        () =>
          service.create(
            { name: 'Osu Store', address: '12 Oxford St', city: 'Accra', state: 'Greater Accra', country: 'Ghana' },
            'admin1',
          ),
        { action: 'CREATE', details: { after: osuValues } },
      ],
      [
        'update',
        () => service.update('pickup1', { isActive: false }, 'admin1'),
        { action: 'UPDATE', details: { changes: { isActive: { from: true, to: false } } } },
      ],
      ['delete', () => service.delete('pickup1', 'admin1'), { action: 'DELETE', details: { before: osuValues } }],
    ])('%s writes an audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      await act();

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        { entity: 'PickupLocation', entityId: 'pickup1', userId: 'admin1', ...expected },
        AUDIT_TX,
      );
    });
  });
});
