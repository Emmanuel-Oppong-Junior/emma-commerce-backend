import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CloudinaryService } from '../../src/commons/cloudinary.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { purchase } from '../helpers/review.helper';

// Reviews (P6-V.1): verified purchase, one per customer and product, photos, moderation and the stored product rating.

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type GqlResult = {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string; reason?: string } }[];
};

const LAPTOP = { productId: 'seed_prod1', variantId: 'seed_var1' };
const PHONE = { productId: 'seed_prod2', variantId: 'seed_var2' };
const RATING = 'rating { average count distribution { stars count } }';

describe('Reviews (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let userToken: string;
  let buyers: { id: string; token: string }[];
  let uploads = 0;

  const cloudinary = {
    uploadImage: jest.fn(async (_file: unknown, folder: string) => {
      uploads += 1;
      return {
        public_id: `${folder}/p${uploads}`,
        secure_url: `https://res.cloudinary.test/${folder}/p${uploads}.png`,
      };
    }),
    urlFor: jest.fn((publicId: string) => `https://res.cloudinary.test/${publicId}`),
  };

  const gql = async (query: string, token?: string): Promise<GqlResult> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body;
  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions.code;
  const reasonOf = (result: GqlResult) => result.errors?.[0]?.extensions.reason;
  const ratingOf = async (productId: string) =>
    (await gql(`{ product(productId: "${productId}") { ${RATING} } }`)).data!.product.rating;
  const create = (token: string, productId: string, score: number, extra = '') =>
    gql(
      `mutation { createReview(input: { productId: "${productId}", score: ${score} ${extra} }) { id score title comment verifiedPurchase status } }`,
      token,
    );

  const buyer = async (name: string) => {
    const email = `${name}@reviews.test`;
    const { accessToken } = await signUpUser(app, { email, password: 'Str0ng!Passw0rd', name: `${name} Mensah` });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { id: user.id, token: accessToken };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) =>
      builder.overrideProvider(CloudinaryService).useValue(cloudinary),
    ));
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    userToken = await signInUser(app);
    buyers = [];
    for (const name of ['ama', 'kofi', 'efua']) buyers.push(await buyer(name));
  });

  afterAll(() => app.close());

  describe('verified purchase', () => {
    it('refuses customers who did not receive the product, or got all of it refunded', async () => {
      const [ama] = buyers;
      expect(reasonOf(await create(ama.token, LAPTOP.productId, 5))).toBe('REVIEW_NOT_VERIFIED_PURCHASE');

      await purchase(prisma, ama.id, LAPTOP, 'NOT_DELIVERED');
      const undelivered = await create(ama.token, LAPTOP.productId, 5);
      expect(codeOf(undelivered)).toBe('FORBIDDEN');
      expect(reasonOf(undelivered)).toBe('REVIEW_NOT_VERIFIED_PURCHASE');

      await purchase(prisma, ama.id, LAPTOP, 'REFUNDED');
      expect(reasonOf(await create(ama.token, LAPTOP.productId, 5))).toBe('REVIEW_NOT_VERIFIED_PURCHASE');
      expect(await prisma.review.count({ where: { userId: ama.id } })).toBe(0);
    });

    it('accepts a customer whose shipment was delivered and updates the rating', async () => {
      const [ama] = buyers;
      const orderItemId = await purchase(prisma, ama.id, LAPTOP, 'SHIPMENT_DELIVERED');

      const result = await create(ama.token, LAPTOP.productId, 4, ', title: "  Solid  ", comment: " Fast and quiet "');

      expect(result.errors).toBeUndefined();
      expect(result.data!.createReview).toMatchObject({
        score: 4,
        title: 'Solid',
        comment: 'Fast and quiet',
        verifiedPurchase: true,
        status: 'PUBLISHED',
      });
      const stored = await prisma.review.findUniqueOrThrow({ where: { id: result.data!.createReview.id } });
      expect(stored.orderItemId).toBe(orderItemId);
      expect(await ratingOf(LAPTOP.productId)).toEqual({
        average: 4,
        count: 1,
        distribution: [
          { stars: 5, count: 0 },
          { stars: 4, count: 1 },
          { stars: 3, count: 0 },
          { stars: 2, count: 0 },
          { stars: 1, count: 0 },
        ],
      });
    });

    it('refuses a second review of the same product', async () => {
      const result = await create(buyers[0].token, LAPTOP.productId, 1);

      expect(codeOf(result)).toBe('CONFLICT');
      expect(reasonOf(result)).toBe('REVIEW_ALREADY_EXISTS');
    });

    it('keeps one review when the same customer submits several at once', async () => {
      const [, kofi] = buyers;
      await purchase(prisma, kofi.id, PHONE, 'COMPLETED');

      const results = await Promise.all([1, 2, 3, 4, 5].map((score) => create(kofi.token, PHONE.productId, score)));

      expect(results.filter((result) => !result.errors)).toHaveLength(1);
      expect(results.filter((result) => reasonOf(result) === 'REVIEW_ALREADY_EXISTS')).toHaveLength(4);
      expect(await prisma.review.count({ where: { userId: kofi.id, productId: PHONE.productId } })).toBe(1);
      expect((await ratingOf(PHONE.productId)).count).toBe(1);
      await expect(
        prisma.review.create({ data: { userId: kofi.id, productId: PHONE.productId, score: 3 } }),
      ).rejects.toThrow(/Unique constraint/);
    });
  });

  describe('edit, delete and the rating', () => {
    let reviewId: string;

    beforeAll(async () => {
      const [, kofi] = buyers;
      await purchase(prisma, kofi.id, LAPTOP, 'COMPLETED');
      reviewId = (await create(kofi.token, LAPTOP.productId, 2, ', comment: "Too loud"')).data!.createReview.id;
    });

    it('averages the published reviews', async () => {
      expect(await ratingOf(LAPTOP.productId)).toMatchObject({ average: 3, count: 2 });
    });

    it('edits the score and clears the comment', async () => {
      const result = await gql(
        `mutation { updateReview(input: { id: "${reviewId}", score: 5, comment: null }) { score comment title editedAt } }`,
        buyers[1].token,
      );

      expect(result.errors).toBeUndefined();
      expect(result.data!.updateReview).toMatchObject({ score: 5, comment: null, title: null });
      expect(result.data!.updateReview.editedAt).not.toBeNull();
      expect(await ratingOf(LAPTOP.productId)).toMatchObject({ average: 4.5, count: 2 });
    });

    it("refuses editing or deleting another customer's review", async () => {
      const edit = await gql(`mutation { updateReview(input: { id: "${reviewId}", score: 1 }) { id } }`, userToken);
      const remove = await gql(`mutation { deleteReview(reviewId: "${reviewId}") { id } }`, userToken);

      expect(codeOf(edit)).toBe('FORBIDDEN');
      expect(codeOf(remove)).toBe('FORBIDDEN');
    });

    it('deletes the own review for good, which the rating follows; the customer may then review again', async () => {
      const result = await gql(`mutation { deleteReview(reviewId: "${reviewId}") { id } }`, buyers[1].token);

      expect(result.errors).toBeUndefined();
      expect(await prisma.review.findUnique({ where: { id: reviewId } })).toBeNull();
      expect(await ratingOf(LAPTOP.productId)).toMatchObject({ average: 4, count: 1 });

      const again = await create(buyers[1].token, LAPTOP.productId, 3);
      expect(again.errors).toBeUndefined();
      expect(await ratingOf(LAPTOP.productId)).toMatchObject({ average: 3.5, count: 2 });
    });
  });

  describe('photos', () => {
    let reviewId: string;
    const upload = (token: string, id = reviewId, body = ONE_PIXEL_PNG) =>
      request(app.getHttpServer())
        .post(`/reviews/${id}/photos`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', body, 'photo.png');

    beforeAll(async () => {
      reviewId = (await prisma.review.findFirstOrThrow({ where: { userId: buyers[0].id } })).id;
    });

    it('adds up to four photos to the own review and returns them as URLs', async () => {
      const first = await upload(buyers[0].token).expect(201);
      expect(first.body).toEqual({ id: expect.any(String), url: expect.stringContaining(`reviews/${reviewId}/`) });
      for (let i = 0; i < 3; i += 1) await upload(buyers[0].token).expect(201);

      const fifth = await upload(buyers[0].token);
      expect(fifth.status).toBe(400);
      expect(cloudinary.uploadImage).toHaveBeenCalledTimes(4);
      expect(cloudinary.uploadImage).toHaveBeenLastCalledWith(expect.anything(), `reviews/${reviewId}`);

      const listed = await gql(`{ review(reviewId: "${reviewId}") { photos { id url } } }`);
      expect(listed.data!.review.photos).toHaveLength(4);
    });

    it("refuses another customer's review, a missing token and a file that is not an image", async () => {
      expect((await upload(buyers[1].token)).status).toBe(403);
      expect((await request(app.getHttpServer()).post(`/reviews/${reviewId}/photos`)).status).toBe(401);
      expect((await upload(buyers[0].token, reviewId, Buffer.from('not an image'))).status).toBe(400);
    });

    it('removes an own photo', async () => {
      const photo = await prisma.reviewPhoto.findFirstOrThrow({ where: { reviewId } });

      expect(codeOf(await gql(`mutation { removeReviewPhoto(photoId: "${photo.id}") }`, buyers[1].token))).toBe(
        'NOT_FOUND',
      );
      const removed = await gql(`mutation { removeReviewPhoto(photoId: "${photo.id}") }`, buyers[0].token);

      expect(removed.data!.removeReviewPhoto).toBe(true);
      expect(await prisma.reviewPhoto.count({ where: { reviewId } })).toBe(3);
    });
  });

  describe('reports and moderation', () => {
    let reviewId: string;

    beforeAll(async () => {
      reviewId = (await prisma.review.findFirstOrThrow({ where: { userId: buyers[0].id } })).id;
    });

    it('lets other customers report a review once; the author cannot report it', async () => {
      const report = (token: string, reason = 'OFFENSIVE', note = '"Rude"') =>
        gql(`mutation { reportReview(input: { id: "${reviewId}", reason: ${reason}, note: ${note} }) }`, token);

      expect((await report(buyers[1].token)).data!.reportReview).toBe(true);
      expect((await report(userToken, 'SPAM', 'null')).data!.reportReview).toBe(true);
      expect(reasonOf(await report(buyers[1].token))).toBe('ALREADY_REPORTED');
      expect(codeOf(await report(buyers[0].token))).toBe('BAD_REQUEST');
      expect(codeOf(await report(buyers[2].token, 'OTHER', 'null'))).toBe('BAD_REQUEST');
    });

    it('lists reported reviews to moderators only', async () => {
      const query = `{ reportedReviews { review { id status } openReports { reason note } } }`;

      expect(codeOf(await gql(query, userToken))).toBe('FORBIDDEN');
      const queue = await gql(query, adminToken);
      expect(queue.errors).toBeUndefined();
      expect(queue.data!.reportedReviews).toEqual([
        {
          review: { id: reviewId, status: 'PUBLISHED' },
          openReports: [
            { reason: 'OFFENSIVE', note: 'Rude' },
            { reason: 'SPAM', note: null },
          ],
        },
      ]);
    });

    it('hides a review from public reads and the rating, audited, and shows it to its author as HIDDEN', async () => {
      expect(
        codeOf(await gql(`mutation { hideReview(input: { id: "${reviewId}", reason: "x" }) { id } }`, userToken)),
      ).toBe('FORBIDDEN');
      const before = await ratingOf(LAPTOP.productId);

      const hidden = await gql(
        `mutation { hideReview(input: { id: "${reviewId}", reason: "Abusive language" }) { status hiddenReason } }`,
        adminToken,
      );

      expect(hidden.data!.hideReview).toEqual({ status: 'HIDDEN', hiddenReason: 'Abusive language' });
      expect(await ratingOf(LAPTOP.productId)).toMatchObject({ count: before.count - 1 });
      const publicIds = (await gql(`{ productReviews(productId: "${LAPTOP.productId}") { id } }`)).data!.productReviews;
      expect(publicIds).not.toContainEqual({ id: reviewId });
      const onProduct = (await gql(`{ product(productId: "${LAPTOP.productId}") { reviews { id } } }`)).data!.product
        .reviews;
      expect(onProduct).not.toContainEqual({ id: reviewId });
      expect(codeOf(await gql(`{ review(reviewId: "${reviewId}") { id } }`, buyers[1].token))).toBe('NOT_FOUND');

      const own = await gql(`{ userReviews { id status } }`, buyers[0].token);
      expect(own.data!.userReviews).toContainEqual({ id: reviewId, status: 'HIDDEN' });
      expect(codeOf(await gql(`{ review(reviewId: "${reviewId}") { hiddenReason } }`, buyers[0].token))).toBe(
        'FORBIDDEN',
      );

      expect((await gql(`{ reportedReviews { review { id } } }`, adminToken)).data!.reportedReviews).toEqual([]);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'Review', entityId: reviewId } });
      expect(audit).toMatchObject({
        action: 'STATUS_CHANGE',
        details: { from: 'PUBLISHED', to: 'HIDDEN', reason: 'Abusive language', resolvedReports: 2 },
      });
    });

    it('unhides it again, audited, and the rating counts it again', async () => {
      const before = await ratingOf(LAPTOP.productId);

      const result = await gql(
        `mutation { unhideReview(input: { id: "${reviewId}", reason: "Appeal upheld" }) { status } }`,
        adminToken,
      );

      expect(result.data!.unhideReview.status).toBe('PUBLISHED');
      expect(await ratingOf(LAPTOP.productId)).toMatchObject({ count: before.count + 1 });
      expect(
        await prisma.auditLog.count({ where: { entity: 'Review', entityId: reviewId, action: 'STATUS_CHANGE' } }),
      ).toBe(2);
      expect(
        codeOf(
          await gql(`mutation { unhideReview(input: { id: "${reviewId}", reason: "again" }) { id } }`, adminToken),
        ),
      ).toBe('CONFLICT');
    });

    it('dismisses reports and replies publicly, both audited', async () => {
      await gql(`mutation { reportReview(input: { id: "${reviewId}", reason: FAKE }) }`, buyers[2].token);
      const dismissed = await gql(
        `mutation { dismissReviewReports(input: { id: "${reviewId}", reason: "Genuine review" }) { status } }`,
        adminToken,
      );
      expect(dismissed.data!.dismissReviewReports.status).toBe('PUBLISHED');
      expect((await gql(`{ reportedReviews { review { id } } }`, adminToken)).data!.reportedReviews).toEqual([]);

      await gql(
        `mutation { replyToReview(input: { reviewId: "${reviewId}", body: " Thank you! " }) { id } }`,
        adminToken,
      );
      const reply = (await gql(`{ review(reviewId: "${reviewId}") { reply { body repliedAt } } }`)).data!.review.reply;
      expect(reply).toEqual({ body: 'Thank you!', repliedAt: expect.any(String) });
      expect(await prisma.auditLog.count({ where: { entity: 'Review', entityId: reviewId, action: 'UPDATE' } })).toBe(
        2,
      );
    });
  });

  describe('public reads', () => {
    beforeAll(async () => {
      // Reviews written straight into the database by five more customers, a day apart, scores 1-5.
      for (let i = 1; i <= 5; i += 1) {
        await prisma.user.create({
          data: { id: `rv_reader_${i}`, email: `reader${i}@reviews.test`, name: `Reader ${i}` },
        });
        await prisma.review.create({
          data: {
            id: `rv_${i}`,
            userId: `rv_reader_${i}`,
            productId: PHONE.productId,
            score: i,
            createdAt: new Date(Date.UTC(2026, 0, i)),
          },
        });
      }
    });

    it('sorts newest, highest or lowest first and pages with the last id', async () => {
      const ids = async (args: string) =>
        (
          (await gql(`{ productReviews(productId: "${PHONE.productId}", ${args}) { id } }`)).data!.productReviews as {
            id: string;
          }[]
        ).map((review) => review.id);

      const newest = await ids('first: 50');
      expect(newest.slice(-5)).toEqual(['rv_5', 'rv_4', 'rv_3', 'rv_2', 'rv_1']);
      const scores = async (sort: string) =>
        (
          (await gql(`{ productReviews(productId: "${PHONE.productId}", sort: ${sort}) { score } }`)).data!
            .productReviews as { score: number }[]
        ).map((review) => review.score);
      const lowest = await scores('LOWEST');
      expect(lowest).toEqual([...lowest].sort((a, b) => a - b));
      const highest = await scores('HIGHEST');
      expect(highest).toEqual([...highest].sort((a, b) => b - a));
      expect(highest).toHaveLength(6);

      const firstPage = await ids('first: 2');
      const secondPage = await ids(`first: 2, after: "${firstPage[1]}"`);
      expect(secondPage).toEqual(newest.slice(2, 4));
      expect(codeOf(await gql(`{ productReviews(productId: "${PHONE.productId}", first: 51) { id } }`))).toBe(
        'BAD_USER_INPUT',
      );
    });

    it('caps the latest reviews on the product and hides the reviews of unpublished products', async () => {
      const latest = await gql(`{ product(productId: "${PHONE.productId}") { reviews(first: 2) { id } } }`);
      expect(latest.data!.product.reviews).toHaveLength(2);
      expect(codeOf(await gql(`{ productReviews(productId: "seed_prod_draft") { id } }`))).toBe('NOT_FOUND');
    });

    it.each([
      ['anonymous', undefined],
      ['signed in', 'user'],
    ])('never exposes reviewer contact details or ids to a %s caller', async (_who, who) => {
      const token = who ? userToken : undefined;
      const fields = 'id user { displayName } product { id }';
      const reads = [
        `{ productReviews(productId: "${LAPTOP.productId}") { ${fields} } }`,
        `{ product(productId: "${LAPTOP.productId}") { reviews { ${fields} } } }`,
      ];
      for (const query of reads) {
        const result = await gql(query, token);
        expect(result.errors).toBeUndefined();
        const body = JSON.stringify(result);
        expect(body).not.toMatch(/@reviews\.test|@example\.com/);
        expect(body).not.toContain(buyers[0].id);
      }
      expect(
        (await gql(`{ productReviews(productId: "${LAPTOP.productId}") { user { displayName } } }`, token)).data!
          .productReviews,
      ).toContainEqual({ user: { displayName: 'ama M.' } });
      for (const selection of ['userId', 'user { email }', 'user { phoneNumber }', 'user { addresses { street } }']) {
        const result = await gqlRequest(
          app,
          `{ productReviews(productId: "${LAPTOP.productId}") { ${selection} } }`,
          undefined,
          token,
        ).expect(400);
        expect(result.body.errors?.[0]?.message).toMatch(/Cannot query field/);
      }
    });
  });
});
