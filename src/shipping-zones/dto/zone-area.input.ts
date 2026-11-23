import { Field, InputType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { GhanaRegion } from '../../addresses/enums/ghana-region.enum';

@InputType({
  description:
    'A place a zone delivers to: a region alone, a town alone, or an area within a town. Towns and areas are matched ' +
    'without regard to case, accents, punctuation or repeated spaces',
})
export class ZoneAreaInput {
  @Field(() => GhanaRegion, { nullable: true })
  @IsOptional()
  @IsEnum(GhanaRegion)
  region?: GhanaRegion;

  @Field({ nullable: true, description: "Matched against the address's city" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  town?: string;

  @Field({ nullable: true, description: "Matched against the address's area; needs town" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  area?: string;
}
