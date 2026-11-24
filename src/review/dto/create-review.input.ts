import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_REVIEW_COMMENT_LENGTH, MAX_REVIEW_TITLE_LENGTH } from '../review-rules';

export const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@InputType()
export class CreateReviewInput {
  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  productId: string;

  @Field(() => Int, { description: 'Rate number 1 - 5' })
  @IsInt()
  @Min(1)
  @Max(5)
  score: number;

  @Field(() => String, { nullable: true, description: `Up to ${MAX_REVIEW_TITLE_LENGTH} characters, trimmed` })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(MAX_REVIEW_TITLE_LENGTH)
  title?: string | null;

  @Field(() => String, { nullable: true, description: `Up to ${MAX_REVIEW_COMMENT_LENGTH} characters, trimmed` })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(MAX_REVIEW_COMMENT_LENGTH)
  comment?: string | null;
}
