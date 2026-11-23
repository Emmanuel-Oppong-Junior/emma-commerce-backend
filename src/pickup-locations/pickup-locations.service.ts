import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PickupLocationData, PickupLocationsRepository, PickupLocationWithHours } from './pickup-locations.repository';
import { CreatePickupLocationInput, OpeningHoursInput } from './dto/create-pickup-location.input';
import { UpdatePickupLocationInput } from './dto/update-pickup-location.input';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { formatOpeningHours, OpeningHours, openingHoursProblem } from './opening-hours';
import { formatMinutes, parseTime } from '../shipping-zones/slots/delivery-slots';
import { PickupLocationEntity } from './entities/pickup-location.entity';
import { STORE_COUNTRY } from '../addresses/dto/create-address.input';

const AUDITED_PICKUP_FIELDS = [
  'name',
  'address',
  'city',
  'region',
  'country',
  'contactPhone',
  'instructions',
  'ghanaPostGps',
  'latitude',
  'longitude',
  'isActive',
] as const satisfies readonly (keyof PickupLocationWithHours)[];

const AUDITED_KEYS: string[] = [...AUDITED_PICKUP_FIELDS, 'openingHours'];
const auditValues = (location: PickupLocationWithHours): Record<string, Prisma.InputJsonValue | null> => ({
  ...fieldValues(location, AUDITED_PICKUP_FIELDS),
  openingHours: formatOpeningHours(location.openingHours),
});

/** The pickup point as the API shows it: hours as HH:MM, plus the week in one line. */
export function toPickupLocationEntity(location: PickupLocationWithHours): PickupLocationEntity {
  return {
    ...location,
    latitude: location.latitude?.toNumber() ?? null,
    longitude: location.longitude?.toNumber() ?? null,
    openingHours: location.openingHours.map((day) => ({
      weekday: day.weekday,
      opens: formatMinutes(day.opensMinute),
      closes: formatMinutes(day.closesMinute),
    })),
    openingHoursText: formatOpeningHours(location.openingHours),
  };
}

function toOpeningHours(inputs: OpeningHoursInput[]): OpeningHours[] {
  const hours = inputs.map((input) => {
    const opensMinute = parseTime(input.opens);
    const closesMinute = parseTime(input.closes);
    if (opensMinute === null || closesMinute === null) {
      throw new BadRequestException('Opening hours are times of day as HH:MM (00:00-24:00)');
    }
    return { weekday: input.weekday, opensMinute, closesMinute };
  });
  const problem = openingHoursProblem(hours);
  if (problem) throw new BadRequestException(problem);
  return hours;
}

@Injectable()
export class PickupLocationsService {
  constructor(
    private readonly repository: PickupLocationsRepository,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreatePickupLocationInput, actorId: string): Promise<PickupLocationEntity> {
    const { openingHours = [], ...fields } = input;
    const hours = toOpeningHours(openingHours);
    const data: PickupLocationData = {
      ...fields,
      country: fields.country ?? STORE_COUNTRY,
      isActive: fields.isActive ?? true,
    };
    const location = await this.auditService.record(
      (tx) => this.repository.create(data, hours, tx),
      (created) => ({
        entity: 'PickupLocation',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: auditValues(created) },
      }),
    );
    return toPickupLocationEntity(location);
  }

  async update(id: string, input: UpdatePickupLocationInput, actorId: string): Promise<PickupLocationEntity> {
    const existing = await this.findOne(id);
    const { openingHours, ...fields } = input;
    const hours = openingHours && toOpeningHours(openingHours);
    const location = await this.auditService.record(
      (tx) => this.repository.update(id, fields, hours, tx),
      (updated) => ({
        entity: 'PickupLocation',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(auditValues(existing), auditValues(updated), AUDITED_KEYS) },
      }),
    );
    return toPickupLocationEntity(location);
  }

  async delete(id: string, actorId: string): Promise<PickupLocationEntity> {
    const location = await this.auditService.record(
      (tx) => this.repository.delete(id, tx),
      (deleted) => ({
        entity: 'PickupLocation',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: auditValues(deleted) },
      }),
    );
    return toPickupLocationEntity(location);
  }

  async findAll(): Promise<PickupLocationEntity[]> {
    return (await this.repository.findAll()).map(toPickupLocationEntity);
  }

  async findActive(): Promise<PickupLocationEntity[]> {
    return (await this.repository.findActive()).map(toPickupLocationEntity);
  }

  async findOne(id: string): Promise<PickupLocationWithHours> {
    const location = await this.repository.findById(id);
    if (!location) throw new NotFoundException(`Pickup location "${id}" not found`);
    return location;
  }

  /** Throws BadRequestException because callers use it to validate a location chosen in client input. */
  async findActiveById(id: string, db?: Prisma.TransactionClient): Promise<PickupLocationWithHours> {
    const location = await this.repository.findById(id, db);
    if (!location || !location.isActive) {
      throw new BadRequestException(`Pickup location "${id}" does not exist or is not active`);
    }
    return location;
  }
}
