import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { matchKey, ZoneAreaValue } from './zone-matching';

export const ZONE_INCLUDE = {
  areas: { orderBy: [{ level: 'asc' }, { matchKey: 'asc' }] },
  rateRules: {
    include: { weightBands: { orderBy: { fromGrams: 'asc' } } },
    orderBy: [{ serviceLevel: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.ShippingZoneInclude;

export type ZoneWithRates = Prisma.ShippingZoneGetPayload<{ include: typeof ZONE_INCLUDE }>;

const RULE_INCLUDE = { weightBands: { orderBy: { fromGrams: 'asc' } } } satisfies Prisma.RateRuleInclude;

export type RateRuleWithBands = Prisma.RateRuleGetPayload<{ include: typeof RULE_INCLUDE }>;

/** An entry of an active zone with the zone's name and active rules, for matching an address. */
export type MatchableArea = Prisma.ZoneAreaGetPayload<{
  include: { zone: { select: { id: true; name: true; rateRules: { include: typeof RULE_INCLUDE } } } };
}>;

export interface RateRuleData {
  serviceLevel?: Prisma.RateRuleCreateInput['serviceLevel'];
  baseFee?: Prisma.Decimal;
  freeAbove?: Prisma.Decimal | null;
  isActive?: boolean;
  weightBands?: { fromGrams: number; fee: Prisma.Decimal }[];
}

const areaRows = (areas: readonly ZoneAreaValue[]) => areas.map((area) => ({ ...area, matchKey: matchKey(area) }));

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class ShippingZonesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: { name: string; isActive: boolean; areas: readonly ZoneAreaValue[] },
    db: Prisma.TransactionClient,
  ): Promise<ZoneWithRates> {
    try {
      return await db.shippingZone.create({
        data: { name: data.name, isActive: data.isActive, areas: { create: areaRows(data.areas) } },
        include: ZONE_INCLUDE,
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(`Shipping zone "${data.name}" already exists, or one of its areas was just taken`);
      }
      throw e;
    }
  }

  async findById(id: string, db: Prisma.TransactionClient = this.prisma): Promise<ZoneWithRates | null> {
    return db.shippingZone.findUnique({ where: { id }, include: ZONE_INCLUDE });
  }

  async findAll(): Promise<ZoneWithRates[]> {
    return this.prisma.shippingZone.findMany({ orderBy: { name: 'asc' }, include: ZONE_INCLUDE });
  }

  async findActive(): Promise<ZoneWithRates[]> {
    return this.prisma.shippingZone.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: { ...ZONE_INCLUDE, rateRules: { ...ZONE_INCLUDE.rateRules, where: { isActive: true } } },
    });
  }

  async countPromotions(zoneId: string): Promise<number> {
    return this.prisma.promotion.count({ where: { shippingZones: { some: { id: zoneId } } } });
  }

  /** The entries with these keys of other zones than `excludeZoneId`, active or not. */
  async findAreasByKey(keys: string[], excludeZoneId?: string) {
    return this.prisma.zoneArea.findMany({
      where: { matchKey: { in: keys }, ...(excludeZoneId && { zoneId: { not: excludeZoneId } }) },
      include: { zone: { select: { name: true } } },
      orderBy: { matchKey: 'asc' },
    });
  }

  /** The entries of active zones with these keys, with each zone's active rules. */
  async findMatchableAreas(keys: string[], db: Prisma.TransactionClient = this.prisma): Promise<MatchableArea[]> {
    return db.zoneArea.findMany({
      where: { matchKey: { in: keys }, zone: { isActive: true } },
      include: {
        zone: {
          select: { id: true, name: true, rateRules: { where: { isActive: true }, include: RULE_INCLUDE } },
        },
      },
    });
  }

  async update(
    id: string,
    data: { name?: string; isActive?: boolean; areas?: readonly ZoneAreaValue[] },
    db: Prisma.TransactionClient,
  ): Promise<ZoneWithRates> {
    try {
      if (data.areas) {
        await db.zoneArea.deleteMany({ where: { zoneId: id } });
        await db.zoneArea.createMany({ data: areaRows(data.areas).map((area) => ({ ...area, zoneId: id })) });
      }
      return await db.shippingZone.update({
        where: { id },
        data: { name: data.name, isActive: data.isActive },
        include: ZONE_INCLUDE,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Shipping zone "${id}" not found`);
      }
      if (isUniqueViolation(e)) {
        throw new ConflictException(`Shipping zone name "${data.name}" is taken, or one of its areas was just taken`);
      }
      throw e;
    }
  }

  async delete(id: string, db: Prisma.TransactionClient): Promise<ZoneWithRates> {
    try {
      return await db.shippingZone.delete({ where: { id }, include: ZONE_INCLUDE });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Shipping zone "${id}" not found`);
      }
      throw e;
    }
  }

  async findRateRule(id: string): Promise<RateRuleWithBands | null> {
    return this.prisma.rateRule.findUnique({ where: { id }, include: RULE_INCLUDE });
  }

  /** The zone's active rule for the level, other than `excludeId`. */
  async findActiveRule(zoneId: string, serviceLevel: RateRuleData['serviceLevel'], excludeId?: string) {
    return this.prisma.rateRule.findFirst({
      where: { zoneId, serviceLevel, isActive: true, ...(excludeId && { id: { not: excludeId } }) },
    });
  }

  async createRateRule(
    zoneId: string,
    data: Required<Omit<RateRuleData, 'freeAbove'>> & { freeAbove: Prisma.Decimal | null },
    db: Prisma.TransactionClient,
  ): Promise<RateRuleWithBands> {
    try {
      return await db.rateRule.create({
        data: { ...data, zoneId, weightBands: { create: data.weightBands } },
        include: RULE_INCLUDE,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw activeRuleTaken();
      throw e;
    }
  }

  async updateRateRule(id: string, data: RateRuleData, db: Prisma.TransactionClient): Promise<RateRuleWithBands> {
    const { weightBands, ...fields } = data;
    try {
      if (weightBands) {
        await db.rateWeightBand.deleteMany({ where: { rateRuleId: id } });
        await db.rateWeightBand.createMany({ data: weightBands.map((band) => ({ ...band, rateRuleId: id })) });
      }
      return await db.rateRule.update({ where: { id }, data: fields, include: RULE_INCLUDE });
    } catch (e) {
      if (isUniqueViolation(e)) throw activeRuleTaken();
      throw e;
    }
  }

  async deleteRateRule(id: string, db: Prisma.TransactionClient): Promise<RateRuleWithBands> {
    return db.rateRule.delete({ where: { id }, include: RULE_INCLUDE });
  }
}

function activeRuleTaken(): ConflictException {
  return new ConflictException('The zone already has an active rate rule for this service level; deactivate it first');
}
