import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Address } from '../generated/prisma/client';
import { CreateAddressInput, STORE_COUNTRY } from './dto/create-address.input';
import { UpdateAddressInput } from './dto/update-address.input';
import { AddressesRepository } from './addresses.repository';

@Injectable()
export class AddressesService {
  constructor(private readonly addressesRepository: AddressesRepository) {}

  /**
   * Creates a new address for the user.
   * @param userId - The ID of the user.
   * @param data - The address data to create.
   * @returns The created address.
   */
  async createAddress(userId: string, data: CreateAddressInput): Promise<Address> {
    await this.enforceAddressLimit(userId);
    return this.addressesRepository.create({ ...data, country: data.country ?? STORE_COUNTRY, userId });
  }

  /**
   * Retrieves a specific address by ID for the user.
   * @param userId - The ID of the user.
   * @param addressId - The ID of the address.
   * @returns The address.
   */
  async getAddress(userId: string, addressId: string): Promise<Address> {
    return this.retrieveUserAddress(userId, addressId);
  }

  /**
   * Retrieves all addresses for the user.
   * @param userId - The ID of the user.
   * @returns List of addresses.
   */
  async getUserAddresses(userId: string): Promise<Address[]> {
    return this.addressesRepository.findByUser(userId);
  }

  /**
   * Retrieves addresses for admin-level access.
   * - SUPER_ADMIN: returns all addresses when no `userId` is provided.
   * - ADMIN: must supply a `userId` to retrieve that user's addresses only.
   * [MED-4] Regular users must never reach this path; route via `getUserAddresses` instead.
   * @param userId - Optional filter to scope results to a single user.
   * @returns List of addresses.
   */
  async getAllAddresses(userId?: string): Promise<Address[]> {
    if (userId) {
      return this.addressesRepository.findByUser(userId);
    }
    return this.addressesRepository.findAll();
  }

  /**
   * Updates an existing address for the user.
   * @param userId - The ID of the user.
   * @param addressId - The ID of the address.
   * @param data - The address data to update.
   * @returns The updated address.
   */
  async updateAddress(userId: string, addressId: string, data: UpdateAddressInput): Promise<Address> {
    await this.retrieveUserAddress(userId, addressId);
    return this.addressesRepository.update(addressId, data);
  }

  /**
   * Deletes an address for the user.
   * @param userId - The ID of the user.
   * @param addressId - The ID of the address.
   * @returns The deleted address.
   */
  async deleteAddress(userId: string, addressId: string): Promise<Address> {
    await this.retrieveUserAddress(userId, addressId);
    return this.addressesRepository.delete(addressId);
  }

  private async enforceAddressLimit(userId: string): Promise<void> {
    const count = await this.addressesRepository.countByUser(userId);
    if (count >= 10) {
      throw new BadRequestException('You have reached the maximum of 10 saved addresses');
    }
  }

  private async retrieveUserAddress(userId: string, addressId: string): Promise<Address> {
    const address = await this.addressesRepository.findById(addressId);
    if (!address || address.userId !== userId) {
      throw new NotFoundException(`Address "${addressId}" not found`);
    }
    return address;
  }
}
