import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { CodRiskRepository } from './cod-risk.repository';
import { CodRiskResolver } from './cod-risk.resolver';
import { CodRiskService } from './cod-risk.service';

@Module({
  imports: [CommonsModule],
  providers: [CodRiskRepository, CodRiskService, CodRiskResolver],
  exports: [CodRiskService],
})
export class CodModule {}
