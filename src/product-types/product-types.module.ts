import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { ProductTypesRepository } from './product-types.repository';
import { ProductTypesService } from './product-types.service';
import { ProductTypesResolver } from './product-types.resolver';
import { ProductTypesLoader } from './product-types.loader';

@Module({
  imports: [CommonsModule],
  providers: [ProductTypesRepository, ProductTypesService, ProductTypesResolver, ProductTypesLoader],
  exports: [ProductTypesRepository, ProductTypesLoader],
})
export class ProductTypesModule {}
