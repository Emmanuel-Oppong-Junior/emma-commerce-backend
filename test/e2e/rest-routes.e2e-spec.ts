import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CloudinaryService } from '../../src/commons/cloudinary.service';
import { createTestApp } from '../helpers/app.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { getAuthHeader, signInUser } from '../helpers/auth.helper';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('REST routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  const cloudinary = {
    uploadImage: jest.fn().mockResolvedValue({ secure_url: 'https://cdn.test/img.png', public_id: 'ecommerce/img' }),
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) =>
      builder.overrideProvider(CloudinaryService).useValue(cloudinary),
    ));
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  describe('health', () => {
    it('GET /health/live returns 200', async () => {
      await request(server()).get('/health/live').expect(200);
    });

    it.each(['/health', '/health/ready'])('GET %s answers without a server error', async (path) => {
      const res = await request(server()).get(path);
      expect([200, 503]).toContain(res.status);
    });
  });

  describe('GET /', () => {
    it('returns 200 with a valid token', async () => {
      await request(server()).get('/').set(getAuthHeader(userToken)).expect(200);
    });
  });

  describe('payment', () => {
    it('POST /payment/webhook rejects a bad signature with 401', async () => {
      await request(server())
        .post('/payment/webhook')
        .set('x-paystack-signature', 'not-a-valid-signature')
        .send({ event: 'charge.success', data: { reference: 'ref-unknown' } })
        .expect(401);
    });

    it('POST /payment/initialize returns 401 without a token', async () => {
      await request(server()).post('/payment/initialize').send({}).expect(401);
    });

    it('POST /payment/initialize reaches validation with a valid token', async () => {
      await request(server()).post('/payment/initialize').set(getAuthHeader(userToken)).send({}).expect(400);
    });

    it('POST /payment/initialize rejects a client-chosen currency other than GHS', async () => {
      const res = await request(server())
        .post('/payment/initialize')
        .set(getAuthHeader(userToken))
        .send({ orderId: 'any-order', paymentMethod: 'card', currency: 'USD' })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('currency must be GHS');
    });
  });

  describe('upload', () => {
    it('POST /upload/single-image returns 401 without a token', async () => {
      await request(server()).post('/upload/single-image').attach('file', ONE_PIXEL_PNG, 'pixel.png').expect(401);
    });

    it('POST /upload/single-image uploads with a valid token', async () => {
      const res = await request(server())
        .post('/upload/single-image')
        .set(getAuthHeader(userToken))
        .attach('file', ONE_PIXEL_PNG, 'pixel.png')
        .expect(201);

      expect(res.body).toEqual({ url: 'https://cdn.test/img.png', public_id: 'ecommerce/img' });
    });

    it('POST /upload/multiple-images uploads with a valid token', async () => {
      const res = await request(server())
        .post('/upload/multiple-images')
        .set(getAuthHeader(userToken))
        .attach('files', ONE_PIXEL_PNG, 'a.png')
        .attach('files', ONE_PIXEL_PNG, 'b.png')
        .expect(201);

      expect(res.body.files).toHaveLength(2);
    });
  });
});
