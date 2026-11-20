import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TaxService } from './tax.service';
import { TaxEntity } from './entities/tax-rate.entity';
import { CreateTaxInput } from './dto/create-tax-rate.input';
import { UpdateTaxInput } from './dto/update-tax-rate.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';

@Resolver(() => TaxEntity)
export class TaxResolver {
  constructor(private readonly taxService: TaxService) {}

  @RequirePermission('tax.manage')
  @RequireStepUp()
  @Mutation(() => TaxEntity, { description: 'Create a tax (admin only)' })
  createTax(@ActiveUser('id') actorId: string, @Args('input') input: CreateTaxInput) {
    return this.taxService.create(input, actorId);
  }

  @RequirePermission('tax.manage')
  @RequireStepUp()
  @Mutation(() => TaxEntity, { description: 'Update a tax (admin only)' })
  updateTax(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTaxInput,
  ) {
    return this.taxService.update(id, input, actorId);
  }

  @RequirePermission('tax.manage')
  @RequireStepUp()
  @Mutation(() => TaxEntity, { description: 'Delete a tax (admin only)' })
  deleteTax(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.taxService.delete(id, actorId);
  }

  @RequirePermission('tax.manage')
  @Query(() => [TaxEntity], { description: 'Get all taxes (admin only)' })
  taxes() {
    return this.taxService.findAll();
  }

  @RequirePermission('tax.manage')
  @Query(() => TaxEntity, { description: 'Get a tax by ID (admin only)' })
  tax(@Args('id', { type: () => ID }) id: string) {
    return this.taxService.findOne(id);
  }
}
