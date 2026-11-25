import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { ActiveAccess, CustomerOnly, RequirePermission } from '../iam/authorization/policy.decorators';
import { hasPermission, StaffAccess } from '../iam/authorization/staff-access';
import { Product } from '../products/entities/product.entity';
import { ProductsLoader } from '../products/loaders/products.loader';
import { ContentPageArgs } from '../review/dto/review-list.args';
import { ModerateContentInput, ReportContentInput } from '../review/dto/review-moderation.inputs';
import { CONTENT_WRITE_LIMIT } from '../review/review.resolver';
import { PublicProfile, toPublicProfile } from '../users/entities/public-profile.entity';
import { UsersLoader } from '../users/loaders/users.loader';
import { ProductQuestion, ReportedProductQuestion } from './product-question.entity';
import { AnswerProductQuestionInput, AskProductQuestionInput, ProductQuestionsArgs } from './product-questions.inputs';
import { ProductQuestionsService } from './product-questions.service';

@Auth(AuthType.Bearer)
@Resolver(() => ProductQuestion)
export class ProductQuestionsResolver {
  constructor(
    private readonly service: ProductQuestionsService,
    private readonly usersLoader: UsersLoader,
    private readonly productsLoader: ProductsLoader,
  ) {}

  @Auth(AuthType.Optional)
  @Query(() => [ProductQuestion], {
    name: 'productQuestions',
    description: 'Answered questions of a public product, latest answer first, a page at a time',
  })
  getProductQuestions(@Args() args: ProductQuestionsArgs) {
    return this.service.getProductQuestions(args);
  }

  @Auth(AuthType.Optional)
  @Query(() => ProductQuestion, {
    name: 'productQuestion',
    description: 'An answered question of a public product; its asker and moderators also see it unanswered or hidden',
  })
  getProductQuestion(
    @Args('questionId', { type: () => String }) questionId: string,
    @ActiveUser('id') userId: string | undefined,
    @ActiveAccess() access: StaffAccess,
  ) {
    return this.service.getQuestion(questionId, { userId, canModerate: hasPermission(access, 'review.moderate') });
  }

  @Query(() => [ProductQuestion], {
    name: 'myProductQuestions',
    description: "The caller's own questions, answered or not, newest first",
  })
  getMyProductQuestions(@ActiveUser('id') userId: string, @Args() page: ContentPageArgs) {
    return this.service.getUserQuestions(userId, page);
  }

  @RequirePermission('review.moderate')
  @Query(() => [ProductQuestion], {
    name: 'unansweredProductQuestions',
    description: 'Published questions waiting for an answer, oldest first',
  })
  getUnansweredProductQuestions(@Args() page: ContentPageArgs) {
    return this.service.getUnansweredQuestions(page);
  }

  @RequirePermission('review.moderate')
  @Query(() => [ReportedProductQuestion], {
    name: 'reportedProductQuestions',
    description: 'Moderation queue: questions with open reports, oldest question first',
  })
  async getReportedProductQuestions(@Args() page: ContentPageArgs) {
    const questions = await this.service.getReportedQuestions(page);
    return questions.map(({ reports, ...question }) => ({ question, openReports: reports }));
  }

  @CustomerOnly()
  @Throttle(CONTENT_WRITE_LIMIT)
  @Mutation(() => ProductQuestion, {
    name: 'askProductQuestion',
    description: 'Asks a question about a public product; it shows publicly once the store answers it',
  })
  askProductQuestion(@ActiveUser('id') userId: string, @Args('input') input: AskProductQuestionInput) {
    return this.service.ask(userId, input);
  }

  @CustomerOnly()
  @Throttle(CONTENT_WRITE_LIMIT)
  @Mutation(() => Boolean, {
    name: 'reportProductQuestion',
    description: 'Reports a public question to staff; once per customer and question (ALREADY_REPORTED)',
  })
  reportProductQuestion(@ActiveUser('id') userId: string, @Args('input') input: ReportContentInput) {
    return this.service.report(userId, input);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => ProductQuestion, {
    name: 'answerProductQuestion',
    description: "Sets or replaces the store's answer, which makes the question public unless hidden (audited)",
  })
  answerProductQuestion(@ActiveUser('id') actorId: string, @Args('input') input: AnswerProductQuestionInput) {
    return this.service.answer(actorId, input);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => ProductQuestion, {
    name: 'hideProductQuestion',
    description: 'Hides a question from public reads, closing its open reports (audited)',
  })
  hideProductQuestion(@ActiveUser('id') actorId: string, @Args('input') input: ModerateContentInput) {
    return this.service.hide(actorId, input);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => ProductQuestion, {
    name: 'unhideProductQuestion',
    description: 'Publishes a hidden question again (audited)',
  })
  unhideProductQuestion(@ActiveUser('id') actorId: string, @Args('input') input: ModerateContentInput) {
    return this.service.unhide(actorId, input);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => ProductQuestion, {
    name: 'dismissProductQuestionReports',
    description: "Closes a question's open reports and leaves it as it is (audited)",
  })
  dismissProductQuestionReports(@ActiveUser('id') actorId: string, @Args('input') input: ModerateContentInput) {
    return this.service.dismissReports(actorId, input);
  }

  @ResolveField(() => PublicProfile)
  async user(@Parent() question: ProductQuestion): Promise<PublicProfile> {
    return toPublicProfile(await this.usersLoader.loader.load(question.userId));
  }

  @ResolveField(() => Product)
  product(@Parent() question: ProductQuestion) {
    return this.productsLoader.loader.load(question.productId);
  }
}
