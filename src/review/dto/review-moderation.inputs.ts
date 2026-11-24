import { Field, ID, InputType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ContentReportReason } from '../../generated/prisma/client';
import { MAX_MODERATION_REASON_LENGTH, MAX_REPORT_NOTE_LENGTH, MAX_REVIEW_REPLY_LENGTH } from '../review-rules';
import { trim } from './create-review.input';

@InputType()
export class ReportContentInput {
  @Field(() => ID, { description: 'The review or question reported' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @Field(() => ContentReportReason)
  @IsEnum(ContentReportReason)
  reason: ContentReportReason;

  @Field(() => String, {
    nullable: true,
    description: `Up to ${MAX_REPORT_NOTE_LENGTH} characters; required for OTHER`,
  })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(MAX_REPORT_NOTE_LENGTH)
  note?: string | null;
}

@InputType()
export class ModerateContentInput {
  @Field(() => ID, { description: 'The review or question' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @Field(() => String, { description: 'Why (staff only, audited)' })
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(MAX_MODERATION_REASON_LENGTH)
  reason: string;
}

@InputType()
export class ReplyToReviewInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  reviewId: string;

  @Field(() => String, { description: 'The public reply; replaces an earlier one' })
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(MAX_REVIEW_REPLY_LENGTH)
  body: string;
}
