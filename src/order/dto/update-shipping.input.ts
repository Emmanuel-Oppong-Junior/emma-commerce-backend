import { Field, ID, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class UpdateShippingInput {
  @Field(() => ID)
  @IsNotEmpty()
  orderId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  carrier?: string;
}
