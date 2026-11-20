import { Field, InputType } from '@nestjs/graphql';
import { ArrayMaxSize, IsOptional, Length, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ATTRIBUTE_KEY_PATTERN, AttributeDefinitionInput } from './attribute-definition.input';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@InputType()
export class CreateProductTypeInput {
  @Field({ description: 'Stable lower-case identifier, e.g. "phone" (letters, digits, underscores)' })
  @Matches(ATTRIBUTE_KEY_PATTERN, {
    message: 'key must start with a lower-case letter and contain only a-z, 0-9 and _ (at most 50 characters)',
  })
  key: string;

  @Field()
  @Transform(trim)
  @Length(1, 100)
  name: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @Field(() => [AttributeDefinitionInput], { nullable: true })
  @IsOptional()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AttributeDefinitionInput)
  attributes?: AttributeDefinitionInput[];
}

@InputType()
export class UpdateProductTypeInput {
  @Field({ nullable: true })
  @IsOptional()
  @Transform(trim)
  @Length(1, 100)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @MaxLength(500)
  description?: string;
}
