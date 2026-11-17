import * as Joi from 'joi';

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
] as const;

const JWT_SECRET_KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_RESET_SECRET'] as const;

// Matches values copied from examples and docs. "xxx" must be its own segment (as in "sk_live_xxx")
// so random base64 secrets that happen to contain those letters are not rejected.
const PLACEHOLDER_SECRET_PATTERN =
  /change[-_]?me|replace[-_]?me|placeholder|^your[-_]|^(secret|password|test|example)$|(^|[-_])x{3,}($|[-_])|^(.)\4*$/i;

const requiredInProduction = (schema: Joi.StringSchema) =>
  schema.when('NODE_ENV', { is: 'production', then: Joi.required(), otherwise: Joi.optional() });

function rejectUnsafeProductionSecrets(env: Record<string, unknown>, helpers: Joi.CustomHelpers) {
  if (env.NODE_ENV !== 'production') return env;

  const placeholderKeys = PRODUCTION_SECRET_KEYS.filter(
    (key) => typeof env[key] === 'string' && PLACEHOLDER_SECRET_PATTERN.test(env[key] as string),
  );
  if (placeholderKeys.length > 0) {
    return helpers.message({
      custom: `Placeholder secret values are not allowed in production: ${placeholderKeys.join(', ')}`,
    });
  }

  if (new Set(JWT_SECRET_KEYS.map((key) => env[key])).size !== JWT_SECRET_KEYS.length) {
    return helpers.message({ custom: `${JWT_SECRET_KEYS.join(', ')} must all be different in production` });
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

  // Paystack
  PAYSTACK_SECRET_KEY: Joi.string().required(),
  PAYSTACK_CALLBACK_URL: Joi.string().uri().optional(),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: Joi.string().required(),
  CLOUDINARY_API_KEY: Joi.string().required(),
  CLOUDINARY_API_SECRET: Joi.string().required(),

  // Redis (required in production; elsewhere the cache falls back to in-memory when absent)
  REDIS_HOST: requiredInProduction(Joi.string()),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional(),

  // Email (Resend)
  RESEND_API_KEY: Joi.string().optional(),
  RESEND_FROM_EMAIL: Joi.string().email().optional(),

  // Password reset JWT
  JWT_RESET_SECRET: Joi.string().min(32).required(),
  JWT_RESET_TOKEN_TTL: Joi.number().default(900),

  // Logging
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),

  // Tracing: tracing.ts enables only on the exact string 'true', so other spellings are rejected.
  OTEL_ENABLED: Joi.string().valid('true', 'false').optional(),
  OTEL_SERVICE_NAME: Joi.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional(),
}).custom(rejectUnsafeProductionSecrets);
