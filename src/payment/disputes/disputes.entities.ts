import { ArgsType, Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsDate, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { DisputeSource, DisputeStatus, PaymentProvider } from '../../generated/prisma/client';
import { MoneyObject } from '../../commons/money/money.object';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';

registerEnumType(DisputeStatus, {
  name: 'DisputeStatus',
  description:
    'OPEN, AWAITING_EVIDENCE (answer by evidenceDueAt), UNDER_REVIEW (with the bank); resolved: WON, LOST, ACCEPTED (the merchant accepted the claim)',
});
registerEnumType(DisputeSource, {
  name: 'DisputeSource',
  description: 'PROVIDER: from the payment provider webhook; STAFF: recorded or changed by staff',
});
registerEnumType(PaymentProvider, { name: 'PaymentProvider' });

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@ObjectType({ description: 'A staff evidence note; notes are append-only' })
export class DisputeNoteEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  authorId: string;

  @Field()
  body: string;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}

@ObjectType({ description: 'One status change of a dispute' })
export class DisputeHistoryEntry {
  @Field(() => ID)
  id: string;

  @Field(() => DisputeStatus, { nullable: true, description: 'Null for the entry that opened the dispute' })
  fromStatus: DisputeStatus | null;

  @Field(() => DisputeStatus)
  toStatus: DisputeStatus;

  @Field(() => DisputeSource)
  source: DisputeSource;

  @Field(() => ID, { nullable: true, description: 'The staff user, for STAFF changes' })
  actorId: string | null;

  @Field(() => String, { nullable: true, description: "The provider's own status, for PROVIDER changes" })
  providerStatus: string | null;

  @Field(() => String, { nullable: true })
  note: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}

@ObjectType({ description: 'A chargeback or dispute on a captured payment' })
export class DisputeEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID, { description: 'The disputed payment (attempt)' })
  attemptId: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => PaymentProvider)
  provider: PaymentProvider;

  @Field(() => String, { nullable: true, description: "The provider's dispute id (unique per provider)" })
  providerDisputeId: string | null;

  @Field(() => MoneyObject)
  amount: Decimal;

  @Field()
  currency: string;

  @Field(() => String, { nullable: true, description: 'e.g. chargeback, fraud' })
  category: string | null;

  @Field(() => String, { nullable: true })
  reason: string | null;

  @Field(() => DisputeStatus)
  status: DisputeStatus;

  @Field(() => DisputeSource, { description: 'Who opened it' })
  source: DisputeSource;

  @Field(() => GraphQLISODateTime, { nullable: true })
  evidenceDueAt: Date | null;

  @Field(() => GraphQLISODateTime)
  openedAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  resolvedAt: Date | null;

  @Field(() => ID, { nullable: true, description: 'The staff user who recorded it by hand' })
  createdById: string | null;

  @Field(() => [DisputeNoteEntity], { description: 'Oldest first' })
  notes: DisputeNoteEntity[];

  @Field(() => [DisputeHistoryEntry], { description: 'Status changes, oldest first' })
  history: DisputeHistoryEntry[];

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ArgsType()
export class DisputesArgs {
  @Field(() => DisputeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;

  @Field(() => ID, { nullable: true, description: 'Only the disputes of this payment (attempt)' })
  @IsOptional()
  @IsString()
  paymentId?: string;

  @Field(() => Int, { defaultValue: 20, description: '1-50, newest first' })
  @IsInt()
  @Min(1)
  @Max(50)
  first: number = 20;
}

@InputType()
export class RecordDisputeInput {
  @Field(() => ID, { description: 'The captured online payment (attempt) disputed' })
  @IsString()
  @IsNotEmpty()
  paymentId: string;

  @DecimalInputField({ description: 'More than 0, at most the payment amount' })
  @IsMoneyAmount({ positive: true })
  amount: Decimal;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  category?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @Field(() => String, { nullable: true, description: "The provider's dispute id, when it has one" })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  providerDisputeId?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  evidenceDueAt?: Date;

  @Field(() => DisputeStatus, {
    nullable: true,
    description: 'OPEN (default), AWAITING_EVIDENCE or UNDER_REVIEW',
  })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;
}

@InputType()
export class UpdateDisputeStatusInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  disputeId: string;

  @Field(() => DisputeStatus)
  @IsEnum(DisputeStatus)
  status: DisputeStatus;

  @Field(() => String, { nullable: true, description: 'Kept in the dispute history' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

@InputType()
export class AddDisputeNoteInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  disputeId: string;

  @Field({ description: 'Evidence or a step taken; notes cannot be edited or deleted' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body: string;
}
