import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { FailedJobsResolver } from './failed-jobs.resolver';
import { FailedJobsService } from './failed-jobs.service';

@Module({
  imports: [CommonsModule],
  providers: [FailedJobsResolver, FailedJobsService],
})
export class FailedJobsModule {}
