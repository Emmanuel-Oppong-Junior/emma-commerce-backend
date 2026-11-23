import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { RateRuleData, RateRuleWithBands, ShippingZonesRepository, ZoneWithRates } from './shipping-zones.repository';
import { CreateShippingZoneInput } from './dto/create-shipping-zone.input';
import { UpdateShippingZoneInput } from './dto/update-shipping-zone.input';
import { ZoneAreaInput } from './dto/zone-area.input';
import { CreateRateRuleInput, UpdateRateRuleInput } from './dto/rate-rule.input';
import { AuditService, fieldChanges } from '../commons/audit.service';
import {
  AddressPlace,
  DELIVERY_UNAVAILABLE,
  candidateKeys,
  matchKey,
  matchZone,
  toZoneArea,
  ZoneAreaValue,
} from './zone-matching';
import { DeliveryRate, rateRuleProblem } from './delivery-fee';

/** The zone an address is delivered in, with its active rate rules. */
export interface DeliveryZone {
  id: string;
  name: string;
  rules: DeliveryRate[];
}

export function deliveryUnavailable(message: string): BadRequestException {
  return new BadRequestException({ message, extensions: { reason: DELIVERY_UNAVAILABLE } });
}

const zoneAudit = (zone: ZoneWithRates) => ({
  name: zone.name,
  isActive: zone.isActive,
  areas: zone.areas.map((area) => area.matchKey),
});

const ruleAudit = (rule: RateRuleWithBands) => ({
  zoneId: rule.zoneId,
  serviceLevel: rule.serviceLevel,
  baseFee: rule.baseFee.toFixed(2),
  freeAbove: rule.freeAbove?.toFixed(2) ?? null,
  isActive: rule.isActive,
  weightBands: rule.weightBands.map((band) => ({ fromGrams: band.fromGrams, fee: band.fee.toFixed(2) })),
});

function changes<T extends object>(before: T, after: T) {
  return fieldChanges(before, after, Object.keys(after) as (keyof T)[]);
}

@Injectable()
export class ShippingZonesService {
  constructor(
    private readonly repository: ShippingZonesRepository,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreateShippingZoneInput, actorId: string): Promise<ZoneWithRates> {
    const areas = await this.checkedAreas(input.areas);
    return this.auditService.record(
      (tx) => this.repository.create({ name: input.name, isActive: input.isActive ?? true, areas }, tx),
      (zone) => ({
        entity: 'ShippingZone',
        entityId: zone.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: zoneAudit(zone) },
      }),
    );
  }

  async update(id: string, input: UpdateShippingZoneInput, actorId: string): Promise<ZoneWithRates> {
    const existing = await this.findOne(id);
    const areas = input.areas && (await this.checkedAreas(input.areas, id));
    return this.auditService.record(
      (tx) => this.repository.update(id, { name: input.name, isActive: input.isActive, areas }, tx),
      (updated) => ({
        entity: 'ShippingZone',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: changes(zoneAudit(existing), zoneAudit(updated)) },
      }),
    );
  }

  /**
   * Deletes a zone with its areas and rules. A zone a free-shipping promotion is limited to cannot be deleted:
   * dropping it would open that promotion to every zone. Orders keep their zone snapshot.
   */
  async delete(id: string, actorId: string): Promise<ZoneWithRates> {
    if ((await this.repository.countPromotions(id)) > 0) {
      throw new ConflictException(`Shipping zone "${id}" limits promotions; take it off them before deleting it`);
    }
    return this.auditService.record(
      (tx) => this.repository.delete(id, tx),
      (deleted) => ({
        entity: 'ShippingZone',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: zoneAudit(deleted) },
      }),
    );
  }

  async findAll(): Promise<ZoneWithRates[]> {
    return this.repository.findAll();
  }

  async findActive(): Promise<ZoneWithRates[]> {
    return this.repository.findActive();
  }

  async findOne(id: string): Promise<ZoneWithRates> {
    const zone = await this.repository.findById(id);
    if (!zone) throw new NotFoundException(`Shipping zone "${id}" not found`);
    return zone;
  }

  /** Adds a rate rule to a zone (a price change: step-up at the resolver); audited. */
  async createRateRule(zoneId: string, input: CreateRateRuleInput, actorId: string): Promise<RateRuleWithBands> {
    await this.findOne(zoneId);
    const isActive = input.isActive ?? true;
    const data = {
      serviceLevel: input.serviceLevel,
      baseFee: input.baseFee,
      freeAbove: input.freeAbove ?? null,
      isActive,
      weightBands: input.weightBands ?? [],
    };
    this.assertValidRule(data);
    if (isActive) await this.assertNoOtherActiveRule(zoneId, data.serviceLevel);
    return this.auditService.record(
      (tx) => this.repository.createRateRule(zoneId, data, tx),
      (rule) => ({
        entity: 'RateRule',
        entityId: rule.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: ruleAudit(rule) },
      }),
    );
  }

  /** Changes a rate rule's fees, bands or active flag; audited with the fees before and after. */
  async updateRateRule(id: string, input: UpdateRateRuleInput, actorId: string): Promise<RateRuleWithBands> {
    const existing = await this.findRateRule(id);
    const data: RateRuleData = {
      baseFee: input.baseFee,
      freeAbove: input.freeAbove,
      isActive: input.isActive,
      weightBands: input.weightBands,
    };
    this.assertValidRule({
      baseFee: data.baseFee ?? existing.baseFee,
      weightBands: data.weightBands ?? existing.weightBands,
    });
    if (input.isActive && !existing.isActive) {
      await this.assertNoOtherActiveRule(existing.zoneId, existing.serviceLevel, id);
    }
    return this.auditService.record(
      (tx) => this.repository.updateRateRule(id, data, tx),
      (updated) => ({
        entity: 'RateRule',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: changes(ruleAudit(existing), ruleAudit(updated)) },
      }),
    );
  }

  /** Deletes a rate rule; orders keep the fee they were charged (their rateRuleId is a snapshot). */
  async deleteRateRule(id: string, actorId: string): Promise<RateRuleWithBands> {
    await this.findRateRule(id);
    return this.auditService.record(
      (tx) => this.repository.deleteRateRule(id, tx),
      (deleted) => ({
        entity: 'RateRule',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: ruleAudit(deleted) },
      }),
    );
  }

  /**
   * The active zone delivering to the address: its most specific matching area (area within the town, then the town,
   * then the region), with the zone's active rate rules. BAD_REQUEST with reason DELIVERY_UNAVAILABLE outside Ghana,
   * when no active zone covers the address, or when the zone has no active rule: delivery there is never free.
   */
  async deliveryZoneFor(place: AddressPlace, db?: Prisma.TransactionClient): Promise<DeliveryZone> {
    const describe = [place.area, place.city, place.region].filter(Boolean).join(', ');
    const entries = await this.repository.findMatchableAreas(candidateKeys(place), db);
    const match = matchZone(
      entries.map((entry) => ({ ...entry, zoneId: entry.zone.id })),
      place,
    );
    if (!match) {
      throw deliveryUnavailable(`Delivery is not available to "${describe}": no active shipping zone covers it`);
    }
    if (match.zone.rateRules.length === 0) {
      throw deliveryUnavailable(`Delivery is not available to "${describe}": its zone has no delivery rate`);
    }
    return { id: match.zone.id, name: match.zone.name, rules: match.zone.rateRules };
  }

  private async findRateRule(id: string): Promise<RateRuleWithBands> {
    const rule = await this.repository.findRateRule(id);
    if (!rule) throw new NotFoundException(`Rate rule "${id}" not found`);
    return rule;
  }

  private assertValidRule(rule: Pick<DeliveryRate, 'baseFee' | 'weightBands'>): void {
    const problem = rateRuleProblem(rule);
    if (problem) throw new BadRequestException(problem);
  }

  private async assertNoOtherActiveRule(
    zoneId: string,
    serviceLevel: RateRuleData['serviceLevel'],
    excludeId?: string,
  ): Promise<void> {
    if (await this.repository.findActiveRule(zoneId, serviceLevel, excludeId)) {
      throw new ConflictException(
        `The zone already has an active ${serviceLevel} rate rule; deactivate it before activating another`,
      );
    }
  }

  /** Normalised, de-duplicated areas, refused when malformed or when another zone (active or not) lists one. */
  private async checkedAreas(inputs: ZoneAreaInput[], zoneId?: string): Promise<ZoneAreaValue[]> {
    const byKey = new Map<string, ZoneAreaValue>();
    for (const input of inputs) {
      const area = toZoneArea(input);
      if (typeof area === 'string') throw new BadRequestException(area);
      byKey.set(matchKey(area), area);
    }
    const taken = await this.repository.findAreasByKey([...byKey.keys()], zoneId);
    if (taken.length > 0) {
      throw new ConflictException(
        `Areas already covered by another shipping zone: ${taken.map((area) => `${area.matchKey} (zone "${area.zone.name}")`).join(', ')}`,
      );
    }
    return [...byKey.values()];
  }
}
