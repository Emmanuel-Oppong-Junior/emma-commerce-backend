import { Field, ID, InputType } from '@nestjs/graphql';
import { IsString, MinLength } from 'class-validator';

@InputType()
export class CreateReturnRequestInput {
  @Field(() => ID)
  @IsString()
  orderId: string;

  @Field()
  @IsString()
  @MinLength(10)
  reason: string;
}
