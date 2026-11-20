import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';
import { JobQueue } from '../job-queues';

@ArgsType()
export class FailedJobsArgs {
  @Field(() => JobQueue)
  @IsEnum(JobQueue)
  queue: JobQueue;

  @Field(() => Int, { defaultValue: 20, description: 'How many to return, 1 to 100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 20;
}

@ArgsType()
export class RetryFailedJobArgs {
  @Field(() => JobQueue)
  @IsEnum(JobQueue)
  queue: JobQueue;

  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  jobId: string;
}
