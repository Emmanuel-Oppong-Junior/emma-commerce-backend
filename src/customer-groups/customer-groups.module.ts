import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { CustomerGroupsResolver } from './customer-groups.resolver';
import { CustomerGroupsService } from './customer-groups.service';
import { CustomerGroupsRepository } from './customer-groups.repository';

@Module({
  imports: [CommonsModule],
  providers: [CustomerGroupsResolver, CustomerGroupsService, CustomerGroupsRepository],
})
export class CustomerGroupsModule {}
