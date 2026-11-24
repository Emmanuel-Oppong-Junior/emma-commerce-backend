import { Module } from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewResolver } from './review.resolver';
import { ReviewRepository } from './review.repository';
import { UsersLoader } from '../users/loaders/users.loader';
import { ProductsLoader } from '../products/loaders/products.loader';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonsModule } from '../commons/commons.module';
import { ProductRatingLoader, ReviewPhotosLoader } from './review.loaders';
import { ProductRatingResolver } from './product-rating.resolver';
import { ReviewPhotoController } from './review-photo.controller';

/** Verified-purchase reviews with photos, moderation and the product rating (P6-V.1). */
@Module({
  imports: [PrismaModule, CommonsModule],
  controllers: [ReviewPhotoController],
  providers: [
    ReviewResolver,
    ReviewService,
    ReviewRepository,
    UsersLoader,
    ProductsLoader,
    ReviewPhotosLoader,
    ProductRatingLoader,
    ProductRatingResolver,
  ],
})
export class ReviewModule {}
