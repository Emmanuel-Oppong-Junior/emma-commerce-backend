import { Field, GraphQLISODateTime, InputType } from '@nestjs/graphql';
import { IsBoolean, IsDate, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

/** When a banner, homepage section or collection is live (P8-C). */
@InputType({ isAbstract: true })
export class ScheduleInput {
  @Field(() => Boolean, { nullable: true, description: 'Shown to customers inside its schedule; default true' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Live from this instant; null: at once' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  startsAt?: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'Live until just before this instant (after startsAt); null: open-ended',
  })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endsAt?: Date | null;
}
