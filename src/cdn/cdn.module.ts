import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { CDN_PURGER, LoggingCdnPurger } from './cdn-purger';
import { CdnPurges } from './cdn-purges';

/** CDN invalidation for the worker. The real CDN adapter replaces LoggingCdnPurger when hosting picks a CDN. */
@Module({
  imports: [CommonsModule],
  providers: [CdnPurges, { provide: CDN_PURGER, useClass: LoggingCdnPurger }],
  exports: [CdnPurges],
})
export class CdnModule {}
