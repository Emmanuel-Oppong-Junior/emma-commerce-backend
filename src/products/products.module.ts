import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsResolver } from './products.resolver';
import { TagModule } from '../tag/tag.module';
import { DiscountModule } from '../discount/discount.module';
import { DiscountLoader } from './loaders/discount.loader';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsRepository } from './products.repository';

@Module({
  providers: [ProductsResolver, ProductsService, ProductsRepository, DiscountLoader],
  imports: [TagModule, DiscountModule, PrismaModule],
})
export class ProductsModule {}
