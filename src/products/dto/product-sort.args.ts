import { Field, InputType } from '@nestjs/graphql';
import { IsEnum, IsOptional } from 'class-validator';
import { ProductSortField } from '../enums/product-sort-field.enum';
import { SortOrder } from '../../commons/enums/sort-order.enum';

@InputType()
export class ProductSortArgs {
  @Field(() => ProductSortField, {
    nullable: true,
    defaultValue: ProductSortField.CREATED_AT,
    description: 'Field to sort products by',
  })
  @IsOptional()
  @IsEnum(ProductSortField)
  sortBy?: ProductSortField = ProductSortField.CREATED_AT;

  @Field(() => SortOrder, {
    nullable: true,
    defaultValue: SortOrder.DESC,
    description: 'Sort direction',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder = SortOrder.DESC;
}
