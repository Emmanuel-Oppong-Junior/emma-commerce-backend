import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { LoggerService } from './commons/logger.service';
import { AllExceptionsFilter } from './commons/filters/all-exceptions.filter';
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // logger: false,
  });

  // Security headers
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      // [CRITICAL-3] Explicit CSP directives — never rely on helmet's silent defaults in production
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production'
          ? {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'https:'],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'"],
                frameSrc: ["'none'"],
                upgradeInsecureRequests: [],
              },
            }
          : false,
      // [MED-1] HSTS — tell browsers to always use HTTPS for this domain
      strictTransportSecurity:
        process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // [MED-5] CORS — in production ALLOWED_ORIGINS must be explicitly configured.
  // Falling back to localhost in production would silently open CORS to local dev servers.
  const isProduction = process.env.NODE_ENV === 'production';
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : isProduction
      ? (() => {
          throw new Error(
            '[Security] ALLOWED_ORIGINS env var must be set in production. ' +
              'Set it to a comma-separated list of allowed origins (e.g. https://yourdomain.com).',
          );
        })()
      : ['http://localhost:3000', 'http://localhost:4000', 'http://localhost:5173'];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Custom logger
  const logger = app.get(LoggerService);
  app.useLogger(logger);

  // Global exception filter (REST)
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  // Strict validation — strip unknown props and reject extra fields
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application running on port ${port}`, 'Bootstrap');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.log(`${signal} received — closing application gracefully`, 'Bootstrap');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap();
