import { Field, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsBoolean, IsEnum } from 'class-validator';
import { StoreFeatureKey } from './store-feature-registry';

registerEnumType(StoreFeatureKey, {
  name: 'StoreFeatureKey',
  description: 'A store-level feature the Owner can switch off (CASH_ON_DELIVERY is the payment method switch)',
});

@ObjectType('StoreFeature', { description: 'Whether a store-level feature is on, so the storefront can hide it' })
export class StoreFeatureEntity {
  @Field(() => StoreFeatureKey)
  key: StoreFeatureKey;

  @Field()
  enabled: boolean;

  @Field()
  description: string;
}

@InputType()
export class SetStoreFeatureInput {
  @Field(() => StoreFeatureKey)
  @IsEnum(StoreFeatureKey)
  key: StoreFeatureKey;

  @Field()
  @IsBoolean()
  enabled: boolean;
}
