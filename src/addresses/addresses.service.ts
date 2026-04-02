import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Address } from '@prisma/client';
import { CreateAddressInput } from './dto/create-address.input';
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
    return this.addressesRepository.create({ ...data, userId });
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
   * Retrieves all addresses (admin only).
   * @returns List of all addresses.
   */
  async getAllAddresses(): Promise<Address[]> {
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
      throw new NotFoundException(`Address "${addressId}" not found for user "${userId}"`);
    }
    return address;
  }
}
