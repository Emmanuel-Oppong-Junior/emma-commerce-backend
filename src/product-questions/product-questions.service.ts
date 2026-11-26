import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentReportReason, ModerationStatus, ProductQuestion } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { StoreFeaturesService } from '../store-features/store-features.service';
import { ContentPageArgs } from '../review/dto/review-list.args';
import { ModerateContentInput, ReportContentInput } from '../review/dto/review-moderation.inputs';
import { cleanText, ModerationAction, moderationRefusal, reportRefusal } from '../review/review-rules';
import { ALREADY_REPORTED } from '../review/review.service';
import { AnswerProductQuestionInput, AskProductQuestionInput, ProductQuestionsArgs } from './product-questions.inputs';
import { ProductQuestionsRepository } from './product-questions.repository';

export interface QuestionViewer {
  userId?: string;
  canModerate: boolean;
}

@Injectable()
export class ProductQuestionsService {
  constructor(
    private readonly repository: ProductQuestionsRepository,
    private readonly audit: AuditService,
    private readonly features: StoreFeaturesService,
  ) {}

  /** A signed-in customer's question on a public product; it shows publicly once staff answer it. */
  async ask(userId: string, input: AskProductQuestionInput): Promise<ProductQuestion> {
    await this.features.assertEnabled('PRODUCT_QA');
    await this.assertPublicProduct(input.productId);
    return this.repository.create({ productId: input.productId, userId, body: input.body });
  }

  /** Answered, published questions of a public product, latest answer first. */
  async getProductQuestions(args: ProductQuestionsArgs): Promise<ProductQuestion[]> {
    await this.assertPublicProduct(args.productId);
    return this.repository.findPublic(args.productId, args.first, args.after);
  }

  /** A public question; its asker and moderators also see it unanswered or hidden. */
  async getQuestion(questionId: string, viewer: QuestionViewer): Promise<ProductQuestion> {
    const question = await this.repository.findById(questionId);
    if (question && (viewer.canModerate || question.userId === viewer.userId)) return question;
    if (
      !question ||
      !this.repository.isPublic(question) ||
      !(await this.repository.isPublicProduct(question.productId))
    ) {
      throw new NotFoundException(`Question "${questionId}" not found`);
    }
    return question;
  }

  getUserQuestions(userId: string, page: ContentPageArgs): Promise<ProductQuestion[]> {
    return this.repository.findByUser(userId, page.first, page.after);
  }

  getUnansweredQuestions(page: ContentPageArgs): Promise<ProductQuestion[]> {
    return this.repository.findUnanswered(page.first, page.after);
  }

  getReportedQuestions(page: ContentPageArgs) {
    return this.repository.findReported(page.first, page.after);
  }

  /** Sets or replaces the store's answer (audited). */
  async answer(actorId: string, input: AnswerProductQuestionInput): Promise<ProductQuestion> {
    return this.repository.transaction(async (tx) => {
      const current = await this.repository.lock(tx, input.questionId);
      if (!current) throw new NotFoundException(`Question "${input.questionId}" not found`);
      const question = await this.repository.update(tx, current.id, { answer: input.answer, answeredAt: new Date() });
      await this.audit.log(
        {
          entity: 'ProductQuestion',
          entityId: current.id,
          action: 'UPDATE',
          userId: actorId,
          details: { answer: { from: current.answer, to: question.answer } },
        },
        tx,
      );
      return question;
    });
  }

  async report(userId: string, input: ReportContentInput): Promise<boolean> {
    await this.features.assertEnabled('PRODUCT_QA');
    const question = await this.getQuestion(input.id, { canModerate: false });
    const refusal = reportRefusal(question.userId, userId);
    if (refusal) throw new BadRequestException(refusal);
    const note = cleanText(input.note);
    if (input.reason === ContentReportReason.OTHER && !note) {
      throw new BadRequestException('A note is required when the reason is OTHER');
    }
    if (await this.repository.findReport(question.id, userId)) {
      throw new ConflictException({
        message: `You have already reported question "${question.id}"`,
        extensions: { reason: ALREADY_REPORTED },
      });
    }
    await this.repository.createReport({ questionId: question.id, reporterId: userId, reason: input.reason, note });
    return true;
  }

  hide(actorId: string, input: ModerateContentInput): Promise<ProductQuestion> {
    return this.moderate(actorId, input, 'HIDE');
  }

  unhide(actorId: string, input: ModerateContentInput): Promise<ProductQuestion> {
    return this.moderate(actorId, input, 'UNHIDE');
  }

  async dismissReports(actorId: string, input: ModerateContentInput): Promise<ProductQuestion> {
    return this.repository.transaction(async (tx) => {
      const question = await this.repository.lock(tx, input.id);
      if (!question) throw new NotFoundException(`Question "${input.id}" not found`);
      const dismissed = await this.repository.resolveReports(tx, question.id, new Date());
      await this.audit.log(
        {
          entity: 'ProductQuestion',
          entityId: question.id,
          action: 'UPDATE',
          userId: actorId,
          details: { dismissedReports: dismissed, reason: input.reason },
        },
        tx,
      );
      return question;
    });
  }

  private moderate(actorId: string, input: ModerateContentInput, action: ModerationAction): Promise<ProductQuestion> {
    return this.repository.transaction(async (tx) => {
      const current = await this.repository.lock(tx, input.id);
      if (!current) throw new NotFoundException(`Question "${input.id}" not found`);
      const refusal = moderationRefusal(current.status, action);
      if (refusal) throw new ConflictException(`Question "${current.id}": ${refusal}`);
      const now = new Date();
      const question = await this.repository.update(
        tx,
        current.id,
        action === 'HIDE'
          ? { status: ModerationStatus.HIDDEN, hiddenAt: now, hiddenReason: input.reason }
          : { status: ModerationStatus.PUBLISHED, hiddenAt: null, hiddenReason: null },
      );
      const resolvedReports = action === 'HIDE' ? await this.repository.resolveReports(tx, current.id, now) : 0;
      await this.audit.log(
        {
          entity: 'ProductQuestion',
          entityId: current.id,
          action: 'STATUS_CHANGE',
          userId: actorId,
          details: { from: current.status, to: question.status, reason: input.reason, resolvedReports },
        },
        tx,
      );
      return question;
    });
  }

  private async assertPublicProduct(productId: string): Promise<void> {
    if (!(await this.repository.isPublicProduct(productId))) {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
  }
}
