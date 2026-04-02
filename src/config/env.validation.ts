import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // Database
  DATABASE_URL: Joi.string().required(),

  // Server
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  ALLOWED_ORIGINS: Joi.string().optional(),

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

  // Logging
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
});
