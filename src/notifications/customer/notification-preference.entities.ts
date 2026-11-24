import { Field, GraphQLISODateTime, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { ConsentAction, ConsentSource, NotificationCategory, NotificationChannel } from '../../generated/prisma/client';

registerEnumType(NotificationCategory, {
  name: 'NotificationCategory',
  description: 'TRANSACTIONAL (codes, receipts, order updates: always on) or MARKETING (opt-in only)',
});
registerEnumType(NotificationChannel, { name: 'NotificationChannel' });
registerEnumType(ConsentAction, { name: 'ConsentAction' });
registerEnumType(ConsentSource, {
  name: 'ConsentSource',
  description: 'Where a consent change came from: CHECKOUT, ACCOUNT_SETTINGS, STAFF_REQUEST or EMAIL_LINK',
});

/** The sources a customer may name for their own change; staff and email links have their own operations. */
export const CUSTOMER_CONSENT_SOURCES = [ConsentSource.CHECKOUT, ConsentSource.ACCOUNT_SETTINGS] as const;
export type CustomerConsentSource = (typeof CUSTOMER_CONSENT_SOURCES)[number];

@ObjectType({ description: 'Whether a category of messages reaches the customer on a channel' })
export class NotificationPreferenceEntity {
  @Field(() => NotificationCategory)
  category: NotificationCategory;

  @Field(() => NotificationChannel)
  channel: NotificationChannel;

  @Field()
  enabled: boolean;

  @Field({ description: 'True when the customer cannot switch it off (transactional messages)' })
  locked: boolean;
}

@InputType()
export class UpdateNotificationPreferenceInput {
  @Field(() => NotificationCategory)
  @IsEnum(NotificationCategory)
  category: NotificationCategory;

  @Field(() => NotificationChannel)
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;

  @Field()
  @IsBoolean()
  enabled: boolean;

  @Field(() => ConsentSource, {
    nullable: true,
    defaultValue: ConsentSource.ACCOUNT_SETTINGS,
    description: 'CHECKOUT (the opt-in box at checkout) or ACCOUNT_SETTINGS (default)',
  })
  @IsOptional()
  @IsIn(CUSTOMER_CONSENT_SOURCES)
  source?: CustomerConsentSource;
}

@InputType()
export class RecordCustomerConsentInput {
  @Field(() => ID)
  @IsString()
  userId: string;

  @Field(() => NotificationChannel, { description: 'EMAIL or SMS (marketing)' })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;

  @Field({ description: 'true: the customer asked to receive marketing; false: to stop it' })
  @IsBoolean()
  granted: boolean;
}

@ObjectType({ description: 'One entry of the consent ledger (append-only)' })
export class ConsentEventEntity {
  @Field(() => ID)
  id: string;

  @Field(() => NotificationCategory)
  category: NotificationCategory;

  @Field(() => NotificationChannel)
  channel: NotificationChannel;

  @Field(() => ConsentAction)
  action: ConsentAction;

  @Field(() => ConsentSource)
  source: ConsentSource;

  @Field(() => ID, { nullable: true, description: 'The staff member who recorded it (STAFF_REQUEST)' })
  actorId: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}
