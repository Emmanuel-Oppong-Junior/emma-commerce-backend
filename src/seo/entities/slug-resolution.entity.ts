import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { SlugEntityType } from '../../generated/prisma/client';

registerEnumType(SlugEntityType, {
  name: 'SlugEntityType',
  description: 'The kind of catalogue page a slug belongs to; slugs are unique per kind',
});

@ObjectType({ description: 'Where a slug leads: the entity and its current slug' })
export class SlugResolution {
  @Field(() => SlugEntityType)
  type: SlugEntityType;

  @Field(() => ID)
  id: string;

  @Field(() => String, { description: 'The current slug; link to it (301) when redirected is true' })
  slug: string;

  @Field(() => Boolean, { description: 'The slug asked for is an old one of this entity' })
  redirected: boolean;
}
