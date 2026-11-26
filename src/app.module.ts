import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ThrottlerModule, ThrottlerOptions } from '@nestjs/throttler';
import { GqlThrottlerGuard } from './commons/guards/gql-throttler.guard';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis/redis.module';
import { PlatformModule } from './platform.module';
import { RedisThrottlerStorage } from './commons/throttler/redis-throttler.storage';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
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
import { ProductTypesModule } from './product-types/product-types.module';
import { TagModule } from './tag/tag.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { ReviewModule } from './review/review.module';
import { ProductQuestionsModule } from './product-questions/product-questions.module';
import { RecentlyViewedModule } from './recently-viewed/recently-viewed.module';
import { PaymentModule } from './payment/payment.module';
import { LoggerMiddleware } from './commons/middlewares/logger.middleware';
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { GraphqlLoggingInterceptor } from './commons/interceptors/graphql-logging.interceptor';
import { formatError } from './commons/error-formatters/grapqhl-error.formatter';
import { LoggerService } from './commons/logger.service';
import { PromotionsModule } from './promotions/promotions.module';
import { CustomerGroupsModule } from './customer-groups/customer-groups.module';
import { PriceListsModule } from './price-lists/price-lists.module';
import { BrandModule } from './brand/brand.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CustomerNotificationsModule } from './notifications/customer/customer-notifications.module';
import { CurrencyModule } from './currency/currency.module';
import { TaxModule } from './tax/tax.module';
import { InventoryModule } from './inventory/inventory.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { ReturnsModule } from './returns/returns.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { PickupLocationsModule } from './pickup-locations/pickup-locations.module';
import { ShippingZonesModule } from './shipping-zones/shipping-zones.module';
import { StoreModule } from './store/store.module';
import { FailedJobsModule } from './jobs/failed-jobs.module';
import { PhoneVerificationModule } from './phone-verification/phone-verification.module';
import { GuestCheckoutModule } from './guest-checkout/guest-checkout.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { ContentModule } from './content/content.module';
import { DeliveryModule } from './delivery/delivery.module';
import { ImportsModule } from './imports/imports.module';
import { ExportsModule } from './exports/exports.module';
import { AppMetrics } from './observability/metrics';
import { graphqlMetricsPlugin } from './observability/graphql-metrics.plugin';
import { HttpMetricsMiddleware } from './observability/http-metrics.middleware';

const THROTTLERS: ThrottlerOptions[] = [
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
  {
    name: 'mfa',
    ttl: 60000, // 1 minute
    limit: 5, // two-factor enrolment, sign-in completion and step-up attempts
  },
  {
    name: 'contentWrite',
    ttl: 60000, // 1 minute
    limit: 10, // reviews, product questions and reports written per minute
  },
  {
    name: 'productView',
    ttl: 60000, // 1 minute
    limit: 60, // recordProductView calls per minute
  },
];

@Module({
  imports: [
    PlatformModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({ storage: new RedisThrottlerStorage(redis), throttlers: THROTTLERS }),
    }),
    UsersModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [CommonsModule],
      useFactory: (logger: LoggerService, metrics: AppMetrics) => ({
        playground: false,
        introspection: process.env.NODE_ENV !== 'production',
        // Apollo 5 answers bad variable values with HTTP 400; keep v4's 200 until the frontend is checked against it.
        status400ForVariableCoercionErrors: false,
        formatError: formatError(logger),
        plugins: [
          process.env.NODE_ENV === 'production'
            ? ApolloServerPluginLandingPageDisabled()
            : ApolloServerPluginLandingPageLocalDefault(),
          queryCostPlugin(),
          graphqlMetricsPlugin(metrics),
        ],
        validationRules: [depthLimitRule(), aliasLimitRule()],
        sortSchema: true,
        autoSchemaFile: 'schema.gql',
        context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
      }),
      inject: [LoggerService, AppMetrics],
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
    ProductTypesModule,
    TagModule,
    WishlistModule,
    ReviewModule,
    ProductQuestionsModule,
    RecentlyViewedModule,
    PaymentModule,
    PromotionsModule,
    CustomerGroupsModule,
    PriceListsModule,
    BrandModule,
    HealthModule,
    NotificationsModule,
    CustomerNotificationsModule,
    CurrencyModule,
    TaxModule,
    InventoryModule,
    PurchasingModule,
    ReturnsModule,
    AnalyticsModule,
    PickupLocationsModule,
    ShippingZonesModule,
    StoreModule,
    FailedJobsModule,
    PhoneVerificationModule,
    DeliveryModule,
    GuestCheckoutModule,
    LoyaltyModule,
    ImportsModule,
    ExportsModule,
    ContentModule,
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
    consumer.apply(LoggerMiddleware, HttpMetricsMiddleware).forRoutes('{*splat}');
  }
}
