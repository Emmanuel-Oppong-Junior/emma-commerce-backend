import { Field, InputType } from '@nestjs/graphql';
import { ArrayNotEmpty, ArrayUnique, IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

@InputType()
export class CreateStaffRoleInput {
  @Field({ description: 'Unique key: upper case letters, digits and underscores, 2-40 characters (e.g. STOCK_TAKER)' })
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, { message: 'key must be 2-40 upper case letters, digits or underscores' })
  key: string;

  @Field()
  @IsString()
  @Length(2, 60)
  name: string;

  @Field(() => [String], { description: 'Permission keys from staffPermissions; you must hold each of them' })
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  permissions: string[];

  @Field({ defaultValue: false, description: 'Require holders to enrol two-factor authentication' })
  @IsOptional()
  @IsBoolean()
  mfaRequired?: boolean;
}

@InputType()
export class UpdateStaffRoleInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @Length(2, 60)
  name?: string;

  @Field(() => [String], { nullable: true, description: 'Replaces the permission list; you must hold each of them' })
  @IsOptional()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  mfaRequired?: boolean;
}
