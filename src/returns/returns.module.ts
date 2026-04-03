import { Module } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnsResolver } from './returns.resolver';
import { ReturnsRepository } from './returns.repository';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [ReturnsService, ReturnsResolver, ReturnsRepository],
  exports: [ReturnsService],
})
export class ReturnsModule {}
