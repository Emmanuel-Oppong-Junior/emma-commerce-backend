const { randomBytes } = require('node:crypto');
const { existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, '..', '.env.test');
const databaseUrl = process.argv[2];

if (!databaseUrl) {
  console.error('Usage: node scripts/write-test-env.js <DATABASE_URL ending in _test>');
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
  LOG_LEVEL: 'warn',
};

writeFileSync(
  target,
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
);
console.log(`Wrote ${target} with test-only values.`);
