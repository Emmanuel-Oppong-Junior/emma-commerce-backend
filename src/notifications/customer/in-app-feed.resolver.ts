import {
  Args,
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Auth } from '../../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../../iam/authentication/enums/auth-type.enum';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { FEED_PAGE_MAX, InAppFeedService } from './in-app-feed.service';

@ObjectType({ description: 'A message in your in-app notification feed' })
export class InAppNotification {
  @Field(() => ID)
  id: string;

  @Field()
  title: string;

  @Field()
  body: string;

  @Field({ description: 'The template it came from, e.g. order.placed, refund.processed' })
  templateKey: string;

  @Field(() => String, { nullable: true, description: 'What it is about: Order (refId = the order id)' })
  refType: string | null;

  @Field(() => ID, { nullable: true })
  refId: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null while unread' })
  readAt: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}

@ObjectType()
export class InAppNotificationPage {
  @Field(() => [InAppNotification])
  nodes: InAppNotification[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}

@ArgsType()
export class MyNotificationsArgs {
  @Field(() => Int, { defaultValue: 20, description: `1-${FEED_PAGE_MAX}` })
  @IsInt()
  @Min(1)
  @Max(FEED_PAGE_MAX)
  first: number = 20;

  @Field(() => ID, { nullable: true, description: 'Id of the last notification of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;

  @Field({ defaultValue: false, description: 'Only unread notifications' })
  @IsBoolean()
  unreadOnly: boolean = false;
}

@Auth(AuthType.Bearer)
@Resolver(() => InAppNotification)
export class InAppFeedResolver {
  constructor(private readonly feed: InAppFeedService) {}

  @Query(() => InAppNotificationPage, {
    description: 'Your in-app notifications, newest first (poll it; kept 90 days)',
  })
  myNotifications(@ActiveUser('id') userId: string, @Args() { first, after, unreadOnly }: MyNotificationsArgs) {
    return this.feed.list(userId, first, after, unreadOnly);
  }

  @Query(() => Int, { description: 'How many of your in-app notifications are unread' })
  unreadNotificationCount(@ActiveUser('id') userId: string) {
    return this.feed.unreadCount(userId);
  }

  @Mutation(() => Int, {
    description:
      'Mark up to 100 of your notifications read; returns how many changed (ids not yours, or already read, are ignored)',
  })
  markNotificationsRead(@ActiveUser('id') userId: string, @Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.feed.markRead(userId, ids);
  }

  @Mutation(() => Int, { description: 'Mark all your notifications read; returns how many changed' })
  markAllNotificationsRead(@ActiveUser('id') userId: string) {
    return this.feed.markAllRead(userId);
  }
}
