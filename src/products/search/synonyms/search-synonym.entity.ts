import { Field, GraphQLISODateTime, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ArrayMaxSize, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { SearchSynonymKind } from '../../../generated/prisma/client';
import { MAX_SYNONYMS, MAX_TERM_LENGTH } from './synonym-rules';

registerEnumType(SearchSynonymKind, {
  name: 'SearchSynonymKind',
  description: 'How a synonym group expands searches (P6-S.4)',
  valuesMap: {
    TWO_WAY: { description: 'Every term finds the others ("phone, mobile, cellphone")' },
    ONE_WAY: { description: 'term also finds the synonyms, not the reverse ("tv" finds "television")' },
  },
});

@ObjectType({ description: 'A staff-managed search synonym group (P6-S.4)' })
export class SearchSynonym {
  @Field(() => ID)
  id: string;

  @Field(() => SearchSynonymKind)
  kind: SearchSynonymKind;

  @Field(() => String, { nullable: true, description: 'ONE_WAY: the term searched for; null for TWO_WAY' })
  term: string | null;

  @Field(() => [String], { description: 'Lower case, single-spaced' })
  synonyms: string[];

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@InputType()
export class SearchSynonymInput {
  @Field(() => SearchSynonymKind)
  @IsEnum(SearchSynonymKind)
  kind: SearchSynonymKind;

  @Field(() => String, { nullable: true, description: 'ONE_WAY only: the term that also finds the synonyms' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TERM_LENGTH)
  term?: string | null;

  @Field(() => [String], {
    description:
      'TWO_WAY: 2-20 interchangeable terms; ONE_WAY: 1-20 terms. Letters, digits, single spaces and hyphens; ' +
      'stored lower case',
  })
  @ArrayMaxSize(MAX_SYNONYMS)
  @IsString({ each: true })
  @MaxLength(MAX_TERM_LENGTH, { each: true })
  synonyms: string[];
}
