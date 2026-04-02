import { Module } from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewResolver } from './review.resolver';
import { ReviewRepository } from './review.repository';

@Module({
  providers: [ReviewResolver, ReviewService, ReviewRepository],
})
export class ReviewModule {}
