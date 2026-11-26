import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CommonsModule } from '../commons/commons.module';
import { FeatureGuard } from './feature.guard';
import { StoreFeaturesResolver } from './store-features.resolver';
import { StoreFeaturesService } from './store-features.service';

/** Global, like Prisma: the API and the worker both check switches from many modules (P8-F). */
@Global()
@Module({
  imports: [CommonsModule],
  providers: [StoreFeaturesService, StoreFeaturesResolver, { provide: APP_GUARD, useClass: FeatureGuard }],
  exports: [StoreFeaturesService],
})
export class StoreFeaturesModule {}
