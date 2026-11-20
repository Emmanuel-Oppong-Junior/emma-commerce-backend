import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsResolver } from './products.resolver';
import { TagModule } from '../tag/tag.module';
import { DiscountModule } from '../discount/discount.module';
import { DiscountLoader } from './loaders/discount.loader';
import { VariantsLoader } from './loaders/variants.loader';
import { ReviewsLoader } from './loaders/reviews.loader';
import { ProductsLoader } from './loaders/products.loader';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsRepository } from './products.repository';
import { TaxModule } from '../tax/tax.module';
import { CommonsModule } from '../commons/commons.module';
import { ProductTypesModule } from '../product-types/product-types.module';
import { VariantModule } from '../variant/variant.module';
import {
  BrandProductsResolver,
  CategoryProductsResolver,
  SubCategoryProductsResolver,
} from './nested-products.resolver';

@Module({
  providers: [
    ProductsResolver,
    CategoryProductsResolver,
    SubCategoryProductsResolver,
    BrandProductsResolver,
    ProductsService,
    ProductsRepository,
    DiscountLoader,
    VariantsLoader,
    ReviewsLoader,
    ProductsLoader,
  ],
  imports: [TagModule, DiscountModule, PrismaModule, TaxModule, CommonsModule, ProductTypesModule, VariantModule],
  exports: [ProductsLoader],
})
export class ProductsModule {}
