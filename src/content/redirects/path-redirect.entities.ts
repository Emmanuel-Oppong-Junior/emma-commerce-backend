import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsIn, IsOptional, IsString } from 'class-validator';

@ObjectType({ description: 'A staff-entered storefront path redirect' })
export class PathRedirect {
  @Field(() => ID)
  id: string;

  @Field(() => String, { description: 'Path that redirects (no query, no trailing slash)' })
  fromPath: string;

  @Field(() => String, { description: 'Internal path it redirects to (may have a query)' })
  toPath: string;

  @Field(() => Int, { description: '301 (permanent) or 302 (temporary)' })
  statusCode: number;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ObjectType({ description: 'Where a storefront path redirects to, after following every redirect from it' })
export class PathResolution {
  @Field(() => String)
  toPath: string;

  @Field(() => Int, { description: '301 when every redirect followed is permanent, else 302' })
  statusCode: number;
}

@InputType()
export class CreatePathRedirectInput {
  @Field(() => String, {
    description:
      'Internal path starting with one "/", no query or fragment, max 500 characters; a trailing "/" is dropped. Unique.',
  })
  @IsString()
  fromPath: string;

  @Field(() => String, { description: 'Internal path starting with one "/" (a query is allowed); never a loop' })
  @IsString()
  toPath: string;

  @Field(() => Int, { nullable: true, defaultValue: 301, description: '301 (default) or 302' })
  @IsOptional()
  @IsIn([301, 302])
  statusCode?: number;
}
