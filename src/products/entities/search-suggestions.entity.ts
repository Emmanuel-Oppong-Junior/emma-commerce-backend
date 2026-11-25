import { ArgsType, Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

export const MAX_SUGGESTIONS = 10;
export const SUGGESTION_PREFIX_MAX_LENGTH = 50;

@ObjectType()
export class Suggestion {
  @Field(() => ID)
  id: string;

  @Field(() => String)
  name: string;
}

@ObjectType({ description: 'Autocomplete for a typed prefix (P6-S.4)' })
export class SearchSuggestions {
  @Field(() => [Suggestion], { description: 'Published products' })
  products: Suggestion[];

  @Field(() => [Suggestion], { description: 'Brands with a published product' })
  brands: Suggestion[];

  @Field(() => [Suggestion], { description: 'Categories with a published product' })
  categories: Suggestion[];
}

@ArgsType()
export class SearchSuggestionsArgs {
  @Field(() => String, {
    description: 'What the customer typed (at most 50 characters); under two letters or digits gives no suggestions',
  })
  @IsString()
  @MaxLength(SUGGESTION_PREFIX_MAX_LENGTH)
  prefix: string;

  @Field(() => Int, { defaultValue: 5, description: 'Suggestions of each kind, 1-10' })
  @IsInt()
  @Min(1)
  @Max(MAX_SUGGESTIONS)
  first: number = 5;
}
