import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AddressesService } from './addresses.service';
import { Address } from './entities/address.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CreateAddressInput } from './dto/create-address.input';
import { UpdateAddressInput } from './dto/update-address.input';
import { ForbiddenException } from '@nestjs/common';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import {
  ActiveAccess,
  RequirePermission,
  RequireStepUp,
  StepUpCondition,
} from '../iam/authorization/policy.decorators';
import { hasPermission, StaffAccess } from '../iam/authorization/staff-access';

const EXPORTS_ALL: StepUpCondition = {
  label: 'userId is omitted (exports every address)',
  applies: (args) => !args.userId,
};

@Resolver(() => Address)
export class AddressesResolver {
  constructor(private readonly addressService: AddressesService) {}

  @Auth(AuthType.Bearer)
  @Query(() => Address, {
    name: 'address',
    description: 'Retrieves a specific address by ID for the current user',
  })
  async getAddress(@ActiveUser('id') userId: string, @Args('addressId', { type: () => String }) addressId: string) {
    return this.addressService.getAddress(userId, addressId);
  }

  @Auth(AuthType.Bearer)
  @Query(() => [Address], {
    name: 'userAddresses',
    description: 'Retrieves all addresses for the current user',
  })
  async getUserAddresses(@ActiveUser('id') userId: string) {
    return this.addressService.getUserAddresses(userId);
  }

  /**
   * [MED-4] Staff only. Omitting `userId` exports every customer address, so it needs customer.data.export.
   * Regular users should use `userAddresses` instead.
   */
  @RequirePermission('user.view')
  @RequireStepUp(EXPORTS_ALL)
  @Query(() => [Address], {
    name: 'addresses',
    description:
      'Staff (user.view): retrieves the addresses of one user. Omitting userId lists every address and needs customer.data.export (the Owner).',
  })
  async getAllAddresses(
    @ActiveUser('id') actorId: string,
    @ActiveAccess() access: StaffAccess,
    @Args('userId', { type: () => String, nullable: true }) userId?: string,
  ) {
    if (userId) return this.addressService.getAllAddresses(userId);
    if (!hasPermission(access, 'customer.data.export')) {
      throw new ForbiddenException('Supply a userId: listing every address needs the customer.data.export permission');
    }
    return this.addressService.exportAllAddresses(actorId);
  }

  @Auth(AuthType.Bearer)
  @Mutation(() => Address, {
    name: 'createAddress',
    description: 'Creates a new address for the user',
  })
  async createAddress(@ActiveUser('id') userId: string, @Args('input') input: CreateAddressInput) {
    return this.addressService.createAddress(userId, input);
  }

  @Auth(AuthType.Bearer)
  @Mutation(() => Address, {
    name: 'updateAddress',
    description: 'Updates an existing address for the user',
  })
  async updateAddress(
    @ActiveUser('id') userId: string,
    @Args('addressId', { type: () => String }) addressId: string,
    @Args('input') input: UpdateAddressInput,
  ) {
    return this.addressService.updateAddress(userId, addressId, input);
  }

  @Auth(AuthType.Bearer)
  @Mutation(() => Address, {
    name: 'deleteAddress',
    description: 'Deletes an address for the user',
  })
  async deleteAddress(@ActiveUser('id') userId: string, @Args('addressId', { type: () => String }) addressId: string) {
    return this.addressService.deleteAddress(userId, addressId);
  }
}
