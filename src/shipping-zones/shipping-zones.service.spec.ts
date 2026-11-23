import { BadRequestException, ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { ShippingZonesService } from './shipping-zones.service';
import { ShippingZonesRepository } from './shipping-zones.repository';
import { AUDIT_TX, createAuditServiceMock, withoutUndefined } from '../../test/helpers/audit.helper';

const fixedDate = new Date('2025-03-18T00:00:00.000Z');
const standard = {
  id: 'rule-std',
  zoneId: 'zone-accra',
  serviceLevel: 'STANDARD' as const,
  baseFee: new Decimal('15'),
  freeAbove: null,
  isActive: true,
  weightBands: [],
  createdAt: fixedDate,
  updatedAt: fixedDate,
};
const greaterAccra = {
  id: 'zone-accra',
  name: 'Greater Accra',
  isActive: true,
  codEnabled: true,
  createdAt: fixedDate,
  updatedAt: fixedDate,
  areas: [
    {
      id: 'a1',
      zoneId: 'zone-accra',
      level: 'TOWN' as const,
      region: null,
      town: 'accra',
      area: null,
      matchKey: 'TOWN:accra',
    },
  ],
  rateRules: [standard],
};
const matchable = (level: 'REGION' | 'TOWN' | 'AREA', matchKey: string, zoneId: string, values: object) => ({
  id: matchKey,
  zoneId,
  level,
  region: null,
  town: null,
  area: null,
  matchKey,
  ...values,
  zone: { id: zoneId, name: zoneId, rateRules: [{ ...standard, zoneId }] },
});
const accraAddress = { country: 'GH', region: 'GREATER_ACCRA' as const, city: 'Accra', area: 'Osu' };

describe('ShippingZonesService', () => {
  let repository: jest.Mocked<
    Pick<
      ShippingZonesRepository,
      | 'create'
      | 'update'
      | 'delete'
      | 'countPromotions'
      | 'findById'
      | 'findAreasByKey'
      | 'findMatchableAreas'
      | 'findRateRule'
      | 'findActiveRule'
      | 'createRateRule'
      | 'updateRateRule'
      | 'deleteRateRule'
    >
  >;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: ShippingZonesService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockImplementation(async (data) => ({
        ...greaterAccra,
        ...data,
        areas: data.areas.map((area: object, i: number) => ({ id: `a${i}`, ...area, matchKey: 'k' })),
      })),
      update: jest.fn().mockResolvedValue(greaterAccra),
      delete: jest.fn().mockResolvedValue(greaterAccra),
      countPromotions: jest.fn().mockResolvedValue(0),
      findById: jest.fn().mockResolvedValue(greaterAccra),
      findAreasByKey: jest.fn().mockResolvedValue([]),
      findMatchableAreas: jest.fn().mockResolvedValue([]),
      findRateRule: jest.fn().mockResolvedValue(standard),
      findActiveRule: jest.fn().mockResolvedValue(null),
      createRateRule: jest.fn().mockImplementation(async (zoneId, data) => ({ ...standard, ...data, zoneId })),
      updateRateRule: jest
        .fn()
        .mockImplementation(async (id, data) => ({ ...standard, ...withoutUndefined(data), id })),
      deleteRateRule: jest.fn().mockResolvedValue(standard),
    };
    audit = createAuditServiceMock();
    service = new ShippingZonesService(repository as never, audit as never);
  });

  it('refuses to delete a zone a free-shipping promotion is limited to (it would open it to every zone)', async () => {
    repository.countPromotions.mockResolvedValue(1);

    await expect(service.delete('zone-accra', 'admin1')).rejects.toThrow(ConflictException);
    expect(repository.delete).not.toHaveBeenCalled();
  });

  describe('create', () => {
    it('stores normalised areas, a spelling repeated once', async () => {
      await service.create(
        {
          name: 'Greater Accra',
          areas: [{ town: ' Accra ' }, { town: 'ACCRA' }, { town: 'Accra', area: 'East-Legon' }, { region: 'VOLTA' }],
        },
        'admin1',
      );

      expect(repository.findAreasByKey).toHaveBeenCalledWith(
        ['TOWN:accra', 'AREA:accra|east legon', 'REGION:VOLTA'],
        undefined,
      );
      expect(repository.create).toHaveBeenCalledWith(
        {
          name: 'Greater Accra',
          isActive: true,
          areas: [
            { level: 'TOWN', region: null, town: 'accra', area: null },
            { level: 'AREA', region: null, town: 'accra', area: 'east legon' },
            { level: 'REGION', region: 'VOLTA', town: null, area: null },
          ],
        },
        AUDIT_TX,
      );
    });

    it('refuses an area another zone already lists, naming the clash', async () => {
      repository.findAreasByKey.mockResolvedValue([
        { ...greaterAccra.areas[0], matchKey: 'TOWN:tema', zone: { name: 'Greater Accra' } },
      ] as never);

      await expect(service.create({ name: 'Coastal', areas: [{ town: 'Tema' }] }, 'admin1')).rejects.toThrow(
        new ConflictException('Areas already covered by another shipping zone: TOWN:tema (zone "Greater Accra")'),
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a blank town', { town: ' !! ' }],
      ['an area without a town', { area: 'Osu' }],
      ['a region with a town', { region: 'VOLTA' as const, town: 'Ho' }],
      ['nothing', {}],
    ])('refuses %s', async (_name, area) => {
      await expect(service.create({ name: 'Bad', areas: [area] }, 'admin1')).rejects.toThrow(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('checks overlap against every zone except the one being updated', async () => {
      await service.update('zone-accra', { areas: [{ town: 'Kasoa' }] }, 'admin1');

      expect(repository.findAreasByKey).toHaveBeenCalledWith(['TOWN:kasoa'], 'zone-accra');
      expect(repository.update).toHaveBeenCalledWith(
        'zone-accra',
        { name: undefined, isActive: undefined, areas: [{ level: 'TOWN', region: null, town: 'kasoa', area: null }] },
        AUDIT_TX,
      );
    });

    it('leaves the areas alone when they are not given', async () => {
      await service.update('zone-accra', { isActive: false }, 'admin1');

      expect(repository.findAreasByKey).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith(
        'zone-accra',
        { name: undefined, isActive: false, areas: undefined },
        AUDIT_TX,
      );
    });

    it('rejects an unknown zone without writing', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update('missing', { isActive: false }, 'admin1')).rejects.toThrow(
        'Shipping zone "missing" not found',
      );
      expect(repository.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('deliveryZoneFor', () => {
    it('matches an area of the town over the town, and the town over the region', async () => {
      repository.findMatchableAreas.mockResolvedValue([
        matchable('REGION', 'REGION:GREATER_ACCRA', 'zone-region', { region: 'GREATER_ACCRA' }),
        matchable('AREA', 'AREA:accra|osu', 'zone-osu', { town: 'accra', area: 'osu' }),
        matchable('TOWN', 'TOWN:accra', 'zone-town', { town: 'accra' }),
      ] as never);

      await expect(service.deliveryZoneFor(accraAddress)).resolves.toMatchObject({ id: 'zone-osu' });
      expect(repository.findMatchableAreas).toHaveBeenCalledWith(
        ['AREA:accra|osu', 'TOWN:accra', 'REGION:GREATER_ACCRA'],
        undefined,
      );
    });

    it.each([
      ['no active zone covers the address', accraAddress],
      ['the address is outside Ghana', { ...accraAddress, country: 'NG' }],
    ])('refuses delivery with reason DELIVERY_UNAVAILABLE when %s, never charging nothing', async (_name, place) => {
      repository.findMatchableAreas.mockResolvedValue(
        place.country === 'NG' ? ([matchable('TOWN', 'TOWN:accra', 'z', { town: 'accra' })] as never) : [],
      );

      const error = await service.deliveryZoneFor(place).catch((e: BadRequestException) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        extensions: { reason: 'DELIVERY_UNAVAILABLE' },
      });
    });

    it('refuses delivery when the matching zone has no active rate rule', async () => {
      const bare = matchable('TOWN', 'TOWN:accra', 'zone-town', { town: 'accra' });
      repository.findMatchableAreas.mockResolvedValue([{ ...bare, zone: { ...bare.zone, rateRules: [] } }] as never);

      await expect(service.deliveryZoneFor(accraAddress)).rejects.toThrow('its zone has no delivery rate');
    });
  });

  describe('rate rules', () => {
    it('creates a rule with its bands', async () => {
      const bands = [{ fromGrams: 5000, fee: new Decimal('25') }];

      await service.createRateRule(
        'zone-accra',
        { serviceLevel: 'EXPRESS', baseFee: new Decimal('20'), weightBands: bands },
        'admin1',
      );

      expect(repository.findActiveRule).toHaveBeenCalledWith('zone-accra', 'EXPRESS', undefined);
      expect(repository.createRateRule).toHaveBeenCalledWith(
        'zone-accra',
        { serviceLevel: 'EXPRESS', baseFee: new Decimal('20'), freeAbove: null, isActive: true, weightBands: bands },
        AUDIT_TX,
      );
    });

    it('refuses a second active rule for the same zone and level', async () => {
      repository.findActiveRule.mockResolvedValue(standard as never);

      await expect(
        service.createRateRule('zone-accra', { serviceLevel: 'STANDARD', baseFee: new Decimal('10') }, 'admin1'),
      ).rejects.toThrow(ConflictException);
      expect(repository.createRateRule).not.toHaveBeenCalled();
    });

    it('refuses weight bands that get cheaper as the cart gets heavier', async () => {
      await expect(
        service.createRateRule(
          'zone-accra',
          {
            serviceLevel: 'STANDARD',
            baseFee: new Decimal('10'),
            weightBands: [
              { fromGrams: 1000, fee: new Decimal('20') },
              { fromGrams: 5000, fee: new Decimal('15') },
            ],
          },
          'admin1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('checks new bands against the stored base fee when only the bands change', async () => {
      await expect(
        service.updateRateRule('rule-std', { weightBands: [{ fromGrams: 1000, fee: new Decimal('10') }] }, 'admin1'),
      ).rejects.toThrow('cannot cost less');
    });
  });

  describe('audit trail', () => {
    it.each<[string, () => Promise<unknown>, object]>([
      [
        'createShippingZone',
        () => service.create({ name: 'Greater Accra', areas: [{ town: 'Accra' }] }, 'admin1'),
        { entity: 'ShippingZone', entityId: 'zone-accra', action: 'CREATE' },
      ],
      [
        'updateShippingZone',
        () => service.update('zone-accra', { isActive: false }, 'admin1'),
        { entity: 'ShippingZone', entityId: 'zone-accra', action: 'UPDATE' },
      ],
      [
        'deleteShippingZone',
        () => service.delete('zone-accra', 'admin1'),
        {
          entity: 'ShippingZone',
          entityId: 'zone-accra',
          action: 'DELETE',
          details: { before: { name: 'Greater Accra', isActive: true, areas: ['TOWN:accra'] } },
        },
      ],
      [
        'createRateRule',
        () => service.createRateRule('zone-accra', { serviceLevel: 'STANDARD', baseFee: new Decimal('15') }, 'admin1'),
        { entity: 'RateRule', entityId: 'rule-std', action: 'CREATE' },
      ],
      [
        'updateRateRule',
        () => service.updateRateRule('rule-std', { baseFee: new Decimal('20') }, 'admin1'),
        {
          entity: 'RateRule',
          entityId: 'rule-std',
          action: 'UPDATE',
          details: { changes: { baseFee: { from: '15.00', to: '20.00' } } },
        },
      ],
      [
        'deleteRateRule',
        () => service.deleteRateRule('rule-std', 'admin1'),
        { entity: 'RateRule', entityId: 'rule-std', action: 'DELETE' },
      ],
    ])('%s writes an audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      await act();

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin1', ...expected }), AUDIT_TX);
    });
  });
});
