import { Field, Float, ID, InputType } from '@nestjs/graphql';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

@InputType()
export class ApproveReturnInput {
  @Field(() => ID)
  @IsString()
  returnRequestId: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  refundAmount: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  adminNote?: string;
}

@InputType()
export class RejectReturnInput {
  @Field(() => ID)
  @IsString()
  returnRequestId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  adminNote?: string;
}
