import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { SeoModule } from '../seo/seo.module';
import { CommonsModule } from '../commons/commons.module';
import { CollectionsService } from './collections/collections.service';
import { CollectionsResolver } from './collections/collections.resolver';
import { BannersService } from './banners/banners.service';
import { BannersResolver } from './banners/banners.resolver';
import { HomepageService } from './homepage/homepage.service';
import { HomepageResolver } from './homepage/homepage.resolver';
import { PathRedirectsService } from './redirects/path-redirects.service';
import { PathRedirectsResolver } from './redirects/path-redirects.resolver';

// Storefront content (P8-C): collections, banners, homepage sections and path redirects. Public reads are not cached:
// the homepage resolves products whose visibility changes outside this module, so a cached copy could show a product
// that was just unpublished.
@Module({
  imports: [ProductsModule, SeoModule, CommonsModule],
  providers: [
    CollectionsService,
    CollectionsResolver,
    BannersService,
    BannersResolver,
    HomepageService,
    HomepageResolver,
    PathRedirectsService,
    PathRedirectsResolver,
  ],
})
export class ContentModule {}
