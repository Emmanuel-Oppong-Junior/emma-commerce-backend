import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { Supplier, SupplierPage } from './supplier.entity';
import { CreateSupplierInput, SuppliersArgs, UpdateSupplierInput } from './supplier.input';
import { SuppliersService } from './suppliers.service';

@Resolver(() => Supplier)
export class SuppliersResolver {
  constructor(private readonly service: SuppliersService) {}

  @RequirePermission('purchasing.view')
  @Query(() => SupplierPage, { description: 'Suppliers by name, optionally active only or matching a search (staff)' })
  suppliers(@Args() { isActive, search, first, after }: SuppliersArgs) {
    return this.service.findMany({ isActive, search }, first, after);
  }

  @RequirePermission('purchasing.view')
  @Query(() => Supplier, { description: 'A supplier (staff)' })
  supplier(@Args('id', { type: () => ID }) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission('purchasing.manage')
  @Mutation(() => Supplier, { description: 'Add a supplier; names are unique ignoring case (staff)' })
  createSupplier(@ActiveUser('id') actorId: string, @Args('input') input: CreateSupplierInput) {
    return this.service.create(input, actorId);
  }

  @RequirePermission('purchasing.manage')
  @Mutation(() => Supplier, { description: 'Edit a supplier; isActive: false deactivates it (staff)' })
  updateSupplier(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateSupplierInput,
  ) {
    return this.service.update(id, input, actorId);
  }

  @RequirePermission('purchasing.manage')
  @Mutation(() => Supplier, {
    description: 'Delete a supplier no purchase order refers to; otherwise deactivate it (staff)',
  })
  deleteSupplier(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.service.delete(id, actorId);
  }
}
