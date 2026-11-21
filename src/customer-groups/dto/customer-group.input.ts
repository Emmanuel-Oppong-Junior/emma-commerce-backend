import { ArgsType, Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const MAX_MEMBERS_PER_CALL = 500;

@InputType()
export class CreateCustomerGroupInput {
  @Field({ description: 'Unique, max 100' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

@InputType({ description: 'Omitted fields stay as they are; null clears the description' })
export class UpdateCustomerGroupInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

@InputType()
export class CustomerGroupMembersInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  groupId: string;

  @Field(() => [ID], { description: `1-${MAX_MEMBERS_PER_CALL} user ids` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MEMBERS_PER_CALL)
  @IsString({ each: true })
  userIds: string[];
}

/** One page of a group's members, by user id; `after` is the last user id of the previous page. */
@ArgsType()
export class CustomerGroupMembersArgs {
  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  after?: string;
}
