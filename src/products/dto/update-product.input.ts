import { CreateProductInput } from './create-product.input';
import { InputType, OmitType, PartialType } from '@nestjs/graphql';

// Stock moves only through restockProduct/adjustProductStock, so an edit form can't overwrite live stock.
@InputType()
export class UpdateProductInput extends PartialType(OmitType(CreateProductInput, ['quantity'] as const)) {}
