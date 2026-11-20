import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { FailedJob } from './entities/failed-job.entity';
import { FailedJobsArgs, RetryFailedJobArgs } from './dto/failed-jobs.args';
import { FailedJobsService } from './failed-jobs.service';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => FailedJob)
export class FailedJobsResolver {
  constructor(private readonly failedJobsService: FailedJobsService) {}

  @RequirePermission('jobs.manage')
  @Query(() => [FailedJob], {
    description:
      'Background jobs of one queue that failed their last attempt, newest first (super admin only; audited)',
  })
  failedJobs(@ActiveUser('id') actorId: string, @Args() { queue, first }: FailedJobsArgs) {
    return this.failedJobsService.list(queue, first, actorId);
  }

  @RequirePermission('jobs.manage')
  @Mutation(() => FailedJob, {
    description: 'Send a failed job back to the queue with its attempts reset (super admin only; audited)',
  })
  retryFailedJob(@ActiveUser('id') actorId: string, @Args() { queue, jobId }: RetryFailedJobArgs) {
    return this.failedJobsService.retry(queue, jobId, actorId);
  }
}
