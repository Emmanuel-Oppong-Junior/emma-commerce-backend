import { ArgsType, Field, ID, InputType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { ContentPageArgs } from '../review/dto/review-list.args';
import { trim } from '../review/dto/create-review.input';

export const MIN_QUESTION_LENGTH = 5;
export const MAX_QUESTION_LENGTH = 1000;
export const MAX_ANSWER_LENGTH = 2000;

@ArgsType()
export class ProductQuestionsArgs extends ContentPageArgs {
  @Field(() => ID)
  @IsString()
  productId: string;
}

@InputType()
export class AskProductQuestionInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  productId: string;

  @Field({ description: `${MIN_QUESTION_LENGTH}-${MAX_QUESTION_LENGTH} characters, trimmed` })
  @IsString()
  @Transform(trim)
  @MinLength(MIN_QUESTION_LENGTH)
  @MaxLength(MAX_QUESTION_LENGTH)
  body: string;
}

@InputType()
export class AnswerProductQuestionInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  questionId: string;

  @Field({ description: `Up to ${MAX_ANSWER_LENGTH} characters, trimmed; replaces an earlier answer` })
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(MAX_ANSWER_LENGTH)
  answer: string;
}
