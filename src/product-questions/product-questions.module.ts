import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsLoader } from '../products/loaders/products.loader';
import { UsersLoader } from '../users/loaders/users.loader';
import { ProductQuestionsRepository } from './product-questions.repository';
import { ProductQuestionsResolver } from './product-questions.resolver';
import { ProductQuestionsService } from './product-questions.service';

/** Product questions and the store's answers (P6-V.2). */
@Module({
  imports: [PrismaModule, CommonsModule],
  providers: [
    ProductQuestionsResolver,
    ProductQuestionsService,
    ProductQuestionsRepository,
    UsersLoader,
    ProductsLoader,
  ],
})
export class ProductQuestionsModule {}
