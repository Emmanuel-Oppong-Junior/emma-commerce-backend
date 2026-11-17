import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { GqlThrottlerGuard } from './commons/guards/gql-throttler.guard';
import { CacheModule } from '@nestjs/cache-manager';
import { cacheConfig } from './config/cache.config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { envValidationSchema } from './config/env.validation';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { aliasLimitRule, depthLimitRule, queryCostPlugin } from './commons/graphql/query-limits';
import { CommonsModule } from './commons/commons.module';
import { ProductsModule } from './products/products.module';
import { CategoriesModule } from './categories/categories.module';
import { SubCategoriesModule } from './sub-categories/sub-categories.module';
import { MulterModule } from '@nestjs/platform-express';
import { IamModule } from './iam/iam.module';
import { BcryptService } from './iam/hashing/bcrypt.service';
import { CartModule } from './cart/cart.module';
import { OrderModule } from './order/order.module';
import { AddressesModule } from './addresses/addresses.module';
import { VariantModule } from './variant/variant.module';
import { TagModule } from './tag/tag.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { ReviewModule } from './review/review.module';
import { PaymentModule } from './payment/payment.module';
import { LoggerMiddleware } from './commons/middlewares/logger.middleware';
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { GraphqlLoggingInterceptor } from './commons/interceptors/graphql-logging.interceptor';
import { formatError } from './commons/error-formatters/grapqhl-error.formatter';
import { LoggerService } from './commons/logger.service';
import { DiscountModule } from './discount/discount.module';
import { BrandModule } from './brand/brand.module';
import { HealthModule } from './health/health.module';
import { CouponsModule } from './coupons/coupons.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CurrencyModule } from './currency/currency.module';
import { TaxModule } from './tax/tax.module';
import { InventoryModule } from './inventory/inventory.module';
import { ReturnsModule } from './returns/returns.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ScheduleModule } from '@nestjs/schedule';
import { PickupLocationsModule } from './pickup-locations/pickup-locations.module';
import { ShippingZonesModule } from './shipping-zones/shipping-zones.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Tests get their env from .env.test only; never fall through to a developer's .env (real email, Redis).
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    CacheModule.registerAsync(cacheConfig),
    ThrottlerModule.forRoot([
      {
        name: 'global',
        ttl: 60000, // 1 minute
        limit: 120, // 120 requests per minute globally
      },
      {
        name: 'auth',
        ttl: 60000, // 1 minute
        limit: 5,
      },
      {
        name: 'passwordReset',
        ttl: 3600000, // 1 hour
        limit: 3,
      },
      {
        name: 'forgotPassword',
        ttl: 3600000, // 1 hour
        limit: 3,
      },
      {
        name: 'forgotPasswordEmail',
        ttl: 3600000, // 1 hour, per email address
        limit: 3,
      },
      {
        name: 'verificationEmail',
        ttl: 3600000, // 1 hour
        limit: 5,
      },
      {
        name: 'payment',
        ttl: 60000, // 1 minute
        limit: 5, // 5 payment initiations per minute per user
      },
      {
        name: 'upload',
        ttl: 60000, // 1 minute
        limit: 10, // 10 uploads per minute per user
      },
    ]),
    PrismaModule,
    UsersModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [CommonsModule],
      useFactory: (logger: LoggerService) => ({
        playground: false,
        introspection: process.env.NODE_ENV !== 'production',
        formatError: formatError(logger),
        plugins: [
          process.env.NODE_ENV === 'production'
            ? ApolloServerPluginLandingPageDisabled()
            : ApolloServerPluginLandingPageLocalDefault(),
          queryCostPlugin(),
        ],
        validationRules: [depthLimitRule(), aliasLimitRule()],
        sortSchema: true,
        autoSchemaFile: 'schema.gql',
        context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
      }),
      inject: [LoggerService],
    }),
    CommonsModule,
    ProductsModule,
    CategoriesModule,
    SubCategoriesModule,
    MulterModule.register({
      dest: './upload',
    }),
    IamModule,
    CartModule,
    OrderModule,
    AddressesModule,
    VariantModule,
    TagModule,
    WishlistModule,
    ReviewModule,
    PaymentModule,
    DiscountModule,
    BrandModule,
    HealthModule,
    CouponsModule,
    NotificationsModule,
    CurrencyModule,
    TaxModule,
    InventoryModule,
    ReturnsModule,
    AnalyticsModule,
    PickupLocationsModule,
    ShippingZonesModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    BcryptService,
    {
      provide: APP_INTERCEPTOR,
      useClass: GraphqlLoggingInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: GqlThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
