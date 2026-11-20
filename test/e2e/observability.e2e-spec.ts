import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from '../helpers/app.helper';

describe('Observability (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('request id', () => {
    it('echoes a well-formed client X-Request-ID on REST and GraphQL responses', async () => {
      await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-ID', 'e2e-request-1')
        .expect(200)
        .expect('X-Request-ID', 'e2e-request-1');
      await request(app.getHttpServer())
        .post('/graphql')
        .set('X-Request-ID', 'e2e-request-2')
        .send({ query: '{ __typename }' })
        .expect(200)
        .expect('X-Request-ID', 'e2e-request-2');
    });

    it('replaces a malformed or missing id with a generated one', async () => {
      const malformed = await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-ID', 'not valid; id')
        .expect(200);
      const missing = await request(app.getHttpServer()).get('/health/live').expect(200);

      expect(malformed.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(missing.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
