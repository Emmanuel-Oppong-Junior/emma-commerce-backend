import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';

// Product Q&A (P6-V.2): customers ask, staff answer, answered questions are public, reports and hiding.

type GqlResult = {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string; reason?: string } }[];
};

describe('Product questions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let askerToken: string;
  let readerToken: string;
  let questionId: string;

  const gql = async (query: string, token?: string): Promise<GqlResult> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body;
  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions.code;
  const publicIds = async (token?: string) =>
    (
      (await gql(`{ productQuestions(productId: "seed_prod1") { id } }`, token)).data!.productQuestions as {
        id: string;
      }[]
    ).map((q) => q.id);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    askerToken = await signInUser(app);
    readerToken = (await signUpUser(app, { email: 'reader@qa.test', password: 'Str0ng!Passw0rd', name: 'Abena Owusu' }))
      .accessToken;
  });

  afterAll(() => app.close());

  it('lets a signed-in customer ask about a public product; guests and staff cannot', async () => {
    const ask = (token: string | undefined, productId = 'seed_prod1', body = '"  Does it come with a charger?  "') =>
      gql(
        `mutation { askProductQuestion(input: { productId: "${productId}", body: ${body} }) { id body answer status user { displayName } } }`,
        token,
      );

    expect(codeOf(await ask(undefined))).toBe('UNAUTHENTICATED');
    expect(codeOf(await ask(adminToken))).toBe('FORBIDDEN');
    expect(codeOf(await ask(askerToken, 'seed_prod_draft'))).toBe('NOT_FOUND');
    expect(codeOf(await ask(askerToken, 'seed_prod1', '"Hi?"'))).toBe('BAD_USER_INPUT');

    const asked = await ask(askerToken);
    expect(asked.errors).toBeUndefined();
    expect(asked.data!.askProductQuestion).toMatchObject({
      body: 'Does it come with a charger?',
      answer: null,
      status: 'PUBLISHED',
      user: { displayName: 'Regular U.' },
    });
    questionId = asked.data!.askProductQuestion.id;
  });

  it('keeps an unanswered question off public reads but shows it to its asker and in the staff queue', async () => {
    expect(await publicIds()).toEqual([]);
    expect(codeOf(await gql(`{ productQuestion(questionId: "${questionId}") { id } }`, readerToken))).toBe('NOT_FOUND');
    expect((await gql(`{ myProductQuestions { id answer } }`, askerToken)).data!.myProductQuestions).toEqual([
      { id: questionId, answer: null },
    ]);
    expect(codeOf(await gql(`{ unansweredProductQuestions { id } }`, readerToken))).toBe('FORBIDDEN');
    expect((await gql(`{ unansweredProductQuestions { id } }`, adminToken)).data!.unansweredProductQuestions).toEqual([
      { id: questionId },
    ]);
  });

  it('publishes the question once staff answer it (audited); customers cannot answer', async () => {
    const answer = (token: string) =>
      gql(
        `mutation { answerProductQuestion(input: { questionId: "${questionId}", answer: " Yes, a 65 W charger. " }) { answer answeredAt } }`,
        token,
      );

    expect(codeOf(await answer(readerToken))).toBe('FORBIDDEN');
    const answered = await answer(adminToken);

    expect(answered.data!.answerProductQuestion).toEqual({
      answer: 'Yes, a 65 W charger.',
      answeredAt: expect.any(String),
    });
    expect(await publicIds()).toEqual([questionId]);
    expect(await publicIds(readerToken)).toEqual([questionId]);
    expect((await gql(`{ unansweredProductQuestions { id } }`, adminToken)).data!.unansweredProductQuestions).toEqual(
      [],
    );
    expect(
      await prisma.auditLog.count({ where: { entity: 'ProductQuestion', entityId: questionId, action: 'UPDATE' } }),
    ).toBe(1);
  });

  it('never exposes the asker beyond the public display name', async () => {
    const result = await gql(`{ productQuestions(productId: "seed_prod1") { id user { displayName } } }`);

    expect(JSON.stringify(result)).not.toMatch(/example\.com|seed_user/);
    const leak = await gqlRequest(
      app,
      `{ productQuestions(productId: "seed_prod1") { userId user { email } } }`,
    ).expect(400);
    expect(leak.body.errors[0].message).toMatch(/Cannot query field/);
  });

  it('takes one report per customer and lists it to moderators', async () => {
    const report = (token: string) =>
      gql(`mutation { reportProductQuestion(input: { id: "${questionId}", reason: OFF_TOPIC }) }`, token);

    expect((await report(readerToken)).data!.reportProductQuestion).toBe(true);
    expect((await report(readerToken)).errors?.[0]?.extensions.reason).toBe('ALREADY_REPORTED');
    expect(codeOf(await report(askerToken))).toBe('BAD_REQUEST');
    const queue = await gql(`{ reportedProductQuestions { question { id } openReports { reason } } }`, adminToken);
    expect(queue.data!.reportedProductQuestions).toEqual([
      { question: { id: questionId }, openReports: [{ reason: 'OFF_TOPIC' }] },
    ]);
  });

  it('hides and unhides a question (audited); a hidden question leaves public reads', async () => {
    const hidden = await gql(
      `mutation { hideProductQuestion(input: { id: "${questionId}", reason: "Off topic" }) { status hiddenReason } }`,
      adminToken,
    );
    expect(hidden.data!.hideProductQuestion).toEqual({ status: 'HIDDEN', hiddenReason: 'Off topic' });
    expect(await publicIds()).toEqual([]);
    expect(
      (await gql(`{ reportedProductQuestions { question { id } } }`, adminToken)).data!.reportedProductQuestions,
    ).toEqual([]);
    expect((await gql(`{ myProductQuestions { id status } }`, askerToken)).data!.myProductQuestions).toEqual([
      { id: questionId, status: 'HIDDEN' },
    ]);

    await gql(
      `mutation { unhideProductQuestion(input: { id: "${questionId}", reason: "Relevant after all" }) { id } }`,
      adminToken,
    );
    expect(await publicIds()).toEqual([questionId]);
    expect(
      await prisma.auditLog.count({
        where: { entity: 'ProductQuestion', entityId: questionId, action: 'STATUS_CHANGE' },
      }),
    ).toBe(2);
  });

  it('dismisses reports with an audit row', async () => {
    await prisma.productQuestionReport.deleteMany();
    await gql(`mutation { reportProductQuestion(input: { id: "${questionId}", reason: SPAM }) }`, readerToken);

    await gql(
      `mutation { dismissProductQuestionReports(input: { id: "${questionId}", reason: "Not spam" }) { id } }`,
      adminToken,
    );

    expect(
      (await gql(`{ reportedProductQuestions { question { id } } }`, adminToken)).data!.reportedProductQuestions,
    ).toEqual([]);
    expect(
      await prisma.auditLog.count({ where: { entity: 'ProductQuestion', entityId: questionId, action: 'UPDATE' } }),
    ).toBe(2);
  });

  it('pages answered questions, latest answer first', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await prisma.productQuestion.create({
        data: {
          id: `qa_${i}`,
          productId: 'seed_prod1',
          userId: 'seed_user',
          body: `Question number ${i}?`,
          answer: `Answer ${i}`,
          answeredAt: new Date(Date.UTC(2026, 0, i)),
        },
      });
    }
    const page = async (args: string) =>
      (
        (await gql(`{ productQuestions(productId: "seed_prod1", ${args}) { id } }`)).data!.productQuestions as {
          id: string;
        }[]
      ).map((q) => q.id);

    expect(await page('first: 2')).toEqual([questionId, 'qa_3']);
    expect(await page('first: 2, after: "qa_3"')).toEqual(['qa_2', 'qa_1']);
    expect(codeOf(await gql(`{ productQuestions(productId: "seed_prod_inactive") { id } }`))).toBe('NOT_FOUND');
  });
});
