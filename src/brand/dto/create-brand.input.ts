import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { SeoFieldsInput } from '../../seo/dto/seo-fields.input';

@InputType()
export class CreateBrandInput extends SeoFieldsInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUrl({ require_tld: true, protocols: ['https'] })
  logo?: string;
}
