import { envValidationSchema } from './env.validation';

// Same options @nestjs/config applies when validationOptions sets only abortEarly.
const validate = (env: Record<string, string | undefined>) =>
  envValidationSchema.validate(env, { abortEarly: false, allowUnknown: true });

const baseEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/emma',
  JWT_SECRET: 'a3f1c9e07b5d42e8a6c1f0b9d7e2a4c5b8f3e6d1',
  JWT_REFRESH_SECRET: 'b7e2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7',
  JWT_RESET_SECRET: 'c9d1e3f5a7b9c2d4e6f8a0b1c3d5e7f9a2b4c6d8',
  JWT_TOKEN_AUDIENCE: 'emma-commerce',
  JWT_TOKEN_ISSUER: 'emma-commerce',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-k2j4h6g8f0d2s4a6',
  FACEBOOK_APP_ID: '1234567890',
  FACEBOOK_APP_SECRET: 'f0e9d8c7b6a5f4e3d2c1b0a9',
  PAYSTACK_SECRET_KEY: 'sk_live_9f8e7d6c5b4a3f2e1d0c',
  CLOUDINARY_CLOUD_NAME: 'emma-cloud',
  CLOUDINARY_API_KEY: '123456789012345',
  CLOUDINARY_API_SECRET: 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2',
  REDIS_HOST: 'localhost',
};

const productionEnv = {
  ...baseEnv,
  NODE_ENV: 'production',
  ALLOWED_ORIGINS: 'https://shop.example.com',
  REDIS_HOST: 'redis.internal',
};

const messageOf = (env: Record<string, string | undefined>) => validate(env).error?.message ?? '';

describe('envValidationSchema', () => {
  describe('NODE_ENV', () => {
    it('rejects an unset NODE_ENV instead of defaulting to development', () => {
      expect(messageOf(baseEnv)).toContain('NODE_ENV is required');
    });

    it('rejects an unknown NODE_ENV', () => {
      expect(messageOf({ ...baseEnv, NODE_ENV: 'prod' })).toContain('"NODE_ENV" must be one of');
    });

    it.each(['development', 'test'])('accepts %s without ALLOWED_ORIGINS', (nodeEnv) => {
      const { error, value } = validate({ ...baseEnv, NODE_ENV: nodeEnv });
      expect(error).toBeUndefined();
      expect(value.NODE_ENV).toBe(nodeEnv);
    });
  });

  describe('Redis', () => {
    it.each(['development', 'test', 'production'])('requires REDIS_HOST when NODE_ENV=%s', (nodeEnv) => {
      const env = { ...productionEnv, NODE_ENV: nodeEnv, REDIS_HOST: undefined };
      expect(messageOf(env)).toContain('"REDIS_HOST" is required');
    });

    it('defaults REDIS_PORT to 6379 and REDIS_DB to 0', () => {
      const { value } = validate({ ...baseEnv, NODE_ENV: 'test' });
      expect(value).toMatchObject({ REDIS_PORT: 6379, REDIS_DB: 0 });
    });

    it.each(['16', '-1', '1.5', 'one'])('rejects REDIS_DB=%s', (db) => {
      expect(messageOf({ ...baseEnv, NODE_ENV: 'test', REDIS_DB: db })).toContain('"REDIS_DB"');
    });
  });

  describe('development and test', () => {
    it('allows placeholder-looking and reused secrets outside production', () => {
      const env = {
        ...baseEnv,
        NODE_ENV: 'development',
        JWT_SECRET: 'change-me-to-a-random-256-bit-secret',
        JWT_REFRESH_SECRET: 'change-me-to-a-random-256-bit-secret',
        GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      };
      expect(validate(env).error).toBeUndefined();
    });
  });

  describe('production', () => {
    it('accepts a complete production configuration', () => {
      expect(validate(productionEnv).error).toBeUndefined();
    });

    it.each(['REDIS_HOST', 'ALLOWED_ORIGINS'])('requires %s', (key) => {
      expect(messageOf({ ...productionEnv, [key]: undefined })).toContain(`"${key}" is required`);
    });

    it.each([
      ['JWT_SECRET', 'change-me-to-a-random-256-bit-secret'],
      ['JWT_REFRESH_SECRET', 'changeme-changeme-changeme-changeme'],
      ['JWT_RESET_SECRET', 'your-reset-secret-at-least-32-characters'],
      ['JWT_SECRET', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
      ['JWT_SECRET', 'replace_me_with_a_long_random_string_now'],
      ['PAYSTACK_SECRET_KEY', 'sk_live_xxx'],
      ['GOOGLE_CLIENT_SECRET', 'Secret'],
      ['CLOUDINARY_API_SECRET', 'placeholder'],
      ['RESEND_API_KEY', 'your_resend_api_key'],
      ['REDIS_PASSWORD', 'password'],
    ])('rejects a placeholder %s and names the key', (key, value) => {
      const message = messageOf({ ...productionEnv, [key]: value });
      expect(message).toContain('Placeholder secret values are not allowed in production');
      expect(message).toContain(key);
      expect(message).not.toContain(value);
    });

    it('does not mistake random secrets containing "xxx" for placeholders', () => {
      expect(validate({ ...productionEnv, JWT_SECRET: 'Qm9xxxZk3LpT8vR2nW6yH1cB4dF7gJ0sA5eK' }).error).toBeUndefined();
    });

    it('rejects JWT secrets reused across access, refresh and reset tokens', () => {
      const message = messageOf({ ...productionEnv, JWT_RESET_SECRET: productionEnv.JWT_SECRET });
      expect(message).toContain('JWT_SECRET, JWT_REFRESH_SECRET, JWT_RESET_SECRET must all be different in production');
    });
  });

  describe('tracing', () => {
    it('accepts a valid tracing configuration', () => {
      const env = {
        ...baseEnv,
        NODE_ENV: 'development',
        OTEL_ENABLED: 'true',
        OTEL_SERVICE_NAME: 'emma-commerce-backend',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/v1/traces',
      };
      expect(validate(env).error).toBeUndefined();
    });

    it.each(['yes', '1', 'TRUE'])('rejects OTEL_ENABLED=%s, which tracing.ts would silently ignore', (flag) => {
      expect(messageOf({ ...baseEnv, NODE_ENV: 'development', OTEL_ENABLED: flag })).toContain('"OTEL_ENABLED"');
    });

    it('rejects an OTEL_EXPORTER_OTLP_ENDPOINT that is not an http(s) URI', () => {
      expect(
        messageOf({ ...baseEnv, NODE_ENV: 'development', OTEL_EXPORTER_OTLP_ENDPOINT: 'otel-collector:4318' }),
      ).toContain('"OTEL_EXPORTER_OTLP_ENDPOINT"');
    });
  });
});
