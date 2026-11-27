import { Args, Query, Resolver } from '@nestjs/graphql';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { SerialUnitsArgs } from './dto/serial-units.args';
import { SerialUnit, SerialUnitPage } from './entities/serial-unit.entity';
import { SerialUnitsService } from './serial-units.service';

@Resolver(() => SerialUnit)
export class SerialUnitsResolver {
  constructor(private readonly units: SerialUnitsService) {}

  @RequirePermission('inventory.view')
  @Query(() => SerialUnitPage, {
    description:
      'A variant’s serialised units by serial, IN_STOCK by default, optionally at one location (staff). For checking ' +
      'stock; picking names the unit in hand with assignShipmentItemSerials. NOT_FOUND for an unknown variant',
  })
  serialUnits(@Args() { variantId, locationId, statuses, first, after }: SerialUnitsArgs): Promise<SerialUnitPage> {
    return this.units.listUnits({ variantId, locationId, statuses }, first, after);
  }
}
