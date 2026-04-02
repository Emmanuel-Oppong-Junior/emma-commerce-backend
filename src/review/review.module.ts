import { Module } from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewResolver } from './review.resolver';
import { ReviewRepository } from './review.repository';
import { UsersLoader } from '../users/loaders/users.loader';
import { ProductsLoader } from '../products/loaders/products.loader';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ReviewResolver, ReviewService, ReviewRepository, UsersLoader, ProductsLoader],
})
export class ReviewModule {}
