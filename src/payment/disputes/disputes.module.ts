import { Module } from '@nestjs/common';
import { CommonsModule } from '../../commons/commons.module';
import { OutboxModule } from '../../outbox/outbox.module';
import { DisputesRepository } from './disputes.repository';
import { DisputesResolver } from './disputes.resolver';
import { DisputesService } from './disputes.service';

@Module({
  imports: [CommonsModule, OutboxModule],
  providers: [DisputesRepository, DisputesService, DisputesResolver],
  exports: [DisputesService],
})
export class DisputesModule {}
