import * as Joi from 'joi';
import { PROCESS_ROLES } from '../process-role';

const PRODUCTION_SECRET_KEYS = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_RESET_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'FACEBOOK_APP_SECRET',
  'PAYSTACK_SECRET_KEY',
  'CLOUDINARY_API_SECRET',
  'REDIS_PASSWORD',
  'RESEND_API_KEY',
  'MFA_ENCRYPTION_KEY',
  'PAYMENT_CONFIG_ENCRYPTION_KEY',
] as const;

const ENCRYPTION_KEYS = ['MFA_ENCRYPTION_KEY', 'PAYMENT_CONFIG_ENCRYPTION_KEY'] as const;

const JWT_SECRET_KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_RESET_SECRET'] as const;

// Matches values copied from examples and docs. "xxx" must be its own segment (as in "sk_live_xxx")
// so random base64 secrets that happen to contain those letters are not rejected.
const PLACEHOLDER_SECRET_PATTERN =
  /change[-_]?me|replace[-_]?me|placeholder|^your[-_]|^(secret|password|test|example)$|(^|[-_])x{3,}($|[-_])|^(.)\4*$/i;

// A hex key that is one short unit repeated (abab..., 0123456789abcdef...) was typed or copied, not generated.
const REPEATED_UNIT_PATTERN = /^(.{1,16})\1+$/;

const requiredInProduction = (schema: Joi.StringSchema) =>
  schema.when('NODE_ENV', { is: 'production', then: Joi.required(), otherwise: Joi.optional() });

function rejectUnsafeProductionSecrets(env: Record<string, unknown>, helpers: Joi.CustomHelpers) {
  if (env.NODE_ENV !== 'production') return env;

  const placeholderKeys = PRODUCTION_SECRET_KEYS.filter(
    (key) =>
      typeof env[key] === 'string' &&
      (PLACEHOLDER_SECRET_PATTERN.test(env[key] as string) ||
        ((ENCRYPTION_KEYS as readonly string[]).includes(key) && REPEATED_UNIT_PATTERN.test(env[key] as string))),
  );
  if (placeholderKeys.length > 0) {
    return helpers.message({
      custom: `Placeholder secret values are not allowed in production: ${placeholderKeys.join(', ')}`,
    });
  }

  if (new Set(JWT_SECRET_KEYS.map((key) => env[key])).size !== JWT_SECRET_KEYS.length) {
    return helpers.message({ custom: `${JWT_SECRET_KEYS.join(', ')} must all be different in production` });
  }

  if (String(env.MFA_ENCRYPTION_KEY).toLowerCase() === String(env.PAYMENT_CONFIG_ENCRYPTION_KEY).toLowerCase()) {
    return helpers.message({ custom: `${ENCRYPTION_KEYS.join(' and ')} must be different in production` });
  }

  return env;
}

export const envValidationSchema = Joi.object({
  // Database
  DATABASE_URL: Joi.string().required(),

  // Server
  PORT: Joi.number().default(3000),
  // No default: an unset NODE_ENV used to boot as development (introspection on, errors unmasked, no CSP/HSTS).
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .required()
    .messages({ 'any.required': 'NODE_ENV is required: set it to development, test or production' }),
  ALLOWED_ORIGINS: requiredInProduction(Joi.string()),
  // main.ts picks the process from ROLE before config loads (src/process-role.ts); this keeps the value documented.
  ROLE: Joi.string()
    .valid(...PROCESS_ROLES)
    .default('api'),

  // JWT
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_TOKEN_AUDIENCE: Joi.string().required(),
  JWT_TOKEN_ISSUER: Joi.string().required(),
  JWT_ACCESS_TOKEN_TTL: Joi.number().default(3600),
  JWT_REFRESH_TOKEN_TTL: Joi.number().default(86400),

  // Google OAuth
  GOOGLE_CLIENT_ID: Joi.string().required(),
  GOOGLE_CLIENT_SECRET: Joi.string().required(),

  // Facebook OAuth
  FACEBOOK_APP_ID: Joi.string().required(),
  FACEBOOK_APP_SECRET: Joi.string().required(),

  // Paystack fallback: used only while the store has no Paystack config in the database (setPaystackConfig). Without
  // either, online payment is unavailable and Paystack webhooks are refused.
  PAYSTACK_SECRET_KEY: Joi.string().optional(),
  PAYSTACK_CALLBACK_URL: Joi.string().uri().optional(),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: Joi.string().required(),
  CLOUDINARY_API_KEY: Joi.string().required(),
  CLOUDINARY_API_SECRET: Joi.string().required(),

  // Redis backs the cache, the throttler and the job queues in every environment.
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().optional(),
  // Logical database index, so test runs and local stacks sharing one Redis server stay apart.
  REDIS_DB: Joi.number().integer().min(0).max(15).default(0),

  // Email (Resend)
  RESEND_API_KEY: Joi.string().optional(),
  RESEND_FROM_EMAIL: Joi.string().email().optional(),

  // Password reset JWT
  JWT_RESET_SECRET: Joi.string().min(32).required(),
  JWT_RESET_TOKEN_TTL: Joi.number().default(900),

  // AES-256-GCM key for TOTP secrets at rest: 32 random bytes as hex (`openssl rand -hex 32`).
  MFA_ENCRYPTION_KEY: Joi.string()
    .pattern(/^[0-9a-fA-F]{64}$/)
    .required()
    .messages({ 'string.pattern.base': 'MFA_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)' }),

  // AES-256-GCM key for payment provider secrets stored in the database: 32 random bytes as hex (`openssl rand -hex 32`).
  PAYMENT_CONFIG_ENCRYPTION_KEY: Joi.string()
    .pattern(/^[0-9a-fA-F]{64}$/)
    .required()
    .messages({ 'string.pattern.base': 'PAYMENT_CONFIG_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)' }),

  // Logging
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),

  // Tracing: tracing.ts enables only on the exact string 'true', so other spellings are rejected.
  OTEL_ENABLED: Joi.string().valid('true', 'false').optional(),
  OTEL_SERVICE_NAME: Joi.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional(),

  // Metrics: src/telemetry.ts serves Prometheus on METRICS_PORT unless METRICS_ENABLED is exactly 'false'. The API and
  // the worker each need their own port when they share a network namespace.
  METRICS_ENABLED: Joi.string().valid('true', 'false').default('true'),
  METRICS_PORT: Joi.number().port().default(9464),

  // Error tracking: Sentry is on only when SENTRY_DSN is set (src/observability/sentry.ts reads these before this
  // validation runs, so a bad value still stops startup here).
  SENTRY_DSN: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional(),
  SENTRY_ENVIRONMENT: Joi.string().optional(),
  SENTRY_RELEASE: Joi.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).default(0),
}).custom(rejectUnsafeProductionSecrets);
