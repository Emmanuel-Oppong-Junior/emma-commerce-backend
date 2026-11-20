import { Field, ObjectType } from '@nestjs/graphql';
import { PageInfo } from '../../commons/entities/pageInfo.entity';
import { Variant } from './variant.entity';

@ObjectType()
export class VariantEdge {
  @Field({ description: 'Pass as paginationArgs.after to get the next page' })
  cursor: string;

  @Field(() => Variant)
  node: Variant;
}

@ObjectType()
export class VariantConnection {
  @Field(() => [VariantEdge])
  edges: VariantEdge[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}
