import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TaxService } from './tax.service';
import { TaxRateEntity } from './entities/tax-rate.entity';
import { CreateTaxRateInput } from './dto/create-tax-rate.input';
import { UpdateTaxRateInput } from './dto/update-tax-rate.input';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';

@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Resolver(() => TaxRateEntity)
export class TaxResolver {
  constructor(private readonly taxService: TaxService) {}

  @Mutation(() => TaxRateEntity, { description: 'Create a tax rate (admin only)' })
  createTaxRate(@Args('input') input: CreateTaxRateInput) {
    return this.taxService.createTaxRate(input);
  }

  @Mutation(() => TaxRateEntity, { description: 'Update a tax rate (admin only)' })
  updateTaxRate(@Args('id', { type: () => ID }) id: string, @Args('input') input: UpdateTaxRateInput) {
    return this.taxService.updateTaxRate(id, input);
  }

  @Mutation(() => TaxRateEntity, { description: 'Delete a tax rate (admin only)' })
  deleteTaxRate(@Args('id', { type: () => ID }) id: string) {
    return this.taxService.deleteTaxRate(id);
  }

  @Query(() => [TaxRateEntity], { description: 'Get all tax rates (admin only)' })
  taxRates() {
    return this.taxService.findAll();
  }

  @Query(() => TaxRateEntity, { description: 'Get a tax rate by ID (admin only)' })
  taxRate(@Args('id', { type: () => ID }) id: string) {
    return this.taxService.findOne(id);
  }
}
