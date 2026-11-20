import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { ProductTypesRepository, ProductTypeWithAttributes } from './product-types.repository';

@Injectable({ scope: Scope.REQUEST })
export class ProductTypesLoader {
  constructor(private readonly repository: ProductTypesRepository) {}

  /** Batches the product type (with attributes) lookups of every product in a request. */
  readonly loader = new DataLoader<string, ProductTypeWithAttributes | null>(async (ids: readonly string[]) => {
    const types = await this.repository.findManyByIds([...ids]);
    const byId = new Map(types.map((productType) => [productType.id, productType]));
    return ids.map((id) => byId.get(id) ?? null);
  });
}
