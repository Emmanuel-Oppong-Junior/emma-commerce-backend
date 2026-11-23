import { Field, ID, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class UpdateShippingInput {
  @Field(() => ID, { description: 'The shipment whose carrier and tracking number are set' })
  @IsNotEmpty()
  shipmentId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  carrier?: string;
}
