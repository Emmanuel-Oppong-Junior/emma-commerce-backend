const { randomBytes } = require('node:crypto');
const { existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, '..', '.env.test');
const databaseUrl = process.argv[2];
const redisUrl = process.argv[3] ?? 'redis://localhost:6379/0';

if (!databaseUrl) {
  console.error('Usage: node scripts/write-test-env.js <DATABASE_URL ending in _test> [redis://host:port/db]');
  process.exit(1);
}
const redis = new URL(redisUrl);
const redisDb = redis.pathname.replace('/', '') || '0';
if (redis.protocol !== 'redis:' || !redis.hostname || !/^([0-9]|1[0-5])$/.test(redisDb)) {
  console.error(`Expected a Redis URL like redis://localhost:6379/0, got "${redisUrl}"`);
  process.exit(1);
}
if (existsSync(target)) {
  console.error(`${target} already exists; not overwriting it.`);
  process.exit(1);
}

const secret = () => randomBytes(32).toString('hex');
const values = {
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  JWT_SECRET: secret(),
  JWT_REFRESH_SECRET: secret(),
  JWT_RESET_SECRET: secret(),
  MFA_ENCRYPTION_KEY: secret(),
  PAYMENT_CONFIG_ENCRYPTION_KEY: secret(),
  JWT_TOKEN_AUDIENCE: 'emma-commerce-test',
  JWT_TOKEN_ISSUER: 'emma-commerce-test',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  FACEBOOK_APP_ID: 'test-facebook-app-id',
  FACEBOOK_APP_SECRET: 'test-facebook-app-secret',
  PAYSTACK_SECRET_KEY: 'sk_test_e2e',
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-cloudinary-key',
  CLOUDINARY_API_SECRET: 'test-cloudinary-secret',
  REDIS_HOST: redis.hostname,
  REDIS_PORT: redis.port || '6379',
  REDIS_DB: redisDb,
  LOG_LEVEL: 'warn',
  // Base of the links in emails (password reset, cart, unsubscribe).
  FRONTEND_URL: 'http://localhost:3001',
  // Tests start their own metrics server on a free port where they need one (test/helpers/metrics.helper.ts).
  METRICS_ENABLED: 'false',
};

writeFileSync(
  target,
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
);
console.log(`Wrote ${target} with test-only values.`);
