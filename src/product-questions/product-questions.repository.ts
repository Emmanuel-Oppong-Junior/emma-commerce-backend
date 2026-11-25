import { Injectable } from '@nestjs/common';
import { ModerationStatus, Prisma, ProductQuestion } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_PRODUCT_WHERE } from '../products/products.service';

type Tx = Prisma.TransactionClient;

const page = (first: number, after?: string | null): { take: number; skip?: number; cursor?: { id: string } } =>
  after ? { take: first, skip: 1, cursor: { id: after } } : { take: first };

/** Answered and not hidden: what anyone may read. */
const PUBLIC_QUESTION = {
  status: ModerationStatus.PUBLISHED,
  answeredAt: { not: null },
} satisfies Prisma.ProductQuestionWhereInput;

@Injectable()
export class ProductQuestionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async isPublicProduct(productId: string): Promise<boolean> {
    return (await this.prisma.product.count({ where: { id: productId, ...PUBLIC_PRODUCT_WHERE } })) > 0;
  }

  create(data: Prisma.ProductQuestionUncheckedCreateInput): Promise<ProductQuestion> {
    return this.prisma.productQuestion.create({ data });
  }

  findById(questionId: string, tx: Tx = this.prisma): Promise<ProductQuestion | null> {
    return tx.productQuestion.findUnique({ where: { id: questionId } });
  }

  /** Locks the question row and returns it. */
  async lock(tx: Tx, questionId: string): Promise<ProductQuestion | null> {
    await tx.$queryRaw`SELECT 1 FROM "ProductQuestion" WHERE "id" = ${questionId} FOR UPDATE`;
    return this.findById(questionId, tx);
  }

  update(tx: Tx, questionId: string, data: Prisma.ProductQuestionUncheckedUpdateInput): Promise<ProductQuestion> {
    return tx.productQuestion.update({ where: { id: questionId }, data });
  }

  isPublic(question: ProductQuestion): boolean {
    return question.status === ModerationStatus.PUBLISHED && question.answeredAt !== null;
  }

  findPublic(productId: string, first: number, after?: string | null): Promise<ProductQuestion[]> {
    return this.prisma.productQuestion.findMany({
      where: { productId, ...PUBLIC_QUESTION },
      orderBy: [{ answeredAt: 'desc' }, { id: 'desc' }],
      ...page(first, after),
    });
  }

  findByUser(userId: string, first: number, after?: string | null): Promise<ProductQuestion[]> {
    return this.prisma.productQuestion.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...page(first, after),
    });
  }

  /** Published questions still waiting for an answer, oldest first. */
  findUnanswered(first: number, after?: string | null): Promise<ProductQuestion[]> {
    return this.prisma.productQuestion.findMany({
      where: { status: ModerationStatus.PUBLISHED, answeredAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...page(first, after),
    });
  }

  findReported(first: number, after?: string | null) {
    return this.prisma.productQuestion.findMany({
      where: { reports: { some: { resolvedAt: null } } },
      include: { reports: { where: { resolvedAt: null }, orderBy: { createdAt: 'asc' } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...page(first, after),
    });
  }

  findReport(questionId: string, reporterId: string) {
    return this.prisma.productQuestionReport.findUnique({
      where: { questionId_reporterId: { questionId, reporterId } },
    });
  }

  createReport(data: Prisma.ProductQuestionReportUncheckedCreateInput) {
    return this.prisma.productQuestionReport.create({ data });
  }

  async resolveReports(tx: Tx, questionId: string, now: Date): Promise<number> {
    return (
      await tx.productQuestionReport.updateMany({ where: { questionId, resolvedAt: null }, data: { resolvedAt: now } })
    ).count;
  }
}
