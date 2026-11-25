import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_REVIEW_COMMENT_LENGTH, MAX_REVIEW_TITLE_LENGTH } from '../review-rules';
import { trim } from './create-review.input';

@InputType({ description: 'Omitted fields stay as they are; title or comment null (or blank) clears it' })
export class UpdateReviewInput {
  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  id: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  score?: number | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(MAX_REVIEW_TITLE_LENGTH)
  title?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(MAX_REVIEW_COMMENT_LENGTH)
  comment?: string | null;
}
