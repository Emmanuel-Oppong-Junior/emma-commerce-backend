import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RecentlyViewedRepository } from './recently-viewed.repository';
import { RecentlyViewedResolver } from './recently-viewed.resolver';
import { RecentlyViewedService } from './recently-viewed.service';

/** Recently viewed products of signed-in users (P6-G.3). */
@Module({
  imports: [PrismaModule],
  providers: [RecentlyViewedResolver, RecentlyViewedService, RecentlyViewedRepository],
})
export class RecentlyViewedModule {}
