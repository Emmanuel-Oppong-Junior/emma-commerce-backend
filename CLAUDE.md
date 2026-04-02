# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Task Tracking

All production-readiness tasks are tracked in [`TODO.md`](./TODO.md). After completing any task from the audit, mark its checkbox (`- [ ]` → `- [x]`) in `TODO.md` before moving on.

## Commands

```bash
# Development
npm run start:dev       # Start with live reload (development)
npm run start:prod      # Run compiled output

# Build
npm run build           # Compile TypeScript via NestJS CLI

# Code quality
npm run lint            # ESLint with auto-fix
npm run format          # Prettier format

# Testing
npm run test            # Run all unit tests
npm run test:watch      # Watch mode
npm run test:cov        # Coverage report
npm run test:e2e        # End-to-end tests (uses test/jest-e2e.json, separate .env.test DB)

# Database
npx prisma migrate dev  # Run migrations in development
npx prisma generate     # Regenerate Prisma Client after schema changes
npm run prisma:seed     # Seed the database
```

## Architecture

**NestJS** backend with **GraphQL** (Apollo Server v4) as the primary API. REST endpoints exist only for payment webhooks (Paystack). The GraphQL schema is auto-generated to `schema.gql` on startup.

**Database:** PostgreSQL via **Prisma** ORM. Schema lives in `prisma/schema.prisma`. Migrations are in `prisma/migrations/`.

### Module structure

Each feature follows this pattern:
```
feature/
├── feature.module.ts
├── feature.service.ts        # Business logic, calls Prisma directly
├── feature.resolver.ts       # GraphQL queries/mutations
├── dto/                      # Input types and filter args (class-validator decorated)
├── entities/                 # GraphQL output types
└── enums/                    # Feature-specific enums
```

Feature modules: `users`, `products`, `categories`, `sub-categories`, `brand`, `tag`, `variant`, `cart`, `order`, `payment`, `addresses`, `discount`, `wishlist`, `review`.

### Authentication & Authorization (`src/iam/`)

- **JWT**: Access token (1h) + Refresh token (24h). All routes are protected by default via `AuthenticationGuard`.
- Mark public routes with `@Auth(AuthType.None)`.
- Mark admin routes with `@Roles(Role.ADMIN)` or `@Roles(Role.SUPER_ADMIN)`.
- Social login: Google and Facebook via `GoogleAuthenticationService` / `FacebookAuthenticationService`, linked to users through the `AuthProvider` model.

### Commons (`src/commons/`)

- `LoggerService` — Winston-based logger, used app-wide
- `CloudinaryService` — image upload/storage
- Global exception filter handles Prisma errors and maps them to GraphQL errors
- `PaginationArgs` / `PageInfo` entities are shared across all list queries

### Key environment variables

```
DATABASE_URL
JWT_SECRET / JWT_REFRESH_SECRET
JWT_TOKEN_AUDIENCE / JWT_TOKEN_ISSUER
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
FACEBOOK_APP_ID / FACEBOOK_APP_SECRET
PAYSTACK_SECRET_KEY
CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
```

Test environment uses `.env.test` with a separate database.
