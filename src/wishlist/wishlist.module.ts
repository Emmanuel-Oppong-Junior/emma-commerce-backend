import { Module } from '@nestjs/common';
import { WishlistService } from './wishlist.service';
import { WishlistResolver } from './wishlist.resolver';
import { WishlistRepository } from './wishlist.repository';

@Module({
  providers: [WishlistResolver, WishlistService, WishlistRepository],
})
export class WishlistModule {}
