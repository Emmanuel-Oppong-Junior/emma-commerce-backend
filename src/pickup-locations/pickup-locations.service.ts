import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PickupLocation } from '../generated/prisma/client';
import { PickupLocationsRepository } from './pickup-locations.repository';
import { CreatePickupLocationInput } from './dto/create-pickup-location.input';
import { UpdatePickupLocationInput } from './dto/update-pickup-location.input';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';

const AUDITED_PICKUP_FIELDS = [
  'name',
  'address',
  'city',
  'state',
  'country',
  'isActive',
] as const satisfies readonly (keyof PickupLocation)[];

@Injectable()
export class PickupLocationsService {
  constructor(
    private readonly repository: PickupLocationsRepository,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreatePickupLocationInput, actorId: string): Promise<PickupLocation> {
    return this.auditService.record(
      (tx) => this.repository.create({ ...input, isActive: input.isActive ?? true }, tx),
      (location) => ({
        entity: 'PickupLocation',
        entityId: location.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(location, AUDITED_PICKUP_FIELDS) },
      }),
    );
  }

  async update(id: string, input: UpdatePickupLocationInput, actorId: string): Promise<PickupLocation> {
    const existing = await this.findOne(id);
    return this.auditService.record(
      (tx) => this.repository.update(id, input, tx),
      (updated) => ({
        entity: 'PickupLocation',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_PICKUP_FIELDS) },
      }),
    );
  }

  async delete(id: string, actorId: string): Promise<PickupLocation> {
    return this.auditService.record(
      (tx) => this.repository.delete(id, tx),
      (deleted) => ({
        entity: 'PickupLocation',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_PICKUP_FIELDS) },
      }),
    );
  }

  async findAll(): Promise<PickupLocation[]> {
    return this.repository.findAll();
  }

  async findActive(): Promise<PickupLocation[]> {
    return this.repository.findActive();
  }

  async findOne(id: string): Promise<PickupLocation> {
    const location = await this.repository.findById(id);
    if (!location) throw new NotFoundException(`Pickup location "${id}" not found`);
    return location;
  }

  /** Throws BadRequestException because callers use it to validate a location chosen in client input. */
  async findActiveById(id: string): Promise<PickupLocation> {
    const location = await this.repository.findById(id);
    if (!location || !location.isActive) {
      throw new BadRequestException(`Pickup location "${id}" does not exist or is not active`);
    }
    return location;
  }
}
