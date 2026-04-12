import { Injectable, NotFoundException } from '@nestjs/common';
import { PickupLocation } from '@prisma/client';
import { PickupLocationsRepository } from './pickup-locations.repository';
import { CreatePickupLocationInput } from './dto/create-pickup-location.input';
import { UpdatePickupLocationInput } from './dto/update-pickup-location.input';

@Injectable()
export class PickupLocationsService {
  constructor(private readonly repository: PickupLocationsRepository) {}

  async create(input: CreatePickupLocationInput): Promise<PickupLocation> {
    return this.repository.create({ ...input, isActive: input.isActive ?? true });
  }

  async update(id: string, input: UpdatePickupLocationInput): Promise<PickupLocation> {
    return this.repository.update(id, input);
  }

  async delete(id: string): Promise<PickupLocation> {
    return this.repository.delete(id);
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

  async findActiveById(id: string): Promise<PickupLocation> {
    const location = await this.repository.findById(id);
    if (!location || !location.isActive) throw new NotFoundException(`Pickup location "${id}" not found or inactive`);
    return location;
  }
}
