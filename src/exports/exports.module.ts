import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/** CSV/XLSX exports of products, stock levels and orders (P8-I). */
@Module({
  imports: [CommonsModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
