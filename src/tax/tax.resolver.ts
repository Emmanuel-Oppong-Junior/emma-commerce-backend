import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TaxService } from './tax.service';
import { TaxEntity } from './entities/tax-rate.entity';
import { CreateTaxInput } from './dto/create-tax-rate.input';
import { UpdateTaxInput } from './dto/update-tax-rate.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';

@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Resolver(() => TaxEntity)
export class TaxResolver {
  constructor(private readonly taxService: TaxService) {}

  @Mutation(() => TaxEntity, { description: 'Create a tax (admin only)' })
  createTax(@ActiveUser('id') actorId: string, @Args('input') input: CreateTaxInput) {
    return this.taxService.create(input, actorId);
  }

  @Mutation(() => TaxEntity, { description: 'Update a tax (admin only)' })
  updateTax(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTaxInput,
  ) {
    return this.taxService.update(id, input, actorId);
  }

  @Mutation(() => TaxEntity, { description: 'Delete a tax (admin only)' })
  deleteTax(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.taxService.delete(id, actorId);
  }

  @Query(() => [TaxEntity], { description: 'Get all taxes (admin only)' })
  taxes() {
    return this.taxService.findAll();
  }

  @Query(() => TaxEntity, { description: 'Get a tax by ID (admin only)' })
  tax(@Args('id', { type: () => ID }) id: string) {
    return this.taxService.findOne(id);
  }
}
