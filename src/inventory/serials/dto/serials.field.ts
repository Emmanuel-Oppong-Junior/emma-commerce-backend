import { applyDecorators } from '@nestjs/common';
import { Field } from '@nestjs/graphql';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export const MAX_SERIALS_PER_CHANGE = 1000;

/** An optional list of serial numbers on a stock input (P4-D.1); normalised and checked by the service. */
export function SerialsField(description: string) {
  return applyDecorators(
    Field(() => [String], { nullable: true, description }),
    IsOptional(),
    IsArray(),
    ArrayMaxSize(MAX_SERIALS_PER_CHANGE),
    IsString({ each: true }),
    MaxLength(100, { each: true }),
  );
}
