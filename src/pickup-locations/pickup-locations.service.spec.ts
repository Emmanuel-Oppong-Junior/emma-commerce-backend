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
  region: 'GREATER_ACCRA' as const,
  country: 'GH',
  contactPhone: '+233244123456',
  instructions: null,
  ghanaPostGps: null,
  latitude: null,
  longitude: null,
  isActive: true,
  createdAt: fixedDate,
  updatedAt: fixedDate,
  openingHours: [{ pickupLocationId: 'pickup1', weekday: 'MONDAY' as const, opensMinute: 480, closesMinute: 1020 }],
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

  describe('opening hours', () => {
    const input = { name: 'Osu Store', address: '12 Oxford St', city: 'Accra', region: 'GREATER_ACCRA' as const };

    it('stores the hours as minutes and shows them as HH:MM with the week in one line', async () => {
      const created = await service.create(
        { ...input, openingHours: [{ weekday: 'MONDAY', opens: '08:00', closes: '17:00' }] },
        'admin1',
      );

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'GH', isActive: true }),
        [{ weekday: 'MONDAY', opensMinute: 480, closesMinute: 1020 }],
        AUDIT_TX,
      );
      expect(created).toMatchObject({
        openingHours: [{ weekday: 'MONDAY', opens: '08:00', closes: '17:00' }],
        openingHoursText: 'Mon 08:00-17:00, Tue-Sun closed',
      });
    });

    it.each([
      ['a day closing before it opens', [{ weekday: 'MONDAY' as const, opens: '17:00', closes: '08:00' }]],
      [
        'a weekday twice',
        [
          { weekday: 'MONDAY' as const, opens: '08:00', closes: '12:00' },
          { weekday: 'MONDAY' as const, opens: '13:00', closes: '17:00' },
        ],
      ],
      ['a time outside the day', [{ weekday: 'MONDAY' as const, opens: '08:00', closes: '25:00' }]],
    ])('refuses %s', async (_name, openingHours) => {
      await expect(service.create({ ...input, openingHours }, 'admin1')).rejects.toThrow(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('audit trail', () => {
    const osuValues = {
      name: 'Osu Store',
      address: '12 Oxford St',
      city: 'Accra',
      region: 'GREATER_ACCRA',
      country: 'GH',
      contactPhone: '+233244123456',
      instructions: null,
      ghanaPostGps: null,
      latitude: null,
      longitude: null,
      isActive: true,
      openingHours: 'Mon 08:00-17:00, Tue-Sun closed',
    };

    beforeEach(() => repository.findById.mockResolvedValue(osuStore));

    it.each<[string, () => Promise<unknown>, object]>([
      [
        'create',
        () =>
          service.create(
            {
              name: 'Osu Store',
              address: '12 Oxford St',
              city: 'Accra',
              region: 'GREATER_ACCRA',
              contactPhone: '+233244123456',
              openingHours: [{ weekday: 'MONDAY', opens: '08:00', closes: '17:00' }],
            },
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
