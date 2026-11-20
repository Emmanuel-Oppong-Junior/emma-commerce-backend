import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { JobQueue } from '../job-queues';

registerEnumType(JobQueue, { name: 'JobQueue', description: 'Background job queues run by the worker' });

@ObjectType({ description: 'A background job that failed its last attempt. Job data is never exposed.' })
export class FailedJob {
  @Field(() => JobQueue)
  queue: JobQueue;

  @Field(() => ID)
  id: string;

  @Field({ description: 'Job name: an outbox event type (order.placed.v1), an email or a maintenance job' })
  name: string;

  @Field(() => Int)
  attemptsMade: number;

  @Field(() => Int)
  maxAttempts: number;

  @Field({ description: 'Last error, with email addresses masked' })
  failedReason: string;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  failedAt: Date | null;
}
