import { Field, ID, InputType } from '@nestjs/graphql';
import { IsArray, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

@InputType()
export class RemoveProductsFromTagDto {
  @Transform((value: any) => value ?? [])
  @Field(() => [ID], {
    description: 'List of product IDs to be added to tag',
    nullable: true,
    defaultValue: [],
  })
  @IsOptional()
  @IsArray({ message: 'Products must be an array of IDs' })
  productIds: string[];
}
