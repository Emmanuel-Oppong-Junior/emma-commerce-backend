import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { VelocityCounter } from './velocity-counter';
import { VelocityRepository } from './velocity.repository';
import { VelocityResolver } from './velocity.resolver';
import { VelocityService } from './velocity.service';

@Module({
  imports: [CommonsModule],
  providers: [VelocityCounter, VelocityRepository, VelocityService, VelocityResolver],
  exports: [VelocityService],
})
export class FraudModule {}
