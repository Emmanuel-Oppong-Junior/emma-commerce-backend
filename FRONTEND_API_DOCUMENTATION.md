# Emma Commerce Backend — Complete Frontend Technical Documentation

> `schema.gql` (generated from the resolvers) is the source of truth for operation names, arguments, types, nullability and enum values. This document adds what the schema cannot say: who may call each operation, validation rules, errors and behaviour. If the two disagree, `schema.gql` wins; report the difference.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [GraphQL API Reference](#2-graphql-api-reference)
   - [Authentication (IAM)](#21-authentication-iam)
   - [Users](#22-users)
   - [Products](#23-products)
   - [Categories](#24-categories)
   - [SubCategories](#25-subcategories)
   - [Brands](#26-brands)
   - [Tags](#27-tags)
   - [Variants](#28-variants)
   - [Cart](#29-cart)
   - [Guest checkout](#29a-guest-checkout-p6-g1)
   - [Wishlist](#210-wishlist)
   - [Orders](#211-orders)
   - [Payment](#212-payment)
   - [Promotions and coupon codes](#213-promotions-and-coupon-codes)
   - [Loyalty points](#213a-loyalty-points-p6-l1)
   - [Referrals](#213b-referrals-p6-l2)
   - [Inventory](#215-inventory)
   - [Returns](#216-returns)
   - [Reviews](#217-reviews)
   - [Product questions and answers](#217a-product-questions-and-answers)
   - [Recently viewed products](#217b-recently-viewed-products)
   - [Tax](#218-tax)
   - [Analytics](#219-analytics)
   - [Addresses](#220-addresses)
   - [Shipping Zones & Pickup Locations](#221-shipping-zones--pickup-locations)
   - [Store settings](#222-store-settings)
   - [Store features](#222a-store-features-p8-f)
   - [Background jobs](#223-background-jobs)
   - [Staff roles and permissions](#224-staff-roles-and-permissions)
   - [Two-factor authentication and step-up](#225-two-factor-authentication-and-step-up)
   - [Product types and attributes](#226-product-types-and-attributes)
   - [Storefront content and SEO](#227-storefront-content-and-seo-p8-c)
   - [Bulk imports and exports](#228-bulk-imports-and-exports)
3. [REST API Reference](#3-rest-api-reference)
4. [Types & Enums](#4-types--enums)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [Commerce Flows](#6-commerce-flows)
7. [Order Lifecycle](#7-order-lifecycle)
8. [Payment Integration (Paystack)](#8-payment-integration-paystack)
9. [Inventory Rules](#9-inventory-rules)
10. [Promotions System](#10-promotions-system)
11. [Tax & Currency](#11-tax--currency)
12. [Error Handling Standard](#12-error-handling-standard)
13. [Pagination & Filtering](#13-pagination--filtering)
14. [File Upload (Cloudinary)](#14-file-upload-cloudinary)
15. [Notifications System](#15-notifications-system)
16. [Analytics Queries](#16-analytics-queries)
17. [Environment Variables Required](#17-environment-variables-required)
18. [Frontend Integration Guide](#18-frontend-integration-guide)
19. [Example Complete User Journey](#19-example-complete-user-journey)

---

## 1. System Overview

### Architecture

The backend is a modular **NestJS** application. Each feature domain (products, cart, orders, etc.) lives in its own NestJS module following a consistent pattern:

```
feature/
├── feature.module.ts
├── feature.service.ts        # Business logic
├── feature.repository.ts     # Prisma data access
├── feature.resolver.ts       # GraphQL queries/mutations
├── dto/                      # Input types with class-validator decorators
└── entities/                 # GraphQL output types
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | NestJS v10+ |
| API | GraphQL (code-first) via Apollo Server v4 |
| ORM | Prisma v6 |
| Database | PostgreSQL |
| Auth | JWT (Access + Refresh Tokens) stored in `RefreshToken` table |
| Hashing | bcrypt |
| Payments | Paystack |
| File Storage | Cloudinary (images resized to 500×500 before upload via sharp) |
| Caching | Redis (required in every environment; also backs rate limiting and the job queues) |
| Email | Resend |
| Logging | Winston (via custom `LoggerService`) |
| Tracing | OpenTelemetry (OTLP/HTTP exporter, opt-in via `OTEL_ENABLED=true`) |
| Background jobs | BullMQ on Redis, run by a separate `ROLE=worker` process. Repeatable jobs, each run once per cluster: unpaid-order expiry (hourly), payment reconciliation sweep (every 5 minutes), Paystack daily diff (01:30 UTC), stock ledger reconciliation (02:30 UTC, reports only), low-stock staff digest (every 3 hours, 06:00-21:00 UTC). Low-stock alerts are events raised by stock changes (`inventory.low_stock.v1`), not a scan |
| Rate Limiting | `@nestjs/throttler` with per-named-throttler rules |

### GraphQL Approach

**Code-first.** The schema is auto-generated to `schema.gql` on startup. NestJS `@ObjectType()` and `@InputType()` decorators define the schema. Apollo Server v4 is the driver.

- Landing page: Apollo Sandbox outside production, disabled in production.
- Introspection: **disabled in production**.
- Error formatting: internal errors are masked in production; validation/auth/business logic errors are always forwarded.

### Auth Strategy

- **Default**: all routes require Bearer JWT unless decorated with `@Auth(AuthType.None)`.
- **Optional sign-in** (P2-W.1): the public catalogue queries `products`, `product`, `brands`, `brand` and `categories` work without a token, and honour one when it is sent, so a signed-in customer sees their own prices (`Variant.customerPrice`, `priceTiers`, and their group and first-order promotions in `discountedPrice`). A token that is sent must be valid: an invalid or expired one fails with `UNAUTHENTICATED` (refresh it, or send no token), it never falls back to the anonymous view.
- Access token: short-lived (default 1 hour, `JWT_ACCESS_TOKEN_TTL`).
- Refresh token: longer-lived (default 24 hours, `JWT_REFRESH_TOKEN_TTL`), stored **hashed** in the `RefreshToken` database table.
- Refresh tokens are **rotated** on use — old token is revoked, new pair is issued atomically. Replaying a used refresh token signs the user out everywhere (see [Section 5](#5-authentication--authorization)).
- A session can be refreshed for at most **30 days** after sign-in; then the user must sign in again.
- Password reset tokens: 15-minute TTL signed with separate secret (`JWT_RESET_SECRET`).
- **Account lockout**: 5 consecutive failed logins trigger a 15-minute lockout (tracked in `User.failedLoginAttempts` and `User.lockedUntil`).
- **Two-factor authentication (TOTP)**: any user may enrol; Owners and Managers must. Accounts with it complete `signIn` (and social sign-in) with `completeMfaSignIn`. Sensitive staff actions need a verification in the last 10 minutes (`stepUp`). See [2.25](#225-two-factor-authentication-and-step-up).

### Payment Integration

- Paystack serves online payments (card and mobile money). The store's Paystack keys are set by the Owner with `setPaystackConfig` ([2.12](#212-payment)); the server's `PAYSTACK_SECRET_KEY` is only a fallback. Which methods are on offer comes from the public `availablePaymentMethods` query.
- Payment is initiated via a **REST POST** endpoint (`POST /payment/initialize`) with the chosen method (`CARD` or `MOBILE_MONEY`).
- Frontend redirects user to Paystack's `authorizationUrl`.
- After payment Paystack redirects the browser to `PAYSTACK_CALLBACK_URL`, which must be a **frontend page** (the backend has no callback route). That page calls the `verifyPayment` GraphQL mutation with the `reference` query parameter.
- Paystack also calls the **webhook** (`POST /payment/webhook`) with `charge.success` or `charge.failed` events, and a background sweep re-checks open payments every 5 minutes.

### File Storage (Cloudinary)

Images are uploaded via REST endpoints for staff holding `catalog.media.upload` only (`POST /upload/single-image`, `POST /upload/multiple-images`). Images are resized to **500×500** pixels (contain mode, white background) before upload. Folder: `ecommerce`.

### Observability

- Winston logger logs all HTTP requests (middleware), GraphQL operations (interceptor), and errors, as JSON lines in production.
- **Request id:** every response (REST and GraphQL) carries an `X-Request-ID` header. Send your own `X-Request-ID` (letters, digits and `-`, at most 64 characters) to correlate a client action with server logs; any other value is ignored and replaced with a generated UUID. The header is allowed and exposed by CORS. Quote it when reporting a problem.
- OpenTelemetry: activate with `OTEL_ENABLED=true`; exports traces to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318/v1/traces`).
- Server errors (5xx / `INTERNAL_SERVER_ERROR`) are tracked in Sentry with the request id; client errors are not. Prometheus metrics are served on a separate internal port, not by the API. No change to any operation.

### Database

PostgreSQL via Prisma. Product search (P6-S.1, ADR-0010) runs on Postgres full-text search (a weighted `tsvector` per product, GIN index) with `pg_trgm` trigram matching for typos, behind a search port.

---

## 2. GraphQL API Reference

**GraphQL Endpoint**: `POST /graphql`

### Platform rules

**Auth.** Every operation requires `Authorization: Bearer <accessToken>` unless marked **Auth Required: No** (public). A missing, invalid or expired token, or a deactivated account, gives `UNAUTHENTICATED`. The account (and its role) is re-read from the database on every request.

**Permissions.** Staff operations need a permission (e.g. `order.refund`), granted by the user's staff role (see [2.24](#224-staff-roles-and-permissions)). Customers have no staff role and no permissions. The labels in this reference still say `ADMIN` and `SUPER_ADMIN`: `ADMIN` means the **Manager** role (every legacy ADMIN account became a Manager) and `SUPER_ADMIN` the **Owner** role; the exact permission of every operation is in the table in [2.24](#224-staff-roles-and-permissions). The Owner holds every permission, so nothing locks an Owner out any more (the former `ADMIN`-only operations `getUserPayment`, `softDeletePayment`, `restorePayment`, `updateSubCategory` and `removeSubCategory` now accept the Owner too). A few self-service operations (`cancelOrder`, `verifyPayment`, `getMyPayments`, `createReview`, `updateReview`, `deleteReview`, `reportReview`, `askProductQuestion`, `reportProductQuestion`) are for customers only and refuse any staff account with `FORBIDDEN`. Permissions are re-read with the account on every request, so a role change applies on the caller's next request. A missing permission is `FORBIDDEN`.

**Query limits** (checked before execution; a violation is a `GRAPHQL_VALIDATION_FAILED` error, HTTP 400):

| Limit | Value |
|---|---|
| Selection depth | 8 |
| Aliases per document | 15 |
| Estimated cost | 3000 (each field 1; a list costs its `first`/`paginationArgs.first`, or 10, times its fields) |

Introspection does not count towards the limits and is disabled in production.

**Rate limits** (`@nestjs/throttler`, counted per client IP unless stated):

| Scope | Limit |
|---|---|
| Every request (GraphQL and REST) | 120 / minute |
| `signUp`, `signIn`, `signInWithGoogle`, `signInWithFacebook` | 5 / minute |
| `verifyEmail` | 10 / minute |
| `forgotPassword` | 3 / hour per IP and 3 / hour per email address |
| `resetPassword` | 3 / hour |
| `resendVerificationEmail` | 5 / hour (plus one email per minute per account) |
| `completeMfaSignIn`, `startMfaEnrollment`, `confirmMfaEnrollment`, `stepUp` | 5 / minute |
| `POST /payment/initialize` | 5 / minute |
| `POST /upload/*` | 10 / minute |
| `refreshToken`, `signOut` | exempt from all limits |

Over a limit the request fails with HTTP status 429; in GraphQL that is `extensions.code: "BAD_REQUEST"` with `extensions.status: 429` (see [Section 12](#12-error-handling-standard)).

**Tokens**: access 1 hour, refresh 24 hours (rotated, session capped at 30 days), password reset 15 minutes. Details in [Section 5](#5-authentication--authorization).

**Errors** use `extensions.code` and `extensions.status`; the mapping is in [Section 12](#12-error-handling-standard). Validation failures on input types are `BAD_USER_INPUT`; unknown input fields are rejected.

---

### 2.1 Authentication (IAM)

All auth mutations are `@Auth(AuthType.None)` — **no token required** unless noted.

---

#### `signUp`
- **Type**: Mutation
- **Args**: `input: SignUpInput!`
- **Auth Required**: No
- **Rate Limit**: 5 requests/minute
- **Description**: Register a new user account with email and password. Returns a token pair immediately; the account starts unverified (`User.emailVerified: false`) and a verification email with a one-time token is sent shortly after. The welcome email is sent only once the address is verified with `verifyEmail`. Unverified accounts can sign in and check out as usual.

**Input: `SignUpInput`**

```typescript
{
  name: string;      // Required. 2–50 chars. Trimmed and lowercased.
  email: string;     // Required. Valid email. Trimmed and lowercased.
  password: string;  // Required. Password policy: 8–128 chars; uppercase, lowercase, digit and special char (@$!%*?&_-#); no other characters.
}
```

**Example Input**:
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "Secret@123"
}
```

**Response: `AuthEntity`**

```typescript
{
  accessToken: string;   // JWT access token (1h)
  refreshToken: string;  // JWT refresh token (24h)
}
```

**Possible Errors**:
- `CONFLICT` — Email already registered.
- `BAD_USER_INPUT` — Validation failure (name length, email format, password complexity).

---

#### `signIn`
- **Type**: Mutation
- **Args**: `input: SignInInput!`
- **Auth Required**: No
- **Rate Limit**: 5 requests/minute
- **Description**: Authenticate with email and password. Account lockout enforced after 5 failed attempts (15-minute cooldown).

**Input: `SignInInput`**

```typescript
{
  email: string;     // Required. Valid email.
  password: string;  // Required. Non-empty, at most 128 chars (no complexity check at sign-in).
}
```

**Response: `AuthEntity`** (same as `signUp`)

**Possible Errors**:
- `UNAUTHENTICATED` — Invalid email or password.
- `UNAUTHENTICATED` — Account locked (includes remaining lock time in seconds in message).
- `UNAUTHENTICATED` with `extensions.reason: "MFA_REQUIRED"` and `extensions.mfaChallenge` — the password was right but the account has two-factor authentication: no tokens are issued; finish with `completeMfaSignIn` (see [2.25](#225-two-factor-authentication-and-step-up)). `signInWithGoogle` / `signInWithFacebook` behave the same for such accounts. Accounts without two-factor authentication are unaffected.

---

#### `refreshToken`
- **Type**: Mutation
- **Args**: `input: RefreshTokenInput!`
- **Auth Required**: No (uses refresh token)
- **Rate Limit**: Not throttled (gated by token validity)
- **Description**: Issue new access + refresh token pair. Old refresh token is immediately revoked (rotation). Account must be active.
- **Rules**:
  - Send each refresh token once. Serialise refresh calls per client (one in flight, shared across tabs) and store the new pair before using it.
  - Presenting an already-rotated token is treated as theft: if no other token of the user was issued in the last 10 seconds, **every session of the user is revoked**. Inside those 10 seconds (two tabs racing) the late call just fails.
  - The new refresh token never outlives the session: 30 days after the original sign-in, refresh fails with "Session has expired, please sign in again".

**Input: `RefreshTokenInput`**

```typescript
{
  refreshToken: string; // Required. The current valid refresh token.
}
```

**Response: `AuthEntity`**

**Possible Errors**:
- `UNAUTHENTICATED` — "Invalid or expired refresh token" (unknown, revoked, reused or expired), "Session has expired, please sign in again", "Account is inactive", "User not found".

---

#### `signOut`
- **Type**: Mutation
- **Args**: `input: SignOutInput!`
- **Auth Required**: Yes (Bearer)
- **Rate Limit**: Not throttled
- **Description**: Revoke the provided refresh token. Idempotent — succeeds even if token not found. The access token stays valid until it expires (up to 1 hour); discard it client-side.

**Input: `SignOutInput`**

```typescript
{
  refreshToken: string; // The refresh token to revoke.
}
```

**Response**: `Boolean` (always `true`)

---

#### `signInWithGoogle`
- **Type**: Mutation
- **Args**: `input: SocialLoginInput!`
- **Auth Required**: No
- **Rate Limit**: 5 requests/minute
- **Description**: Authenticate via a Google OAuth **access token** (the code calls Google's `tokeninfo?access_token=` and `userinfo` endpoints; the schema description says "ID token", which is inaccurate). If no account is linked to the Google identity, a new account is created.

**Input: `SocialLoginInput`**

```typescript
{
  token: string; // Google OAuth access token obtained client-side.
}
```

**Response: `AuthEntity`**

**Flow**:
1. Backend validates token against Google's tokeninfo endpoint.
2. Verifies `aud` matches `GOOGLE_CLIENT_ID` and that `userinfo` belongs to the same Google user.
3. Looks up the account linked to that Google ID.
4. If none: creates a new account (no password; email starts verified). If an account with the same email already exists (e.g. registered with a password), the call is refused; there is no account linking yet.
5. Returns token pair.

**Possible Errors**:
- `UNAUTHENTICATED` — Invalid Google token, token not issued for this app, Google account has no email, or "Google account email address is not verified".
- `CONFLICT` — "An account with this email already exists. Sign in with your email and password, …".
- `INTERNAL_SERVER_ERROR` (`status: 503`) — Google could not be reached or answered with an error.

---

#### `signInWithFacebook`
- **Type**: Mutation
- **Args**: `input: SocialLoginInput!`
- **Auth Required**: No
- **Rate Limit**: 5 requests/minute
- **Description**: Authenticate via Facebook access token. Same behaviour as Google (new account if not linked, `CONFLICT` if the email is already registered), except that new Facebook accounts start with an unverified email.

**Input: `SocialLoginInput`**

```typescript
{
  token: string; // Facebook access token obtained client-side.
}
```

**Response: `AuthEntity`**

**Possible Errors**: `UNAUTHENTICATED` (invalid token, no email on the Facebook account), `CONFLICT` (email already registered), `INTERNAL_SERVER_ERROR` with `status: 503` (Facebook unreachable).

---

#### `forgotPassword`
- **Type**: Mutation
- **Args**: `input: ForgotPasswordInput!`
- **Auth Required**: No
- **Rate Limit**: 3 requests/hour per IP, and 3 requests/hour per email address (trimmed, case-insensitive), whichever is hit first. Over either limit the request fails with the same throttling error whether or not the email has an account.
- **Description**: Send a password reset email. Always returns `true` even if the email is not found (prevents user enumeration). The response is sent before the account lookup, so its timing is the same either way; the email itself follows shortly after.

**Input: `ForgotPasswordInput`**

```typescript
{
  email: string; // Required. Valid email. Trimmed and lowercased.
}
```

**Response**: `Boolean` (always `true`; a failure while issuing the reset is logged server-side, not returned)

**Note**: The reset token is a signed JWT (15-minute TTL, `JWT_RESET_SECRET`) delivered in the email. The token is stored **hashed** in `User.passwordResetToken`.

---

#### `resetPassword`
- **Type**: Mutation
- **Args**: `input: ResetPasswordInput!`
- **Auth Required**: No
- **Rate Limit**: 3 requests/hour
- **Description**: Reset password using the token from the email.

**Input: `ResetPasswordInput`**

```typescript
{
  resetToken: string;  // The JWT token from the password reset email.
  newPassword: string; // Password policy (same as signUp).
}
```

**Response**: `Boolean`. On success every session of the user is revoked (they sign in again with the new password).

**Possible Errors**:
- `UNAUTHENTICATED` — "Invalid or expired reset token" (invalid, expired, or already used).

---

#### `verifyEmail`
- **Type**: Mutation
- **Args**: `input: VerifyEmailInput!`
- **Auth Required**: No
- **Rate Limit**: 10 requests/minute
- **Description**: Verify an email address with the token from a verification email (the frontend page that receives the token calls this). Without a pending change it marks the account's current email verified. With a pending email change it replaces `email` with `pendingEmail` and **revokes every refresh token of the user** (all sessions end; the user signs in again with the new email).

**Input: `VerifyEmailInput`**

```typescript
{
  token: string; // The token from the email. Non-empty, at most 128 chars.
}
```

**Response**: `Boolean` (`true`)

**Possible Errors**:
- `BAD_REQUEST` — "Invalid or expired verification token" (unknown, expired after 24 hours, already used, or replaced by a newer token).
- `CONFLICT` — The pending new address was taken by another account before it was verified; the email change is cancelled (`pendingEmail` cleared).

**Note**: Tokens are random, single-use, valid for 24 hours, and stored **hashed** (`User.emailVerificationToken`). Each new verification email (sign-up, resend, email change) replaces the previous token.

---

#### `resendVerificationEmail`
- **Type**: Mutation
- **Auth Required**: Yes (any signed-in user)
- **Rate Limit**: 5 requests/hour per IP, and at most one email per minute per account
- **Description**: Send a fresh verification token: to `pendingEmail` if an email change is in progress, otherwise to the current email if it is unverified.

**Response**: `Boolean` (`true`)

**Possible Errors**:
- `UNAUTHENTICATED` — No or invalid access token.
- `BAD_REQUEST` — "Your email address is already verified" (nothing pending), or "A verification email was sent less than a minute ago; please wait before retrying".

---

### 2.2 Users

Customer accounts are managed with `user.manage` (Manager, Owner). Acting on a **staff** account (any user with a staff role) with `updateUser`, `removeUser`, `archiveUser` or `deArchiveUser` also needs `staff.manage` and every permission that account holds; an Owner account can only be changed by an Owner, and the last active Owner can never be archived, deleted or demoted. In practice a Manager manages customers only and the Owner manages staff. Owner accounts (legacy `SUPER_ADMIN`) are never listed by `users` and cannot be created with `createUser`; make an Owner with `assignStaffRole`.

---

#### `createUser` (`staff.manage`: Owner)
- **Type**: Mutation
- **Args**: `createUserInput: CreateUserInput!`
- **Response**: `User!`
- **Description**: Create a user account with a password.

**Input: `CreateUserInput`**

```typescript
{
  name: string;            // Required. 2–50 chars. Trimmed and lowercased.
  email: string;           // Required. Valid email. Trimmed and lowercased.
  password: string;        // Required. Password policy (same as signUp).
  phoneNumber?: string;    // Optional. Ghana number, stored as +233XXXXXXXXX (formats in 2.20 Addresses).
  profilePicture?: string; // Valid URL.
  isActive: boolean;       // Default true.
  role: Role;              // Default USER. USER or ADMIN; SUPER_ADMIN is refused. ADMIN gives the account the
                           // Manager staff role (same escalation rules as assignStaffRole).
}
```

**Possible Errors**: `FORBIDDEN` ("Super admin accounts cannot be created through the API"), `CONFLICT` ("A user with this email already exists", or "Phone number is already in use"), `BAD_USER_INPUT` (including a phone number that is empty or not a Ghana number).

---

#### `users` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `filter: UserPaginateArgs!`
- **Response**: `UserConnection!`
- **Description**: Cursor-paginated, filtered list of users. `SUPER_ADMIN` accounts are never included.

**Input: `UserPaginateArgs`** (`PaginationArgs` fields plus filters)

```typescript
{
  first: number;          // Default 12, 1–100
  after?: string;         // Cursor (user ID from the previous page)
  orderBy?: string;       // One of: id, name, email, phoneNumber, role, isActive, createdAt, updatedAt, lastLoginAt, profilePicture (also accepts "password")
  orderInAsc?: boolean;   // Default true
  email?: string;         // Partial match, case-insensitive
  phoneNumber?: string;   // Exact match against the stored form (+233XXXXXXXXX); not normalised
  role?: Role;            // USER | ADMIN (SUPER_ADMIN is always excluded)
  isActive?: boolean;
  name?: string;          // Partial match, case-insensitive
  createdAfter?: DateTime;// Users created on or after this date
}
```

An `orderBy` outside the list fails with `INTERNAL_SERVER_ERROR` (masked in production).

**Response: `UserConnection`**

```typescript
{
  edges: [{ node: User, cursor: string }];
  pageInfo: PageInfo; // { hasNextPage, hasPreviousPage, pageSize, totalCount }
}
```

**Example**:
```graphql
query {
  users(filter: { first: 20, role: USER, isActive: true }) {
    edges { cursor node { id name email role isActive createdAt } }
    pageInfo { hasNextPage totalCount }
  }
}
```

---

#### `userById` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `id: String!`
- **Response**: `User!`. An unknown ID is `NOT_FOUND`.

---

#### `userByEmail` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `email: String!`
- **Response**: `User!`. Same unknown-value behaviour as `userById`.

---

#### `userByProviderId` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `providerId: String!` (the Google or Facebook user ID)
- **Response**: `User!` linked to that social identity. Same unknown-value behaviour as `userById`.

---

#### `userProfile`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user)
- **Response**: `User!` for the caller, with `addresses` and `orders` available. `NOT_FOUND` if the account no longer exists.

---

#### `updateMyProfile` (USER, ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Auth Required**: Yes
- **Description**: Update the currently authenticated user's own profile. Changing `email` requires the `currentPassword` argument and does **not** change the email immediately: the new address is stored as `pendingEmail`, a verification token is emailed to it, and a notice (with the new address masked) goes to the current address. `email` switches only when the new address is verified with `verifyEmail`, which also signs the user out everywhere. Other fields in the same call are applied right away. Submitting the current email unchanged needs no password.

**Args**: `updateMyProfileInput: UpdateUserInput!`, `currentPassword: String` (optional; required when `email` changes)

**Input: `UpdateUserInput`**

```typescript
{
  name?: string;           // Optional. 2–50 chars.
  email?: string;          // Optional. Valid email. A new value becomes pendingEmail until verified.
  phoneNumber?: string | null; // Optional. Ghana number as 0XXXXXXXXX, 233XXXXXXXXX, +233XXXXXXXXX or 00233XXXXXXXXX
                               // (spaces, dashes, dots, parentheses ignored); stored as +233XXXXXXXXX. null removes it;
                               // "" or any other format is BAD_USER_INPUT.
  profilePicture?: string; // Optional. Must be a valid URL.
}
```

**Response**: `User` (with the unchanged `email` and the new `pendingEmail` after an email change request)

**Possible Errors** (email change):
- `BAD_REQUEST` — "currentPassword is required to change your email", or the account has no password (social sign-in only; set one with `forgotPassword` first).
- `FORBIDDEN` — "Current password is incorrect". Nothing in the call is applied.
- `CONFLICT` — "This email address is already in use".

**Possible Errors** (phone number): `BAD_USER_INPUT` for an empty or non-Ghana number; `CONFLICT` "Phone number is already in use" when another account has the same number (compared after normalisation, so `0244123456` and `+233244123456` are the same). Nothing in the call is applied.

---

#### `updateUser` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: String!`, `updateUserInput: UpdateUserInput!`
- **Response**: `User!`
- **Description**: Update another user's profile (super admin accounts cannot be modified; admin accounts only by a super admin). A new `email` goes through the same verification as `updateMyProfile` (stored as `pendingEmail`, verification email to the new address, notice to the old one, switch on `verifyEmail`), without a password.
- **Possible Errors**: `FORBIDDEN`, `NOT_FOUND`, `CONFLICT` ("This email address is already in use", or "Phone number is already in use"), `BAD_USER_INPUT` (phone number as for `updateMyProfile`).

---

#### `changeUserPassword` (USER, ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Auth Required**: Yes
- **Args**: `input: ChangeUserPasswordInput!`
- **Response**: `User!`. On success every session of the user is revoked; the current access token keeps working until it expires (up to 1 hour), but the next refresh fails, so sign the user in again.

**Input: `ChangeUserPasswordInput`**

```typescript
{
  oldPassword: string; // Non-empty, at most 128 chars. Must verify against current password.
  newPassword: string; // Password policy (same as signUp).
}
```

**Possible Errors**: `FORBIDDEN` ("Old password is incorrect", "New password must be different from old password"), `BAD_USER_INPUT`.

---

#### `removeUser` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: String!`
- **Response**: `User!`
- **Description**: Permanently deletes a user (addresses, cart, wishlist, reviews, sessions go with it). A user who has orders or return requests cannot be deleted (`CONFLICT`); archive them instead.
- **Possible Errors**: `NOT_FOUND`, `FORBIDDEN` (super admin target, or an ADMIN acting on an ADMIN), `CONFLICT`.

---

#### `archiveUser` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: String!`
- **Response**: `User!`
- **Description**: Deactivates the account (`isActive = false`) and revokes all its sessions. A deactivated user cannot sign in, refresh, or use an existing access token.
- **Possible Errors**: `NOT_FOUND`, `FORBIDDEN` (same target rules as `removeUser`).

---

#### `deArchiveUser` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: String!`
- **Response**: `User!`
- **Description**: Reactivates an archived account (`isActive = true`). The user signs in again.
- **Possible Errors**: `NOT_FOUND`, `FORBIDDEN` (same target rules as `removeUser`).

---

**`User` Object Type**:

```typescript
{
  id: string;
  name: string | null;
  email: string;           // Owner or admin only.
  emailVerified: boolean;  // Owner or admin only. False until the current email is verified.
  pendingEmail?: string;   // Owner or admin only. New email awaiting verification.
  phoneNumber?: string;    // Owner or admin only. E.164, e.g. "+233244123456".
  authProvider?: string;   // Not populated today (always null).
  facebookId?: string;     // Not populated today (always null).
  isActive: boolean;
  profilePicture?: string;
  role: string;            // DEPRECATED legacy role, kept in step: "SUPER_ADMIN" for an Owner, "ADMIN" for any
                           // other staff role, "USER" for customers. Use staffRole / permissions.
  staffRole?: StaffRole;   // Owner or user.view only. The staff role, null for customers.
  permissions: string[];   // Owner or user.view only. Effective permissions, [] for customers.
  createdAt: DateTime;
  updatedAt: DateTime;
  lastLoginAt?: DateTime;
  addresses?: Address[];   // Owner or admin only.
  orders?: Order[];        // Owner or admin only.
}
```

"Owner or admin only" means the user themself or staff holding `user.view`. Reading such a field of another user without it gives `FORBIDDEN` for that field.

---

### 2.3 Products

> **Optional sign-in (P2-W.1):** `products` and `product` (and `brands`, `brand`, `categories`) need no token, but a valid bearer token makes the viewer's prices personal: see `Variant.customerPrice` / `priceTiers` in [2.8](#28-variants). An invalid or expired token fails with `UNAUTHENTICATED`.

> **Visibility:** the public `products` and `product` queries only ever return products that are active **and** `PUBLISHED`; `isActive`/`status` sent in `filterArgs` cannot widen that. `product` returns `null` for a draft, archived or inactive product. Admins list and open products in any state with `adminProducts` / `adminProduct`. Nested `products` on `Category`, `SubCategory` and `Brand` also return published products only, newest first, capped by `first` (default 20, 1–100; anything else is an error).

> **Price and stock live on the variant (P1-V.3, ADR-0003).** A product is sold only through its variants (SKUs, see [2.8](#28-variants)): each variant has its own `basePrice`, `price`, `discountedPrice`, `sku`, `barcode` and `quantity`. A variant's `price` (what customers pay and checkout charges) is `basePrice × (1 + sum of active tax rates)` when the product `isTaxable`, otherwise `basePrice`. The product shows summaries: `priceRange`, `totalStock` and `inStock`. Customers pick a variant from `Product.variants` and put that in the cart.

> **Breaking changes (P6-S.1)** `[breaking-api]`: product cursors (`ProductEdge.cursor`, `paginationArgs.after` on `products`/`adminProducts`) are opaque keyset cursors instead of product ids, valid only with the `sortArgs` they were made with (a product id as `after` is now `BAD_REQUEST`). `ProductSortArgs.sortBy` has no schema default (default: `RELEVANCE` with search text, else `CREATED_AT`). `inStock: false` now keeps only products nobody can buy (it was ignored). `inStock: true` now also leaves out units of expired lots. `priceMin` above `priceMax` is `BAD_REQUEST`. `search` is limited to 200 characters, no longer matches part of a tag name (whole tag words are matched), and matches the brand, category and sub-category names and the short description too. New: `ProductSortField.RELEVANCE`, `ProductFilterArgs.brandId` and `productTypeId`.

> **Breaking change (P1-V.3):** `Product.price`, `basePrice`, `currentPrice`, `quantity`, `sku`, `barcode`, `stockStatus`, `lowStockAlert`, `discountedPrice` and `appliedDiscount` → removed; read `priceRange` / `totalStock` / `inStock` on the product and `price` / `discountedPrice` / `appliedDiscount` / `sku` / `barcode` / `quantity` on each of its `variants`. The `StockStatus` enum is removed. `ProductSortField` loses `PRICE` and `QUANTITY`. `CreateProductInput` loses `basePrice`, `quantity`, `sku`, `barcode`, `stockStatus` and `lowStockAlert` and requires `variants`; `UpdateProductInput` loses `basePrice`, `sku`, `barcode`, `stockStatus` and `lowStockAlert`. `Product.variants` is now non-null and returns only active variants.

---

#### `products`
- **Type**: Query
- **Auth Required**: No
- **Args**: `paginationArgs: PaginationArgs`, `filterArgs: ProductFilterArgs`, `sortArgs: ProductSortArgs` (all optional)
- **Response**: `ProductConnection!`
- **Description**: Cursor-paginated, filtered, sorted list of **published, active** products only.

```typescript
// PaginationArgs (when the argument is omitted entirely, the page size is 10)
{
  first: number;        // Default 12, 1–100
  after?: string;       // The cursor of the last edge of the previous page (opaque; only valid with the same sortArgs)
  orderBy?: string;     // Ignored for products; use sortArgs
  orderInAsc?: boolean; // Ignored for products; use sortArgs
}

// ProductFilterArgs
{
  categoryId?: string;
  categoryName?: string;      // Exact, case-insensitive
  subCategoryName?: string;   // The sub-category's name, exact, case-insensitive
  subcategoryId?: string;
  isActive?: boolean;         // Default true; ignored by public queries
  status?: ProductStatus;     // DRAFT | PUBLISHED | ARCHIVED; ignored by public queries
  search?: string;            // Full-text search, max 200 characters: see "Search" below
  createdAfter?: string;      // ISO date string
  priceMin?: Decimal;         // Inclusive, compared with an active variant's price
  priceMax?: Decimal;         // Inclusive, compared with an active variant's price; priceMin > priceMax is BAD_REQUEST
  brand?: string;             // Brand name, exact, case-insensitive
  brandId?: string;           // P6-S.1
  productTypeId?: string;     // P6-S.1
  inStock?: boolean;          // true = a customer can buy an active variant now; false = of none; omitted = no filter
  tagId?: string;             // With tagName, the product needs both
  tagName?: string;           // Exact, case-insensitive
  attributes?: { key: string; values: string[] }[];  // P6-S.2: see "Facets" below; at most 10 keys, 1-20 values each
}

// ProductSortArgs
{
  sortBy?: ProductSortField;  // RELEVANCE | CREATED_AT | NAME | UPDATED_AT; default RELEVANCE with search text, else CREATED_AT
  sortOrder: SortOrder;       // DESC (default) | ASC; RELEVANCE is always best first
}
```

**Filters (P6-S.1).** Every filter given applies (they combine with AND; none replaces another). `priceMin`/`priceMax` compare with an active variant's stored selling `price` (tax included, before promotions and B2B price lists: a list price or promotion can make the price the customer pays lower than the filter suggests; filter on the shelf price). With both bounds, one variant must be inside both. `inStock: true` keeps a product when one of its active variants has units a customer can buy now, exactly like `Variant.available > 0` and `Product.inStock`: unreserved units at its best location serving customers, units of expired lots left out; `inStock: false` keeps the products none of whose variants can be bought. With `inStock: true` and a price bound the **same** variant must be in stock and in range (`priceMax: "50", inStock: true` needs a variant that costs at most 50 and is in stock). There is no price or stock sort.

**Search (P6-S.1).** `search` uses web-search syntax: words must all match (`kente scarf`), `"quoted phrase"`, `OR`, `-exclude`; any other punctuation (`' : & | ! ( ) < *`) is accepted and never fails. It matches the product name (weight highest), its brand, category, sub-category and tag names, then its short description and description, as whole words without stemming (`shoe` does not find `shoes`; text in Twi, Ga or Ewe and brand names are matched as written). When the words match nothing under the other filters, names similar to each word are matched instead, so typos and partial words still find products (`samsnug` → "Samsung Galaxy S24", `galx` → "Galaxy ..."). Text that is blank or only punctuation is no search. Results come best match first unless `sortBy` says otherwise.

**Pagination.** Every sort breaks ties by product id, so walking pages with `after` never repeats or skips a product, also among products with the same name, date or relevance. `after` takes an edge's `cursor`; a cursor that is not one, or that was made for another `sortBy`/`sortOrder`, is `BAD_REQUEST` (start again from the first page). `totalCount` counts every match.

**Response: `ProductConnection`**

```typescript
{
  edges: [{ cursor: string; node: Product }];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; pageSize: number; totalCount: number };
}
```

**`Product` Object Type**:

```typescript
{
  id: string;
  name: string;
  shortDescription?: string;
  description?: string;
  images?: string[];            // HTTPS URLs
  attachments?: string[];
  priceRange?: { min: Money; max: Money };  // Lowest and highest price of the active variants; null when none is priced
  totalStock: number;           // Units in stock across the active variants
  inStock: boolean;             // true when an active variant has stock
  currency?: Currency;          // Default GHS; only products in the store currency can be checked out
  isTaxable: boolean;           // Variant prices add tax to their basePrice
  productTypeId: string;        // See 2.26
  productType: ProductType;
  attributes: JSONObject;       // Non-axis attribute values, keyed by attribute key (see 2.26)
  requiresPrescription: boolean; isPerishable: boolean; shelfLifeDays?: number;
  trackLots: boolean; trackSerials: boolean;
  serialFormat: SerialFormat;   // P4-D.1: FREE_TEXT | IMEI, how serials of a trackSerials product are checked
  warrantyMonths?: number;      // P4-D.1: warranty of each serialised unit from delivery; null = none
  fulfilmentKind: FulfilmentKind; unitOfMeasure: UnitOfMeasure;   // Capability fields, see 2.26
  status?: ProductStatus;       // DRAFT | PUBLISHED | ARCHIVED
  isActive: boolean;
  publishedAt?: DateTime;       // Not set by any API operation
  deliveryOptions?: DeliveryOptions[];
  selectedDeliveryRegions?: string[];
  expiryDate?: DateTime;
  categoryId?: string;
  category?: Category;
  subcategoryId?: string;
  subcategory?: SubCategory;
  brandId?: string;
  brand?: Brand;
  tags?: Tag[];
  variants: Variant[];          // The active variants (SKUs): what a customer chooses and buys
  reviews?: Review[];
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**Example**:
```graphql
query {
  products(
    paginationArgs: { first: 12 }
    filterArgs: { categoryId: "clx_cat", inStock: true }
    sortArgs: { sortBy: CREATED_AT, sortOrder: DESC }
  ) {
    edges {
      cursor
      node {
        id name currency images inStock totalStock
        priceRange { min { amount currency } max { amount currency } }
        variants { id sku optionValues price { amount currency } discountedPrice { amount currency } available }
      }
    }
    pageInfo { hasNextPage totalCount }
  }
}
```

---

#### `productFacets` (P6-S.2)
- **Type**: Query
- **Auth Required**: No (optional sign-in, like `products`)
- **Args**: `filterArgs: ProductFilterArgs` (optional; the same filters as `products`)
- **Response**: `ProductFacets!`
- **Description**: Counts for building a filter sidebar next to `products`. Send the same `filterArgs` as the list. Each facet is counted **without its own filter** (brands without `brand`/`brandId`, categories without `categoryId`/`categoryName`, an attribute without its own `attributes` entry, the price range without `priceMin`/`priceMax`, `inStockCount` without `inStock`) and with every other filter, so the other choices stay visible; when that facet has no filter of its own, its counts are exactly what the list returns for that value. `totalCount` equals the list's `totalCount`.

```typescript
// ProductFacets
{
  totalCount: number;                 // Products matching every filter
  inStockCount: number;               // Products that would match with inStock: true
  price?: { min: Money; max: Money }; // Active variant prices (sellable ones only when inStock: true); null if none is priced
  brands: { id: string; name: string; count: number }[];      // Up to 20, most products first
  categories: { id: string; name: string; count: number }[];  // Up to 20, most products first
  attributes: {                       // Up to 10 filterable attributes, in definition position order
    key: string; label: string;
    values: { value: string; count: number }[];  // Up to 20, most products first
  }[];
}
```

**Attributes.** Only attributes marked `isFilterable` on a product type ([2.26](#226-product-types-and-attributes)) are counted, both product attributes and variant axes (a product counts once per value whatever number of active variants carry it). The same key on several product types is one facet. Values that differ only in case are one value. Filter with `filterArgs.attributes: [{ key: "colour", values: ["Red", "Blue"] }, { key: "material", values: ["Cotton"] }]`: every key must match (AND), any of its values (OR), ignoring case, on the product's attributes or on one of its active variants. The same key twice is `BAD_REQUEST`; a malformed key or an empty `values` is `BAD_USER_INPUT`. Any attribute key can be filtered, filterable or not.

**Example**:
```graphql
query {
  productFacets(filterArgs: { categoryId: "clx_cat", attributes: [{ key: "colour", values: ["Red"] }] }) {
    totalCount inStockCount
    price { min { amount } max { amount } }
    brands { id name count }
    attributes { key label values { value count } }
  }
}
```

---

#### `searchSuggestions` (P6-S.4)
- **Type**: Query
- **Auth Required**: No (optional sign-in); rate-limited like every public query (global throttler, 120 requests a minute per client)
- **Args**: `prefix: String!` (at most 50 characters), `first: Int = 5` (1-10, per kind; anything else is `BAD_USER_INPUT`)
- **Response**: `SearchSuggestions! { products: [Suggestion!]!; brands: [Suggestion!]!; categories: [Suggestion!]! }`, `Suggestion { id: ID!; name: String! }`
- **Description**: Autocomplete while the customer types. Returns up to `first` published products, brands with a published product and categories with a published product whose name contains the prefix (ignoring case; `%` and `_` are literal) or resembles it allowing typos (`samsnug` → Samsung). Names starting with the prefix come first, then the most similar. A prefix with fewer than two letters or digits returns empty lists (no error). Synonyms are not applied here; they apply to `products(filterArgs: { search })`. Debounce keystrokes on the client (~200 ms).

```graphql
query { searchSuggestions(prefix: "gal", first: 5) { products { id name } brands { id name } categories { id name } } }
```

**Synonyms (P6-S.4).** Staff manage synonym groups that the product `search` expands at query time (see [2.7](#27-tags), "Search synonyms"). A search for a term of a `TWO_WAY` group also matches the other terms of the group; a `ONE_WAY` group's `term` also matches its `synonyms`, not the reverse. Terms are matched as whole words (or phrases); excluded words (`-phone`) and the `OR` keyword are left as they are. Synonyms apply to full-text matching, not to the typo fallback.

---

#### `product`
- **Type**: Query
- **Auth Required**: No
- **Args**: `productId: String!`
- **Response**: `Product | null` (`null` unless the product is active and `PUBLISHED`)

---

#### `adminProducts` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Roles**: `ADMIN`, `SUPER_ADMIN`
- **Args**: same as `products`: `paginationArgs: PaginationArgs`, `filterArgs: ProductFilterArgs`, `sortArgs: ProductSortArgs`
- **Description**: Products in any status, including `DRAFT`, `ARCHIVED` and inactive. Use `filterArgs.status` / `filterArgs.isActive` to narrow. Omit `filterArgs` entirely to get every product (sending `filterArgs` without `isActive` applies its default `true`).
- **Response**: `ProductConnection!`

---

#### `adminProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Roles**: `ADMIN`, `SUPER_ADMIN`
- **Args**: `productId: String!`
- **Response**: `Product | null` (any status)

---

#### `createProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `createProductInput: CreateProductInput!`
- **Response**: `Product!`

**Input: `CreateProductInput`**

```typescript
{
  name: string;                  // Required. 1–255 chars.
  variants: VariantFieldsInput[]; // Required. 1–100 variants (SKUs) to sell; a product without options has one, with no optionValues.
  isActive: boolean;             // Default false.
  isTaxable: boolean;            // Default false. Variant prices add tax to their basePrice.
  productTypeId?: string;        // Default General (see 2.26).
  attributes?: JSONObject;       // Non-axis attribute values (see 2.26).
  status?: ProductStatus;        // Default DRAFT. Must be PUBLISHED (and isActive true) to appear publicly.
  shortDescription?: string;     // Max 500 chars.
  description?: string;          // Max 5000 chars.
  images?: string[];             // Max 10 HTTPS URLs.
  attachments?: string[];        // URLs.
  currency?: Currency;           // Default GHS.
  deliveryOptions?: DeliveryOptions[];   // Default [LOCAL_DELIVERY].
  selectedDeliveryRegions?: string[];    // Region names when deliveryOptions includes SELECTED_REGIONS.
  expiryDate?: DateTime;
  categoryId?: string;           // Optional.
  subcategoryId?: string;        // Must belong to categoryId.
  brandId?: string;
  // plus the optional capability fields of 2.26 (requiresPrescription, isPerishable, shelfLifeDays, trackLots,
  // trackSerials, fulfilmentKind, unitOfMeasure) and, for serial tracking (P4-D.1), serialFormat?: SerialFormat
  // (default FREE_TEXT) and warrantyMonths?: number (1-120). A product created with trackSerials: true takes no
  // opening stock on its variants (BAD_REQUEST): receive its units with restockVariant and their serials.
}

// VariantFieldsInput: the CreateVariantInput fields (see 2.8) without productId
{
  basePrice: Decimal;            // Required, >= 0, at most 2 decimals. The variant's price adds tax when the product is taxable.
  quantity: number;              // Required, integer 0–1,000,000: opening stock at the default location, a RECEIPT "Initial stock".
  optionValues?: JSONObject;     // Values for the product type's variant axes; omit for none.
  sku?: string;                  // 1–50 letters, digits, hyphens; unique; generated when omitted.
  barcode?: string;              // 1–100 chars; unique.
  lowStockThreshold?: number;    // Default 5.
  image?: string;                // HTTPS URL.
  weightGrams?: number; lengthMm?: number; widthMm?: number; heightMm?: number;
}
```

Promotions target variants, products, categories or brands from the promotion side (`createPromotion`/`updatePromotion` `targetIds`, see [2.13](#213-promotions-and-coupon-codes)).

**Side effects**: the product and its variants are created in one transaction; each variant's opening stock is recorded as a `RECEIPT` stock movement ("Initial stock"); audit entry (entity `Product`, `CREATE`).

**Possible Errors**:
- `BAD_USER_INPUT` — Validation failure (including no variants or more than 100).
- `NOT_FOUND` — Category, subcategory or product type not found.
- `BAD_REQUEST` — Invalid attributes or option values for the product type; two variants with the same options ("Two variants have the same options (...)"); an SKU or barcode repeated in the list ("SKU or barcode \"...\" is repeated").
- `CONFLICT` — SKU or barcode already used by another variant, or the subcategory does not belong to the category.

---

#### `updateProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`, `updateProductInput: UpdateProductInput!`
- **Response**: `Product!`

- **Auth**: step-up when `isTaxable` is sent (see [2.25](#225-two-factor-authentication-and-step-up))

`UpdateProductInput` has the `CreateProductInput` fields, all optional, **except `variants`**: it has no price, stock, SKU or barcode fields (sending one is a schema error, HTTP 400). Change prices, SKUs and barcodes with `updateVariant`, add variants with `createVariant`, and change stock with `restockVariant` / `adjustVariantStock`. Omitted fields, including `isActive` and `isTaxable`, are left unchanged. Changing `isTaxable` reprices every variant of the product from its `basePrice` in the same transaction (variants without a `basePrice` keep their price), and records each price that moved in the price history (source `ADMIN_EDIT`, see [Price history](#price-history)). Optional `priceChangeReason?: string` (max 500 characters) is stored on those price history entries; it is not a product field.

**Breaking change (P1-V.3):** `basePrice`, `sku`, `barcode`, `stockStatus`, `lowStockAlert` → removed from `UpdateProductInput` (set them per variant); the step-up condition changed from "`basePrice` is sent" to "`isTaxable` is sent".

---

#### `permanentlyDeleteProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`
- **Response**: `Product!`
- **Description**: Deletes the product together with its variants and their stock levels and stock movements. Refused while any cart or order line references the product; archive it instead.
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` ("Cannot delete product referenced in active carts or orders").

---

#### `archiveProduct` / `restoreProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`
- **Description**: `archiveProduct` sets `isActive = false`; `restoreProduct` sets `isActive = true`. Neither changes `status`; use `updateProduct` to set `status` (e.g. `ARCHIVED` or `PUBLISHED`).
- **Response**: `Product!`

---

#### `addTagToProduct` / `removeTagFromProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`, `tagId: String!`
- **Response**: `Product!`
- **Possible Errors**: `NOT_FOUND` (product or tag).

---

### 2.4 Categories

---

#### `categories`
- **Type**: Query
- **Auth Required**: No
- **Description**: All categories sorted alphabetically.
- **Response**: `[Category!]!`

**`Category` Object Type**:

```typescript
{
  id: string;
  name: string;
  description?: string;
  image?: string;
  products: Product[];          // products(first: Int! = 20): published products only, newest first, 1–100
  subcategories: SubCategory[];
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `category`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user; unlike `categories`, this one is not public)
- **Args**: `id: String!`
- **Response**: `Category | null`

---

#### `createCategory` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: CreateCategoryInput!`
- **Response**: `Category!`

**Input: `CreateCategoryInput`**

```typescript
{
  name: string;          // Required. 2–50 chars after trimming. Letters, digits, spaces, hyphens only. Unique.
  image?: string;        // Optional. HTTPS URL.
  description?: string;  // Optional. Max 500 chars.
}
```

**Possible Errors**: `CONFLICT` (name already exists), `BAD_USER_INPUT`.

---

#### `updateCategory` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: String!`, `input: UpdateCategoryInput!` (all fields optional, same rules)
- **Response**: `Category!`
- **Possible Errors**: `NOT_FOUND`, `CONFLICT` (name taken).

---

#### `removeCategory` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: String!`
- **Response**: `Category!`
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` if the category still has products or subcategories.

---

### 2.5 SubCategories

Resolver default: `ADMIN`, `SUPER_ADMIN`; reads are open to any signed-in user.

---

#### `subCategories`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user)
- **Response**: `[SubCategory!]!`, sorted by name

**`SubCategory` Object Type**:

```typescript
{
  id: string;
  name: string;
  description?: string;
  image?: string;
  categoryId: string;
  category?: SubCategory;   // Typed SubCategory in schema.gql (schema defect); use categoryId
  products?: Product[];     // products(first: Int! = 20): published only, newest first, 1–100
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `subCategory`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user)
- **Args**: `id: String!`
- **Response**: `SubCategory | null`

---

#### `createSubCategory` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: CreateSubCategoryInput!`
- **Response**: `SubCategory!`

**Input: `CreateSubCategoryInput`**

```typescript
{
  name: string;          // Required. 2–50 chars after trimming. Letters, digits, spaces, hyphens.
  categoryId: string;    // Required. Parent category ID.
  image?: string;        // Optional. HTTPS URL.
  description?: string;  // Optional. Max 500 chars.
}
```

**Constraint**: `(name, categoryId)` must be unique (`CONFLICT`).

---

#### `updateSubCategory` (ADMIN only)
- **Type**: Mutation
- **Roles**: `ADMIN` only; a `SUPER_ADMIN` gets `FORBIDDEN` (method-level role overrides the resolver default)
- **Args**: `id: String!`, `input: UpdateSubCategoryInput!` (all `CreateSubCategoryInput` fields optional)
- **Response**: `SubCategory!`
- **Possible Errors**: `NOT_FOUND`, `CONFLICT` (name already used in that category).

---

#### `removeSubCategory` (ADMIN only)
- **Type**: Mutation
- **Roles**: `ADMIN` only (as `updateSubCategory`)
- **Args**: `id: String!`
- **Response**: `SubCategory!`
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` ("Cannot delete SubCategory with associated products").

---

### 2.6 Brands

---

#### `brands`
- **Type**: Query
- **Auth Required**: No
- **Response**: `[Brand]` (list and items nullable)

**`Brand` Object Type**:

```typescript
{
  id: string;
  name: string;
  description?: string;
  logo?: string;              // HTTPS URL
  products?: Product[];       // products(first: Int! = 20): published only, newest first, 1–100
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `brand`
- **Type**: Query
- **Auth Required**: No
- **Args**: `id: String!`
- **Response**: `Brand | null`

---

#### `createBrand` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: CreateBrandInput!`
- **Response**: `Brand!`

**Input: `CreateBrandInput`**

```typescript
{
  name: string;          // Required. Max 255 chars. Unique.
  description?: string;  // Optional.
  logo?: string;         // Optional. HTTPS URL with TLD.
}
```

---

#### `updateBrand` / `deleteBrand` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `updateBrand(id: String!, input: UpdateBrandInput!)` (all fields optional); `deleteBrand(id: String!)`
- **Response**: `Brand!`
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` on a duplicate name. Deleting a brand leaves its products without a brand.

---

### 2.7 Tags

Resolver default: `ADMIN`, `SUPER_ADMIN`; reads are open to any signed-in user.

---

#### `tags`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user)
- **Response**: `[Tag!]!`

**`Tag` Object Type**:

```typescript
{
  id: string;
  name: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `tag`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user)
- **Args**: `tagId: String!`
- **Response**: `Tag!` (`NOT_FOUND` if unknown)

---

#### `createTag` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `name: String!`
- **Response**: `Tag!`
- **Possible Errors**: `BAD_REQUEST` ("Tag name … is already in use").

---

#### `updateTag` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `tagId: String!`, `name: String!`
- **Response**: `Tag!`

---

#### `deleteTag` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `tagId: String!`
- **Response**: `Tag!`

---

#### `addProductsToTag` / `removeProductsFromTag` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `tagId: String!`, `updateDiscountInput: AddProductsToTagDto!` / `updateDiscountInput: RemoveProductsFromTagDto!` (the second argument really is named `updateDiscountInput`)
- **Response**: `Tag!`

```typescript
// AddProductsToTagDto / RemoveProductsFromTagDto
{
  productIds?: string[]; // Default []
}
```

---

#### Search synonyms (P6-S.4)

Staff-managed groups the product `search` expands with (see [2.3](#23-products), "Synonyms"). Reads need `catalog.product.read`; changes need `catalog.taxonomy.write` (the taxonomy permission, like tags) and are audited (`AuditLog` entity `SearchSynonym`). Changes apply to the next search on every server (not cached).

- `searchSynonyms: [SearchSynonym!]!` (oldest first)
- `createSearchSynonym(input: SearchSynonymInput!): SearchSynonym!` (at most 500 groups)
- `updateSearchSynonym(id: ID!, input: SearchSynonymInput!): SearchSynonym!` (replaces the group)
- `deleteSearchSynonym(id: ID!): SearchSynonym!`

```typescript
// SearchSynonym
{
  id: string;
  kind: SearchSynonymKind;  // TWO_WAY: every term finds the others; ONE_WAY: term also finds synonyms, not the reverse
  term?: string;            // ONE_WAY only
  synonyms: string[];
  createdAt: DateTime; updatedAt: DateTime;
}
// SearchSynonymInput
{
  kind: SearchSynonymKind;
  term?: string;            // Required for ONE_WAY, refused for TWO_WAY
  synonyms: string[];       // TWO_WAY: 2-20 terms; ONE_WAY: 1-20
}
```

Terms are stored lower case, trimmed and single-spaced; each is 1-100 characters of letters, digits, single spaces and hyphens (no quotes or other search syntax), and appears once per group. **Possible Errors**: `BAD_REQUEST` (a rule above, with the reason; more than 500 groups), `NOT_FOUND` (unknown id), `FORBIDDEN`.

**Example**: `createSearchSynonym(input: { kind: TWO_WAY, synonyms: ["phone", "mobile", "cellphone"] })`, `createSearchSynonym(input: { kind: ONE_WAY, term: "tv", synonyms: ["television"] })`.

---

### 2.8 Variants

A **variant is the SKU** (ADR-0003): the unit that is priced, stocked and sold. Its option values are validated against the product type's variant axes (see [2.26](#226-product-types-and-attributes)); each active variant of a product has a different option combination (compared ignoring letter case and key order). An inactive variant is **archived**: it keeps its history and is never sold.

**Breaking changes (P1-V.4):** `size` and `color` are gone (use `optionValues`, e.g. `{ "size": "M", "colour": "Red" }` on an Apparel product); `price` is no longer an input (send `basePrice`; `price` is computed from it, with tax added when the product is taxable); `quantity` is an `Int`; `productVariants` is removed (use `variants(productId:)`); `variant` and `variants` are admin reads (`catalog.product.read`) and `variants` is paginated; `updateVariant` no longer takes `productId` (a variant never moves to another product); `deleteVariant` refuses a variant with history.

**Default variants and the migration (P1-V.2):** every product has at least one variant. `createProduct` creates its variants from `variants` (a product without options sends one, with no option values); existing products were given a default variant by migration, and existing size/color variants became Apparel option values. `Variant.price` is nullable: it is `null` only for the archived default variant of a product migrated without a price. Archived "Legacy" variants (`isActive: false`, zero stock, SKU `LEGACY-...`) hold order and cart lines recorded before a product had variants (including the historical lines of products that already had variants).

**Variant checkout (P1-V.3):** every variant is bought on its own: the cart, checkout, stock deduction and stock restores all work on the variant (see [2.9](#29-cart), [2.11](#211-orders), [2.15](#215-inventory)). A variant can be sold when it is active, priced, and its product is active and `PUBLISHED`. **Breaking change (P1-V.3):** `Variant.discountedPrice` is new; a promotion on a product applies to all its variants (`appliedPromotion` since P2-B.1).

All variant operations need a staff permission. Customers see the active variants of published products through `Product.variants` (archived variants are never listed there).

**`Variant` Object Type**:

```typescript
{
  id: string;
  productId: string;
  product: Product;
  sku?: string;               // unique; generated ("SKU-" + 12 hex) when not given
  barcode?: string;           // unique
  optionValues: JSONObject;   // e.g. { size: "M", colour: "Red" }; {} when the type has no axes
  available: Int;             // units that can be bought now: on hand minus reserved for open orders (P1-N.2; was quantity)
  onHand?: Int;               // staff with inventory.view only (admin variant/variants queries), else FORBIDDEN
  reserved?: Int;             // staff with inventory.view only
  lowStockThreshold?: Int;    // available stock at or below which inventory.low_stock is raised (default 5)
  price?: Money;              // selling price: basePrice, plus tax when the product is taxable; null only for an unpriced migrated variant
  basePrice?: Money;          // price before tax, as entered
  discountedPrice?: Money;    // price of one unit after the best automatic promotion on it (on the variant, its product, category or brand); null without one. Coupons and cart minimums apply only in checkoutQuote. Signed in (P2-W.1): starts from the customer's price-list price when it applies to one unit (then null unless that list allows promotions) and includes their customer-group and first-order promotions
  appliedPromotion?: PublicPromotion; // { id, name, description?, endsAt? } of the promotion behind discountedPrice
  customerPrice?: VariantPriceTier;   // P2-W.1, signed-in customer only: their B2B price at its minimum quantity (= priceTiers[0]); null for a visitor or when no price list of theirs prices the variant below `price`
  priceTiers?: VariantPriceTier[];    // P2-W.1: their B2B unit prices by quantity of this variant, ascending; null for a visitor, [] when no list applies
  isActive: boolean;          // false = archived
  weightGrams?: Int; lengthMm?: Int; widthMm?: Int; heightMm?: Int;
  image?: string;             // overrides the product images for this variant
  priceHistory(first?: Int = 50, after?: ID): PriceChangePage!; // staff with catalog.product.read only, else FORBIDDEN (P2-H.1)
}
```

---

#### `variant`
- **Type**: Query · **Auth**: `catalog.product.read`
- **Args**: `variantId: String!`
- **Response**: `Variant!` (archived ones too) · **Errors**: `NOT_FOUND`, `FORBIDDEN`

#### `variants`
- **Type**: Query · **Auth**: `catalog.product.read`
- **Args**: `paginationArgs?: PaginationArgs` (`first` 1-100, default 12; `after` = a cursor), `productId?: ID`
- **Response**: `VariantConnection!` = `{ edges: { cursor: string; node: Variant }[]; pageInfo: PageInfo }`, ordered by id, archived included

---

#### `createVariant`
- **Type**: Mutation · **Auth**: `catalog.product.write`
- **Args**: `input: CreateVariantInput!`
- **Response**: `Variant!`

```typescript
{
  productId: ID;              // Required
  optionValues?: JSONObject;  // validated against the product type's variant axes
  basePrice: Decimal;         // Required, >= 0, at most 2 decimals
  quantity: Int;              // Required, 0-1,000,000: the opening stock, recorded as a RECEIPT ("Initial stock")
  sku?: string;               // 1-50 letters, digits, hyphens; unique (case-insensitive)
  barcode?: string;           // 1-100 chars; unique
  weightGrams?: Int; lengthMm?: Int; widthMm?: Int; heightMm?: Int;
  image?: string;             // HTTPS URL
  lowStockThreshold?: Int;    // default 5
}
```

- **Side effects**: audit entry (entity `Variant`, `CREATE`); a `RECEIPT` stock movement for the opening stock; price history entries for the first `BASE_PRICE` and `PRICE` (source `VARIANT_CREATED`). `createProduct` records the same for each variant it creates.
- **Possible Errors**: `NOT_FOUND` (product), `BAD_REQUEST` (option values invalid for the type: the message lists each problem, e.g. `Invalid option values for product type "apparel": flavour is not an attribute of this product type`), `CONFLICT` (an active variant already has these options; SKU or barcode taken), `BAD_USER_INPUT`.

#### `updateVariant`
- **Type**: Mutation · **Auth**: `catalog.product.write`; step-up when `basePrice` is sent
- **Args**: `input: UpdateVariantInput!` = every `CreateVariantInput` field except `productId` and `quantity`, all optional, plus `id: string` (required) and `isActive?: boolean` (`false` archives; `true` restores if no active variant has the same options)
- Sending `quantity` or `productId` is a schema error. Change stock with `restockVariant` / `adjustVariantStock`.
- `priceChangeReason?: string` (max 500 characters): why the price changes, stored on the price history entries. A changed `basePrice` and/or `price` each get one entry (source `ADMIN_EDIT`, with the acting staff member); sending the same price records nothing.
- **Possible Errors**: as `createVariant`.

#### `deleteVariant`
- **Type**: Mutation · **Auth**: `catalog.product.write`
- **Args**: `variantId: String!` · **Response**: `Variant!`
- Refused with `CONFLICT` when any order line, cart line or stock movement references the variant ("... archive it (isActive: false) instead of deleting it"), and when it is the product's only variant. Deleting a variant removes its price history.

---

#### Price history

**New (P2-H.1, ADR-0005 §6):** every change to a variant's `basePrice` or `price` is recorded, in the same transaction as the change, as an append-only `PriceChange` (the database refuses edits and deletes). Sources: `VARIANT_CREATED` (first prices, from `createVariant` / `createProduct`), `ADMIN_EDIT` (`updateVariant` with `basePrice`, `updateProduct` changing `isTaxable`), `TAX_RATE_CHANGE` (`createTax` / `updateTax` / `deleteTax` repricing taxable variants) and `MIGRATION` (the price each variant had when price history started; `oldValue` is null). A price that does not change records nothing; a write that fails records nothing. Price writes are still audited as before.

#### `priceChanges`
- **Type**: Query · **Auth**: `catalog.product.read` (Owner, Manager, Inventory clerk, Cashier)
- **Args**: `variantId?: ID`, `productId?: ID` (every variant of the product), `from?: DateTime` (inclusive), `to?: DateTime` (exclusive), `first: Int = 50` (1-100), `after?: ID` (id of the last entry of the previous page)
- **Response**: `PriceChangePage!`, newest first · **Errors**: `UNAUTHENTICATED` (guest), `FORBIDDEN` (customer, staff without the permission), `BAD_USER_INPUT`
- `Variant.priceHistory(first, after)` returns the same page for one variant.

```typescript
PriceChangePage = { nodes: PriceChange[]; totalCount: Int; hasNextPage: boolean };
PriceChange = {
  id: ID;
  variantId: ID;
  field: 'PRICE' | 'BASE_PRICE';        // PRICE = selling price, BASE_PRICE = price before tax
  oldValue?: Money;                     // null for the field's first price
  newValue: Money;                      // amounts in the currency they were recorded in
  source: 'ADMIN_EDIT' | 'VARIANT_CREATED' | 'TAX_RATE_CHANGE' | 'MIGRATION';
  reason?: string;                      // the priceChangeReason sent with the write
  actorId?: ID;                         // the staff member; null for MIGRATION
  createdAt: DateTime;
};
```

---

### 2.9 Cart

All cart operations require `Bearer` JWT. Any role (USER, ADMIN, SUPER_ADMIN) can access; each user has one cart.

A cart line is one **variant** (SKU) of a product (see [2.8](#28-variants)). Only an active variant of an active and `PUBLISHED` product, with a price, can be added, and stock is the variant's.

**Breaking change (P1-V.3):** `AddToCartInput.productId` → `variantId` (required); `CartItem.variantId` is new and `CartItem.variant` is now non-null. The old "comes in variants and cannot be bought until variant checkout is available" refusal is gone: products with options are bought by adding the chosen variant.

**Migrated cart lines:** existing lines now point at the product's default variant, or, for a product that already had variants, at its archived "Legacy" variant (`isActive: false`, zero stock, SKU `LEGACY-...`). Such a Legacy line cannot be updated or checked out (`... is no longer sold`); show it as unavailable and let the customer remove it and pick a current variant.

---

#### `cart`
- **Type**: Query
- **Auth Required**: Yes
- **Description**: Retrieve the current user's cart. Each item's `originalPrice` is the variant `price` recorded when it was last added. For the current price of a line show `item.variant.price` and `item.variant.discountedPrice`; for the totals checkout will charge call [`checkoutQuote`](#checkoutquote).
- **Response**: `Cart | null` (`null` until the first item is added)

**Breaking change (P2-A.2):** `Cart.total`, `Cart.discountTotal`, `Cart.finalTotal`, `CartItem.discountedPrice` and `CartItem.appliedDiscount` → removed (only `cartWithDiscount` ever filled them); use `checkoutQuote` (totals, per-line discounts and tax) or `CartItem.variant.discountedPrice` / `appliedDiscount` (per item, before the cart is checked out).

**`Cart` Object Type**:

```typescript
{
  id: string;
  userId: string;
  items: CartItem[];
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**`CartItem` Object Type**:

```typescript
{
  id: string;
  variantId: string;         // The variant (SKU) in the cart: what is priced and stocked
  variant: Variant;
  productId: string;         // The variant's product
  product: Product;
  originalPrice?: Money;     // List price of one unit of the variant when it was last added
  quantity: number;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `addToCart`
- **Type**: Mutation
- **Auth Required**: Yes
- **Args**: `input: AddToCartInput!`
- **Response**: `Cart!`
- **Description**: Adds the variant, or adds to the quantity of its line if that variant is already in the cart. Creates the cart if needed. Stock is checked but not reserved.

**Input: `AddToCartInput`**

```typescript
{
  variantId: string; // Required. ID of the variant (SKU) to add, from Product.variants.
  quantity: number;  // Required. Integer 1–1,000,000.
}
```

**Possible Errors**:
- `NOT_FOUND` — Variant not found (`Variant "<id>" not found`).
- `BAD_REQUEST` — The variant cannot be sold: `"<product>" (<sku>) is not on sale` (product inactive or not `PUBLISHED`), `"<product>" (<sku>) is no longer sold` (variant archived), `"<product>" (<sku>) has no price and cannot be sold`; or the resulting line quantity exceeds the variant's stock: `Cannot add N of "<product>" (<sku>) to cart; only M in stock`.
- `BAD_USER_INPUT` — `quantity` outside 1–1,000,000.

---

#### `updateCartItem`
- **Type**: Mutation
- **Auth Required**: Yes
- **Args**: `input: UpdateCartItemInput!`
- **Response**: `Cart!`

**Input: `UpdateCartItemInput`**

```typescript
{
  cartItemId: string; // Required.
  quantity: number;   // Required. Integer >= 0. 0 removes the item.
}
```

A quantity above 0 re-checks the line's variant exactly as `addToCart` does (still sellable, enough stock).

**Possible Errors**: `NOT_FOUND` (item not in the caller's cart), `BAD_REQUEST` (variant no longer sellable, or the quantity exceeds its stock; same messages as `addToCart`).

---

#### `removeFromCart`
- **Type**: Mutation
- **Auth Required**: Yes
- **Args**: `cartItemId: String!`
- **Response**: `Cart!`
- **Possible Errors**: `NOT_FOUND` (item not in the caller's cart).

---

#### `clearCart`
- **Type**: Mutation
- **Auth Required**: Yes
- **Response**: `Cart!` (empty)

---

#### `cartWithDiscount` (removed)

**Breaking change (P2-A.2):** `cartWithDiscount` → removed; use [`checkoutQuote`](#checkoutquote), which prices the cart exactly as `createOrder` charges it (item discounts, coupon, tax and shipping) and writes nothing (`cartWithDiscount` also rewrote the cart lines).

---

#### Saved for later (P6-G.2)

A customer can move a cart line out of the cart to buy later, and back. One saved row per variant (saving a variant already saved adds the quantities); at most 100 saved variants. Cart pricing and checkout ignore saved items.

```graphql
type SavedCartItem { id: ID!  variantId: ID!  variant: Variant!  quantity: Int!  available: Boolean!  unavailableReason: String  createdAt: DateTime! }

query { savedItems { id quantity available unavailableReason variant { id sku price } } }   # newest first
mutation { saveCartItemForLater(cartItemId: ID!) { ...Cart } }   # CONFLICT reason SAVED_ITEMS_LIMIT_REACHED at 100; NOT_FOUND if not your line
mutation { moveSavedItemToCart(savedItemId: ID!) { ...Cart } }   # BAD_REQUEST reason SAVED_ITEM_UNAVAILABLE (not on sale: it stays saved), or the cart's stock refusal
mutation { removeSavedItem(savedItemId: ID!) }                    # Boolean
```

`available` is false (with `unavailableReason`) when the variant or its product is no longer on sale; show it greyed out with a remove button. Stock is checked when it is moved back.

#### Abandoned-cart reminders (P6-G.2)

A signed-in customer who opted in to marketing (see [15](#15-notifications-system)) and left items in the cart unchanged for `storeSettings.abandonedCartReminderDelayHours` (default 4; carts older than 7 days are left alone) gets one reminder: an email listing the items with a link to `FRONTEND_URL/cart`, and an SMS when they also opted in to SMS marketing and have a verified phone. Nothing is sent if they placed an order since; the same cart contents are never reminded about twice; at most one reminder per customer in 7 days. The email carries a one-click unsubscribe link `FRONTEND_URL/unsubscribe?token=<token>`: that page calls

```graphql
mutation { unsubscribeMarketingEmail(token: String!) }   # no sign-in; Boolean; BAD_REQUEST reason INVALID_UNSUBSCRIBE_TOKEN
```

which withdraws email marketing consent (ledger source `EMAIL_LINK`); repeating it changes nothing.

### 2.9a Guest checkout (P6-G.1)

Shoppers can buy **without an account**. Every operation below is public (no bearer token) and is authorised by a token instead: the **guest cart token** (`guestCartToken`) for the cart and checkout, the **order access token** (`orderAccessToken`) for the placed order. Keep both on the device; the server never stores them (only the cart token's hash) and cannot show them again.

The flow:

1. `createGuestCart` → `{ guestCartToken, cart }`. The cart expires 30 days after its last use (each call below extends it); an unknown or expired token is `NOT_FOUND` (start a new cart).
2. `addToGuestCart` / `updateGuestCartItem` / `removeFromGuestCart` / `guestCart` work like the customer cart (same `AddToCartInput`, `UpdateCartItemInput`, stock checks and `CartItem` type).
3. `requestGuestPhoneVerification(guestCartToken, input: { phone })` texts a 6-digit code (Ghana numbers, stored E.164); `verifyGuestPhone(guestCartToken, input: { code })`. Same codes and limits as `requestPhoneVerification`/`verifyPhone` (10-minute code, 5 wrong entries, 60 s resend cooldown, 5 codes a day per number, 10 per cart): `BAD_REQUEST` with `reason` `OTP_RATE_LIMITED` (`limit`, `retryAfterSeconds`), `OTP_INVALID` (`attemptsRemaining`), `OTP_ATTEMPTS_EXCEEDED`, `OTP_EXPIRED`, `PHONE_REQUIRED` (`verifyGuestPhone` before any code was requested), `PHONE_ALREADY_VERIFIED`. The code is bound to this cart: another cart cannot use it. Requesting a code for a **different** number makes the cart unverified until that number is confirmed.
4. `guestCheckoutQuote(guestCartToken, input: GuestCheckoutQuoteInput)` prices the cart exactly as `checkoutQuote` does (same `CheckoutQuote` type and `quoteHash`), with the delivery **address itself** (`shippingAddress: CreateAddressInput`, required for `DELIVERY`) instead of `shippingAddressId`. Guests are priced as visitors: no customer-group, first-order or per-customer-limit promotions and no price lists. A coupon whose promotion is limited per customer, to a group or to a first order is `BAD_REQUEST` with `reason: "COUPON_NEEDS_ACCOUNT"`; public coupons work. `cashOnDelivery` is always `{ available: false, reason: GUEST_CHECKOUT, phoneVerified }`.
5. `createGuestOrder(guestCartToken, input: CreateGuestOrderInput)` places the order (the cart is emptied) and returns `{ orderAccessToken, order: GuestOrder }`. Needs the phone verified (`BAD_REQUEST`, `reason: "GUEST_PHONE_NOT_VERIFIED"`); the verified phone is the order's contact phone. **Online payment only**: `paymentMethod: CASH_ON_DELIVERY` (on the quote or the order) is `BAD_REQUEST` with `reason: "COD_NOT_AVAILABLE"`, `codReason: "GUEST_CHECKOUT"`. Also `CONFLICT` `QUOTE_CHANGED`, the stock, delivery zone and slot errors of `createOrder`, and `FORBIDDEN` `VELOCITY_LIMIT` (counted per phone number and network).
6. Pay with [`POST /payment/guest/initialize`](#post-paymentguestinitialize), then after Paystack's redirect call `verifyGuestPayment(orderAccessToken, reference)` (the `transactionId` of the attempt); a reference of another order is `FORBIDDEN`.
7. `guestOrder(orderAccessToken)` reads the order with its `paymentStatus` and `trackingTimeline` (poll it). Any other token is `NOT_FOUND`.

```graphql
input GuestCheckoutQuoteInput {   # CheckoutQuoteInput without shippingAddressId
  fulfillmentType: FulfillmentType!
  shippingAddress: CreateAddressInput   # DELIVERY
  pickupLocationId: ID                  # PICKUP
  couponCode: String
  paymentMethod: OrderPaymentMethod = ONLINE
  serviceLevel: DeliveryServiceLevel = STANDARD
  deliverySlot: DeliverySlotChoiceInput
}                                 # (no redeemPoints: guests collect no loyalty points)
input CreateGuestOrderInput {     # GuestCheckoutQuoteInput plus
  contactName: String!            # 1-100 characters
  contactEmail: String            # optional: receipts and updates are emailed only when given
  quoteHash: String!
}
type GuestCart { id: ID! items: [CartItem!]! phoneLast3: String phoneVerified: Boolean! expiresAt: DateTime! createdAt: DateTime! updatedAt: DateTime! }
type GuestCartSession { guestCartToken: String! cart: GuestCart! }
type GuestOrderPlacement { orderAccessToken: String! order: GuestOrder! }
type GuestOrder {                 # the guest's view: no account, staff or actor details
  id: ID! orderNumber: Int! status: OrderStatus! paymentMethod: OrderPaymentMethod! fulfillmentType: FulfillmentType!
  currency: Currency! subtotal: Money discountTotal: Money taxTotal: Money shippingTotal: Money grandTotal: Money!
  shippingZoneName: String serviceLevel: DeliveryServiceLevel contactName: String contactEmail: String contactPhone: String!
  shippingAddressSnapshot: JSON pickupLocationSnapshot: JSON items: [OrderItem!]! adjustments: [OrderAdjustment!]!
  paymentStatus: OrderPaymentStatus trackingTimeline: [TrackingStep!]! createdAt: DateTime!
}
```

**Messages to guests:** the order placed (with a link to `FRONTEND_URL/guest-order#token=<orderAccessToken>`: read the token from the URL fragment and call `guestOrder`), the payment received and the delivery milestones are texted to the verified phone, and emailed when `contactEmail` was given. Guests get no in-app feed and no marketing (no abandoned-cart reminders).

**Attaching guest orders to an account:** guest orders move to the account that holds their verified phone, never by email and never across a different phone:

- at `signUp` with `guestOrderToken` (an `orderAccessToken`): the guest's verified phone becomes the new account's verified phone (if verified in the last 30 days and no other account holds the number) and every guest order placed with it is attached. `BAD_REQUEST` `INVALID_GUEST_ORDER_TOKEN` / `GUEST_VERIFICATION_EXPIRED`, `CONFLICT` `PHONE_IN_USE`; no account is created then.
- when a signed-in customer verifies that phone (`verifyPhone`).

Attached orders appear in `userOrders`; returns and reviews of a guest order need it attached first (staff get `BAD_REQUEST` `GUEST_ORDER_NOT_ATTACHED` for an outside-policy return of an unattached guest order).

**Breaking changes (P6-G.1)** `[breaking-api]`: `Order.userId` and `Order.contactEmail` are nullable (null on a guest order not yet attached / placed without an email); `FlaggedOrder.userId` and `Redemption.customerId` are nullable for the same reason. New: `Order.contactName`, `CodUnavailableReason.GUEST_CHECKOUT`, `SignUpInput.guestOrderToken`.

### 2.10 Wishlist

All wishlist operations require `Bearer` JWT (any role).

---

#### `wishlist`
- **Type**: Query
- **Auth Required**: Yes
- **Description**: Get or lazily create the user's wishlist.
- **Response**: `Wishlist!`

**`Wishlist` Object Type**:

```typescript
{
  id: string;
  userId: string;
  user: User;
  products: Product[];
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `addToWishlist`
- **Type**: Mutation
- **Auth Required**: Yes
- **Args**: `productId: String!`
- **Response**: `Wishlist!`
- **Possible Errors**: `NOT_FOUND` (product), `BAD_REQUEST` (already in the wishlist; or full at 100 products, which is HTTP 422 with code `BAD_REQUEST`).

---

#### `removeFromWishlist`
- **Type**: Mutation
- **Auth Required**: Yes
- **Args**: `productId: String!`
- **Response**: `Wishlist!`
- **Possible Errors**: `NOT_FOUND` (not in the wishlist).

---

#### `clearWishlist`
- **Type**: Mutation
- **Auth Required**: Yes
- **Response**: `Wishlist!` (empty products array)

---

### 2.11 Orders

> **Status rules (P1-O.2, ADR-0014):** `PLACED → CONFIRMED → IN_FULFILMENT → COMPLETED`, with `CANCELLED` (from `PLACED`, `CONFIRMED`, or `IN_FULFILMENT` while the goods are still in the shop), `EXPIRED` (unpaid `PLACED` online order after 1 hour) and `PAYMENT_REVIEW` (a payment arrived after the order was cancelled or expired; back to `CANCELLED` once that payment is refunded). `COMPLETED` is final. Staff never set the status directly: payment confirms an online order (cash-on-delivery orders are confirmed when placed), the first fulfilment step (`updateShipmentStatus`) moves it to `IN_FULFILMENT`, and delivery (or `recordCodPayment`) completes it. Any other change fails with `CONFLICT`. If two requests change the same order at once, one succeeds and the other gets `CONFLICT` ("was changed by another request; reload it and try again"). Every change is written to the order's `timeline` in the same transaction.

> **Unpaid orders expire:** every hour, `PLACED` `ONLINE` orders older than 1 hour become `EXPIRED` (each line's reserved stock and the coupon use given back) if they have no payment attempt, or only pending/failed/cancelled attempts untouched for 1 hour.

All order operations require `Bearer` JWT.

---

#### `order`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `orderId: String!`
- **Description**: Retrieve one of the caller's own orders. Someone else's order gives `NOT_FOUND` (for admins too; they use `viewOrder`).
- **Response**: `Order!`

**`Order` Object Type**:

```typescript
{
  id: string;
  orderNumber: number;                         // Store order number from 10001 up; unique, may have gaps
  userId: string;
  user?: User;                                 // Owner or admin only (FORBIDDEN otherwise)
  status: OrderStatus;                         // PLACED | CONFIRMED | IN_FULFILMENT | COMPLETED | CANCELLED | EXPIRED | PAYMENT_REVIEW
  paymentStatus?: OrderPaymentStatus;          // PENDING | CAPTURED | PARTIALLY_REFUNDED | REFUNDED | FAILED | CANCELLED; null before any payment
  timeline: OrderStatusEvent[];                // Status history, oldest first
  trackingTimeline: TrackingStep[];            // P5-B.2: the customer's tracking timeline, oldest first: order steps { at, orderStatus } and every shipment's steps { at, shipmentId, shipmentStatus, carrier, trackingNumber }; no actor or staff reason. Poll it (no subscription); on a tie order steps come first, so the order is stable
  shipments: Shipment[];                       // P5-B.1: several when split; empty until staff create one (createShipment). Each: id, orderId, status, items [{ id, orderItemId, quantity }], carrier, trackingNumber, dispatchedAt, deliveredAt, cancelledAt, events
  refunds: OrderRefund[];                      // P3-C.1: refunds of the order, oldest first (see below)
  fulfillmentType: FulfillmentType;            // DELIVERY | PICKUP
  paymentMethod: OrderPaymentMethod;           // ONLINE | CASH_ON_DELIVERY
  contactEmail: string;
  contactPhone: string;
  currency: Currency;                          // GHS
  pricingVersion: Int;                         // The pricing rules it was priced with: 5 since P5-A.1 (delivery rate rules), 4 since P2-W.1 (B2B price lists), 3 since P2-B.4 (flash sales), 2 since P2-B.2 (promotion stacking), 1 before it; all have the full price and tax snapshot. 0: placed before P1-O.1 (parts may be null)
  subtotal?: Money;                            // Σ unitListPrice × quantity, before any discount, tax included
  discountTotal?: Money;                       // Product discounts + coupon (= minus the sum of `adjustments`)
  taxTotal?: Money;                            // Tax included in the line totals; null on pricingVersion 0
  shippingTotal?: Money;                       // Shipping charged; 0 for PICKUP
  grandTotal: Money;                           // Amount charged: subtotal - discountTotal + shippingTotal
  shippingZoneId?: string;                     // P5-A.1 DELIVERY: the zone delivered to (a snapshot id; the zone may change or go)
  shippingZoneName?: string;                   // P5-A.1 DELIVERY: the zone's name when placed
  serviceLevel?: DeliveryServiceLevel;         // P5-A.1 DELIVERY: STANDARD | EXPRESS
  shippingFee?: Money;                         // P5-A.1 DELIVERY: the fee before free-shipping promotions (shippingTotal is after them)
  rateRuleId?: string;                         // P5-A.1 DELIVERY, staff with order.view (FORBIDDEN otherwise): the rate rule charged
  deliverySlot?: DeliveryWindow;               // P5-A.2: { slotId, date, startTime, endTime } booked at placement; null without a slot
  adjustments: OrderAdjustment[];              // Product discounts (per line) and the coupon, as placed
  shippingAddressId?: string;                  // Set for DELIVERY orders
  shippingAddressSnapshot?: JSON;              // DELIVERY: { recipientName, phone, region, street, city, area, landmark, ghanaPostGps, latitude, longitude, zipCode, country } at order time; orders placed before Ghana addresses (P1-G) hold { street, city, state, zipCode, country } instead
  pickupLocationId?: string;                   // Set for PICKUP orders
  pickupLocationSnapshot?: JSON;               // PICKUP: { name, address, city, region, country, contactPhone, instructions, openingHours (text) } at order time (orders before P5-E.1: { name, address, city, state, country })
  stockLocationId?: string;                    // P4-A.1, staff with order.view (FORBIDDEN otherwise): where the order is reserved and fulfilled from
  createdAt: DateTime;
  updatedAt: DateTime;
  items: OrderItem[];
}
```

**`OrderItem` Object Type**:

```typescript
{
  id: string;
  orderId: string;
  productId: string;
  variantId: string;          // The variant (SKU) ordered. P2-B.4: a variant can have two or more items when a flash sale reduced only some of its units (the reduced units first)
  sku?: string;               // SKU at order time; null on lines ordered before variant checkout (P1-V.3)
  optionValues?: JSONObject;  // Option values at order time, e.g. { size: "M" }; null on lines ordered before P1-V.3
  quantity: Int;              // Breaking change (P1-V.3): was Float
  productName: string;        // Product name when ordered (older orders: the name when migrated)
  unitListPrice: Money;       // Price of one unit when ordered before promotions, tax included: the variant price, or the customer's B2B price-list price (P2-W.1)
  unitDiscount: Money;        // Product discount taken off one unit (0 if none)
  unitNet?: Money;            // One unit after its discount, without tax; null on pricingVersion 0
  unitTax?: Money;            // Tax included in one discounted unit; null on pricingVersion 0
  lineTotal: Money;           // (unitListPrice - unitDiscount) × quantity = (unitNet + unitTax) × quantity
  taxLines: OrderLineTax[];   // One per tax included in the line; empty on pricingVersion 0 and untaxed lines
  unitCost?: Decimal;         // P8-A, inventory.cost.view only (others get null here plus a FORBIDDEN error for the field): the variant's weighted-average cost (tax-exclusive, 4 dp) when the sale's stock was consumed (online payment captured, or cash-on-delivery dispatch). Written once, never changed by later cost changes; null when the cost was unknown then or the stock is not consumed yet
  createdAt: DateTime;
  updatedAt: DateTime;
  product: Product;
  variant: Variant;           // The variant now (use sku/optionValues for what was ordered)
}
```

**`OrderRefund` Object Type** (P3-C.1): a refund as the customer sees it, on their own orders (`order`, `userOrders`) and for staff (`orders`, `viewOrder`). It never carries the internal note, the staff member or Paystack details.

```typescript
{
  id: string;
  amount: Money;
  taxAmount?: Money;          // tax included; null for orders placed before tax was recorded
  shippingAmount: Money;      // the part that returns the delivery fee
  reason: RefundReason;
  reasonLabel: string;        // e.g. "Item arrived damaged", "Returned items"
  status: OrderRefundStatus;  // PENDING (being processed; also while staff retry a refused send) | REFUNDED
  lines: { orderItemId: string; productName: string; quantity: number; amount: Money }[];
  createdAt: DateTime;
}
```

**`OrderAdjustment` Object Type** (P1-O.1):

```typescript
{
  id: string;
  orderItemId?: string;       // The line an item promotion applies to (already in its unitDiscount); null for a cart or shipping promotion
  target: OrderAdjustmentTarget; // P2-B.6: MERCHANDISE (a line or the cart; in discountTotal) | SHIPPING (the delivery fee; already in shippingTotal)
  type: OrderAdjustmentType;  // DISCOUNT (automatic promotion) | COUPON (unlocked by a coupon code)
  sourceId?: string;          // The Promotion id (orders placed before P2-B.1: the discount or coupon id, which the promotion kept)
  code?: string;              // The coupon code that unlocked it
  amount: Money;              // Signed: reductions are negative, e.g. "-20.00"
}
```

**`OrderLineTax` Object Type** (P1-O.1): the tax computed when the order was placed; never recomputed (refunds read it).

```typescript
{
  id: string;
  taxId?: string;             // The tax rate it came from (it may have changed or been deleted since)
  name: string;               // e.g. "VAT"
  rate: Decimal;              // e.g. 0.15
  base: Money;                // The line amount without tax the rate applied to (unitNet × quantity)
  amount: Money;
}
```

**How the totals add up** (P1-O.1): prices are tax-inclusive, so each line's tax is inside its `lineTotal`. For a `pricingVersion` 1 order:
- `grandTotal = Σ unitNet × quantity + Σ order-level adjustments (orderItemId null) + taxTotal + shippingTotal`
- `grandTotal = subtotal - discountTotal + shippingTotal`, and `discountTotal = -Σ adjustments`
- A line is taxed when its product `isTaxable` and its variant has a `basePrice` (its `price` is basePrice × (1 + sum of active rates)): `unitNet` = the discounted unit price ÷ (1 + sum of rates), half-up to the pesewa, `unitTax` = the rest, split over the active taxes in proportion to their rates. Shipping and the coupon carry no tax in this snapshot (P2-T will decide).

`pricingVersion` 0 orders (placed before P1-O.1) keep what they stored: `grandTotal` is what was charged; `taxTotal`, `unitNet`, `unitTax` are null and they have no tax lines; `shippingTotal` or `discountTotal` may be null when it was not stored.

**Breaking change (P1-O.1):** `Order.totalAmount` → `grandTotal`; `shippingFee` → `shippingTotal`; `couponDiscount` → the `COUPON` entry of `adjustments`; `finalTotal` removed; `subtotal` is now **before** product discounts (was after) and `discountTotal` now **includes** the coupon (was product discounts only). `OrderItem.priceAtOrder` → `lineTotal` (per line) or `unitListPrice - unitDiscount` (per unit); `originalPrice` → `unitListPrice`; `discountAmount` → `unitDiscount`; `appliedDiscount` → the line's `DISCOUNT` adjustment (`sourceId`). New: `currency`, `pricingVersion`, `taxTotal`, `adjustments`, `productName`, `unitNet`, `unitTax`, `taxLines`.

**Breaking change (P1-V.3):** `OrderItem.variantId` is now non-null and always set; `variant: Variant!`, `sku` and `optionValues` are new. Lines recorded before this release have `sku`/`optionValues` null and point at the product's default variant or, for a product that already had variants then, at its archived "Legacy" variant (`isActive: false`, zero stock, SKU `LEGACY-...`).

**`OrderStatus` Enum** (P1-O.2):

```
PLACED          — Order created, stock reserved; an ONLINE order awaits payment
CONFIRMED       — Paid online, or a cash-on-delivery order (confirmed when placed); ready to fulfil
IN_FULFILMENT   — Fulfilment started (picking, packing, out for delivery or ready for pickup)
COMPLETED       — Delivered or collected (for COD: cash recorded). Final
CANCELLED       — Cancelled by the customer or staff
EXPIRED         — An unpaid ONLINE order expired after 1 hour
PAYMENT_REVIEW  — Money arrived after the order was cancelled or expired; it is refunded (processPendingRefund), then CANCELLED
```

**`OrderStatusEvent` Object Type**: `{ id, from?: OrderStatus (null for the first event), to: OrderStatus, reason?: string, actorId?: ID (staff with order.view only; FORBIDDEN for customers), createdAt }`. Orders migrated from before P1-O.2 start with one event for their status at migration.

**`Shipment` Object Type** (P1-O.2):

```typescript
{
  id: string;
  status: ShipmentStatus;     // PENDING | PICKING | PACKED | READY_FOR_PICKUP | OUT_FOR_DELIVERY | DELIVERED | FAILED_DELIVERY | RETURNED
  carrier?: string;
  trackingNumber?: string;
  dispatchedAt?: DateTime;    // When it went out for delivery or became ready for pickup
  deliveredAt?: DateTime;
  events: ShipmentStatusEvent[]; // { id, from?, to, reason?, actorId? (staff only), createdAt }, oldest first
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**`OrderPaymentStatus` Enum**: the order's payment machine. `PENDING` (awaiting payment), `CAPTURED` (paid; Paystack captures at once, there is no authorised step), `PARTIALLY_REFUNDED` / `REFUNDED` (processed refunds of that payment), `FAILED` (the last attempt failed; a new attempt reopens it), `CANCELLED` (the order closed before payment).

**New (P5-B.2):** `Order.trackingTimeline: [TrackingStep!]!` (`TrackingStep { at, orderStatus, shipmentId, shipmentStatus, carrier, trackingNumber }`); SMS milestones at dispatch and delivery. No guest tracking lookup (guest checkout is Phase 6).

**Breaking changes (P5-B.1, split shipments):** `updateShipmentStatus` and `updateShipping` take `shipmentId` instead of `orderId`, and no longer create the shipment: create it first with `createShipment` (new; without `items` it ships everything). `assignOrderItemSerials` / `unassignOrderItemSerials` (`OrderItemSerialsInput { orderItemId }`) → `assignShipmentItemSerials` / `unassignShipmentItemSerials` (`ShipmentItemSerialsInput { shipmentItemId }`). The `SERIALS_NOT_ASSIGNED` lines now carry `shipmentItemId`. New: `cancelShipment`, `orderShipments`, `Shipment.orderId`, `Shipment.items` (`ShipmentItem`), `Shipment.cancelledAt`, `ShipmentStatus.CANCELLED`.

**Breaking change (P1-O.2):** `OrderStatus` values `PENDING`/`PROCESSING`/`SHIPPED`/`DELIVERED` → `PLACED`/`CONFIRMED`/`IN_FULFILMENT`/`COMPLETED`; new `EXPIRED` and `PAYMENT_REVIEW` (an expiry is now `EXPIRED`, not `CANCELLED`). `Order.trackingNumber` and `Order.carrier` → `Order.shipments[0].trackingNumber` / `.carrier`. `updateOrderStatus` and `UpdateOrderStatusInput` removed: use `updateShipmentStatus` for fulfilment and `adminCancelOrder` to cancel. New: `Order.timeline`, `Order.shipments`, `Order.paymentStatus`, `ShipmentStatus`, `OrderPaymentStatus`.

---

#### `userOrders`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: All orders of the current user.
- **Response**: `[Order!]!`

---

#### `orders` (staff: `order.view`)
- **Type**: Query
- **Args**: `first: Int = 20` (1-100), `after: ID` (id of the last order of the previous page), `status: OrderStatus`
- **Description**: Orders newest first (ties by id), optionally of one status, one page at a time. A page shorter than `first` is the last one. `first` outside 1-100 is `BAD_USER_INPUT`.
- **Response**: `[Order!]!`

**Breaking change (P9-L)** `[breaking-api]`: `orders` returns one page (default 20 orders, newest first) instead of every order; page with `first`/`after`. Unpaginated, it failed outright (Prisma P2029) once the store held about 20,000 orders.

---

#### `viewOrder` (ADMIN, SUPER_ADMIN only)
- **Type**: Query
- **Args**: `id: String!`
- **Description**: Retrieve any order by ID (no ownership check).
- **Response**: `Order!`. An unknown ID returns an error (null for a non-null field), not `NOT_FOUND`.

---

#### `checkoutQuote`
- **Type**: Query
- **Roles**: any signed-in user (`@Auth(Bearer)`, like `createOrder`)
- **Args**: `input: CheckoutQuoteInput!`
- **Response**: `CheckoutQuote!`
- **Description**: Prices the caller's cart for checkout with the chosen fulfilment and coupon, exactly as `createOrder` will charge it, and returns the full breakdown plus the `quoteHash` that `createOrder` requires. Writes nothing (no reservation, no coupon use). Show its `grandTotal` as the amount to pay and send its `quoteHash` with `createOrder`. Quote again whenever the cart, fulfilment or coupon changes. A quote does not expire: `createOrder` re-prices the cart and compares.

**Input: `CheckoutQuoteInput`** (the fulfilment, coupon and payment-method fields of `CreateOrderInput`)

```typescript
{
  fulfillmentType: FulfillmentType;  // Required. DELIVERY | PICKUP
  shippingAddressId?: string;        // Required for DELIVERY: one of the caller's addresses
  pickupLocationId?: string;         // Required for PICKUP: an active pickup location
  couponCode?: string;               // Optional. Case-insensitive.
  paymentMethod?: OrderPaymentMethod; // Default ONLINE. CASH_ON_DELIVERY to pay on delivery/pickup. (P3-A.2)
  serviceLevel?: DeliveryServiceLevel; // P5-A.1, DELIVERY only (ignored for PICKUP): default STANDARD; one of deliveryOptions
  deliverySlot?: { slotId: ID; date: string }; // P5-A.2, STANDARD delivery to a zone with slots: one of deliverySlots (date YYYY-MM-DD)
  redeemPoints?: number;             // P6-L.1: loyalty points to redeem, at most loyalty.redeemablePoints (see 2.13a)
}
```

**Loyalty points (P6-L.1).** `CheckoutQuote.loyalty` (null for guests) reports the customer's points and what `redeemPoints` takes off; `discountTotal` includes it. See [2.13a](#213a-loyalty-points-p6-l1).

**Delivery slots (P5-A.2).** A zone can have weekly delivery windows for `STANDARD` delivery (`EXPRESS` is as soon as possible, without slots; pickup has none). `checkoutQuote.deliverySlots` lists the windows of the next 7 days (today included) that are still before their cutoff and not on a closed date, each with `remaining` places (0 = full; show it disabled), and `deliverySlotRequired` says whether `createOrder` needs one. Times are `HH:MM` in Africa/Accra (= UTC, no daylight saving). Quote again with the chosen `deliverySlot` (it is part of the `quoteHash`) and send the same one to `createOrder`. Errors: `BAD_REQUEST` `DELIVERY_SLOT_REQUIRED` (createOrder without a slot where one is required), `BAD_REQUEST` `DELIVERY_SLOT_UNAVAILABLE` (unknown slot, wrong date, past its cutoff, closed date, `EXPRESS`, pickup or a zone without slots), `CONFLICT` `SLOT_FULL` (no place left; another order may have taken the last one meanwhile: quote again and pick another). Cancelling an order, or its expiry, gives its place back.

**Delivery fee (P5-A.1).** The address is matched to a delivery zone (see [2.21](#221-shipping-zones--pickup-locations)); the zone's active rate rule for the chosen `serviceLevel` sets the fee from the cart's weight and its merchandise total after promotions; free-shipping promotions then apply on top of that fee. `deliveryOptions` lists every level the zone offers with its fee for this cart, so show them and quote again with the one the customer picks. An address no active zone covers, or outside Ghana, fails with `BAD_REQUEST` and `extensions.reason: "DELIVERY_UNAVAILABLE"` (offer pickup or another address); a level the zone does not offer fails with `BAD_REQUEST` and `extensions.reason: "DELIVERY_LEVEL_UNAVAILABLE"`. The level, the rate rule and the fee are part of the `quoteHash`.

**Payment method not offered (P3-A.2):** `checkoutQuote` and `createOrder` fail with `BAD_REQUEST` and `extensions.reason: "PAYMENT_METHOD_UNAVAILABLE"` before anything else when the store does not offer the payment method: `CASH_ON_DELIVERY` while cash on delivery is switched off, or `ONLINE` while no online method is on offer (card and mobile money both off, or Paystack not configured). Read `availablePaymentMethods` to show only what is offered. The payment method does not change the price or the `quoteHash`.

**`CheckoutQuote` Object Type**:

```typescript
{
  quoteHash: string;                 // 64 hex chars. Send to createOrder.
  currency: Currency;                // GHS
  pricingVersion: number;            // The pricing rules used (5 since P5-A.1: delivery rate rules); the order stores it
  lines: QuoteLine[];                // In cart order. P2-B.4: a cart line whose units pay different prices (a flash sale reduced only some) has two or more lines with the same cartItemId, the reduced units first
  adjustments: QuoteOrderAdjustment[]; // The cart promotions that take something off
  shippingAdjustments: QuoteAdjustment[]; // P2-B.6: the free-shipping promotions taken off the delivery fee (already in shippingTotal)
  delivery?: QuoteDelivery;          // P5-A.1 DELIVERY: { zoneId, zoneName, serviceLevel, rateRuleId, fee (before free-shipping promotions), weightGrams, weightBandFromGrams, freeAboveReached, slot (P5-A.2, the slot chosen) }; null for PICKUP
  deliveryOptions: DeliveryOption[]; // P5-A.1 DELIVERY: { serviceLevel, fee, weightBandFromGrams, freeAboveReached } per level the zone offers; [] for PICKUP
  deliverySlots: AvailableDeliverySlot[]; // P5-A.2 STANDARD delivery: { slotId, date, startTime, endTime, remaining } for the next 7 days; [] otherwise
  deliverySlotRequired: boolean;     // P5-A.2: createOrder needs deliverySlot
  subtotal: Money;                   // Σ unitListPrice × quantity, before any discount, tax included
  discountTotal: Money;              // Item promotions + cart promotions (merchandise only; shipping savings are in shippingTotal)
  taxTotal: Money;                   // Tax included in the line totals
  shippingTotal: Money;              // The delivery fee after free-shipping promotions (P2-B.6); 0 for pickup
  grandTotal: Money;                 // What createOrder charges: subtotal - discountTotal + shippingTotal
  cashOnDelivery: CashOnDeliveryAvailability; // P3-B: could this checkout be paid on delivery? (whatever paymentMethod was asked for)
}

CashOnDeliveryAvailability {
  available: boolean;
  reason?: CodUnavailableReason;     // The first gate refusing it: NOT_OFFERED | PHONE_NOT_VERIFIED | BLOCKED | SHIPPING_ZONE_EXCLUDED | OPEN_ORDER_LIMIT | ORDER_TOTAL_ABOVE_CAP
  phoneVerified: boolean;            // The account's current phone number is verified
}

QuoteLine {
  cartItemId: string; variantId: string; productId: string; productName: string; sku: string;
  optionValues?: JSON; quantity: number;
  unitListPrice: Money;              // Price of one unit before promotions, tax included: the variant price, or the customer's price-list price
  fromPriceList: boolean;            // P2-W.1: unitListPrice comes from one of the customer's B2B price lists
  unitDiscount: Money;               // Item promotions taken off one unit
  unitNet: Money;                    // One discounted unit without tax
  unitTax: Money;                    // Tax included in one discounted unit
  lineTotal: Money;                  // (unitListPrice - unitDiscount) × quantity
  adjustments: QuoteAdjustment[];    // The item promotions: { type: DISCOUNT | COUPON, sourceId: promotion id, code, amount (negative) }
  taxLines: QuoteTaxLine[];          // { taxId, name, rate, base, amount }, one per active tax on a taxable line
}

QuoteOrderAdjustment {
  type: OrderAdjustmentType;         // DISCOUNT (automatic) | COUPON (unlocked by the code)
  sourceId: string; code?: string;   // The promotion id; the coupon code when it unlocked it
  amount: Money;                     // Negative
  allocations: { cartItemId: string; amount: Money }[]; // Each cart line's share (one per cart item, a split one summed); they add up exactly to amount
}
```

**Possible Errors**: the same as `createOrder` steps 1–4 below (`NOT_FOUND` for no or empty cart, unknown address or coupon; `BAD_REQUEST` for an unsellable or out-of-stock line, uncovered city, inactive pickup point, unusable coupon...).

**Example**:
```graphql
query {
  checkoutQuote(input: { fulfillmentType: DELIVERY, shippingAddressId: "clx_address_xyz", couponCode: "SAVE10" }) {
    quoteHash
    lines { cartItemId sku quantity unitListPrice { amount currency } unitDiscount { amount currency } lineTotal { amount currency } }
    adjustments { type code amount { amount currency } allocations { cartItemId amount { amount currency } } }
    subtotal { amount currency } discountTotal { amount currency } taxTotal { amount currency } shippingTotal { amount currency } grandTotal { amount currency }
  }
}
```

---

#### `createOrder`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `input: CreateOrderInput!`
- **Response**: `Order!`
- **Description**: Create an order from the caller's cart at the price of the `checkoutQuote` the customer confirmed, for delivery to a saved address or for pickup. Each line's stock is reserved immediately (see [9](#9-inventory-rules)); the cart is emptied.

**Breaking change (P2-A.2):** `CreateOrderInput.quoteHash` is new and **required**: call `checkoutQuote` with the same fulfilment and coupon first and send its `quoteHash`. If anything that determines the charge changed in between (a price, a discount, the coupon's value, a tax rate, the shipping fee, the cart), `createOrder` fails with `CONFLICT` and `extensions.reason: "QUOTE_CHANGED"`: nothing is reserved, charged or recorded; quote again and show the new total.

**Velocity checks (P3-E.1):** too many orders in a short time from the same account, phone number (`contactPhone`) or network (IP address) fail with `FORBIDDEN` and `extensions.reason: "VELOCITY_LIMIT"`; nothing is reserved or recorded. Show the message ("Too many orders in a short time ... Try again later or contact the store"); it names no limit. Below that, an order can be accepted but flagged for staff review (invisible to the customer). See [Velocity checks](#velocity-checks-p3-e1).

**Cash on delivery (P3-B.1/B.2), behaviour change:** `paymentMethod: CASH_ON_DELIVERY` now needs the account's phone number verified by SMS code (once per number) and passes the store's risk gates. Refusals are `BAD_REQUEST` with `extensions.reason: "PHONE_NOT_VERIFIED"` (send the customer through `requestPhoneVerification` / `verifyPhone`), or `extensions.reason: "COD_NOT_AVAILABLE"` with `extensions.codReason` one of `BLOCKED`, `SHIPPING_ZONE_EXCLUDED`, `OPEN_ORDER_LIMIT`, `ORDER_TOTAL_ABOVE_CAP` (rarely `NOT_OFFERED`); nothing is reserved or recorded and the customer can still pay online. `checkoutQuote.cashOnDelivery` reports the same answer beforehand, so hide or explain the COD option there. See [Cash on delivery: phone verification and risk gates](#cash-on-delivery-phone-verification-and-risk-gates-p3-b1b2).

**Input: `CreateOrderInput`**

```typescript
{
  fulfillmentType: FulfillmentType;       // Required. DELIVERY | PICKUP
  shippingAddressId?: string;             // Required for DELIVERY: one of the caller's addresses
  pickupLocationId?: string;              // Required for PICKUP: an active pickup location
  couponCode?: string;                    // Optional. Case-insensitive.
  contactEmail: string;                   // Required. Valid email.
  contactPhone: string;                   // Required. Valid phone number in international format (e.g. +233…).
  paymentMethod?: OrderPaymentMethod;     // Default ONLINE (card or mobile money, chosen at POST /payment/initialize). CASH_ON_DELIVERY to pay on delivery/pickup. BAD_REQUEST PAYMENT_METHOD_UNAVAILABLE when not offered.
  serviceLevel?: DeliveryServiceLevel;    // P5-A.1, DELIVERY only: default STANDARD; the one quoted
  deliverySlot?: { slotId: ID; date: string }; // P5-A.2: the slot quoted; required when checkoutQuote.deliverySlotRequired
  quoteHash: string;                      // Required. checkoutQuote's quoteHash for the same fulfilment and coupon.
}
```

**What happens** (all in one database transaction):
1. The cart row is locked (a second `createOrder` for the same cart waits, then finds the cart empty: `NOT_FOUND`). The cart must hold 1–50 items; the account must be active.
2. `DELIVERY`: the address must belong to the caller and have a region, recipient name and phone (addresses saved before those fields existed may lack them). The address must be in Ghana and is matched to the active zone with the most specific entry for it (an area of the address's town, else its town, else its region; spelling, case, accents and punctuation ignored); that zone's active rate rule for `serviceLevel` sets the fee (P5-A.1). No zone, or no rule → `BAD_REQUEST` `DELIVERY_UNAVAILABLE`; a level the zone does not offer → `BAD_REQUEST` `DELIVERY_LEVEL_UNAVAILABLE`; delivery is never free by default. `PICKUP`: the location must exist and be active; shipping fee 0.
3. The cart's variants are share-locked, then the prices, promotions, coupon code, the caller's redemptions, tax rates and store currency are read and the cart is priced by the pricing engine (see [10](#10-promotions-system)), exactly as `checkoutQuote` does: each line from its **variant**'s current `price` (tax-inclusive) minus its item promotions. Every variant must still be sellable (active, priced, product active and `PUBLISHED`), its product priced in the store currency (GHS), and have enough stock.
4. A coupon code, if given, must be usable (code and promotion active, started, not expired, uses left overall and for the caller, its minimums reached); it unlocks its promotion. Cart promotions come off the lines after item promotions, before shipping, never more than them.
5. The resulting quote's hash must equal `quoteHash`; otherwise `CONFLICT` / `QUOTE_CHANGED` and nothing is written.
6. `grandTotal = Σ lineTotal - cart promotions + shippingTotal` (the fee after free-shipping promotions, P2-B.6), the quote's `grandTotal`. This is the amount Paystack is asked for. The order stores the quote as its snapshot: `subtotal`, `discountTotal`, `taxTotal`, `shippingTotal`, one `OrderAdjustment` per item promotion on a line and one per cart promotion, and per line the tax its price includes (`unitNet`, `unitTax`, `taxLines`), with the engine's `pricingVersion` (5), and for `DELIVERY` the zone, rate rule, service level and fee before promotions (`shippingZoneId`, `shippingZoneName`, `rateRuleId`, `serviceLevel`, `shippingFee`).
7. The order is saved with each line's snapshot (`productName`, `sku`, `optionValues`, prices, tax lines); each line re-checks its variant and reserves its quantity with a conditional update (a `RESERVE` stock movement; if any line fails, the whole order fails and nothing is written); each applied promotion (and the coupon code) has one use taken with a conditional update and a `RESERVED` redemption recorded (none left: `CONFLICT`, see below); the cart is emptied.
8. Status: `PLACED` for `ONLINE` (until paid); `CASH_ON_DELIVERY` orders move straight on to `CONFIRMED` (both steps are in the timeline).
9. A confirmation email goes to the account's email (not `contactEmail`) after the response.

No tax is added at checkout; tax is already inside each variant's `price`, and the order records how much (see "How the totals add up").

**Possible Errors**:
- `CONFLICT` with `extensions.reason: "QUOTE_CHANGED"` — the cart no longer prices to the quote (see above). Call `checkoutQuote` again.
- `CONFLICT` with `extensions.reason: "PROMOTION_LIMIT_REACHED"` (a promotion or the coupon code has no use left) or `"PROMOTION_CUSTOMER_LIMIT_REACHED"` (the caller used up their uses) — another order took the last use meanwhile; nothing was recorded. Call `checkoutQuote` again.
- `CONFLICT` with `extensions.reason: "PROMOTION_UNITS_SOLD_OUT"` (P2-B.4) — a flash sale has fewer units left at its price than the quote reduced (another order took them meanwhile); nothing was recorded. Call `checkoutQuote` again: it shows the units still left at the promotional price.
- `NOT_FOUND` — No cart, empty cart (also the second of two simultaneous submits), shipping address not found for the caller, variant no longer exists (`Variant "<id>" not found`), unknown coupon code.
- `BAD_REQUEST` — Missing `shippingAddressId`/`pickupLocationId` for the chosen type; "Complete the delivery address (region, recipient name and phone) before checkout" (send the customer to `updateAddress` for that address); more than 50 items; account inactive; a variant that cannot be sold (the `addToCart` messages followed by `; remove it from the cart`, e.g. `"Tee" (TEE-M-RED) is no longer sold; remove it from the cart`); a product priced in another currency (`"<product>" is priced in USD; only GHS products can be checked out`); insufficient stock (`Insufficient stock for "<product>" (<sku>): M available, N requested`); the variant sold out or was taken off sale while the order was being placed (`Variant "<sku>" is out of stock or no longer on sale — please review your cart`); every line is in stock but not all at one location serving the delivery or pickup point (`The items in your cart are not all in stock at one location that serves this delivery — please review your cart`, P4-A.1: the customer can split the order); `extensions.reason: "DELIVERY_UNAVAILABLE"`: the address is outside Ghana or no active zone (with an active rate rule) covers it (offer pickup or another address); `extensions.reason: "DELIVERY_LEVEL_UNAVAILABLE"`: the zone does not offer the service level; pickup location missing or inactive; coupon code inactive, not started, expired, at its usage limit, already used by the caller, below its minimums, or for items not in the cart.
- `BAD_USER_INPUT` — Missing or malformed `quoteHash`; invalid `contactEmail`/`contactPhone` or enum value.

**Example**:
```graphql
mutation {
  createOrder(input: {
    fulfillmentType: DELIVERY
    shippingAddressId: "clx_address_xyz"
    contactEmail: "jane@example.com"
    contactPhone: "+233201234567"
    couponCode: "SAVE10"
    quoteHash: "<checkoutQuote.quoteHash>"
  }) {
    id orderNumber status paymentMethod subtotal { amount currency } discountTotal { amount currency } taxTotal { amount currency } shippingTotal { amount currency } grandTotal { amount currency }
    adjustments { type code amount { amount currency } }
  }
}
```

---

#### `cancelOrder`
- **Type**: Mutation
- **Roles**: `USER` only (admins use `adminCancelOrder`; an ADMIN token gets `FORBIDDEN`)
- **Args**: `orderId: String!`, `reason?: String` (shown in the timeline)
- **Description**: Cancel one of the caller's own orders before fulfilment starts: only `PLACED` or `CONFIRMED` orders; otherwise `CONFLICT`. Each line's stock (its reservation: `RELEASE`, or `RETURN_RESTOCK` if it was already paid) and the coupon use are given back exactly once, and an open payment is cancelled. If the order was paid online, a refund request (return request) is opened automatically for staff to process.
- **Response**: `Order!`
- **Possible Errors**: `NOT_FOUND` (not the caller's order), `CONFLICT`.

---

#### `adminCancelOrder` (permission `order.manage`)
- **Type**: Mutation
- **Args**: `orderId: String!`, `reason?: String` (timeline and audit log)
- **Description**: Cancel any `PLACED`, `CONFIRMED` or `IN_FULFILMENT` order. During fulfilment only while no shipment has left the shop (every shipment `PENDING`, `PICKING`, `PACKED`, `RETURNED` or `CANCELLED`); once any shipment was dispatched (`OUT_FOR_DELIVERY`, `READY_FOR_PICKUP`) or `DELIVERED` → `CONFLICT` (P5-B.1: after a partial dispatch cancel the remaining shipments with `cancelShipment` and refund what will not ship with `refundOrder`). Shipments not yet dispatched are cancelled with the order. Same effects as `cancelOrder`, plus an audit entry with the actor and reason.
- **Response**: `Order!`
- **Possible Errors**: `NOT_FOUND`, `CONFLICT`.

---

#### Shipments (P5-B.1)

An order is fulfilled through one or more **shipments**, each carrying some units of its lines (`Shipment.items`: `{ id, orderItemId, quantity }`). Staff create them from the order's **unshipped** units (ordered units not in a non-cancelled shipment); the usual case is one shipment with everything (`createShipment` without `items`). Every shipment runs the shipment steps on its own; the order follows all of them:

- the first step of **any** shipment moves a `CONFIRMED` order to `IN_FULFILMENT`;
- an **online** order becomes `COMPLETED` once no shipment is still open and every ordered unit is in a `DELIVERED` shipment or was refunded (`refundOrder` line units). So a split order completes only when its last shipment is delivered;
- a **cash-on-delivery** order is never split (its one shipment carries every unit, so the single cash collection, always the grand total, matches one delivery) and completes with `recordCodPayment` as before.

Every change runs with the order row locked (two concurrent creates cannot over-allocate: the loser gets `CONFLICT` + `SHIPMENT_QUANTITY_EXCEEDED`; a database trigger backs the rule) and is audited (entity `Shipment`).

#### `createShipment` (permission `order.fulfil`)
- **Args**: `input: CreateShipmentInput!` — `{ orderId: ID!, items?: [{ orderItemId: ID!, quantity: Int! (>= 1) }] (1-200) }`; `items` omitted: every unshipped unit.
- **Response**: `Shipment!` (`PENDING`, with its items and first event). The order's status does not change.
- **Errors**: `NOT_FOUND` (order); `CONFLICT` (order not `CONFIRMED`/`IN_FULFILMENT`; `reason: SHIPMENT_QUANTITY_EXCEEDED` for more units than are unshipped; `reason: NOTHING_TO_SHIP` when everything is already in a shipment); `BAD_REQUEST` (a line not on the order, named twice; `reason: COD_ORDER_NOT_SPLIT` for a cash-on-delivery order not shipped whole). Audited (`CREATE`, with the items).

#### `cancelShipment` (permission `order.fulfil`)
- **Args**: `input: CancelShipmentInput!` — `{ shipmentId: ID!, reason?: String (max 500) }`
- **Response**: `Order!`
- **Description**: Cancels a shipment that has not been dispatched (`PENDING`, `PICKING`, `PACKED` → `CANCELLED`, `cancelledAt` set): its units are unshipped again (create another shipment for them) and serials picked for it go back on the shelf. An online order whose other shipments then hold every unit delivered or refunded completes. Dispatched → `CONFLICT`. Audited (`STATUS_CHANGE`).

#### `orderShipments` (permission `order.view`)
- **Args**: `orderId: ID!` → `[Shipment!]!` (oldest first, with items and events). Customers see their shipments through `order { shipments }`.

#### `updateShipmentStatus` (permission `order.fulfil`)
- **Type**: Mutation
- **Args**: `input: UpdateShipmentStatusInput!` — `{ shipmentId: ID!, status: ShipmentStatus!, reason?: String (max 500) }`
- **Response**: `Order!`
- **Description**: Moves one shipment to its next fulfilment step. Only shipments of `CONFIRMED` or `IN_FULFILMENT` orders (an unpaid online order cannot be fulfilled) → otherwise `CONFLICT`. Unknown shipment → `NOT_FOUND`. `CANCELLED` here → `BAD_REQUEST` (use `cancelShipment`).

**Shipment steps** (`src/order/shipment-status.ts`): `PENDING → PICKING → PACKED → READY_FOR_PICKUP | OUT_FOR_DELIVERY → DELIVERED | FAILED_DELIVERY`; `FAILED_DELIVERY → OUT_FOR_DELIVERY | READY_FOR_PICKUP` (retry) `| RETURNED`; `PENDING | PICKING | PACKED → CANCELLED` (`cancelShipment`). Steps before dispatch may be skipped forward (e.g. `PENDING → PACKED`). A `PICKUP` order is dispatched to `READY_FOR_PICKUP`, a `DELIVERY` order to `OUT_FOR_DELIVERY`; any other step → `CONFLICT`.

**Serial-tracked lines (P4-D.1, per shipment since P5-B.1)**: dispatch is refused with `BAD_REQUEST` + `reason: SERIALS_NOT_ASSIGNED` until every serialised line **of this shipment** has a unit assigned per item (`assignShipmentItemSerials`); dispatch marks them `SOLD` and the shipment's `DELIVERED` starts their warranty. See [Serial units](#serial-units-p4-d1).

**In the same transaction**: the first step of any shipment moves a `CONFIRMED` order to `IN_FULFILMENT`; dispatch consumes a cash-on-delivery order's reserved stock (once: a retried delivery does not consume again) and emails the customer; `DELIVERED` completes an online order once all its units are delivered (see Shipments above). A cash-on-delivery order is delivered by recording its cash (`recordCodPayment`): `DELIVERED` here → `BAD_REQUEST`. Each step is written to the shipment's `events`, the order's `timeline` when the order moves, and the audit log (actor, reason). Concurrent steps: one wins, the other gets `CONFLICT`.

---

#### `updateShipping` (permission `order.fulfil`)
- **Type**: Mutation
- **Args**: `input: UpdateShippingInput!`
- **Response**: `Order!`
- **Description**: Sets carrier and tracking number on one shipment of a `CONFIRMED` or `IN_FULFILMENT` order (otherwise `CONFLICT`; a cancelled shipment → `CONFLICT`). Does not change any status. When a `trackingNumber` is sent, a "shipped" email with the tracking number goes to the customer.

**Input: `UpdateShippingInput`**

```typescript
{
  shipmentId: string;     // Required.
  trackingNumber?: string;
  carrier?: string;
}
```

---

#### Riders and deliveries (P5-C.1)

A **rider** is an active staff member whose role lists `delivery.ride`: the system **Rider** role (seeded, holds only `delivery.ride`, no MFA requirement) or a custom role given it. The Owner is never a rider. Fulfilment staff (`order.fulfil`) assign a rider to a **delivery** shipment (`Shipment.rider`, `Shipment.assignedAt`, both staff-only fields: customers get `FORBIDDEN` for them); riders see and step only the shipments assigned to them, through a small type (`RiderDelivery`) that carries what a delivery needs and nothing else. Every assignment runs with the order row locked and is audited (`RIDER_ASSIGN` / `RIDER_UNASSIGN`, with from/to rider and reason). Staff keep every shipment step they had (`updateShipmentStatus`).

##### `riders` (permission `order.fulfil`)
- `[DeliveryRider!]!` — `{ id, name, phoneNumber }` of the active riders, by name.

##### `assignShipmentRider` (permission `order.fulfil`)
- **Args**: `input: AssignShipmentRiderInput!` — `{ shipmentId: ID!, riderId: ID!, reason?: String (max 500) }` → `Shipment!`
- **Rules**: delivery shipments only (`BAD_REQUEST` + `reason: PICKUP_HAS_NO_RIDER`); not once `DELIVERED`, `RETURNED` or `CANCELLED` (`CONFLICT` + `SHIPMENT_CLOSED`); `riderId` must be an active rider (`BAD_REQUEST` + `NOT_A_RIDER`). The first rider is assigned before dispatch or after a failed attempt (a shipment already `OUT_FOR_DELIVERY` without a rider: `CONFLICT` + `ASSIGN_BEFORE_DISPATCH`). Replacing the rider is free before dispatch; once `OUT_FOR_DELIVERY` or `FAILED_DELIVERY` it needs a `reason` (`BAD_REQUEST` + `ASSIGNMENT_REASON_REQUIRED`). Assigning the rider it already has changes nothing.

##### `unassignShipmentRider` (permission `order.fulfil`)
- **Args**: `input: UnassignShipmentRiderInput!` — `{ shipmentId: ID!, reason?: String }` → `Shipment!`
- **Rules**: before dispatch, or after a failed attempt with a `reason`; while `OUT_FOR_DELIVERY` → `CONFLICT` + `RIDER_ON_THE_ROAD` (reassign instead). No rider: nothing changes.

##### `myDeliveries` / `myDelivery` (permission `delivery.ride`)
- `myDeliveries(status: [ShipmentStatus!], date: String, first: Int = 50)` → `[RiderDelivery!]!`: the shipments assigned to the signed-in rider, oldest assignment first; `status` omitted = the open ones (not delivered, returned or cancelled); `date` (`YYYY-MM-DD`, UTC) = assigned, dispatched or delivered that day; `first` 1-100.
- `myDelivery(shipmentId: ID!)` → `RiderDelivery!`; `NOT_FOUND` when the shipment is not assigned to the caller (the same answer as for an unknown id).

```typescript
RiderDelivery {
  shipmentId: ID; status: ShipmentStatus; orderNumber: Int;
  recipientName?: string;
  recipientPhone: string;           // the delivery address phone, else the order contact phone
  address?: { street, area, city, region, landmark, ghanaPostGps, latitude, longitude };
  items: [{ productName: string; sku?: string; quantity: Int }];
  amountToCollect?: Money;          // cash on delivery not yet paid: the order total; else null
  assignedAt: DateTime; dispatchedAt?: DateTime; deliveredAt?: DateTime;
}
```

##### `startMyDelivery` / `failMyDelivery` (permission `delivery.ride`)
- `startMyDelivery(shipmentId: ID!)` → `RiderDelivery!`: `PACKED` (or `FAILED_DELIVERY`, to try again) → `OUT_FOR_DELIVERY`, exactly as staff dispatch does (stock, serials, events, the customer's SMS).
- `failMyDelivery(input: { shipmentId: ID!, reason: String! (1-500) })` → `RiderDelivery!`: `OUT_FOR_DELIVERY` → `FAILED_DELIVERY` with the reason in the shipment history.
- `NOT_FOUND` for a shipment not assigned to the caller; `CONFLICT` for any other step. Audited (`STATUS_CHANGE`, actor = the rider).

#### Proof of delivery (P5-C.2)

When a shipment **with a rider** goes `OUT_FOR_DELIVERY` (rider or staff), the customer's out-for-delivery SMS also carries a six-digit **delivery code** (one text: `... is out for delivery. Give the rider this code when you receive it: 123456.`; sent to the same phone as the milestone SMS: verified account phone, else address phone, else contact phone). The code is stored only as a keyed hash in Redis, for 7 days, and changes with every dispatch (a retry after `FAILED_DELIVERY` texts a new one). After **5 wrong entries** it locks; then only a staff override delivers. Shipments without a rider (a courier, staff delivering by hand) get no code and are delivered with `updateShipmentStatus` / `recordCodPayment` as before.

A rider's shipment can no longer be moved to `DELIVERED` by `updateShipmentStatus`, nor its cash recorded by `recordCodPayment`: both answer `BAD_REQUEST` + `reason: PROOF_OF_DELIVERY_REQUIRED`. It is delivered with one of:

##### `completeMyDelivery` (permission `delivery.ride`) → `RiderDelivery!`
- **Args**: `input: CompleteMyDeliveryInput!` — `{ shipmentId: ID!, code: String!, photoPublicId?: String, recipientName?: String (max 120), latitude?: Float, longitude?: Float, cashCollected?: Decimal }`

##### `completeDelivery` (permission `order.fulfil`) → `Shipment!`
- **Args**: `input: CompleteDeliveryInput!` — the same fields, with `code?: String` **or** `overrideReason?: String (max 500)`. An override needs `delivery.override` (Owner, Manager): otherwise `FORBIDDEN` + `reason: OVERRIDE_NOT_ALLOWED`.

**Rules (both)**: the shipment must have a rider (`BAD_REQUEST` + `RIDER_NOT_ASSIGNED`) and be `OUT_FOR_DELIVERY` (`CONFLICT`); a rider only for their own (`NOT_FOUND`). Exactly one proof (`PROOF_OF_DELIVERY_REQUIRED`). A wrong code: `BAD_REQUEST` + `DELIVERY_CODE_INVALID` with `extensions.attemptsLeft`; locked: `DELIVERY_CODE_LOCKED`; no code sent for this dispatch (no usable phone, or the SMS job has not run yet): `DELIVERY_CODE_NOT_ISSUED` (use an override). **Cash on delivery** is recorded in the same call: `cashCollected` is required (`CASH_COLLECTION_REQUIRED`) and must equal the order total (`COLLECTION_AMOUNT_MISMATCH`); it is refused for an order paid online (`NO_CASH_TO_COLLECT`). The collection is the shipment's rider's (recorded by the caller) and goes into their unremitted collections. `latitude`/`longitude` go together. In one transaction: a `ProofOfDelivery` (append-only), `DELIVERED` (warranty starts, events, customer SMS/email), the order's completion (online: when its last shipment is delivered; COD: payment captured and `COMPLETED`) and an audit row (`PROOF_OF_DELIVERY`).

**Photo (optional)**: upload first, then pass its `publicId`. `POST /delivery/my-shipments/:shipmentId/photo` (rider, own shipment; `404` otherwise) or `POST /delivery/shipments/:shipmentId/photo` (`order.fulfil`), multipart field `file`, JPEG/PNG/WebP up to 5 MB (checked by content), 10 per minute → `201 { publicId, url }`. Only a photo uploaded for that shipment is accepted (`INVALID_DELIVERY_PHOTO`).

**What people see**: staff read `Shipment.proofOfDelivery` (`{ id, method: CODE | OVERRIDE, overrideReason, deliveredById, deliveredAt, photoUrl, recipientName, latitude, longitude }`, permission `order.view`; customers get `FORBIDDEN`). The customer's `trackingTimeline` has `deliveryConfirmation { method, confirmedAt }` on the `DELIVERED` step of a rider's shipment (no photo, no staff data).

**Breaking changes (P5-C.2)** `[breaking-api]`: `updateShipmentStatus(status: DELIVERED)` and `recordCodPayment` refuse a shipment that has a rider (`PROOF_OF_DELIVERY_REQUIRED`); the out-for-delivery SMS of a rider's shipment now includes the delivery code.

---

#### `deleteOrder` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `orderId: String!`
- **Response**: `Order!`
- **Description**: Soft-delete a closed order (`COMPLETED`, `CANCELLED` or `EXPIRED` only). Sets `deleted = true`, `deletedAt = now()`. **Never moves stock.** An open order returns `CONFLICT` (cancel it first, which restores its stock); deleting twice also returns `CONFLICT`.

---

### 2.12 Payment

> Each `Payment` returned by the API is one **payment attempt**. Each call to `POST /payment/initialize` creates a new attempt with its own reference (`transactionId`); earlier attempts are kept, never deleted, so `getMyPayments`, `getUserPayment` and `payments` return one entry per attempt. A cash-on-delivery collection also appears as a `COMPLETED` attempt.

---

#### `verifyPayment`
- **Type**: Mutation (GraphQL)
- **Roles**: `USER`
- **Args**: `verifyPaymentInput: VerifyPaymentInput!`
- **Response**: `Payment!`
- **Description**: Verify a Paystack payment by reference and update status. Only the order owner can verify (`FORBIDDEN` otherwise).
- **Behaviour**:
  - The payment counts only if Paystack reports `success` for exactly the attempt's amount and currency (GHS). Then the attempt becomes `CAPTURED`, the order's payment `CAPTURED` and the order moves `PLACED → CONFIRMED`.
  - A success for a different amount or currency returns `status: FAILED`; the order stays `PLACED` and can be paid again. The captured money is queued for refund.
  - A success that arrives after the order was cancelled (or already paid by another attempt) returns `status: CAPTURED`; the money is queued for refund and the payment flagged for staff. A cancelled or expired order moves to `PAYMENT_REVIEW` until that refund is processed (then `CANCELLED`); an already-paid order is not changed. Read the order's own `status` to decide what to show.
  - While Paystack has not decided yet (e.g. MoMo approval pending) the attempt stays `PENDING`; call again later.
  - Verifying an attempt that is already `COMPLETED` or `FAILED` returns it unchanged (safe to repeat).

**Input: `VerifyPaymentInput`**

```typescript
{
  reference: string; // Paystack transaction reference (the `reference` query parameter on your callback page).
}
```

**Possible Errors**: `NOT_FOUND` (unknown reference), `FORBIDDEN` (not the caller's order).

**`Payment` Object Type**:

```typescript
{
  id: string;
  orderId: string;
  order: Order;
  amount: Money;
  currency: string;          // "GHS"
  paymentMethod: string;     // Method sent at initialize ("CARD" | "MOBILE_MONEY"; older attempts may hold a free label such as "card"), or "CASH_ON_DELIVERY"
  status: PaymentStatus;     // PENDING | CAPTURED | FAILED | CANCELLED
  transactionId?: string;    // Paystack reference of this attempt
  paymentDetails?: JSON;     // Sanitised provider data: { reference, access_code } after initialize; { reference, status, amount, currency, channel, paid_at, gateway_response } after verification
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**`PaymentStatus` Enum** (one payment attempt): `PENDING`, `CAPTURED`, `FAILED` (refused by Paystack), `CANCELLED` (replaced by a retry before it was paid; a late payment on its reference is still accepted). **Breaking change (P1-O.2):** `COMPLETED` → `CAPTURED`, `ABANDONED` → `CANCELLED`. The order-level payment state is `Order.paymentStatus`.

---

#### `getMyPayments`
- **Type**: Query
- **Roles**: `USER`
- **Response**: `[Payment!]!` (the caller's attempts)

---

#### `getUserPayment` (ADMIN only)
- **Type**: Query
- **Roles**: `ADMIN` only (a `SUPER_ADMIN` gets `FORBIDDEN`)
- **Args**: `userId: String!`
- **Response**: `[Payment!]!`

---

#### `payments` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Response**: `[Payment!]!`, every attempt (not paginated)

---

#### `payment`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `id: String!`
- **Response**: `Payment!`
- **Description**: Users can only access their own payments. Admins can access any.
- **Possible Errors**: `NOT_FOUND`; `UNAUTHENTICATED` (status 401, not 403) when a `USER` asks for someone else's payment.

---

#### `recordCodPayment` (staff: `payment.record`)
- **Type**: Mutation
- **Args**: `input: RecordCodPaymentInput!` — `{ orderId: ID!, riderId: ID!, amount: Decimal!, collectedAt: DateTime }`
- **Description**: Records that a rider collected the grand total in cash. In one step it captures the payment (attempt `CAPTURED`, provider `CASH_ON_DELIVERY`, amount = `grandTotal`, GHS), stores the cash collection (who collected it, who recorded it, when), delivers the shipment (`DELIVERED`), completes the order (`COMPLETED`, customer emailed) and writes an audit entry (with the rider and collection time). The collection then waits to be handed in with `recordCashRemittance` (see [COD cash](#cod-cash-collection-remittances-and-report-p3-b3)).
- **Rules**: only a non-deleted cash-on-delivery order in `IN_FULFILMENT` whose shipment has been dispatched (`OUT_FOR_DELIVERY`, or `READY_FOR_PICKUP` at the counter). A shipment with a rider is refused (`BAD_REQUEST` + `reason: PROOF_OF_DELIVERY_REQUIRED`): its cash is recorded by `completeMyDelivery` / `completeDelivery` (P5-C.2). `riderId` is the staff member who took the cash: for a delivery it must be a rider (P5-C.1: a role with `delivery.ride`, `BAD_REQUEST` + `reason: NOT_A_RIDER` otherwise); at the pickup counter any active staff member. Collections recorded earlier by other staff stay valid and can still be remitted. `amount` must equal the order's `grandTotal` exactly: a short collection is not recorded here (cash a rider fails to hand in shows up as a short remittance). `collectedAt` defaults to now; it may be backdated, but not to before dispatch nor into the future (5 minutes of clock skew allowed). Repeating the call for the same order (double click) records nothing more.
- **Response**: `Payment!`

**Breaking change (P3-B.3):** the argument `orderId: String!` → `input: RecordCodPaymentInput!`, with the new required `riderId` and `amount`.

**Possible Errors**:
- `NOT_FOUND` — order does not exist or is deleted.
- `BAD_REQUEST` — the order is an `ONLINE` order; `reason: RIDER_NOT_STAFF` (unknown rider, no store role or archived); `reason: COLLECTION_AMOUNT_MISMATCH` (amount is not the grand total); `reason: INVALID_COLLECTION_TIME`.
- `CONFLICT` — the order is not `IN_FULFILMENT` (e.g. `PLACED`, `CONFIRMED`, `CANCELLED`, already `COMPLETED`), its shipment has not been dispatched, or its payment was already recorded.

---

#### `availablePaymentMethods` (P3-A.2)
- **Type**: Query
- **Auth Required**: No
- **Response**: `AvailablePaymentMethods!`
- **Description**: What a customer can pay with right now. `online` lists the online methods on offer, each with its provider and, when the Owner set one, the provider's public key (for a popup checkout); an `ONLINE` order needs at least one. `cashOnDelivery` says whether `CASH_ON_DELIVERY` orders are accepted. With nothing configured: card and mobile money through Paystack (when the server has `PAYSTACK_SECRET_KEY`) and cash on delivery.

```graphql
query { availablePaymentMethods { cashOnDelivery online { method provider publicKey } } }
```

```typescript
{
  online: { method: OnlinePaymentMethod; provider: OnlinePaymentProvider; publicKey: string | null }[]; // CARD | MOBILE_MONEY; PAYSTACK
  cashOnDelivery: boolean;
}
```

---

#### `paymentSettings` (Owner: `payment.settings.manage`) (P3-A.2)
- **Type**: Query
- **Response**: `PaymentSettings!`
- **Description**: The payment-method switches and the Paystack config in use. The secret key is write-only: only `secretKeyLast4` is ever shown.

```typescript
{
  methods: {
    cardPaymentsEnabled: boolean; mobileMoneyPaymentsEnabled: boolean; cashOnDeliveryEnabled: boolean;
    cardPaymentProvider: OnlinePaymentProvider; mobileMoneyPaymentProvider: OnlinePaymentProvider; // PAYSTACK
  };
  paystack: {
    configured: boolean;
    source: PaymentCredentialSource;  // DATABASE (setPaystackConfig) | ENVIRONMENT (PAYSTACK_SECRET_KEY fallback) | NONE (online payment unavailable)
    mode: PaymentProviderMode | null; // TEST | LIVE, from the key prefix; null for an environment key without sk_test_/sk_live_
    secretKeyLast4: string | null;
    publicKey: string | null;
    callbackUrl: string | null;
    updatedAt: DateTime | null;       // null unless stored in the database
    updatedById: string | null;
  };
}
```

#### `setPaystackConfig` / `removePaystackConfig` / `updatePaymentMethods` (Owner, step-up) (P3-A.2)
- **Type**: Mutations, each returning `PaymentSettings!`
- **Policy**: permission `payment.settings.manage` (only the Owner holds it) **and** a recent step-up (`FORBIDDEN` + `reason: STEP_UP_REQUIRED` otherwise). Every change is audited; secret values never appear in audit rows or logs.
- `setPaystackConfig(input: { secretKey: String!, publicKey: String, callbackUrl: String })`: replaces the whole Paystack config. `secretKey` must start with `sk_test_` or `sk_live_` (the mode follows it); `publicKey`, if sent, must be a `pk_` key of the same mode (`BAD_REQUEST` otherwise). The secret is stored AES-256-GCM encrypted. From then on these keys open checkouts and check webhook signatures; `PAYSTACK_SECRET_KEY` is no longer used. `callbackUrl` replaces `PAYSTACK_CALLBACK_URL` when set.
- `removePaystackConfig`: deletes the stored keys, so `PAYSTACK_SECRET_KEY` (if set) applies again. `NOT_FOUND` when none are stored.
- `updatePaymentMethods(input: { cardPaymentsEnabled, mobileMoneyPaymentsEnabled, cashOnDeliveryEnabled, cardPaymentProvider, mobileMoneyPaymentProvider })`: omitted fields keep their value. A switched-off method is refused at `checkoutQuote`/`createOrder` (order level) and `POST /payment/initialize` (online method), with `BAD_REQUEST` and reason `PAYMENT_METHOD_UNAVAILABLE`. Orders already placed keep their method.

---

#### Velocity checks (P3-E.1)

Counters per **customer account**, **phone number** (the order's `contactPhone`, Ghana numbers in E.164), **IP address** and **card** (Paystack's card fingerprint, known only once a charge is verified) over fixed 1-hour or 24-hour windows. Counters live in Redis under SHA-256 hashed keys; no phone number, IP address or card value is stored or logged. Each rule has two limits, set by the Owner: above the **soft** limit the action goes through and the order gets a **review flag** for staff; above the **hard** limit the action is refused (`FORBIDDEN`, `reason: VELOCITY_LIMIT`). Card rules can only flag (the card is known after the charge), at level `SOFT` or `HARD`. If Redis is down the checks let everything through (logged and counted in `velocity_check_errors_total`).

| `VelocityRule` | Counts | Per | Window | Default soft / hard |
|---|---|---|---|---|
| `ORDERS_PER_CUSTOMER_1H` | orders placed | customer | 1 h | 3 / 6 |
| `ORDERS_PER_CUSTOMER_24H` | orders placed | customer | 24 h | 6 / 15 |
| `ORDERS_PER_PHONE_24H` | orders placed | phone | 24 h | 6 / 15 |
| `ORDERS_PER_IP_1H` | orders placed | IP | 1 h | 10 / 30 |
| `ORDERS_PER_IP_24H` | orders placed | IP | 24 h | 40 / 120 |
| `PAYMENT_ATTEMPTS_PER_CUSTOMER_1H` | payment attempts started | customer | 1 h | 8 / 20 |
| `PAYMENT_ATTEMPTS_PER_IP_1H` | payment attempts started | IP | 1 h | 20 / 60 |
| `FAILED_PAYMENTS_PER_CUSTOMER_24H` | failed payments | customer | 24 h | 4 / 10 (hard: refuses new attempts) |
| `FAILED_PAYMENTS_PER_CARD_24H` | failed payments | card | 24 h | 3 / 6 (flags only) |

A rule fires when its count in the window, including the order or attempt being made, goes above the limit (soft 3 = the 4th order in the hour is flagged). Windows start at the first counted event.

- `velocityLimits: [VelocityLimit!]!` (Owner: `payment.settings.manage`): every rule with `{ rule, event, subject, windowSeconds, softLimit, hardLimit, isDefault }` (`VelocityEvent`: `ORDER_PLACED | PAYMENT_STARTED | PAYMENT_FAILED`; `VelocitySubject`: `CUSTOMER | PHONE | IP | CARD`; `isDefault` true while the code default applies).
- `updateVelocityLimits(input: { limits: [{ rule, softLimit, hardLimit }] }): [VelocityLimit!]!` (Owner, recent step-up, audited): whole numbers 1–1,000,000 with `hardLimit >= softLimit` (`BAD_REQUEST` otherwise, nothing saved); rules left out keep their limits.
- `flaggedOrders(first: Int = 20): [FlaggedOrder!]!` (1-100) (staff: `order.view`): orders with open review flags, newest first: `{ id, orderNumber, userId, status, grandTotal, createdAt, reviewFlags: [OrderReviewFlag] }`; open `viewOrder` for the full order. `OrderReviewFlag`: `{ id, orderId, rule, level: VelocityLevel (SOFT | HARD), count, limit, createdAt, clearedAt, clearedById, clearNote }`. One open flag per order and rule.
- `clearOrderReviewFlags(input: { orderId, note }): [OrderReviewFlag!]!` (staff: `order.manage`, audited): clears every open flag of the order with the note; `NOT_FOUND` when it has none. A flag does not hold the order: cancel it with `adminCancelOrder` if it is fraud.

---

#### Cash on delivery: phone verification and risk gates (P3-B.1/B.2)

**Phone verification (customer, any signed-in user).** The phone verified is the account's `phoneNumber` (set with `updateMyProfile`); verifying records the number and the time, and changing the number clears it (verify again). The SMS (sent from the worker through Hubtel) reads "`123456` is your verification code. It expires in 10 minutes. Never share it with anyone."

- `myPhoneVerification: PhoneVerificationStatus!`: `{ phoneVerified: Boolean!, phoneVerifiedAt: DateTime }`.
- `requestPhoneVerification: PhoneVerificationRequest!`: texts a new 6-digit code (replacing an earlier one), valid 10 minutes. Returns `{ phoneLast3, expiresInSeconds: 600, resendAfterSeconds: 60 }`. `BAD_REQUEST` with `reason`: `PHONE_REQUIRED` (no number on the profile), `PHONE_ALREADY_VERIFIED`, or `OTP_RATE_LIMITED` with `limit` (`COOLDOWN`: 60 s between codes; `PHONE_DAILY`: 5 codes a day per number, across accounts; `ACCOUNT_DAILY`: 10 a day per account) and `retryAfterSeconds`. In production without SMS credentials it fails with a server error (503).
- `verifyPhone(input: { code: String! }): PhoneVerificationStatus!`: `code` is the 6 digits (`BAD_USER_INPUT` otherwise). `BAD_REQUEST` with `reason`: `OTP_INVALID` (`attemptsRemaining`), `OTP_ATTEMPTS_EXCEEDED` (the 5th wrong code: that code is dead, request a new one) or `OTP_EXPIRED` (no live code, or the number changed since it was sent). Rate limited to 5 calls a minute per client.

**Risk gates.** A cash-on-delivery checkout must pass, in this order: the store offers COD (`NOT_OFFERED`); the account's phone is verified (`PHONE_NOT_VERIFIED`); none of its phones (account, `contactPhone`, address phone) and not the delivery address (GhanaPost GPS code, or street + city) is on the blacklist (`BLOCKED`; the customer is not told which); the delivery zone takes COD (`SHIPPING_ZONE_EXCLUDED`; pickup has no zone gate); the verified phone has fewer open COD orders (placed, confirmed or in fulfilment, under that phone or by the account) than `maxOpenOrdersPerPhone` (`OPEN_ORDER_LIMIT`); `grandTotal` is at most `maxOrderTotal` (`ORDER_TOTAL_ABOVE_CAP`). Each refusal at `createOrder` is counted in `cod_gate_refusals_total{gate}`. A COD order stores the verified phone it was placed under.

Owner operations (`payment.settings.manage`; every change needs a recent step-up and is audited):

- `codRiskSettings: CodRiskSettings!`: `{ maxOpenOrdersPerPhone: Int!, maxOrderTotal: Money! }` (defaults 2 and GHS 2,000.00).
- `updateCodRiskSettings(input: { maxOpenOrdersPerPhone: Int, maxOrderTotal: Decimal }): CodRiskSettings!`: whole number 1-100; amount above 0 with at most 2 decimals (`BAD_USER_INPUT` otherwise). Omitted fields keep their value.
- `setShippingZoneCashOnDelivery(id: ID!, enabled: Boolean!): ShippingZoneEntity!`: allow or refuse COD for deliveries to a zone (`ShippingZoneEntity.codEnabled`; existing and new zones start allowed). `NOT_FOUND` for an unknown zone.
- `codBlacklist(first: Int = 50): [CodBlacklistEntry!]!` (1-200, newest first): `{ id, kind: CodBlacklistKind (PHONE | GHANA_POST_GPS | STREET_ADDRESS), value, reason, createdById, createdAt }`. `value` is the normalised form compared at checkout: E.164 phone (`+233...`), GPS code without separators (`GA1838164`), or `street|city` in lower case without punctuation (`12 oxford st|accra`).
- `addCodBlacklistEntry(input: { phone, ghanaPostGps, street, city, reason: String! }): CodBlacklistEntry!`: exactly one of `phone`, `ghanaPostGps`, or `street` with `city` (`BAD_REQUEST` otherwise); `CONFLICT` when the normalised value is listed already. A street matches only the same words after normalisation ("St" and "Street" differ); prefer the GPS code.
- `removeCodBlacklistEntry(id: ID!): CodBlacklistEntry!`: `NOT_FOUND` for an unknown id.

#### COD cash: collection, remittances and report (P3-B.3)

After `recordCodPayment` the cash is with the **rider** (a staff account for now; a Rider role comes later). The rider hands it to the store in a **remittance**, recorded by the staff member who receives it. Every operation below needs `cod.cash.manage` (Owner, Manager, Cashier). Money is exact (`Money` / `Decimal` strings).

```typescript
CashCollection {
  id: string; orderId: string; orderNumber: number;
  attemptId: string | null;        // the captured cash payment
  riderId: string | null;          // null for collections recorded before P3-B.3
  recordedById: string | null;
  amount: Money; currency: string; collectedAt: DateTime;
  remittanceId: string | null;     // null while outstanding
}
CashRemittance {
  id: string; riderId: string; receivedById: string;
  amount: Money;                   // cash handed in
  expectedAmount: Money;           // sum of the covered collections
  discrepancy: string;             // amount - expectedAmount, 2 decimals: "-20.00" short, "5.00" over, "0.00"
  discrepancyKind: CashDiscrepancyKind | null; // SHORT | OVER | null when it matches
  currency: string; note: string | null; receivedAt: DateTime; createdAt: DateTime;
  collections: CashCollection[];   // empty for an adjusting entry
}
```

- `unremittedCashCollections(riderId: ID!): [CashCollection!]!`: the rider's collections not handed in yet, oldest first (what a remittance can cover).
- `recordCashRemittance(input: { riderId: ID!, amount: Decimal!, collectionIds: [ID!]!, receivedAt: DateTime, note: String }): CashRemittance!` (audited): `amount` 0 or more; `collectionIds` up to 500 of that rider's unremitted collections; `receivedAt` defaults to now. When `amount` differs from the collections' sum the difference is recorded as a discrepancy and `note` is required (`BAD_REQUEST`, `reason: DISCREPANCY_NOTE_REQUIRED`, nothing saved). Remittances can never be edited or deleted: correct one with a new **adjusting entry**, a remittance with no collections (e.g. the GHS 20 a rider brings the next day after a short remittance), which counts entirely as `OVER` and needs a note. Errors: unknown collection → `NOT_FOUND`; another rider's collection, a collection listed twice, no collections and amount 0 → `BAD_REQUEST`; a rider who is neither active staff nor has collected cash before → `BAD_REQUEST` `RIDER_NOT_STAFF`; a collection already remitted (also when two remittances race for it: one wins) → `CONFLICT`, `reason: COLLECTION_ALREADY_REMITTED`. A short or over remittance records `cod.remittance_discrepancy.v1` (logged by the worker) and counts in `cod_remittance_discrepancies_total`.
- `cashRemittances(riderId: ID, first: Int = 20): [CashRemittance!]!` (1-100): newest first.
- `codCashReport(input: { from: DateTime!, to: DateTime!, riderId: ID, first: Int = 20, after: ID }): CodCashReport!`: for `[from, to)` (`from` must be before `to`, else `BAD_REQUEST`). `riders` lists every rider with collections taken or remittances received in the range, ordered by id, paged with `first` (1-100) and `after` (the last `riderId` of the previous page); `totals` covers every rider of the range, not just the page.

```typescript
CodCashReport {
  from: DateTime; to: DateTime;
  riders: {
    riderId: string; riderName: string | null;
    collectionsCount: number; collectedTotal: Money;     // collections taken in the range
    outstandingCount: number; outstandingTotal: Money;   // ...of which not remitted yet
    remittancesCount: number; remittedTotal: Money;      // remittances received in the range
    discrepancyCount: number; shortTotal: Money; overTotal: Money; // their short/over amounts (shortTotal is positive)
    netDiscrepancy: string;                              // overTotal - shortTotal; negative: the rider owes cash
  }[];
  pageInfo: { hasNextPage; hasPreviousPage; pageSize; totalCount };
  totals: { /* the same figures, without riderId/riderName */ };
  uncollectedDeliveries: {                               // store-wide, ignores riderId
    count: number; total: Money;                         // COD orders delivered in the range with no cash collection (cash not recorded)
    orders: { orderId; orderNumber; grandTotal: Money; deliveredAt: DateTime }[]; // the oldest 100
  };
}
```

---

#### Disputes and chargebacks (P3-E.2)

A `Dispute` is a chargeback or dispute on a captured online payment (attempt). Paystack's dispute webhooks create and move it (source `PROVIDER`); staff can also record one by hand (source `STAFF`, e.g. a chargeback notice that arrived by email). An unresolved dispute blocks refunds on its payment (see `processPendingRefund`).

`DisputeStatus`: `OPEN` → `AWAITING_EVIDENCE` (answer by `evidenceDueAt`) ⇄ `UNDER_REVIEW` (with the bank) → `WON` | `LOST` | `ACCEPTED` (the merchant accepted the claim). `OPEN` may also go straight to any later status; resolved statuses are final. Paystack mapping: `pending` → `OPEN`, `awaiting-merchant-feedback` → `AWAITING_EVIDENCE`, `awaiting-bank-feedback` → `UNDER_REVIEW`, `resolved` with resolution `declined` → `WON`, `merchant-accepted` → `ACCEPTED`; any other value leaves the status unchanged (logged; staff set it by hand). A late webhook the table does not allow (a reminder after the resolution) changes nothing.

```typescript
Dispute {
  id: string; attemptId: string; orderId: string;
  provider: PaymentProvider;           // PAYSTACK | CASH_ON_DELIVERY
  providerDisputeId: string | null;    // unique per provider
  amount: Money; currency: string;
  category: string | null; reason: string | null;
  status: DisputeStatus; source: DisputeSource;  // PROVIDER | STAFF
  evidenceDueAt: DateTime | null; openedAt: DateTime; resolvedAt: DateTime | null;
  createdById: string | null;          // staff who recorded it
  notes: { id; authorId; body; createdAt }[];                                          // append-only, oldest first
  history: { id; fromStatus: DisputeStatus | null; toStatus; source; actorId; providerStatus; note; createdAt }[];
  createdAt: DateTime; updatedAt: DateTime;
}
```

- `disputes(status: DisputeStatus, paymentId: ID, first: Int = 20): [Dispute!]!` and `dispute(id: ID!): Dispute!` (staff: `payment.view`; `NOT_FOUND` for an unknown id).
- `recordDispute(input: { paymentId, amount: Decimal, category, reason, providerDisputeId, evidenceDueAt, status }): Dispute!` (`payment.dispute.manage`: Owner, Manager; audited): the payment must be a `CAPTURED` online payment (`CONFLICT` otherwise; cash on delivery `BAD_REQUEST`), the amount more than 0 and at most the payment amount (`BAD_REQUEST`), `status` `OPEN` (default), `AWAITING_EVIDENCE` or `UNDER_REVIEW`. A `providerDisputeId` already recorded → `CONFLICT`.
- `updateDisputeStatus(input: { disputeId, status, note }): Dispute!` (`payment.dispute.manage`, audited): `CONFLICT` for a move the table does not allow.
- `addDisputeNote(input: { disputeId, body }): Dispute!` (`payment.dispute.manage`, audited): appends an evidence note (max 5000 characters); notes cannot be edited or deleted.

---

#### `softDeletePayment` / `restorePayment` (ADMIN only)
- **Type**: Mutation
- **Roles**: `ADMIN` only (a `SUPER_ADMIN` gets `FORBIDDEN`)
- **Args**: `id: String!`
- **Response**: `Payment!`
- **Note**: There is no `removePayment`. Payment records are financial history and cannot be deleted; `softDeletePayment` only hides one, `restorePayment` un-hides it (it is then returned by `payment`, `payments` and the other payment reads again). `NOT_FOUND` for an unknown ID; `restorePayment` also answers `NOT_FOUND` for a payment that is not soft-deleted.

---

### 2.13 Promotions and coupon codes

**Breaking change (P2-B.1, ADR-0005):** discounts and coupons are now **promotions**. A promotion is either automatic or unlocked by a **coupon code**. Every operation below needs the `promotion.manage` permission (Owner, Manager); every change also needs a recent step-up (`FORBIDDEN` + `reason: STEP_UP_REQUIRED`) and is audit-logged. Removed, with their replacements:

| Removed | Use instead |
|---|---|
| `discounts`, `discount(id)` | `promotions(isActive, scope)`, `promotion(id)` |
| `createDiscount`, `updateDiscount`, `removeDiscount` | `createPromotion`, `updatePromotion`, `deletePromotion` |
| `addToDiscount`, `removeFromDiscount` | `updatePromotion(id, input: { targetIds })` (replaces all targets; `[]` clears them) |
| `coupons`, `coupon(id)` | `promotion(id) { couponCodes }` (a coupon is a CART promotion with `requiresCoupon` and a code) |
| `createCoupon`, `updateCoupon`, `deleteCoupon` | `createPromotion(... requiresCoupon: true)` + `createCouponCode`, `updateCouponCode`, `deleteCouponCode` |
| mutation `validateCoupon(input: { code, orderTotal })` → `CouponValidation` | query `validateCouponCode(code)` → `CouponCodeValidation` (what the code unlocks; `checkoutQuote` with `couponCode` gives the exact amount) |
| types `Discount`, `Coupon`, `CouponValidation`; enums `DiscountType`, `DiscountTypeEnum` (`PERCENTAGE`, `FLAT`) | `Promotion`, `CouponCode`, `CouponCodeValidation`, `PublicPromotion`, `Redemption`; enums `PromotionScope`, `PromotionType` (`PERCENT`, `AMOUNT_OFF`, `FIXED_PRICE`), `RedemptionStatus` |
| `Variant.appliedDiscount: Discount`, `Variant.discountId`, `CreateVariantInput.discountId`, `UpdateVariantInput.discountId`, `Product.discounts` | `Variant.appliedPromotion: PublicPromotion`; targets are set on the promotion |
| `Order.couponId` (never exposed) | `Order` keeps the code in its `COUPON` adjustment's `code` |

Existing discounts and coupons were migrated with their ids, so the `sourceId` of old order adjustments names the promotion they became.

**`Promotion` Object Type** (staff only):

```typescript
{
  id: string;
  name: string;
  description?: string;
  scope: PromotionScope;      // SKU | PRODUCT | CATEGORY | BRAND | CART
  type: PromotionType;        // PERCENT | AMOUNT_OFF | FIXED_PRICE | BXGY | TIERED (P2-B.5) | FREE_SHIPPING (P2-B.6)
  value?: Decimal;            // PERCENT: 0-100; AMOUNT_OFF: amount off each targeted unit (off the cart for CART); FIXED_PRICE: the unit price (never raises a price; not for CART); BXGY: percent off each reward unit (100 = free). Breaking change (P2-B.5): nullable, null for TIERED
  targetIds: ID[];            // Variant ids (SKU), product, category or brand ids; [] for CART. BXGY: the buy targets
  buyQuantity?: number;       // P2-B.5 BXGY: targeted units to buy per application
  getQuantity?: number;       // P2-B.5 BXGY: reward units per application
  maxApplications?: number;   // P2-B.5 BXGY: most applications per order; null = no limit
  rewardTargetIds: ID[];      // P2-B.5 BXGY: reward targets, of the scope's kind; [] = the targets themselves
  tierValueType?: PromotionType; // P2-B.5 TIERED: PERCENT | AMOUNT_OFF | FIXED_PRICE (not for CART), how each tier's value reduces the price
  tiers: PromotionTier[];     // P2-B.5 TIERED: { minimumQuantity?: number (item scopes); minimumSpend?: Money (CART); value: Decimal }, ascending
  shippingZoneIds: ID[];      // P2-B.6 FREE_SHIPPING: only for deliveries to these zones; [] = every zone
  minimumSpend?: Money;       // Least merchandise total (see 10. Promotions System for which subtotal)
  minimumQuantity?: number;   // Least number of targeted units in the cart (any unit for CART)
  startsAt: DateTime;
  endsAt?: DateTime;          // null = open-ended
  isActive: boolean;
  priority: number;           // Lowest wins a tie between equal savings, then the oldest promotion
  stackingGroup: string;      // Default "default"
  exclusive: boolean;
  requiresCoupon: boolean;    // Only orders entering one of its couponCodes get it
  usageLimit?: number;        // Orders that may use it, across all customers
  usedCount: number;          // Orders holding a use (taken at placement, given back on cancel/expiry before payment)
  unitCap?: number;           // P2-B.4 flash sale: units that may be sold at its price across all orders; null = no cap (not for CART)
  unitsUsed: number;          // P2-B.4: units sold at its price by orders holding a use (given back with the use)
  perCustomerLimit?: number;  // Orders each customer may use it on
  firstOrderOnly: boolean;    // P2-B.3: only for a customer without an earlier confirmed or paid order (see 10)
  customerGroupIds: ID[];     // P2-B.3: only for members of one of these customer groups; [] = everyone
  couponCodes: CouponCode[];
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

#### `promotions` / `promotion`

- **Args**: `promotions(isActive: Boolean, scope: PromotionScope)`, newest first; `promotion(id: ID!)` (`NOT_FOUND` if unknown).

#### `createPromotion`

- **Args**: `input: CreatePromotionInput!` → `Promotion!`

```typescript
{
  name: string;                // Required, max 255
  description?: string;
  scope: PromotionScope;       // Required
  type: PromotionType;         // Required
  value?: Decimal;             // >= 0, 2 dp; PERCENT and BXGY at most 100 (BXGY above 0). Required except for TIERED (none) and FREE_SHIPPING (none = waive the fee; else the amount off it, above 0)
  targetIds?: ID[];            // Default []; must exist for the scope; none for CART
  buyQuantity?: number;        // P2-B.5 BXGY only, required there, >= 1
  getQuantity?: number;        // P2-B.5 BXGY only, required there, >= 1
  maxApplications?: number;    // P2-B.5 BXGY only, >= 1
  rewardTargetIds?: ID[];      // P2-B.5 BXGY only; default [] (the targets themselves); must exist for the scope
  tierValueType?: PromotionType; // P2-B.5 TIERED only, required there: PERCENT | AMOUNT_OFF | FIXED_PRICE (not for CART)
  tiers?: PromotionTierInput[]; // P2-B.5 TIERED only, 1-20: { minimumQuantity?: Int (item scopes), minimumSpend?: Decimal (CART), value: Decimal }, strictly ascending thresholds, a higher tier never worth less; PERCENT values in (0, 100], AMOUNT_OFF above 0
  minimumSpend?: Decimal;
  minimumQuantity?: number;    // >= 1
  startsAt?: DateTime;         // Default now
  endsAt?: DateTime;           // After startsAt; omit for open-ended
  isActive?: boolean;          // Default false
  priority?: number;           // Default 0
  stackingGroup?: string;      // Default "default", max 50
  exclusive?: boolean;         // Default false
  requiresCoupon?: boolean;    // Default false
  usageLimit?: number;         // >= 1
  unitCap?: number;            // >= 1; P2-B.4 flash sale unit cap; not for CART (may later be set below unitsUsed: no more units are sold)
  perCustomerLimit?: number;   // >= 1
  firstOrderOnly?: boolean;    // Default false
  customerGroupIds?: ID[];     // Default [] (everyone); must exist
  shippingZoneIds?: ID[];      // P2-B.6 FREE_SHIPPING only; default [] (every zone); must exist
}
```

**Possible Errors**: `BAD_REQUEST` (unknown customer groups, PERCENT above 100, FIXED_PRICE on CART, targets on CART, unknown targets, `endsAt` not after `startsAt`, a `unitCap` on CART; P2-B.5: a missing value, BXGY without quantities or on CART, BXGY or tier fields on another type, invalid tiers).

#### `updatePromotion`

- **Args**: `id: ID!`, `input: UpdatePromotionInput!` (every field optional) → `Promotion!`
- Omitted fields stay; `null` clears an optional one (`description`, `value`, `minimumSpend`, `minimumQuantity`, `endsAt`, `usageLimit`, `unitCap`, `perCustomerLimit`, `buyQuantity`, `getQuantity`, `maxApplications`, `tierValueType`). `rewardTargetIds` and `tiers`, when given, replace the stored ones (`rewardTargetIds` is required when `scope` changes and the promotion has some). `targetIds` replaces every target (`[]` clears them) and is required when `scope` changes; `customerGroupIds` replaces the groups (`[]` opens it to everyone). The result is checked as a whole against the stored promotion (a `value` of 150 on a PERCENT promotion is refused).

#### `deletePromotion`

- **Args**: `id: ID!` → `Promotion!`. Deletes it with its coupon codes. A promotion an order has used cannot be deleted (`CONFLICT`): set `isActive: false` instead.

#### `createCouponCode` / `updateCouponCode` / `deleteCouponCode`

```typescript
CreateCouponCodeInput { promotionId: ID; code: string /* letters, digits, - and _, max 50; stored upper case */; isActive?: boolean /* default true */; usageLimit?: number /* the code's own limit; the promotion's limits still apply */ }
UpdateCouponCodeInput { code?: string; isActive?: boolean; usageLimit?: number | null }
CouponCode { id; code; promotionId; isActive; usageLimit?; usedCount; createdAt; updatedAt }
```

Codes are unique ignoring case (`CONFLICT` for a taken code). A code an order has used cannot be deleted (`CONFLICT`): deactivate it.

#### `redemptions`

- **Args**: `promotionId`, `customerId`, `orderId`, `status: RedemptionStatus` (all optional), `first` (1-100, default 50), `after` (cursor: the last node id) → `RedemptionPage { nodes: Redemption[]; totalCount; hasNextPage }`, newest first.
- `Redemption { id; promotionId; couponCodeId?; customerId; orderId; status: RESERVED | RELEASED; units; createdAt; releasedAt? }`: one row per promotion an order used; `units` (P2-B.4) is how many units the order bought at the promotion's price (0 for a cart promotion).

#### `validateCouponCode` (any signed-in user)

- **Args**: `code: String!` (any letter case) → `CouponCodeValidation!`

```typescript
{
  code: string;                // As stored (upper case)
  promotion: PublicPromotion;  // { id, name, description?, endsAt? }
  scope: PromotionScope;
  type: PromotionType;
  value?: Decimal;             // Breaking change (P2-B.5): null for TIERED
  minimumSpend?: Money;
  minimumQuantity?: number;
}
```

It checks the code for the caller whatever the cart (active, started, not expired, uses left overall and for the caller). Use `checkoutQuote` with `couponCode` for its exact effect on the cart.

**Possible Errors**: `NOT_FOUND` (unknown code); `BAD_REQUEST` with the reason ("This coupon is no longer active", "This coupon is not active yet", "This coupon has expired", "This coupon has reached its usage limit", "You have already used this coupon", "This coupon is only for a first order", "This coupon is not available for your account").

#### Customer groups (P2-B.3, `customer.group.manage`)

A customer group is a named set of customers. A promotion with `customerGroupIds` applies only to members, and members of a price list's groups get its prices (P2-W.1). Changes are audit-logged (members by user id only).

```typescript
CustomerGroup { id; name /* unique */; description?; memberCount: number; members(first = 50 /* 1-100 */, after?: ID /* last userId */): CustomerGroupMemberPage; createdAt; updatedAt }
CustomerGroupMemberPage { nodes: { userId: ID; createdAt: DateTime }[]; totalCount; hasNextPage }
CreateCustomerGroupInput { name: string /* max 100 */; description?: string }
UpdateCustomerGroupInput { name?: string; description?: string | null }
CustomerGroupMembersInput { groupId: ID; userIds: ID[] /* 1-500 */ }
```

- `customerGroups` (by name), `customerGroup(id)`.
- `createCustomerGroup(input)`, `updateCustomerGroup(id, input)` (`CONFLICT` for a taken name).
- `deleteCustomerGroup(id)`: deletes the group and its memberships; `CONFLICT` while a promotion is limited to it (deleting it would open the promotion to everyone).
- `addCustomerGroupMembers(input)` (members already in the group are kept; `BAD_REQUEST` for unknown user ids), `removeCustomerGroupMembers(input)`; both return the group.
- Deleting a group a price list uses only takes those prices away from its members (a list without groups prices nobody), so it is allowed.

#### B2B price lists (P2-W.1, `pricelist.manage`)

A price list gives the members of its customer groups their own unit prices per variant, from a minimum quantity (MOQ), with lower prices for larger quantities. How checkout uses them: [10. Promotions System → B2B price lists](#b2b-price-lists-p2-w1-pricingversion-4). Every mutation needs `pricelist.manage` (Owner and Manager) **and a recent step-up** (`STEP_UP_REQUIRED` otherwise), and is audit-logged (entries with their prices before and after). Customers cannot read price lists, their entries, or which list or group gives them a price: they only see their own prices on `Variant.customerPrice` / `priceTiers` and `QuoteLine.fromPriceList`.

```typescript
PriceList {
  id; name /* unique */; description?; currency /* the store currency */; isActive; startsAt?; endsAt?;
  priority: number;          // breaks ties between equal prices: lowest first, then the oldest list
  allowPromotions: boolean;  // promotions apply on top of its prices (default false: its lines are left out of promotions)
  customerGroupIds: ID[]; entryCount: number;
  entries(first = 50 /* 1-200 */, after?: ID /* last variantId */): PriceListEntryPage; createdAt; updatedAt
}
PriceListEntry { variantId; price: Money /* from minQuantity units, tax included */; minQuantity: number; tiers: { minQuantity; price: Money }[]; updatedAt }
PriceListEntryPage { nodes: PriceListEntry[]; totalCount; hasNextPage }
VariantPriceTier { minQuantity: number; unitPrice: Money; promotionsApply: boolean }   // the customer's view

CreatePriceListInput { name /* max 100 */; description?; isActive = false; startsAt?; endsAt?; priority = 0; allowPromotions = false; customerGroupIds: ID[] = [] }
UpdatePriceListInput { name?; description?; isActive?; startsAt?; endsAt?; priority?; allowPromotions?; customerGroupIds? /* replaces */ }
SetPriceListEntriesInput { priceListId: ID; entries: PriceListEntryInput[] /* 1-200 */ }
PriceListEntryInput { variantId: ID; price: Decimal /* > 0, tax included like Variant.price */; minQuantity: Int = 1; tiers: { minQuantity: Int; price: Decimal }[] = [] }
RemovePriceListEntriesInput { priceListId: ID; variantIds: ID[] /* 1-200 */ }
```

- `priceLists(isActive?)` (newest first), `priceList(id)`.
- `createPriceList(input)`, `updatePriceList(id, input)`: `CONFLICT` for a taken name; `BAD_REQUEST` for unknown customer group ids or `endsAt` not after `startsAt`.
- `deletePriceList(id)`: removes the list and its entries; orders placed at its prices keep them.
- `setPriceListEntries(input)`: each entry replaces its variant's entry (and tiers) in the list. `BAD_REQUEST` for an unknown variant, a variant given twice, a tier not above `minQuantity` and the previous tier, or a tier price above the price below it (equal is allowed); `BAD_USER_INPUT` for a price of 0. A list price at or above the variant's normal price is stored but never used (the normal price applies).
- `removePriceListEntries(input)`: takes the variants out (unknown ones are ignored).
- Prices are tax-inclusive like `Variant.price` and are **not** repriced when tax rates change. Entry changes are audit-logged, not added to the variant price history (`priceChanges` covers `Variant.price` / `basePrice` only).

---

### 2.13a Loyalty points (P6-L.1)

Every signed-in customer collects points automatically; guests never do (not even when a guest order is attached to an account later), nor staff accounts. Defaults (store settings, `loyaltySettings`): **1 point per whole GHS 1** of goods paid, **100 points = GHS 1** at checkout, at least **500 points** per redemption, points pay at most **50 %** of the goods after promotions, points expire **12 months** after they were credited.

- **Earning:** when an order reaches `COMPLETED`, it earns `floor(goods paid × earn rate)`, where goods paid = the line totals after every item and cart promotion and after the points redeemed, without the delivery fee. Once per order. Cancelled and expired orders never earn.
- **Refunds:** a refund of order lines takes back the points of the refunded goods in proportion (rounded down; all of them once everything is refunded). Points already spent become **`pointsOwed`**: the next points credited pay them off first. Redeemed points come back in the same proportion; a cancelled or expired order gives every redeemed point back.
- **Expiry:** points are spent oldest expiry first; unspent points expire (an `EXPIRE` entry). `balance` only counts points not yet expired.

**Redeeming at checkout:** send `redeemPoints` in `CheckoutQuoteInput` / `CreateOrderInput` (same value in both: it is part of the `quoteHash`). `checkoutQuote.loyalty` gives `{ balance, redeemablePoints, pointsRedeemed, amount }`: show `redeemablePoints` as the most the customer can use on this cart (0 = points cannot be used now). The points take `amount` off the goods (in `discountTotal`, shared over the lines like a cart promotion); they never reduce the delivery fee, and free shipping is decided without them. Refusals on both: `BAD_REQUEST` with `reason` `POINTS_BELOW_MINIMUM` (also a non-whole number), `INSUFFICIENT_POINTS`, `POINTS_ABOVE_CAP`, `POINTS_NOT_WHOLE_PESEWAS` (a store rate where the points are not worth whole pesewas), or `FEATURE_DISABLED` with `feature: "LOYALTY"` while loyalty is switched off (**breaking (P8-F):** was `LOYALTY_DISABLED`). `createOrder` debits the points in the order transaction; when they fell since the quote it is `CONFLICT` with `reason: "LOYALTY_BALANCE_CHANGED"` (quote again). The order shows `loyaltyPointsRedeemed` and an adjustment `{ type: LOYALTY_POINTS, sourceId: null, amount }`. Guests have no `redeemPoints` (`GuestCheckoutQuoteInput` leaves it out) and `checkoutQuote.loyalty` is null for them.

| Operation | Who | Notes |
|---|---|---|
| `myLoyalty(first = 20, after)` | signed in | `LoyaltySummary`: `balance`, `pointsOwed`, `nextExpiry { points expiresAt }` (null when nothing expires), `history { nodes totalCount hasNextPage }` newest first; pass the last node `id` as `after` |
| `loyaltySettings` | public | `{ enabled earnPointsPerCedi redeemPointsPerCedi minimumRedeemPoints maxRedeemPercent pointsExpiryMonths referrerRewardPoints newCustomerRewardPoints }` (the last two: P6-L.2) |
| `customerLoyalty(userId, first, after)` | `user.view` | the customer's `LoyaltySummary`; `NOT_FOUND` for an unknown user |
| `adjustLoyaltyPoints(input: { userId, points, reason })` | `loyalty.manage` (Owner, Manager) + step-up | `points` non-zero, -1000000..1000000; `reason` 3-500 chars, **shown to the customer**. Added points expire like earned ones (and pay off points owed first); taking more than the balance is `CONFLICT` `INSUFFICIENT_POINTS`; staff accounts are `BAD_REQUEST`. Audited |
| `updateLoyaltySettings(input)` | `loyalty.manage` + step-up | any of `earnPointsPerCedi` 0-100, `redeemPointsPerCedi` 1-10000, `minimumRedeemPoints` 1-1000000, `maxRedeemPercent` 1-100, `pointsExpiryMonths` 1-120 (for points credited from then on), `referrerRewardPoints` / `newCustomerRewardPoints` 0-100000. Audited |

```graphql
type LoyaltyTransactionEntity {
  id: ID! type: LoyaltyTransactionType!   # EARN REDEEM REDEEM_RETURN REVERSE EXPIRE ADJUST REFERRAL
  points: Int!        # change to the balance (+ credited, - spent / taken back / expired)
  debtChange: Int!    # change to pointsOwed
  orderId: ID reason: String expiresAt: DateTime createdAt: DateTime!
}
```

---

### 2.13b Referrals (P6-L.2)

Every customer has a **referral code** (8 characters, no look-alike letters or digits; created the first time `myReferrals` is read). A new customer enters a friend's code **once**: at sign-up (`SignUpInput.referralCode`) or later with `applyReferralCode`, as long as they have placed no order. When the new customer's **first signed-in order completes**, both get loyalty points (defaults: **500 each**, store settings `referrerRewardPoints` / `newCustomerRewardPoints` in `loyaltySettings`), as `REFERRAL` entries in their loyalty history; the points expire like other points. Later orders never reward again. The new customer needs a **verified phone** by then (not the referrer's number), otherwise the referral is `DISQUALIFIED` for good. If that first order is **refunded in full within the return window**, both rewards are taken back (`REVERSED`). Codes are case-insensitive; spaces and hyphens are ignored.

| Operation | Who | Notes |
|---|---|---|
| `myReferrals` | signed in | `{ code referredBy pendingCount rewardedCount pointsEarned referrals { displayName status createdAt rewardedAt } }`; friends appear by first name only |
| `applyReferralCode(input: { code })` | customers | returns `MyReferrals`. `BAD_REQUEST` with `reason` `INVALID_REFERRAL_CODE`, `SELF_REFERRAL`, `ALREADY_REFERRED`, `HAS_ORDERS` (an order was already placed), `MUTUAL_REFERRAL` (the code's owner was referred by you); `FORBIDDEN` `VELOCITY_LIMIT` when the code was used too often in 24 hours |
| `signUp(input: { ..., referralCode })` | public | `BAD_REQUEST` `INVALID_REFERRAL_CODE` or `FORBIDDEN` `VELOCITY_LIMIT` before the account is created |
| `customerReferrals(userId)` | `user.view` | `{ code referredBy referrals }` with ids, status, `disqualifiedReason`, `velocityFlagged`, the qualifying `orderId` and the points given |

`ReferralStatus`: `PENDING` → `REWARDED` → `REVERSED`, or `PENDING` → `DISQUALIFIED`. While the `REFERRALS` store feature is off (P8-F), `myReferrals`, `applyReferralCode` and a `signUp` with a `referralCode` fail with `BAD_REQUEST` `FEATURE_DISABLED`, and a referral whose first order completes meanwhile is `DISQUALIFIED` with `disqualifiedReason: "REFERRALS_DISABLED"`. A new velocity rule `REFERRALS_PER_REFERRER_24H` (defaults: flag above 5, refuse above 20 sign-ups per referrer in 24 hours) appears in `velocityLimits`.

---

### 2.15 Inventory

Inventory writes need `inventory.adjust` and the ledger query `inventory.view`; see [2.24](#224-staff-roles-and-permissions). **Stock is held per variant (the SKU) and location** (ADR-0008). A variant shows `available` (public), `onHand` and `reserved` (summed over every location) and `stockLevels` (per location) to staff with `inventory.view` (`FORBIDDEN` otherwise). `Product.totalStock` and `Product.inStock` summarise the **available** stock of its active variants.

**Locations and fulfilment (P4-A.1).** Each store has stock locations (`WAREHOUSE`, `BRANCH`, `PICKUP_POINT`); exactly one is the **default**, which is always active. Each shipping zone and each pickup point has an ordered list of fulfilling locations (`setShippingZoneFulfilmentLocations`, `setPickupLocationFulfilmentLocations`); an empty list (the state after migration) means the default location. When an order is placed, **all of its lines are reserved at one location**: the first active location of the zone's or pickup point's list that has every line available (on hand minus reserved); when every listed location is inactive, the default. That location is stored on the order (`Order.stockLocationId`, staff with `order.view`) and on its reservations; payment, cash-on-delivery dispatch, cancellation, expiry and returned-goods restock all act on it. If no single location can fill the whole order, checkout fails with `BAD_REQUEST` (see the createOrder errors in [2.11](#211-orders)). An inactive location is never chosen for new orders and its stock is not shown to customers; orders already reserved there carry on as usual.

**What customers see.** `Variant.available` is what **one order can take**: on hand minus reserved at the best single location that serves customers, never the sum over locations (an order comes from one location). Without a delivery target (product pages, cart) the serving locations are the active ones that appear in any shipping zone's or pickup point's list, plus the default. `addToCart`/`updateCartItem` allow up to that quantity; `checkoutQuote` and `createOrder` check each line against the locations of the chosen zone or pickup point only. `Product.totalStock` adds each active variant's `available`; `products(inStock: true)` keeps products with an active variant in stock at a serving location (units of expired lots left out), `inStock: false` those with none.

**Behaviour change (P4-A.1, not a schema break):** `Variant.available` was the sum over locations and is now the best single serving location (identical while all stock is at the default location). The `inventory.low_stock.v1` event is now measured on the variant's available stock summed over active locations (`available` in the payload is that total; `locationId` is where the movement happened). Every stock change writes one entry to the append-only stock ledger (`StockMovement`); manual changes also write an audit entry (entity `Variant`, action `STOCK_ADJUSTMENT`). On-hand stock can never go below zero, and reserved stock never above on-hand stock.

**Breaking changes (P1-N.2):** `InventoryLogEntity` and `InventoryActionEnum` → removed, replaced by `StockMovement` and `StockMovementReason`. `restockVariant` and `adjustVariantStock` return `StockMovement!` (was `InventoryLogEntity!`). `inventoryLogs`, `productInventoryLogs` and `variantInventoryLogs` → removed; use the paginated `stockMovements` query (optionally by `variantId` or `productId`). `Variant.quantity` → removed; read `available` (and, as staff, `onHand` / `reserved`). Existing inventory log rows were copied into the ledger by migration.

**`StockMovement`**

```typescript
{
  id: string;
  variantId: string;
  locationId: string;
  onHandDelta: number;         // Signed change to on-hand stock
  reservedDelta: number;       // Signed change to reserved stock
  reason: StockMovementReason; // see below
  refType?: string;            // What caused it: "Order", "ReturnRequest", "InventoryLog" (migrated), ...
  refId?: string;
  actorId?: string;            // Staff member or customer who caused it
  adjustmentReason?: StockAdjustmentReason; // ADJUSTMENT only (P4-B.1): DAMAGED, LOST, FOUND, EXPIRED, CORRECTION, STOCK_TAKE, OTHER
  note?: string;               // The note given by staff, or e.g. "Order cancelled"
  lotId?: string;              // P4-C.1: the lot moved (lot-tracked variants; one movement per lot), null otherwise
  lot?: Lot;                   // P4-C.1: that lot (its `stock` is empty here)
  createdAt: DateTime;
}
```

**`StockLocation`** (staff)

```typescript
{
  id: string;
  name: string;
  type: StockLocationType;  // WAREHOUSE | BRANCH | PICKUP_POINT
  isActive: boolean;        // inactive: never chosen for new orders, stock hidden from customers
  isDefault: boolean;       // serves every empty fulfilment list; always active
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**`VariantStockLevel`** (the `Variant.stockLevels` field, `inventory.view`, the default location first): `{ locationId: ID!, locationName: String!, onHand: Int!, reserved: Int!, available: Int! }`.

**`StockMovementReason`**: `RECEIPT` (delivery or opening stock of a new variant), `RESERVE` (held for an order line), `SALE` (a hold consumed: online payment captured or cash-on-delivery order dispatched), `RELEASE` (hold given back on cancel or expiry), `RETURN_RESTOCK` (returned goods, or a paid order cancelled before dispatch), `ADJUSTMENT` (a manual change or a stock-take variance; see `adjustmentReason`), `OPENING_BALANCE` (stock the old inventory log did not explain, migration only), `TRANSFER` (P4-A.2: negative at the source when a transfer is dispatched, positive at the destination when it is received; `refType` `StockTransfer`).

---

#### `restockVariant`
- **Type**: Mutation
- **Args**: `input: RestockVariantInput!`
- **Response**: `StockMovement!` (reason `RECEIPT`, or `RETURN_RESTOCK` with `returnRequestId`)
- **Description**: Add stock to a variant at a location: a delivery, or goods returned by a customer once received and inspected. Returned goods (`returnRequestId`) go back to the location their order was fulfilled from unless `locationId` says otherwise; anything else goes to the default location unless `locationId` is given.

**Input: `RestockVariantInput`**

```typescript
{
  variantId: string;        // Required.
  quantity: number;         // Required. Integer >= 1.
  reason?: string;          // Max 500 chars. Default "Manual restock" ("Returned goods restocked" with returnRequestId).
  returnRequestId?: string; // The return request the goods came back under; recorded as RETURN_RESTOCK referencing it.
  locationId?: string;      // P4-A.1. Where the stock is received (default: the return's order location, else the default location).
  lot?: LotInput;           // P4-C.1. Lot-tracked variants only: see "Lots and expiry" below.
  serials?: string[];       // P4-D.1. Serial-tracked products only (required there, refused otherwise): one per unit. A receipt names
                            // new serials; a return restock names units sold on the return request's order.
}
```

For a lot-tracked variant (P4-C.1) a receipt needs `lot` with `lotNumber` and `expiresAt` (in the future); an existing lot number adds to that lot (its `expiresAt` must match). A return restock may name an existing, unexpired lot; without one the units go back into the lots the order's sales drew from (earliest expiry first). When the units spread over several lots, the first movement is returned (all of them are in `stockMovements`).

**Possible Errors**: `NOT_FOUND` (`Variant "<id>" not found`, `Return request "<id>" not found`, `Stock location "<id>" not found`); `BAD_REQUEST` (P4-C.1: `Variant "<id>" tracks lots: give the lot number and expiry of the units received`, `Lot "<n>" needs its expiry date (expiresAt)`, `Lot "<n>" expires at <date>, not <date>`, `Lot "<n>" expired at <date>; expired goods cannot be received`, `Variant "<id>" has no lot "<n>"`, `... name the lot the returned units belong to`, `Variant "<id>" does not track lots; leave the lot out`). Serial-tracked products (P4-D.1): `BAD_REQUEST` + `reason: SERIALS_REQUIRED` (missing or miscounted serials), `BAD_REQUEST` (malformed serial, a serial given twice, serials on an untracked product), `CONFLICT` + `reason: SERIAL_ALREADY_KNOWN` + `extensions.serials` (serials the variant already has), `CONFLICT` + `reason: SERIAL_NOT_AVAILABLE` (return restock of a serial not sold on that order).

---

#### `adjustVariantStock`
- **Type**: Mutation (`inventory.adjust`)
- **Args**: `input: AdjustVariantStockInput!`
- **Response**: `StockMovement!` (reason `ADJUSTMENT`, with `adjustmentReason`)
- **Description**: Change a variant's on-hand stock at a location by a signed amount, never an absolute quantity, with a reason from a fixed list: damage, loss, expiry, found goods, a correction. Units reserved for open orders cannot be adjusted away. One `ADJUSTMENT` stock movement and one audit entry (entity `Variant`, action `STOCK_ADJUSTMENT`, with `adjustmentReason`).

**Input: `AdjustVariantStockInput`**

```typescript
{
  variantId: string;               // Required.
  locationId?: string;             // Stock location; default: the store's default location.
  delta: number;                   // Required. Non-zero integer; negative removes stock.
  reason: StockAdjustmentReason;   // Required. See below.
  note?: string;                   // Max 500 chars. Required (not blank) when reason is OTHER. Stored as the movement's note.
  lot?: LotInput;                  // P4-C.1. Lot-tracked variants: required when adding (existing lot, or a new one with expiresAt); optional when removing.
  serials?: string[];              // P4-D.1. Serial-tracked products only (required there): one per unit. A removal names units
                                   // IN_STOCK at the location (they become WRITTEN_OFF); an addition names new serials or
                                   // WRITTEN_OFF ones that turned up (back IN_STOCK).
}
```

For a lot-tracked variant (P4-C.1), a removal without `lot` is drawn first expiry first out (unexpired lots, then expired ones), one movement per lot (the first is returned; the audit entry lists every lot). Errors: `BAD_REQUEST` `Variant "<id>" tracks lots: name the lot the units are added to`, `Cannot remove N units of lot "<n>": only M at this location`, `Variant "<id>" has no lot "<n>"`.

**`StockAdjustmentReason`**: `DAMAGED`, `LOST`, `EXPIRED` (remove stock only: `delta` < 0), `FOUND` (adds stock only: `delta` > 0), `CORRECTION`, `OTHER` (either way; `OTHER` needs a `note`), `STOCK_TAKE` (set only by an approved stock-take, see [Stock-takes](#stock-takes); refused here).

**Possible Errors**: `NOT_FOUND` (`Variant "<id>" not found`, `Stock location "<id>" not found or inactive`); `BAD_REQUEST` (`DAMAGED can only remove stock: send a negative delta`, `FOUND can only add stock: send a positive delta`, `STOCK_TAKE cannot be given by hand`, `A note is required when the reason is OTHER`, `Cannot remove N units from variant "<id>": only M available`); `BAD_USER_INPUT` (`delta` 0, unknown reason).

**Breaking change (P4-B.1):** `AdjustVariantStockInput.reason` is now a `StockAdjustmentReason` enum (was free text, which moves to the new optional `note`); `locationId` is new. `StockMovement.adjustmentReason` is new (null on movements recorded before P4-B.1 and on every other kind of movement).

---

#### `stockMovements`
- **Type**: Query (`inventory.view`)
- **Args**: `variantId?: ID`, `productId?: ID` (every variant of the product), `reason?: StockMovementReason`, `first: Int = 50` (1–100), `after?: ID` (the id of the last movement of the previous page)
- **Response**: `StockMovementPage! { nodes: [StockMovement!]!, totalCount: Int!, hasNextPage: Boolean! }`, newest first

---

#### `stockLocations` / `stockLocation` (P4-A.1)
- **Type**: Query (`inventory.view`)
- **Args**: none / `id: ID!`
- **Response**: `[StockLocation!]!` (the default first, then by name) / `StockLocation!` (`NOT_FOUND` when unknown)

#### `createStockLocation` (P4-A.1)
- **Type**: Mutation (`inventory.location.manage`)
- **Args**: `input: CreateStockLocationInput! { name: String! (1–120), type?: StockLocationType (default WAREHOUSE), isActive?: Boolean (default true) }`
- **Response**: `StockLocation!`. Audited (entity `StockLocation`, action `CREATE`). A new location holds no stock and fulfils nothing until it is restocked (`restockVariant` with `locationId`) and added to a fulfilment list.

#### `updateStockLocation` (P4-A.1)
- **Type**: Mutation (`inventory.location.manage`)
- **Args**: `id: ID!`, `input: UpdateStockLocationInput! { name?, type?, isActive?, isDefault? }`
- **Response**: `StockLocation!`. Audited with the changed fields. `isDefault: true` makes the (active) location the default and takes the flag off the old one.
- **Possible Errors**: `NOT_FOUND`; `BAD_REQUEST` when deactivating the default, sending `isDefault: false` for the default ("Make another location the default instead"), or making an inactive location the default.

#### `deleteStockLocation` (P4-A.1)
- **Type**: Mutation (`inventory.location.manage`)
- **Args**: `id: ID!`
- **Response**: `StockLocation!` (the deleted location). Audited. It leaves every fulfilment list it was on.
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` for the default location, and for a location with stock history (any movement, reservation, order or transfer): deactivate it instead (`updateStockLocation` with `isActive: false`).

#### `setShippingZoneFulfilmentLocations` / `setPickupLocationFulfilmentLocations` (P4-A.1)
- **Type**: Mutation (`inventory.location.manage`)
- **Args**: `shippingZoneId: ID!` / `pickupLocationId: ID!`, `input: FulfilmentLocationsInput! { locationIds: [ID!]! }` (at most 20, no repeats; the first is tried first; `[]` = the default location). A pickup point may list its own `PICKUP_POINT` location.
- **Response**: `[StockLocation!]!`, the new list in order. Audited on the zone or pickup point (`UPDATE`, `fulfilmentLocations` from/to). Read a list back on `ShippingZone.fulfilmentLocations` / `PickupLocation.fulfilmentLocations` (`inventory.view`; inactive entries included, they are skipped when placing).
- **Possible Errors**: `NOT_FOUND` (zone, pickup point or a location); `BAD_USER_INPUT` (repeats, more than 20).

---

#### Stock transfers (P4-A.2)

Stock moves between two locations in **two steps**. `createStockTransfer` makes a `DRAFT` (nothing moves). `dispatchStockTransfer` takes every line off the source's **available** stock (on hand minus reserved, so stock held for orders never leaves) with a `TRANSFER` movement per line; from then on the units are **in transit**: counted on the transfer, at neither location (`stockInTransit`). `receiveStockTransfer` adds what arrived to the destination (`TRANSFER` movements) and ends the transfer: `RECEIVED` when every unit arrived, `PARTIALLY_RECEIVED` when a line came up short. A shortfall is recorded on the line as its `variance` with a required note; no stock is created for the missing units (they left the source at dispatch). A transfer is received once; there is no second delivery. `cancelStockTransfer` works only on a `DRAFT`; goods already dispatched are received (short if need be) and sent back on a new transfer. Each step is a conditional status change: of two concurrent dispatches, receipts or cancels one wins and the other gets `CONFLICT`. Every step is audited (entity `StockTransfer`: `CREATE`, then `STATUS_CHANGE` with from/to, the variances or the cancel reason). Writes need `inventory.transfer` (Owner, Manager, Inventory clerk); reads need `inventory.view`.

**`StockTransferStatus`**: `DRAFT` → `DISPATCHED` | `CANCELLED`; `DISPATCHED` → `RECEIVED` | `PARTIALLY_RECEIVED`. `RECEIVED`, `PARTIALLY_RECEIVED` and `CANCELLED` are final.

**`StockTransfer`**

```typescript
{
  id: string;
  fromLocationId: string;
  toLocationId: string;
  status: StockTransferStatus;
  note?: string;
  lines: StockTransferLine[];
  createdById: string;
  dispatchedById?: string;  dispatchedAt?: DateTime;
  receivedById?: string;    receivedAt?: DateTime;
  cancelledById?: string;   cancelledAt?: DateTime;
  createdAt: DateTime;
  updatedAt: DateTime;
}
// StockTransferLine
{
  id: string;
  variantId: string;
  quantity: number;            // units dispatched (or to dispatch)
  receivedQuantity?: number;   // null until received
  variance?: number;           // quantity - receivedQuantity once received
  varianceNote?: string;       // why units are missing
}
```

#### `createStockTransfer`
- **Type**: Mutation (`inventory.transfer`)
- **Args**: `input: CreateStockTransferInput! { fromLocationId: ID!, toLocationId: ID!, lines: [{ variantId: ID!, quantity: Int! (>= 1) }] (1–100, one per variant), note?: String (max 500) }`
- **Response**: `StockTransfer!` (`DRAFT`)
- **Possible Errors**: `BAD_REQUEST` (same location twice, repeated variant, an inactive location); `BAD_USER_INPUT` (quantity below 1, no lines); `NOT_FOUND` (location or variant).

#### `dispatchStockTransfer`
- **Type**: Mutation (`inventory.transfer`)
- **Args**: `id: ID!`, `input?: DispatchStockTransferInput { lines?: [{ variantId: ID!, serials: [String!]! }] }` (P4-D.1): the units sent on each line of a serial-tracked variant, one serial per unit, each `IN_STOCK` at the source (they go `IN_TRANSIT`). Required for those lines, refused for others.
- **Response**: `StockTransfer!` (`DISPATCHED`)
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` (not a draft: already dispatched, received or cancelled; `reason: SERIAL_NOT_AVAILABLE` for a unit not in stock at the source); `BAD_REQUEST` (`Cannot dispatch N of variant "<id>": only M available at the source`; `reason: SERIALS_REQUIRED`; serials for a variant not on the transfer; nothing is dispatched).

#### `receiveStockTransfer`
- **Type**: Mutation (`inventory.transfer`)
- **Args**: `id: ID!`, `input?: ReceiveStockTransferInput { lines?: [{ variantId: ID!, receivedQuantity: Int! (0..quantity), note?: String, serials?: [String!] }] }`. List only the lines that arrived short; every other line is received in full. A short line needs a `note`. A short line of a serial-tracked variant also names the units that arrived (`serials`, one per unit received); its other units in transit become `WRITTEN_OFF` (P4-D.1). A line received in full may omit them.
- **Response**: `StockTransfer!` (`RECEIVED` or `PARTIALLY_RECEIVED`)
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` (not in transit: still a draft, already received or cancelled); `BAD_REQUEST` (more received than dispatched, a variant not on the transfer, a shortfall without a note).

#### `cancelStockTransfer`
- **Type**: Mutation (`inventory.transfer`)
- **Args**: `id: ID!`, `input?: { reason?: String (max 500) }`
- **Response**: `StockTransfer!` (`CANCELLED`)
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` (already dispatched, received or cancelled).

#### `stockTransfers` / `stockTransfer` / `stockInTransit`
- **Type**: Query (`inventory.view`)
- **Args**: `stockTransfers(status?: StockTransferStatus, locationId?: ID (leaving or arriving there), variantId?: ID, first: Int = 50 (1–100), after?: ID)`; `stockTransfer(id: ID!)`; `stockInTransit(variantIds?: [ID!])`
- **Response**: `StockTransferPage! { nodes, totalCount, hasNextPage }` newest first; `StockTransfer!` (`NOT_FOUND` when unknown); `[VariantInTransit!]! { variantId, quantity }`, the units on dispatched transfers per variant (variants with none in transit are left out).

---

#### Low-stock digest (staff email)

No API operation (P4-B.2). When a stock change takes a variant's available stock at a location from above its `lowStockThreshold` (default 5) to at or below it, the event `inventory.low_stock.v1` is recorded once per crossing and stored as a **pending low-stock alert**, at most one per variant and location until a digest lists it. Every 3 hours (06:00, 09:00, 12:00, 15:00, 18:00 and 21:00 UTC) the worker sends **one email to each active staff member holding `inventory.alerts`** (Owner, Manager and Inventory clerk by default), with a section per location listing the variants still at or below their level and their available stock. Variants that recovered above their level before the digest (restocked, order cancelled) are left out; nothing is sent when nothing is pending. To stop a staff member receiving it, give them a role without `inventory.alerts`.

---

#### Stock-takes

A **stock-take** (P4-B.1) is a count session at one stock location. Counters (`inventory.adjust`) open it, enter what they find on the shelf and submit it; an approver (`inventory.stocktake.approve`, Owner and Manager) reviews the variances and approves them into stock, or cancels.

- **Status** (`StockTakeStatus`): `OPEN` (counting) → `SUBMITTED` (counts closed) → `APPROVED` (variances posted); `OPEN` or `SUBMITTED` → `CANCELLED` (no stock moves). Anything else is `CONFLICT`. At most one `OPEN` or `SUBMITTED` stock-take per location.
- **Scope**: a category's variants (`categoryId`), a list of variants (`variantIds`, up to 500) or, with neither, every variant. A category or full count covers active variants plus archived ones that still have stock at the location.
- **Blind counts**: counters see SKUs, product names and their own counts; the expected quantities and variances (`StockTakeLine.expectedAtOpen`, `expectedQuantity`, `variance`, and `stockTakeVarianceReport`) need `inventory.stocktake.approve` (`FORBIDDEN` otherwise).
- **Expected quantity** = units that should be on the shelf: on hand at the location **plus units already sold but not yet dispatched** (paid online orders whose shipment is still `PENDING`, `PICKING` or `PACKED`; goods at the pickup counter or out for delivery count as gone). `expectedAtOpen` is read when the session opens; `expectedQuantity` is read again **when each line is counted**, so sales, receipts and adjustments that happen between opening and counting are not variances. Counting a line again replaces the count and re-reads its expected quantity.
- **Variance** = `countedQuantity - expectedQuantity` (negative = shortage). Approval posts each non-zero variance as **one `ADJUSTMENT` stock movement with `adjustmentReason: STOCK_TAKE`** (`refType: "StockTake"`, `refId`: the stock-take id), all in one transaction. Variances are deltas, so stock that moves after a line was counted is kept. Uncounted lines are left as they are. A second approval gets `CONFLICT` and posts nothing.
- A shortage that would take on-hand stock below the units reserved for open orders refuses the whole approval: `CONFLICT` + `reason: STOCK_TAKE_BELOW_RESERVED` (recount, or cancel the stock-take); nothing is posted and the session stays `SUBMITTED`.
- **Serial-tracked variants (P4-D.1)** are counted like any other, but a stock-take cannot say which units are missing or new: any variance on one refuses the whole approval with `CONFLICT` + `reason: STOCK_TAKE_SERIAL_VARIANCE` + `extensions.variantIds`. Cancel the stock-take, adjust those variants naming the serials (`adjustVariantStock`), and count again. An exact count approves normally.
- Every open, count batch, submit, approve (with the posted movement ids) and cancel writes an audit entry (entity `StockTake`).

```typescript
StockTake {
  id: string; locationId: string; status: StockTakeStatus;
  categoryId?: string; note?: string;
  openedById: string; openedAt: DateTime;
  submittedById?: string; submittedAt?: DateTime;
  approvedById?: string; approvedAt?: DateTime;
  cancelledById?: string; cancelledAt?: DateTime; cancelReason?: string;
  lineCount: number;      // variants in the session
  countedCount: number;   // variants counted so far
}
StockTakeLine {
  id: string; stockTakeId: string; variantId: string; sku: string; productName: string;
  countedQuantity?: number; countedById?: string; countedAt?: DateTime;
  expectedAtOpen: number;     // inventory.stocktake.approve only
  expectedQuantity?: number;  // inventory.stocktake.approve only; null until counted
  variance?: number;          // inventory.stocktake.approve only; null until counted
  movementId?: string;        // the STOCK_TAKE movement posted on approval
}
```

- `openStockTake(input: { locationId?, categoryId?, variantIds?: [ID!], note? })` → `StockTake!` (`inventory.adjust`). `locationId` defaults to the store's default location. Errors: `BAD_REQUEST` (both `categoryId` and `variantIds`; "There are no variants to count in this scope"), `NOT_FOUND` (location, category, variants), `CONFLICT` + `reason: STOCK_TAKE_ALREADY_OPEN`.
- `recordStockTakeCounts(input: { stockTakeId, counts: [{ variantId, countedQuantity }] })` → `[StockTakeLine!]!` (`inventory.adjust`; 1-200 counts per call, `countedQuantity` 0-1,000,000). Errors: `NOT_FOUND`, `CONFLICT` (not `OPEN`), `BAD_REQUEST` (a variant twice, or not in the stock-take).
- `submitStockTake(id)` → `StockTake!` (`inventory.adjust`). `BAD_REQUEST` when nothing was counted; `CONFLICT` when not `OPEN`.
- `approveStockTake(id)` → `StockTake!` (`inventory.stocktake.approve`). `CONFLICT` when not `SUBMITTED`, `STOCK_TAKE_BELOW_RESERVED` or `STOCK_TAKE_SERIAL_VARIANCE`.
- `cancelStockTake(id, reason?: String)` → `StockTake!` (`inventory.stocktake.approve`; reason up to 500 characters). `CONFLICT` once approved or cancelled.
- `stockTakes(status?, locationId?, first = 20 (1-200), after?)` → `StockTakePage! { nodes, totalCount, hasNextPage }`, newest first (`inventory.view`).
- `stockTake(id)` → `StockTake!` (`inventory.view`).
- `stockTakeLines(stockTakeId, counted?: Boolean, first = 50 (1-200), after?)` → `StockTakeLinePage!`, in SKU order (`inventory.view`; `counted: false` lists what is left to count).
- `stockTakeVarianceReport(id)` → `StockTakeVarianceReport! { stockTake, lines, totals }` (`inventory.stocktake.approve`): each counted line with `expectedAtOpen`, `changeSinceOpen` (how the expected quantity moved before the count), `expectedQuantity`, `countedQuantity`, `variance`, `unitPrice` and `varianceValue` (`Money`, at the variant's **current price**; null without a price), and since P4-E.1 `unitCost` (`Decimal`, the weighted-average cost) and `varianceCostValue` (`Money`; null when the cost is unknown); `totals`: `lineCount`, `countedCount`, `uncountedCount`, `linesWithVariance`, `shortageUnits`, `surplusUnits`, `netVarianceUnits`, `shortageValue`, `surplusValue`, `netVarianceValue`, and at cost `shortageCostValue`, `surplusCostValue`, `netVarianceCostValue` (lines of unknown cost add nothing). Every cost field needs `inventory.cost.view` as well; without it each one is `null` in `data` plus its own `FORBIDDEN` entry in `errors`.

#### Lots and expiry (P4-C.1)

Opt-in per product with `Product.trackLots` (default `false`; set on `createProduct` / `updateProduct`, permission `product.manage`). An untracked product behaves exactly as before: no lots, `lotId` null.

- **Lots.** A `Lot` belongs to one variant: `lotNumber` (unique per variant), `expiresAt`, optional `manufacturedAt`. Its units are held per location; for a tracked variant the lots at a location always add up to that location's on-hand stock. Every on-hand change of a tracked variant records its lot (`StockMovement.lotId`), one movement per lot touched.
- **Receiving** (`restockVariant` with `lot`, `adjustVariantStock` adding with `lot`): lot number plus expiry, in the future. `createProduct` / `createVariant` refuse opening stock (`quantity` > 0) for a tracked product (`BAD_REQUEST`): receive it with `restockVariant`.
- **First expiry, first out.** Units leaving a location are drawn from the unexpired lots with the earliest expiry (ties: the oldest lot): sales (online payment captured, cash-on-delivery dispatch), transfer dispatch, removals without a lot and stock-take shortages. Reservations stay per variant and location; lots are drawn when the sale is consumed. A paid order cancelled before dispatch puts its units back into the lots it drew from.
- **Expired lots are not sold.** From `expiresAt` on, a lot's units are left out of `Variant.available`, `Product.totalStock`/`inStock`, the cart and checkout checks and placement (`createOrder` refuses them like any missing stock). An hourly job writes them off: one `ADJUSTMENT` with `adjustmentReason: EXPIRED`, `refType: "Lot"`, `refId`: the lot id, per lot. Units held for open orders are not written off: the reservation is kept and, if no unexpired units are left when the sale is consumed, the expired lot supplies it (a warning is logged with ids). The `products(inStock: ...)` filter leaves them out too (P6-S.1).
- **Transfers** ship unexpired lots only (`dispatchStockTransfer` refuses with `only N available at the source` otherwise, also keeping what the source's reservations need) and the same lots arrive at the destination; a shortfall falls on the lots that expire last.
- **Stock-takes** count per variant: a shortage is drawn first expiry first, a surplus goes into the variant's latest-expiring lot; a tracked variant that never had a lot refuses the approval with `CONFLICT` + `reason: STOCK_TAKE_NO_LOT`.
- **Switching tracking** (`updateProduct` with `trackLots`) is allowed only while the product holds no stock: nothing on hand, in transit or sold awaiting dispatch (`BAD_REQUEST` naming the counts). To start tracking a stocked product, adjust its stock out (`CORRECTION`) and receive it again with lot numbers.

```typescript
LotInput {
  lotNumber: string;       // Required, max 100 characters
  expiresAt?: DateTime;    // Required on a receipt and to create a lot; must match an existing lot
  manufacturedAt?: DateTime; // Not in the future, before expiresAt
}
Lot {
  id: string; variantId: string; lotNumber: string;
  expiresAt: DateTime; manufacturedAt?: DateTime; createdAt: DateTime;
  expired: boolean;
  onHand: number;                                   // over every location
  stock: { locationId: string; locationName: string; onHand: number }[]; // locations holding some
}
ExpiringStockLine {
  lotId: string; lotNumber: string; expiresAt: DateTime; manufacturedAt?: DateTime;
  expired: boolean;                // expired, not yet written off
  variantId: string; sku: string; productId: string; productName: string;
  locations: { locationId: string; locationName: string; onHand: number }[]; // by location name
  onHand: number;
  unitPrice?: Money;               // the variant's current selling price
  value?: Money;                   // onHand x unitPrice
  unitCost?: Decimal;              // P4-E.1, inventory.cost.view (others: null plus a FORBIDDEN error): the variant's weighted-average cost; null when unknown
  costValue?: Money;               // P4-E.1, inventory.cost.view (others: null plus a FORBIDDEN error): onHand x unitCost; null when the cost is unknown
}
```

- `expiringStock(withinDays: Int = 30 (1-365), locationId?: ID, categoryId?: ID)` → `[ExpiringStockLine!]!` (`inventory.view`): lots with units on hand expiring within the window (expired ones included), soonest first. `BAD_USER_INPUT` outside 1-365.
- `variantLots(variantId: ID!)` → `[Lot!]!` (`inventory.view`): every lot of the variant, soonest expiry first.

API changes (P4-C.1, additive): `LotInput`, `Lot`, `LotLocationStock`, `ExpiringStockLine`, `RestockVariantInput.lot`, `AdjustVariantStockInput.lot`, `StockMovement.lotId` / `lot`, queries `expiringStock` and `variantLots`. `Product.trackLots` existed and is now enforced.

---

#### Serial units (P4-D.1)

A product with `trackSerials: true` (see [2.26](#226-product-types-and-attributes)) has **one `SerialUnit` per physical unit** of each variant, identified by its serial (e.g. an IMEI). Products without it behave exactly as before and refuse `serials` everywhere (`BAD_REQUEST`).

- **Format** (`Product.serialFormat`): `FREE_TEXT` (default: 1-64 letters, digits and `- _ . /`) or `IMEI` (15 digits with a valid Luhn check digit). Serials are stored normalised: spaces removed and upper case; an IMEI also loses its dashes. Unique per variant. Malformed serials → `BAD_REQUEST`.
- **Every stock change of a tracked variant names its units**, one serial per unit (`BAD_REQUEST` + `reason: SERIALS_REQUIRED` otherwise): `restockVariant` (new serials; a return restock names units sold on that order), `adjustVariantStock` (removal: units in stock there; addition: new or written-off serials), `dispatchStockTransfer` / `receiveStockTransfer`. A unit in the wrong status or place (or taken by a concurrent request) → `CONFLICT` + `reason: SERIAL_NOT_AVAILABLE` + `extensions.serials`; nothing is changed.
- **Status** (`SerialUnitStatus`): `IN_STOCK` (on the shelf at `locationId`) → `ASSIGNED` (picked for an order line, still on the shelf) → `SOLD` (dispatched); `ASSIGNED → IN_STOCK` (unassigned, or the order cancelled); `SOLD → IN_STOCK` (return restocked, or the order cancelled after its shipment came back); `IN_STOCK → IN_TRANSIT → IN_STOCK` (transfer) or `WRITTEN_OFF` (missing on arrival); `IN_STOCK → WRITTEN_OFF` (negative adjustment) `→ IN_STOCK` (found).
- **Assignment at pick** (per shipment line since P5-B.1): while a shipment is `PICKING` or `PACKED`, staff assign the units they picked to each of its serialised lines (`Shipment.items[].id`) with `assignShipmentItemSerials` (and take them off with `unassignShipmentItemSerials`); an order line split across two shipments gets each part's units named on its own shipment. Each unit must be `IN_STOCK` at the order's stock location. **Dispatch** of a shipment (`updateShipmentStatus` to `OUT_FOR_DELIVERY` / `READY_FOR_PICKUP`) is refused with `BAD_REQUEST` + `reason: SERIALS_NOT_ASSIGNED` + `extensions.lines: [{ shipmentItemId, orderItemId, quantity, assigned }]` until every serialised line of that shipment has exactly its quantity assigned; the units then become `SOLD`. Online orders still consume stock at payment; their units stay on the shelf until dispatch. Cancelling an order or a shipment frees its assigned units.
- **Warranty** starts at the delivery of the unit's shipment (`DELIVERED` via `updateShipmentStatus`, or `recordCodPayment` for cash on delivery) and ends `Product.warrantyMonths` calendar months later (on the last day of a shorter month); no warranty when it is null.
- **Tracking flag**: `trackSerials` can be turned on only while the product has nothing on hand, in transit or on an open order (adjust it to zero first); turned off only while none of its units is `IN_STOCK`, `ASSIGNED` or `IN_TRANSIT` (`BAD_REQUEST` otherwise). A tracked product's variants take no opening stock (`createProduct`, `createVariant`: `BAD_REQUEST`).
- **Reconciliation**: the nightly stock reconciliation also checks, per tracked variant and location, that `IN_STOCK` + `ASSIGNED` units = on hand + units sold online and not yet dispatched (metric `stock_reconciliation_mismatches{kind="SERIAL_UNITS"}`); it only reports.

```typescript
SerialUnit {
  id: string; variantId: string;
  serial: string;                 // stored form
  status: SerialUnitStatus;
  locationId?: string;            // while IN_STOCK or ASSIGNED
  orderItemId?: string;           // while ASSIGNED or SOLD
  receivedAt: DateTime; soldAt?: DateTime;
  warrantyStartsAt?: DateTime; warrantyEndsAt?: DateTime;
}
SerialUnitLookup { unit: SerialUnit; sku: string; productName: string; orderId?: string; orderNumber?: number; customerId?: string }
OrderItemSerial { serial: string; status: SerialUnitStatus; soldAt?: DateTime; warrantyStartsAt?: DateTime; warrantyEndsAt?: DateTime }
```

- `assignShipmentItemSerials(input: { shipmentItemId: ID!, serials: [String!]! (1-1000) })` → `Order!` (`order.fulfil`). Errors: `NOT_FOUND` (shipment line or order), `CONFLICT` (order not `CONFIRMED`/`IN_FULFILMENT`, shipment not `PICKING`/`PACKED`, `SERIAL_NOT_AVAILABLE`), `BAD_REQUEST` (product not serial-tracked, more units than the shipment line's quantity, malformed serial). Audited (entity `OrderItem`, action `UPDATE`, `details.change: SERIALS_ASSIGNED`).
- `unassignShipmentItemSerials(input: { shipmentItemId: ID!, serials: [String!]! })` → `Order!` (`order.fulfil`). Same rules; each serial must be assigned to that shipment line (`CONFLICT` + `SERIAL_NOT_AVAILABLE`). Audited (`SERIALS_UNASSIGNED`).
- `serialUnitLookup(serial: String!)` → `[SerialUnitLookup!]!` (`order.view`): units with that serial on any variant (as typed: spaces and, for an IMEI, dashes ignored), with order, customer id, sale date and warranty window. Empty when unknown.
- `OrderItem.serials: [OrderItemSerial!]!`: the units assigned to (`ASSIGNED`) or sold on (`SOLD`) the line, with their warranty. Customers see it on their own orders (`order`, `userOrders`); staff on every order.

---

#### Purchasing: suppliers, purchase orders and cost (P4-E.1)

Staff buy stock from **suppliers** on **purchase orders**; each delivery received adds the units at the order's stock location and updates the variant's **weighted-average cost**. All of it is additive (no existing operation changed). Not in this release: emailing or printing purchase orders, approvals, other currencies, landed costs (freight, duty), supplier invoices and reorder suggestions.

**Permissions**: reads `purchasing.view` (Owner, Manager, Inventory clerk); suppliers and purchase-order changes `purchasing.manage` (Owner, Manager); receiving `purchasing.receive` (Owner, Manager, Inventory clerk). **Costs are hidden** without `inventory.cost.view` (Owner, Manager): every cost field below is nullable and, for anyone else, resolves to `null` in `data` **and** adds one `FORBIDDEN` entry to `errors` for each cost field selected (one per field per object, so a list of 20 lines with `unitCost` gives 20 errors); the rest of the response still resolves. An Inventory clerk should simply not select them. No step-up: costs never change a selling price.

- **Suppliers.** `name` is unique ignoring case and spacing (`CONFLICT`). They are paid in the store currency (`currency` defaults to it; any other is `BAD_REQUEST`). A supplier a purchase order refers to cannot be deleted (`CONFLICT`): deactivate it (`updateSupplier` with `isActive: false`); an inactive supplier takes no new orders (`BAD_REQUEST`).
- **Status** (`PurchaseOrderStatus`): `DRAFT` → `SENT` | `CANCELLED`; `SENT` → `PARTIALLY_RECEIVED` | `RECEIVED` (by receipts) | `CANCELLED` (nothing has arrived); `PARTIALLY_RECEIVED` → `PARTIALLY_RECEIVED` | `RECEIVED` (more receipts) | `CLOSED` (closed short: the rest will not come). `RECEIVED`, `CLOSED`, `CANCELLED` are final. Anything else is `CONFLICT`; of two concurrent changes one wins and the other gets `CONFLICT`. There is no approval step.
- **Editing.** Supplier, location and lines change only in `DRAFT` (`CONFLICT` after); the expected date and note until the order is final. `sendPurchaseOrder` only records `sentAt` (nothing is emailed yet).
- **Unit costs** are tax-exclusive, in the store currency, `Decimal` with up to 4 decimal places, `>= 0` (`BAD_USER_INPUT` otherwise).
- **Receiving.** `receivePurchaseOrder` names, per line, the units in this delivery: at least 1 and **at most what is outstanding** (no over-receipt: `BAD_REQUEST`). One `PurchaseOrderReceipt` per call. The units are added at the order's location as `RECEIPT` stock movements with `refType: "PurchaseOrder"`, `refId`: the order id, and their `unitCost`. Lot-tracked variants need `lot` (number + expiry in the future; an existing lot number adds to it), serial-tracked variants exactly one new serial per unit (`BAD_REQUEST` + `reason: SERIALS_REQUIRED`; a known serial is `CONFLICT` + `reason: SERIAL_ALREADY_KNOWN`); others refuse both (`BAD_REQUEST`). The order becomes `RECEIVED` when every line is complete, otherwise `PARTIALLY_RECEIVED`. The destination must still be active (`BAD_REQUEST`).
- **Weighted-average cost** (`Variant.costPrice`, store-wide over every location): on each receipt line, new = (units on hand before × old cost + units received × unit cost) / (on hand before + received), rounded half-up to 4 dp; when the cost was unknown (null) or nothing was on hand, the unit cost alone. Other ways stock comes in (manual restock, returns, transfers, found adjustments) do not change it. Every change is a `CostChange` (append-only history). `setVariantCost` sets or corrects the cost by hand, with a reason (also after purchase orders costed the variant; later receipts average from the new cost). Cost never affects selling prices or checkout.
- **Audit**: entity `Supplier` (`CREATE`/`UPDATE`/`DELETE`), `PurchaseOrder` (`CREATE`, `UPDATE` with before/after, `STATUS_CHANGE` with from/to; a receipt's entry also lists its lines with unit cost, lot number and serial count), `Variant` `UPDATE` for a manual cost.

```typescript
Supplier { id; name; contactName?; phone?; email?; address?; notes?; currency: Currency; isActive: boolean; createdAt; updatedAt }
PurchaseOrder {
  id; number: number; reference: string;          // "PO-00042", unique
  supplierId; supplier: Supplier; locationId; status: PurchaseOrderStatus; currency: Currency;
  expectedAt?: DateTime; note?: string;
  lines: PurchaseOrderLine[]; receipts: PurchaseOrderReceipt[];   // receipts oldest first
  totalCost?: Money; receivedCost?: Money;        // inventory.cost.view
  createdById; sentById?; sentAt?; closedById?; closedAt?; closeReason?; cancelledById?; cancelledAt?; cancelReason?;
  createdAt; updatedAt;
}
PurchaseOrderLine { id; variantId; quantityOrdered; quantityReceived; quantityOutstanding; unitCost?: Decimal; lineCost?: Money }
PurchaseOrderReceipt { id; receivedById; receivedAt; note?; lines: PurchaseOrderReceiptLine[]; cost?: Money }
PurchaseOrderReceiptLine { id; lineId; variantId; quantity; unitCost?: Decimal; cost?: Money; lotId?: string; movementId: string }
CostChange { id; variantId; oldValue?: Decimal; newValue: Decimal; currency; source: PURCHASE_ORDER | MANUAL; refType?; refId?; reason?; actorId?; createdAt }
// New fields on existing types, each inventory.cost.view: Variant.costPrice?: Decimal; StockMovement.unitCost?: Decimal
```

- `suppliers(isActive?: Boolean, search?: String (name, contact, email or phone), first: Int = 50 (1-100), after?: ID)` → `SupplierPage! { nodes, totalCount, hasNextPage }` by name; `supplier(id: ID!)` → `Supplier!`.
- `createSupplier(input: { name!, contactName?, phone?, email?, address?, notes?, currency?, isActive? })`, `updateSupplier(id, input)` (same fields, all optional; `null` clears an optional one), `deleteSupplier(id)` → `Supplier!`.
- `purchaseOrders(status?, supplierId?, locationId?, variantId?, createdFrom?: DateTime, createdTo?: DateTime ([from, to)), first = 50, after?)` → `PurchaseOrderPage!` newest first; `purchaseOrder(id)` → `PurchaseOrder!`.
- `createPurchaseOrder(input: { supplierId!, locationId!, expectedAt?, note?, lines: [{ variantId!, quantity!: Int >= 1, unitCost!: Decimal }] (1-100, one per variant) })` → `PurchaseOrder!` (`DRAFT`). `NOT_FOUND` for an unknown supplier, location or variant; `BAD_REQUEST` for an inactive supplier or location or a variant twice.
- `updatePurchaseOrder(id, input: { supplierId?, locationId?, expectedAt?, note?, lines? })` → `PurchaseOrder!` (lines given replace them all).
- `sendPurchaseOrder(id)`, `cancelPurchaseOrder(id, input?: { reason? })`, `closePurchaseOrder(id, input: { reason! })` → `PurchaseOrder!`.
- `receivePurchaseOrder(id, input: { lines: [{ variantId!, quantity!, lot?: LotInput, serials?: [String!] }] (1-100), note? })` → `PurchaseOrder!`.
- `variantCostHistory(variantId: ID!, first = 50, after?)` → `CostChangePage!` newest first (`inventory.cost.view`).
- `setVariantCost(input: { variantId!, cost!: Decimal (<= 4 dp), reason!: String })` → `CostChange!` (`purchasing.manage` + `inventory.cost.view`).

---

### 2.16 Returns

---

> **Breaking changes (P6-R.1, item-level returns):** `createReturnRequest` → `requestReturn` (lines with quantities and reasons instead of one free-text reason); `myReturnRequests` → `myReturns` (paginated `CustomerReturnPage`); `returnRequests` → `returns` (paginated `ReturnRequestPage`, filters) plus `returnRequest(id)`; `processRefund(returnRequestId)` → `refundReturn(input)`; `approveReturn` no longer takes `refundAmount`/`adminNote` (input `ReturnStepInput { returnRequestId, staffNote? }`, permission `return.manage` only, no step-up); `rejectReturn` takes a customer-visible `reason` and an optional `staffNote` (was `adminNote`). Types: `ReturnRequestEntity` → `ReturnRequest` (staff) and `CustomerReturn` (customer); enum `ReturnStatusEnum` → `ReturnStatus` (`PENDING` renamed `REQUESTED`; new `RECEIVED`, `INSPECTED`, `EXCHANGED`, `CANCELLED`). Cancelling a paid online order no longer opens a return request: it records a `PENDING` refund (reason `ORDER_CANCELLED`) that staff send with `processPendingRefund`. `restockVariant` with `returnRequestId` is refused for item-level returns (their units are restocked by `inspectReturn`); it still works for legacy requests.

**How a return works:** the customer returns some **delivered** units of an order's lines (`requestReturn`), each line with a quantity, a `ReturnReason` and optional photos; for an exchange (`resolution: EXCHANGE`) each line names the variant wanted. Staff approve or reject it, record the goods arriving (`receiveReturn`, per line how many came; a short receipt is final), inspect them (`inspectReturn`: per line how many go back into stock and how many are written off) and settle with `refundReturn` (money back for the units received) or `exchangeReturn` (a replacement order at no charge). Every step is a conditional transition with a history event (`ReturnRequest.events`); staff steps are audited.

```
REQUESTED ─approve→ APPROVED ─receive→ RECEIVED ─inspect→ INSPECTED ─refundReturn→ REFUND_PENDING → REFUNDED
    │                  │                                       │       (cash on delivery: REFUNDED at once)
    ├─reject→ REJECTED ←┤ (goods never arrived)                └─exchangeReturn→ EXCHANGED
    └─cancelReturn→ CANCELLED ←┘ (customer, before RECEIVED)
```

**Return window and policy:** units can be returned within `StoreSettings.returnWindowDays` (default 14) days of the delivery of the shipment that carried them (a pickup: when collected), unless their product type sets `returnWindowDays`; a product type with `returnable: false` (perishables, hygiene, digital goods) is never returned (set with `setProductTypeReturnPolicy`). Staff with `return.override` can accept a return outside the window or of a non-returnable type with `acceptReturnOutsidePolicy`.

**Units:** a line's units under returns (not rejected or cancelled; once received, the units that arrived) plus its units refunded outside returns never exceed its delivered units; concurrent requests are serialised (order row lock, plus a database trigger).

#### `POST /returns/orders/:orderId/photos` (customer, REST)
- Multipart field `file`: a JPEG, PNG or WebP of at most 5 MB, for the caller's own order (else `404`). Returns `{ publicId, url }`; put `publicId` in a line's `photoPublicIds` (at most 3 per line; only photos uploaded for that order are accepted). Throttled to 10 uploads a minute.

#### `requestReturn` (customer)
- **Type**: Mutation · **Auth**: signed-in customer (`@CustomerOnly`: staff accounts get `FORBIDDEN`)
- **Args**: `input: RequestReturnInput!` · **Response**: `CustomerReturn!`

```typescript
interface RequestReturnInput {
  orderId: string;                       // your own order (else NOT_FOUND)
  resolution?: 'REFUND' | 'EXCHANGE';    // default REFUND
  lines: {                               // 1-50 lines, each order line once
    orderItemId: string;
    quantity: number;                    // >= 1, at most the units delivered and not yet refunded or returned
    reason: ReturnReason;                // DAMAGED | DEFECTIVE | WRONG_ITEM | NOT_AS_DESCRIBED | CHANGED_MIND | SIZE_FIT | OTHER
    note?: string;                       // required for OTHER, max 1000
    photoPublicIds?: string[];           // from the photo upload, at most 3
    exchangeVariantId?: string;          // EXCHANGE only (required then): a variant of the same product at the line's unit price
  }[];
}
```

**Errors**: `BAD_REQUEST` with `extensions.reason`: `NOT_RETURNABLE` (product type not returnable), `OUTSIDE_RETURN_WINDOW`, `NOT_DELIVERED` (nothing of that line delivered yet), `EXCHANGE_NOT_ALLOWED` (another product, another price, or not on sale); `BAD_REQUEST` for a malformed request (duplicate line, OTHER without note, foreign photo, exchange variant missing or given on a refund); `CONFLICT` + `reason: RETURN_QUANTITY_EXCEEDED` (more units than are left).

```typescript
interface CustomerReturn {             // no staff notes, override reason, history actors or dispositions
  id: string; orderId: string;
  status: ReturnStatus; resolution: ReturnResolution;
  rejectionReason: string | null;      // why staff refused it
  replacementOrderId: string | null;   // the replacement order of an exchange
  lines: ReturnLine[];
  createdAt: string; updatedAt: string;
}
interface ReturnLine {
  id: string; orderItemId: string; productName: string; sku: string | null;
  quantity: number; reason: ReturnReason; note: string | null;
  photoUrls: string[]; exchangeVariantId: string | null;
  receivedQuantity: number | null;     // null until received
}
```

#### `cancelReturn` (customer)
- **Args**: `returnRequestId: ID!` · **Response**: `CustomerReturn!`
- Withdraws your own return while `REQUESTED` or `APPROVED` (else `CONFLICT`; another customer's: `NOT_FOUND`). Its units become returnable again.

#### `myReturns` (customer)
- **Type**: Query · **Args**: `first: Int = 20` (1-100), `after: ID` (last id of the previous page) · **Response**: `CustomerReturnPage { nodes: [CustomerReturn!]!, totalCount: Int!, hasNextPage: Boolean! }`, newest first.

#### `returns` / `returnRequest` (`return.manage`)
- `returns(status?, orderId?, createdFrom?, createdTo?, first = 20, after?)`: `ReturnRequestPage`, newest first. `returnRequest(id: ID!)`: one `ReturnRequest`.

```typescript
interface ReturnRequest {
  id: string; orderId: string; userId: string;
  status: ReturnStatus; resolution: ReturnResolution;
  legacy: boolean;                     // a whole-order request from before P6-R.1: no lines, free-text `reason`
  reason: string | null;               // legacy only
  refundAmount: Money | null;          // legacy only: the amount approved
  staffNote: string | null;            // internal, latest
  rejectionReason: string | null;
  policyOverrideReason: string | null; // set by acceptReturnOutsidePolicy
  createdById: string | null;          // staff member who created it
  replacementOrderId: string | null;
  lines: StaffReturnLine[];            // ReturnLine + photoPublicIds, restockQuantity, writeOffQuantity
  events: { id: string; from: ReturnStatus | null; to: ReturnStatus; actorId: string | null; note: string | null; createdAt: string }[];
  refund: RefundEntity | null;         // once recorded
  createdAt: string; updatedAt: string;
}
```

#### `acceptReturnOutsidePolicy` (`return.manage` + `return.override`)
- **Args**: `input: AcceptReturnOutsidePolicyInput!` = `RequestReturnInput` + `overrideReason: String!` + `staffNote?` · **Response**: `ReturnRequest!`
- Creates an `APPROVED` return for the order's customer, skipping the window and the product type's returnable flag (never the delivered-units cap). Audited (`CREATE` with the reason).

#### `approveReturn` / `rejectReturn` (`return.manage`)
- `approveReturn(input: { returnRequestId, staffNote? })`: `REQUESTED → APPROVED`. A legacy request cannot be approved (`BAD_REQUEST`: reject it, or refund with `refundOrder`).
- `rejectReturn(input: { returnRequestId, reason, staffNote? })`: `REQUESTED` or `APPROVED` (goods never arrived) → `REJECTED`; `reason` is shown to the customer.
- Two staff acting at once: one wins, the other gets `CONFLICT`. Wrong status: `CONFLICT`.

#### `receiveReturn` (`return.manage`)
- `input: { returnRequestId, lines: [{ returnLineId, receivedQuantity }], staffNote? }`: `APPROVED → RECEIVED`. List every line once with 0 to its quantity; at least one unit must have arrived (else reject the return). Units that never arrived are not refunded and become returnable again.

#### `inspectReturn` (`return.manage` + `inventory.adjust`)
- `input: { returnRequestId, lines: [{ returnLineId, restockQuantity, writeOffQuantity, lot?, serials? }], staffNote? }`: `RECEIVED → INSPECTED`. Every line with units received, once; `restockQuantity + writeOffQuantity = receivedQuantity`.
- Restocked units go back into sellable stock at the location the order was fulfilled from (`RETURN_RESTOCK` movement referring to the return): a lot-tracked variant into the existing lot named in `lot` or, by default, the lots the order's sale drew from; a serial-tracked variant needs one serial per restocked unit, each a unit sold on this order (`CONFLICT` + `SERIAL_NOT_AVAILABLE` otherwise). Written-off units add no stock (they left stock when sold).

#### `refundReturn` (`order.refund` + step-up)
- `input: { returnRequestId, refundShipping = false, staffNote? }` · **Response**: `ReturnRequest!`
- An `INSPECTED` return is refunded for the units received, at what the order stored for them (never re-priced), plus the delivery fee only with `refundShipping` (once per order). Online payments: a `Refund` (`RETURN`, one line per returned order line) is recorded (`REFUND_PENDING`) and sent through Paystack at once (`PROCESSED` → `REFUNDED`); refused → `BAD_REQUEST`, the refund `FAILED` and the return `REFUND_PENDING`: call `refundReturn` again to resend. Outcome unknown → the refund stays `SENDING` (`CONFLICT` on retries; check Paystack). Cash on delivery: recorded as cash handed back, `REFUNDED` at once. Caps (payment, line units, delivery fee) and disputes (`CONFLICT` + `PAYMENT_DISPUTED`) as for `refundOrder`. A return has at most one refund, so repeats never refund twice. Not yet inspected: `CONFLICT`. A return asking for an exchange can be refunded instead.
- **Legacy** requests (no lines): an `APPROVED` one with its `refundAmount` refunds that amount through Paystack (`APPROVED → REFUND_PENDING → REFUNDED`), as `processRefund` did.

#### `exchangeReturn` (`return.manage`)
- `input: { returnRequestId, staffNote? }`: an `INSPECTED` return with `resolution: EXCHANGE` → `EXCHANGED`. Creates a replacement order (`replacementOrderId`) for the customer: one line per returned line with the wanted variant and the units received, priced 0, total 0, same address or pickup point, `CONFIRMED` at once (paid by the returned units; the customer gets the order confirmation email). Its stock is reserved and taken as sold at the first location serving the original order's zone or pickup point that holds every unit; then it is fulfilled like any order (`createShipment`...).
- `BAD_REQUEST` + `reason`: `EXCHANGE_NOT_ALLOWED` (no longer the same price or not on sale), `EXCHANGE_OUT_OF_STOCK`: refund instead with `refundReturn`. A refund return: `BAD_REQUEST`.

**Customer messages:** `APPROVED`, `REJECTED`, `RECEIVED` and `EXCHANGED` record a `return.status_changed.v1` event (the email follows with the notification templates; today the worker logs it). A refund emails the customer as every refund does.

---

#### `processPendingRefund` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `refundId: ID!`
- **Response**: `RefundEntity`
- **Description**: Sends a `PENDING` refund through Paystack, or resends a `FAILED` one. Used for auto-refunds that payment verification queues when money arrives for a cancelled, already-paid or wrong-amount payment (these are never sent automatically). A refund linked to a return request also completes that request. Same cap, claim and error rules as `processRefund`: a second call gets `CONFLICT`.
- **Disputes (P3-E.2):** every refund (`refundOrder`, `refundReturn`, `processPendingRefund`) is refused with `CONFLICT` and `extensions.reason: "PAYMENT_DISPUTED"` while the payment has an unresolved dispute (`OPEN`, `AWAITING_EVIDENCE`, `UNDER_REVIEW`): the bank may still return the money. A dispute resolved `LOST` or `ACCEPTED` counts as money already returned, so only what is left after it (and earlier refunds) can be refunded, else the same `CONFLICT`. Nothing is sent, and a new refund (`refundOrder`, `refundReturn`) is refused before anything is recorded: no `Refund` row, no audit entry, the return stays `INSPECTED`. An existing `PENDING` refund stays `PENDING`.

---

#### `refunds` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `status: RefundStatusEnum` (optional)
- **Response**: `[RefundEntity!]!`, newest first. Use `refunds(status: PENDING)` to find auto-refunds waiting to be sent.

```typescript
{
  id: string;
  attemptId: string;          // the payment the money is returned from
  returnRequestId?: string;   // set for refunds of return requests
  amount: Money;
  taxAmount?: Money;          // P1-O.1: tax included in amount, from the order's stored tax lines in proportion
                              // (amount x taxTotal / grandTotal, half-up, capped at the tax not yet refunded); null for
                              // orders placed before tax was recorded and for auto-refunds of charges that never paid the order.
                              // P3-C.1: refunded line units take their line's stored tax per unit instead (see refundOrder)
  currency: string;
  status: RefundStatusEnum;   // PENDING | SENDING | PROCESSED | FAILED
  reason: RefundReason;       // P3-C.1, see refundOrder; RETURN for return refunds, PAYMENT_NOT_ACCEPTED for auto-refunds
  note?: string;              // P3-C.1: internal staff note (never shown to the customer)
  method: RefundMethod;       // P3-C.1: PROVIDER (Paystack) | CASH (cash-on-delivery money handed back by staff)
  shippingAmount: Money;      // P3-C.1: the part of amount that returns the delivery fee ("0.00" if none)
  createdById?: string;       // P3-C.1: the staff member who issued it with refundOrder (null for return and auto-refunds)
  lines: RefundLine[];        // P3-C.1: the order line units it pays back (empty for amount-only refunds)
  providerRef?: string;       // Paystack refund id
  failureReason?: string;     // why the last send failed, or "Outcome unknown: ..."
  createdAt: DateTime;
  updatedAt: DateTime;
}

// RefundLine (P3-C.1)
{
  id: string;
  orderItemId: string;
  quantity: number;
  amount: Money;              // what these units were charged (see refundOrder)
}
```

---

#### `refundOrder` (permission `order.refund`, step-up) — P3-C.1
- **Type**: Mutation
- **Args**: `input: RefundOrderInput!`
- **Response**: `RefundEntity!`
- **Description**: Refunds a paid order outside the returns flow: chosen line units, the delivery fee and/or a free amount, in one request or several over time. **Money only:** nothing is restocked (returned goods go back with `restockVariant`). Needs `order.refund` and a recent step-up (`FORBIDDEN` + `reason: STEP_UP_REQUIRED`); audit-logged.

```typescript
// RefundOrderInput
{
  orderId: string;
  idempotencyKey: string;     // Required. 8-100 letters, digits, "-" or "_", chosen by the client per refund. Sending it
                              // again returns the refund it recorded (whatever its status) and refunds nothing more;
                              // the same key on another order: CONFLICT
  lines?: { orderItemId: string; quantity: number }[];   // quantity >= 1
  shipping?: boolean;         // also refund the delivery fee
  amount?: Decimal;           // a free amount (> 0) on top of the lines and the fee
  reason: RefundReason;       // CUSTOMER_REQUEST | DAMAGED | WRONG_ITEM | NOT_DELIVERED | PRICE_ADJUSTMENT | DUPLICATE_CHARGE | OTHER
  note?: string;              // internal, max 1000 characters; required for OTHER
}
```

- **Amounts come from what the order stored at placement, never re-priced:** a line unit refunds `lineTotal / quantity` plus its share of the order's cart discounts (`OrderItem` stores each line's share; the units of a line add up to exactly what the line was charged, the last unit taking the rounding remainder). The delivery fee refunds `shippingTotal` (after free-shipping promotions). `taxAmount` = each refunded unit's stored tax + the free amount × `taxTotal / grandTotal`, never above the tax not yet refunded; shipping is untaxed; null for `pricingVersion` 0 orders.
- **Caps (checked under a row lock, so two concurrent refunds cannot both pass):** all refunds of the payment (return refunds, auto-refunds and these; `FAILED` ones excluded) never exceed what it captured; a line's refunded units never exceed its quantity; the delivery fee is refunded at most once. Exceeding any of them: `CONFLICT` and nothing is written. Return requests have no lines, so they count towards the payment cap only.
- **Validation (`BAD_REQUEST`):** nothing to refund, an unknown or repeated line, a fee the order does not have, `OTHER` without a note, or `RETURN` / `PAYMENT_NOT_ACCEPTED` (set by the system only). The order must have a captured payment (not one flagged for review).
- **Online payments** are refunded through Paystack at once; the response is the refund `PROCESSED` (or the error rules of `processRefund`: refused → `BAD_REQUEST` and the refund `FAILED`, resend it with `processPendingRefund`; outcome unknown → it stays `SENDING`). Units of a `FAILED` refund are free to refund again.
- **Cash on delivery:** there is no provider to send through; the refund is recorded as cash handed back (`method: CASH`, `PROCESSED` at once).
- **Payment status:** each processed refund moves `Order.paymentStatus` to `PARTIALLY_REFUNDED`, or `REFUNDED` once the whole capture is back. The order status does not change.
- **Customer email:** every processed refund (also return refunds and auto-refunds) emails the customer the amount, the reason label and the refunded lines. Failures are not emailed.

**`RefundReason` Enum** (P3-C.1): `CUSTOMER_REQUEST`, `DAMAGED`, `WRONG_ITEM`, `NOT_DELIVERED`, `PRICE_ADJUSTMENT`, `DUPLICATE_CHARGE`, `OTHER` (staff choose these), `RETURN` (return refunds), `PAYMENT_NOT_ACCEPTED` (auto-refunds of charges that could not be accepted), `ORDER_CANCELLED` (P6-R.1: the `PENDING` refund recorded when a paid order is cancelled; send it with `processPendingRefund`). **`RefundMethod` Enum**: `PROVIDER`, `CASH`.

---

### 2.17 Reviews

> **Privacy:** `Review.user` is a `PublicProfile { displayName }` (first name + last initial, or "Customer"). A review exposes no user id, email, phone, address or order. Separately, `User.email`, `User.emailVerified`, `User.pendingEmail`, `User.phoneNumber`, `User.addresses`, `User.orders` and `Order.user` return a `FORBIDDEN` error unless the caller is that user or an ADMIN/SUPER_ADMIN.

**Rules (P6-V.1).** Only a customer who **received** the product can review it (a *verified purchase*): one of their order lines for the product has a unit in a `DELIVERED` shipment, or the order is `COMPLETED`, and not all of that line's units were refunded. Otherwise `createReview` fails with `FORBIDDEN` + `extensions.reason: "REVIEW_NOT_VERIFIED_PURCHASE"`. One review per customer and product (enforced by the database; a second one, even sent at the same moment, is `CONFLICT` + `reason: "REVIEW_ALREADY_EXISTS"`: edit the existing one). Reviews are **published at once**. Reviews written before this check show `verifiedPurchase: false`. Staff can hide a review (it leaves every public read and the rating; its author still sees it in `userReviews` with `status: HIDDEN`) and publish it again. Only active, `PUBLISHED` products have readable reviews (`NOT_FOUND` otherwise). Writing reviews and reports is rate-limited (10 a minute).

**Rating.** `Product.rating { average count distribution { stars count } }` covers the published reviews: `average` to 2 decimals (null without reviews), `distribution` 5 stars first. It is stored on the product and updated in the same transaction as every review create, edit, delete, hide and unhide.

**`Review` Object Type**:

```typescript
{
  id: string;
  score: number;             // 1–5
  title?: string;            // up to 120 characters
  comment?: string;          // up to 2000 characters
  productId: string;
  verifiedPurchase: boolean; // written by a customer who received the product
  status: ModerationStatus;  // PUBLISHED | HIDDEN (only the author and moderators ever see HIDDEN)
  hiddenReason?: string;     // staff with review.moderate only (FORBIDDEN for anyone else)
  reply?: { body: string; repliedAt: DateTime }; // the store's public reply
  photos: { id: string; url: string }[];         // at most 4
  editedAt?: DateTime;       // when the author last changed it
  user: PublicProfile;       // { displayName } only, e.g. "Kwame A." ("Customer" if no name)
  product: Product;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `productReviews` (public, optional sign-in)
- **Type**: Query
- **Args**: `productId: ID!`, `sort: ReviewSort = NEWEST` (`NEWEST`, `HIGHEST`, `LOWEST`; newest first within a score), `first: Int = 20` (1–50), `after: ID` (the last review id of the previous page)
- **Response**: `[Review!]!`: published reviews only. Fewer than `first` items means the last page; `Product.rating.count` is the total.

`Product.reviews(first: Int = 5)` (1–20) gives the latest published reviews for a product card or page.

---

#### `review` (public, optional sign-in)
- **Type**: Query
- **Args**: `reviewId: String!`
- **Response**: `Review!`: a published review of a public product; its author and moderators also get it when hidden. `NOT_FOUND` otherwise.

---

#### `userReviews`
- **Type**: Query (signed in)
- **Args**: `first: Int = 20` (1–50), `after: ID`
- **Response**: `[Review!]!`: the caller's own reviews in any status, newest first.

---

#### `createReview` (customers only)
- **Type**: Mutation
- **Args**: `input: CreateReviewInput!`
- **Response**: `Review!`

```typescript
{
  productId: string;  // Required.
  score: number;      // Required. Integer 1–5.
  title?: string;     // Optional, trimmed, up to 120 characters.
  comment?: string;   // Optional, trimmed, up to 2000 characters.
}
```

**Possible Errors**: `NOT_FOUND` (product not public), `FORBIDDEN` + `REVIEW_NOT_VERIFIED_PURCHASE`, `CONFLICT` + `REVIEW_ALREADY_EXISTS`, `BAD_USER_INPUT` (lengths, score).

---

#### `updateReview` (customers only)
- **Type**: Mutation
- **Args**: `input: UpdateReviewInput!` = `{ id: string; score?: number; title?: string | null; comment?: string | null }`
- **Response**: `Review!`
- **Description**: Omitted fields stay as they are; `title`/`comment` sent as `null` (or blank) are cleared. Sets `editedAt`. `NOT_FOUND` (review), `FORBIDDEN` ("You can only modify your own reviews").

---

#### `deleteReview` (customers only)
- **Type**: Mutation
- **Args**: `reviewId: String!`
- **Response**: `Review!`
- **Description**: Permanently deletes one of the caller's own reviews (with its photos); the customer may then write a new one. Same errors as `updateReview`.

---

#### Photos: `POST /reviews/:reviewId/photos` and `removeReviewPhoto` (customers only)
Upload one image per request as multipart field `file` (JPEG, PNG or WebP, checked by content, at most 5 MB) to the caller's own review: `201 { id, url }`. A review holds at most 4 photos (`400`, `reason: REVIEW_PHOTO_LIMIT`); another customer's review is `403`, no token `401`. `mutation removeReviewPhoto(photoId: String!): Boolean!` removes one (`NOT_FOUND` for someone else's photo).

---

#### `reportReview` (customers only)
- **Type**: Mutation
- **Args**: `input: ReportContentInput!` = `{ id: ID! (the review), reason: ContentReportReason!, note?: string (up to 500; required for OTHER) }`
- **Response**: `Boolean!`
- **Description**: `ContentReportReason`: `SPAM`, `OFFENSIVE`, `OFF_TOPIC`, `FAKE`, `PERSONAL_INFORMATION`, `OTHER`. Once per customer and review (`CONFLICT` + `reason: ALREADY_REPORTED`); not your own review (`BAD_REQUEST`); hidden reviews are `NOT_FOUND`.

---

#### Moderation (staff with `review.moderate`: Owner, Manager, Support)
- `reportedReviews(first: Int = 20, after: ID): [ReportedReview!]!`: the queue: reviews with open reports, oldest first. `ReportedReview { review: Review!, openReports: [ContentReport!]! }`, `ContentReport { id, reason, note, createdAt }` (the reporter is not shown).
- `hideReview(input: { id, reason }): Review!`: hides a published review (`CONFLICT` if already hidden) and closes its open reports. Audited.
- `unhideReview(input: { id, reason }): Review!`: publishes a hidden review again (`CONFLICT` if not hidden). Audited.
- `dismissReviewReports(input: { id, reason }): Review!`: closes the open reports and leaves the review as it is. Audited.
- `replyToReview(input: { reviewId, body }): Review!`: sets (or replaces) the store's public reply, up to 2000 characters. Audited.

**Breaking changes (P6-V.1)** `[breaking-api]`: `adminDeleteReview` removed (use `hideReview`); `Review.userId` removed; `productReviews` takes `productId: ID!`, pages (`first` default 20, `after`, `sort`) and is public; `review` is public (published reviews only); `userReviews` pages (`first`, `after`); `Product.reviews` returns only the latest published reviews (`first` default 5, max 20) instead of every review; `createReview` requires a verified purchase and answers a duplicate with `CONFLICT` (was `BAD_REQUEST`); `updateReview` no longer takes `productId`, a `null` comment now clears it, and another customer's review is `FORBIDDEN` (was `BAD_REQUEST`). New: `Product.rating`, `Review.title/verifiedPurchase/status/hiddenReason/reply/photos/editedAt`, `reportReview`, `removeReviewPhoto`, `POST /reviews/:reviewId/photos`, the moderation operations above.

---

### 2.17a Product questions and answers

**Rules (P6-V.2).** A signed-in customer asks a question about an active, `PUBLISHED` product (5–1000 characters, trimmed). Staff with `review.moderate` (Owner, Manager, Support) answer it; customers do not answer. A question is **public once answered** and not hidden; until then only its asker (in `myProductQuestions`) and staff see it. The asker is shown only as `user: PublicProfile { displayName }`. Customers report public questions (once each); staff hide and unhide them like reviews. Asking and reporting are rate-limited (10 a minute).

**`ProductQuestion` Object Type**:

```typescript
{
  id: string;
  productId: string;
  body: string;
  answer?: string;          // the store's answer; null until answered
  answeredAt?: DateTime;
  status: ModerationStatus; // PUBLISHED | HIDDEN
  hiddenReason?: string;    // staff with review.moderate only
  user: PublicProfile;      // { displayName } only
  product: Product;
  createdAt: DateTime;
}
```

- `productQuestions(productId: ID!, first: Int = 20, after: ID): [ProductQuestion!]!` (public, optional sign-in): answered, published questions, latest answer first; `after` = last id of the previous page. `NOT_FOUND` for a product that is not public.
- `productQuestion(questionId: String!): ProductQuestion!` (public, optional sign-in): an answered public question; its asker and moderators also get it unanswered or hidden; `NOT_FOUND` otherwise.
- `myProductQuestions(first: Int = 20, after: ID): [ProductQuestion!]!` (signed in): the caller's questions, answered or not, newest first.
- `askProductQuestion(input: { productId: ID!, body: String! }): ProductQuestion!` (customers only): `NOT_FOUND` (product not public), `BAD_USER_INPUT` (length).
- `reportProductQuestion(input: ReportContentInput!): Boolean!` (customers only): same input and rules as `reportReview` (`ALREADY_REPORTED`, not your own, `OTHER` needs a note, non-public questions `NOT_FOUND`).
- Staff (`review.moderate`): `unansweredProductQuestions(first, after)` (published, unanswered, oldest first); `reportedProductQuestions(first, after): [ReportedProductQuestion!]!` (`{ question, openReports: [ContentReport] }`); `answerProductQuestion(input: { questionId, answer })` (sets or replaces the answer, up to 2000 characters); `hideProductQuestion(input: { id, reason })` (closes open reports); `unhideProductQuestion(input: { id, reason })`; `dismissProductQuestionReports(input: { id, reason })`. All four mutations are audited; `CONFLICT` when hiding a hidden question or unhiding a visible one.

New in P6-V.2 (additive, no breaking change).

---

### 2.17b Recently viewed products

**Signed-in users (P6-G.3).** The server does not record views on its own: call `recordProductView` when a product page is shown.

- `recordProductView(productId: ID!): Boolean!` (signed in, staff included): records the view of an active, `PUBLISHED` product (`NOT_FOUND` otherwise). One entry per product (viewing it again moves it to the top); only the latest 20 distinct products are kept. Rate-limited to 60 a minute.
- `recentlyViewed(limit: Int = 20): [Product!]!` (signed in): latest first, 1–20 (`BAD_REQUEST` outside). Products no longer on sale (inactive, draft, archived) are left out.

**Guests:** keep the list on the device (e.g. `localStorage`, latest 20 product ids) and read the products with the public `product` query. The server has no guest list and does not merge a guest list into the account at sign-in; a client may replay its ids through `recordProductView` after signing in (oldest first).

New in P6-G.3 (additive, no breaking change).

---

### 2.18 Tax

All tax operations: `ADMIN`, `SUPER_ADMIN` only.

Taxes are named, Ghana-wide rates (e.g. VAT, NHIS levy) with no country or region. The sum of the **active** rates is built into the `price` of every variant of a taxable product (`Variant.price = basePrice × (1 + sum)`); creating, updating or deleting a tax reprices all those variants in the same transaction, recording each price that moved in the price history (source `TAX_RATE_CHANGE`, see [Price history](#price-history)), so if the reprice fails the mutation returns an error and neither the tax change, any price nor any history entry is saved. Variants without a `basePrice` (unpriced migrated variants) keep their price; it is never reverse-computed. Prices are rounded to 2 decimal places, half away from zero (basePrice 10.10 at 15% → 11.62), the same way whether the price was set by a variant edit, a product's `isTaxable` change or a tax change. No tax is added at checkout and orders do not show a tax line.

---

#### `taxes`
- **Type**: Query
- **Response**: `[TaxEntity!]!`, sorted by name

**`TaxEntity` Object Type**:

```typescript
{
  id: string;
  name: string;       // e.g. "VAT", "NHIS Levy". Unique.
  rate: Decimal;        // Decimal 0–1 (0.15 = 15%)
  isActive: boolean;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `tax`
- **Type**: Query
- **Args**: `id: ID!`
- **Response**: `TaxEntity!` (`NOT_FOUND` if unknown)

---

#### `createTax`
- **Type**: Mutation
- **Args**: `input: CreateTaxInput!`
- **Response**: `TaxEntity!`

**Input: `CreateTaxInput`**

```typescript
{
  name: string;       // Required. Unique (CONFLICT).
  rate: Decimal;        // Required. 0 ≤ rate ≤ 1.
  isActive: boolean;  // Default true.
  priceChangeReason?: string; // Max 500 chars; stored on the price history entries of the variants it reprices
}
```

---

#### `updateTax`
- **Type**: Mutation
- **Args**: `id: ID!`, `input: UpdateTaxInput!` (`name?`, `rate?` 0–1, `isActive?`, `priceChangeReason?`)
- **Response**: `TaxEntity!`

---

#### `deleteTax`
- **Type**: Mutation
- **Args**: `id: ID!`, `priceChangeReason?: String` (max 500 characters)
- **Response**: `TaxEntity!`

---

### 2.19 Analytics

Staff reports (P8-A). Every query needs `report.view`; `marginReport` and `inventoryValuation` also need `inventory.cost.view`; `rebuildAnalytics` needs `report.view` + `jobs.manage`. Definitions are in [16. Analytics Queries](#16-analytics-queries).

> **Breaking changes (P8-A)** `[breaking-api]`: `salesReport(startDate, endDate)` → `salesReport(firstDay, lastDay, bucket)` returning `{ totals, buckets, refreshedAt, daysNotComputed }`; `SalesReport.orderCount` → `paidOrders`; `totalRevenue` removed (use `netRevenue`); `averageOrderValue` is now **net** revenue / paid orders (was gross / orders). `topProducts(limit)` → `topProducts(firstDay, lastDay, first, orderBy)` with `unitsSold`, `unitsRefunded`, `sales`, `refunds`, `netSales`, `archived` (was `totalQuantitySold`, `totalRevenue`, all time). `revenueByCategory` → `topCategories(firstDay, lastDay, first)` (no `orderCount`). `dashboardSummary` today figures come from the rollups (up to 15 minutes behind) and "today" is the UTC day. New: `marginReport`, `conversionReport`, `cohortReport`, `inventoryValuation`, `promotionPerformance`, `rebuildAnalytics`, `OrderItem.unitCost`.

Range arguments (`firstDay`, `lastDay`) are inclusive days `YYYY-MM-DD` in UTC (= Ghana time); a malformed value is `BAD_USER_INPUT`, a day that does not exist, a last day before the first or more than 731 days is `BAD_REQUEST`. `first` is 1-100 (default 10). `bucket` is `DAY` (default), `WEEK` (ISO, Monday-Sunday) or `MONTH`; the first and last bucket are cut to the range.

```graphql
salesReport(firstDay: String!, lastDay: String!, bucket: ReportBucket = DAY): SalesReport!
topProducts(firstDay: String!, lastDay: String!, first: Int = 10, orderBy: TopProductsOrder = UNITS): [TopProduct!]!   # UNITS | SALES
topCategories(firstDay: String!, lastDay: String!, first: Int = 10): [TopCategory!]!
marginReport(firstDay: String!, lastDay: String!, first: Int = 10): MarginReport!          # + inventory.cost.view
conversionReport(firstDay: String!, lastDay: String!, bucket: ReportBucket = DAY): ConversionReport!
cohortReport(firstMonth: String!, lastMonth: String!, followMonths: Int = 12): [Cohort!]!   # YYYY-MM, <= 24 cohorts, followMonths 0-24
inventoryValuation: InventoryValuation!                                                    # + inventory.cost.view
promotionPerformance(firstDay: String!, lastDay: String!, first: Int = 10): [PromotionPerformance!]!
dashboardSummary: DashboardSummary!
rebuildAnalytics(input: { firstDay: String!, lastDay: String! }): AnalyticsRebuild!        # mutation, + jobs.manage
```

```typescript
SalesFigures {
  paidOrders: Int; unitsSold: Int;
  grossRevenue: Money;      // Σ grandTotal of the orders paid
  itemSales: Money;         // Σ what their lines were charged (after product discounts and their share of cart discounts), tax included
  itemDiscounts: Money; orderDiscounts: Money /* cart promotions + coupons */; loyaltyDiscounts: Money;
  shipping: Money /* delivery fees charged */; shippingDiscounts: Money /* free shipping */; tax: Money;
  refundCount: Int; refunds: Money; refundedShipping: Money; refundedTax: Money;
  netRevenue: Money;        // grossRevenue - refunds (negative when refunds exceed sales)
  averageOrderValue: Money; // netRevenue / paidOrders, 0 without paid orders
}
SalesReport { totals: SalesFigures; buckets: (SalesFigures & { firstDay: String; lastDay: String })[]; refreshedAt?: DateTime; daysNotComputed: Int }
TopProduct { productId; productName; archived: Boolean; unitsSold; unitsRefunded; sales: Money; refunds: Money; netSales: Money }
TopCategory { categoryId?; categoryName?; unitsSold; sales: Money; refunds: Money; netSales: Money }
MarginFigures {
  unitsSold: Int; netSales: Money /* tax-exclusive, all lines */; costedNetSales: Money /* lines of known cost */;
  cogs: Money; grossMargin: Money /* costedNetSales - cogs */; marginRate?: Decimal /* 4 dp, 0.2500 = 25 % */;
  unknownCostUnits: Int; unknownCostNetSales: Money /* left out of the margin */
}
MarginReport { overall: MarginFigures; byProduct: (MarginFigures & { productId; productName; archived })[]; byCategory: (MarginFigures & { categoryId?; categoryName? })[]; unallocatedRefunds: Money }
ConversionReport { totals: FunnelFigures; buckets: (FunnelFigures & { firstDay; lastDay })[]; refreshedAt?; daysNotComputed }
FunnelFigures { cartsStarted; checkoutQuotes; ordersPlaced; paidOrders; quoteRate?: Float; placementRate?: Float; paymentRate?: Float; conversionRate?: Float }
Cohort { month: String /* YYYY-MM */; customers; repeatCustomers; repeatRate?: Float; months: { offset; activeCustomers; orders; netRevenue: Money }[] }
InventoryValuation { units; value: Money; unknownCostUnits; unknownCostVariants; locations: { locationId; locationName; isActive; units; value: Money; unknownCostUnits }[] }
PromotionPerformance { promotionId; promotionName? /* null once deleted */; couponCode?; orders; discount: Money; revenue: Money; units }
AnalyticsRebuild { jobId: ID; firstDay; lastDay }
DashboardSummary { totalUsers; ordersToday; revenueToday /* net */; grossRevenueToday; refundsToday; lowStockProductCount; lowStockVariantCount }
```

A variant is low on stock when its available stock (on hand minus reserved) is at or below its `lowStockThreshold` (default 5). Expiring stock is the existing `expiringStock` query ([2.15](#215-inventory)). CSV export of reports is not part of this API yet.

---

### 2.20 Addresses

**Breaking change (P1-G):** addresses are Ghana addresses. `state` is gone, replaced by the required `region` enum (`GhanaRegion`); `zipCode` is optional; `recipientName`, `phone`, `area`, `landmark`, `ghanaPostGps`, `latitude` and `longitude` are new; `country` must be `GH`. New addresses need `recipientName`, `phone` and `region`. Addresses saved before this change can have `region`, `recipientName` and `phone` set to `null`: checkout refuses them with `BAD_REQUEST` "Complete the delivery address (region, recipient name and phone) before checkout" until the customer fills them in with `updateAddress`.

**Formats**:
- `phone`: a Ghana number written as `0XXXXXXXXX`, `233XXXXXXXXX`, `+233XXXXXXXXX` or `00233XXXXXXXXX`, where the nine-digit national number does not start with 0. Spaces, dashes, dots and parentheses are ignored (`024 412 3456`, `(024) 412-3456`). It is stored and returned in E.164 form, `+233XXXXXXXXX`. Anything else (another country, too short or long, letters) is `BAD_USER_INPUT`.
- `ghanaPostGps`: a GhanaPostGPS digital address, two letters, 3–4 digits, then 4 digits; case, spaces and hyphens are free (`GA1234567`, `ga-123-4567`, `AK 484 9321`). Stored and returned as `XX-NNN-NNNN` or `XX-NNNN-NNNN` (`GA-123-4567`). Anything else is `BAD_USER_INPUT`.
- `region`: one of the 16 regions: `AHAFO`, `ASHANTI`, `BONO`, `BONO_EAST`, `CENTRAL`, `EASTERN`, `GREATER_ACCRA`, `NORTH_EAST`, `NORTHERN`, `OTI`, `SAVANNAH`, `UPPER_EAST`, `UPPER_WEST`, `VOLTA`, `WESTERN`, `WESTERN_NORTH`.
- `country`: optional, defaults to `GH`; if sent it must be `GH` (any case, surrounding spaces ignored), otherwise `BAD_USER_INPUT`. The store delivers in Ghana only.
- `latitude` / `longitude`: optional `Float`s, sent together (or both `null` to clear them); latitude −90..90, longitude −180..180. Stored with 6 decimal places.
- `city` is the city or town and `area` the area within it; shipping zones match them (P5-A.1: an area of the town, else the town, else the `region`; case, accents and punctuation ignored).

---

#### `address`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `addressId: String!`
- **Response**: `Address!`
- **Description**: One of the caller's own addresses. Anyone else's, or an unknown id, gives `NOT_FOUND` with the same message (`Address "<id>" not found`).

**`Address` Object Type**:

```typescript
{
  id: string;
  recipientName: string | null;  // null only on addresses saved before P1-G
  phone: string | null;          // E.164, e.g. "+233244123456"; null only on addresses saved before P1-G
  region: GhanaRegion | null;    // null only on addresses saved before P1-G whose old state could not be mapped
  street: string;
  city: string;                  // City or town; used to find the shipping zone at checkout
  area: string | null;           // Area, neighbourhood or suburb
  landmark: string | null;       // Nearby landmark and delivery directions
  ghanaPostGps: string | null;   // e.g. "GA-123-4567"
  latitude: number | null;
  longitude: number | null;
  zipCode: string | null;
  country: string;               // "GH"
  userId: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `userAddresses`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: All addresses of the caller.
- **Response**: `[Address!]!`

---

#### `addresses` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `userId: String` (ADMIN must supply it, otherwise `FORBIDDEN`; SUPER_ADMIN may omit it to get every address)
- **Response**: `[Address!]!`

---

#### `createAddress`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `input: CreateAddressInput!`
- **Response**: `Address!`
- **Possible Errors**: `BAD_REQUEST` ("You have reached the maximum of 10 saved addresses"), `BAD_USER_INPUT` (a required field missing, or a value outside the formats above).

**Input: `CreateAddressInput`**

```typescript
{
  recipientName: string;   // Required. Trimmed, 1-100 chars.
  phone: string;           // Required. Ghana number (see Formats); stored as +233XXXXXXXXX.
  region: GhanaRegion;     // Required.
  street: string;          // Required. Max 255 chars.
  city: string;            // Required. City or town. Max 100 chars.
  area?: string;           // Optional. Max 100 chars.
  landmark?: string;       // Optional. Landmark and delivery directions. Max 200 chars.
  ghanaPostGps?: string;   // Optional. GhanaPostGPS address (see Formats).
  latitude?: number;       // Optional. With longitude.
  longitude?: number;      // Optional. With latitude.
  zipCode?: string;        // Optional. Max 20 chars.
  country?: string;        // Optional. Default "GH"; only "GH" accepted.
}
```

---

#### `updateAddress`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `addressId: String!`, `input: UpdateAddressInput!` (every `CreateAddressInput` field, all optional)
- **Response**: `Address!`
- **Description**: Changes only the fields sent. `null` on an optional field (`area`, `landmark`, `ghanaPostGps`, `zipCode`, or `latitude` and `longitude` together) clears it. `null` on a required field (`recipientName`, `phone`, `region`, `street`, `city`, `country`) is `BAD_USER_INPUT`.
- **Possible Errors**: `NOT_FOUND` (not the caller's address), `BAD_USER_INPUT`.

---

#### `deleteAddress`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `addressId: String!`
- **Response**: `Address!`
- **Possible Errors**: `NOT_FOUND` (not the caller's address); `CONFLICT` if an order was shipped to it.

---

### 2.21 Shipping Zones & Pickup Locations

**Breaking change (P5-A.1):** a shipping zone no longer has `cities` and `fee`. It lists **areas** (a Ghana region, a town, or an area within a town) and prices delivery with **rate rules**, one active rule per service level (`STANDARD`, `EXPRESS`). `CreateShippingZoneInput`/`UpdateShippingZoneInput` take `areas` instead of `cities` and `fee`; add fees with `createRateRule`. The query `getShippingFee` is removed: `checkoutQuote` returns `delivery` and `deliveryOptions` (the fee depends on the cart: its weight and its total after promotions). Existing zones were migrated: each city became a town entry and each fee the zone's active `STANDARD` rule.

**Matching.** At checkout a `DELIVERY` address (which must be in Ghana) is matched to the active zone holding its most specific entry: an area of the address's town (`town` + `area` = the address's `city` + `area`) beats the town, which beats the region. Towns and areas are compared ignoring case, accents, apostrophes, punctuation and repeated spaces (`"East-Legon"` = `"east legon"`) and are stored that way. Each region, town or town area belongs to at most one zone (active or not): creating or updating a zone with an entry another zone lists fails with `CONFLICT` naming the entry and its zone. No match → `BAD_REQUEST` `DELIVERY_UNAVAILABLE`, never a free delivery. A **pickup location** is where a `PICKUP` order is collected (no shipping fee).

**Rates.** A rate rule has a `baseFee`, optional `weightBands` (`fromGrams`, `fee`: from that cart weight up the band's fee applies; ascending, never cheaper than the band below or the base fee) and an optional `freeAbove`: delivery is free once the merchandise total after item and cart promotions (tax included) reaches it. The cart weight is Σ variant `weightGrams` × quantity; a variant without a weight counts as 0 g. Free-shipping promotions apply after the rule's fee. Rate rule changes are price changes: they need `shipping.manage` and a recent step-up (`FORBIDDEN` + `reason: STEP_UP_REQUIRED`) and are audited with the fees before and after.

---

#### `activeShippingZones`
- **Type**: Query
- **Auth Required**: No
- **Response**: `[ShippingZoneEntity!]!`, active zones sorted by name, with their active rate rules only (the public rate card)

**`ShippingZoneEntity` Object Type**:

```typescript
{
  id: string;
  name: string;      // Unique
  areas: ZoneArea[]; // { id, level: REGION | TOWN | AREA, region?: GhanaRegion, town?: string, area?: string } (town/area normalised)
  rateRules: RateRule[]; // { id, zoneId, serviceLevel, baseFee: Money, freeAbove?: Money, weightBands: { fromGrams, fee: Money }[], isActive, createdAt, updatedAt }
  isActive: boolean;
  codEnabled: boolean; // P3-B.2: cash on delivery may be chosen for deliveries here (setShippingZoneCashOnDelivery, Owner)
  fulfilmentLocations: StockLocation[]; // inventory.view, see 2.15
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `shippingZones` (`shipping.manage`)
- **Type**: Query
- **Response**: `[ShippingZoneEntity!]!`, all zones sorted by name, with every rule

---

#### `shippingZone` (`shipping.manage`)
- **Type**: Query
- **Args**: `id: ID!`
- **Response**: `ShippingZoneEntity!` (`NOT_FOUND` if unknown)

---

#### `createShippingZone` (`shipping.manage`)
- **Type**: Mutation
- **Args**: `input: CreateShippingZoneInput!`
- **Response**: `ShippingZoneEntity!` (audited)

**Input: `CreateShippingZoneInput`**

```typescript
{
  name: string;           // Required. Unique. At most 100 characters.
  areas: ZoneAreaInput[]; // Required, 1-500: each { region } alone, { town } alone, or { town, area } (at most 100 characters each); repeats merged
  isActive?: boolean;     // Default true.
}
```

**Possible Errors**: `CONFLICT` ("Areas already covered by another shipping zone: TOWN:tema (zone "Greater Accra")", or the name is taken), `BAD_REQUEST` (an entry that is not exactly a region, a town, or a town with an area; a name without letters or digits).

---

#### `updateShippingZone` (`shipping.manage`)
- **Type**: Mutation
- **Args**: `id: ID!`, `input: UpdateShippingZoneInput!` (`name?`, `areas?` replaces every area, `isActive?`; omitted = unchanged, `null` refused)
- **Response**: `ShippingZoneEntity!` (audited)
- **Possible Errors**: `NOT_FOUND`, `CONFLICT` (area overlap or name taken), `BAD_REQUEST`.

---

#### `deleteShippingZone` (`shipping.manage`)
- **Type**: Mutation
- **Args**: `id: ID!`
- **Response**: `ShippingZoneEntity!` (audited)
- **Description**: Deletes the zone with its areas and rate rules. Existing orders keep their zone, rule and fee snapshot. `CONFLICT` while a free-shipping promotion is limited to the zone.

---

#### `createRateRule` / `updateRateRule` / `deleteRateRule` (`shipping.manage`, step-up) (P5-A.1)
- **Type**: Mutation
- **Args**: `createRateRule(zoneId: ID!, input: CreateRateRuleInput!)`, `updateRateRule(id: ID!, input: UpdateRateRuleInput!)`, `deleteRateRule(id: ID!)`
- **Response**: `RateRule!` (audited, fees before/after)

```typescript
CreateRateRuleInput {
  serviceLevel: DeliveryServiceLevel; // STANDARD | EXPRESS
  baseFee: Decimal;                   // >= 0, 2 decimal places
  freeAbove?: Decimal;                // Free once the merchandise total after promotions reaches it
  weightBands?: { fromGrams: Int; fee: Decimal }[]; // At most 50; fromGrams >= 1, ascending; fees never decrease (and >= baseFee)
  isActive?: boolean;                 // Default true. At most one active rule per zone and level
}
UpdateRateRuleInput { baseFee?; freeAbove? (null clears it); weightBands? (replaces them); isActive? }
```

- **Possible Errors**: `NOT_FOUND` (zone or rule), `CONFLICT` (the zone already has an active rule for the level), `BAD_REQUEST` (bands out of order, a band cheaper than the one below or the base fee), `FORBIDDEN` (`STEP_UP_REQUIRED`). Orders already placed keep the fee they were charged.

---

#### Delivery slots (`shipping.manage`) (P5-A.2)
- `createDeliverySlot(zoneId: ID!, input: CreateDeliverySlotInput!): DeliverySlotEntity!` — `{ weekday: Weekday (MONDAY..SUNDAY), startTime: "HH:MM", endTime: "HH:MM" ("24:00" ends the day), capacity: Int (>= 1, orders per date), cutoffHours?: Int (default 0: bookable until this many hours before the start), isActive?: Boolean }`.
- `updateDeliverySlot(id: ID!, input: UpdateDeliverySlotInput!)` (`startTime?`, `endTime?`, `capacity?`, `cutoffHours?`, `isActive?`); a lower capacity only stops new bookings.
- `deleteDeliverySlot(id: ID!)` — `CONFLICT` once it has been booked: deactivate it instead.
- `addDeliveryClosure(zoneId: ID!, input: { date: "YYYY-MM-DD", reason?: String }): DeliveryClosureEntity!`, `removeDeliveryClosure(id: ID!)` — dates the zone does not deliver (`CONFLICT` for a date already closed).
- `ShippingZoneEntity.deliverySlots` (`{ id, zoneId, weekday, startTime, endTime, capacity, cutoffHours, isActive }`) and `ShippingZoneEntity.deliveryClosures` (from today on).
- `BAD_REQUEST` for a window ending before it starts or a time outside 00:00-24:00. All audited.

#### `deliveryBookings` (`order.view`) (P5-A.2)
- **Args**: `date: String!` (YYYY-MM-DD), `zoneId?: ID`
- **Response**: `[DeliveryBooking!]!`: per slot booked that day `{ slotId, date, startTime, endTime, zoneId, zoneName, capacity, booked, orders: { orderId, orderNumber, status }[] }` (cancelled and expired orders have given their place back).

---

**Breaking change (P5-E.1):** `PickupLocationEntity.state` and the `state` inputs are gone, replaced by `region: GhanaRegion` (required on create; `null` only on points migrated from a state that matched no region). New: `contactPhone`, `instructions`, `ghanaPostGps`, `latitude`/`longitude`, `openingHours` and `openingHoursText`. `country` is optional and must be `GH`. The order's `pickupLocationSnapshot` now holds `{ name, address, city, region, country, contactPhone, instructions, openingHours }` (`openingHours` as the one-line text) instead of `state`.

**Ready for pickup (P5-E.1).** When staff move a pickup order's shipment to `READY_FOR_PICKUP`, the customer gets an email (account address) and an SMS (the order's `contactPhone`, Ghana numbers only) with the order number, the pickup point, its address and opening hours, once per event. This replaces the generic "order update" email for that step.

#### `activePickupLocations`
- **Type**: Query
- **Auth Required**: No
- **Response**: `[PickupLocationEntity!]!`, active locations sorted by name

**`PickupLocationEntity` Object Type**:

```typescript
{
  id: string;
  name: string;
  address: string;   // Street address
  city: string;
  region?: GhanaRegion;      // P5-E.1 (replaces state)
  country: string;
  contactPhone?: string;     // P5-E.1, E.164: show it so customers can call
  instructions?: string;     // P5-E.1: how to find the counter, what to bring
  ghanaPostGps?: string;     // P5-E.1, XX-NNN(N)-NNNN
  latitude?: Float; longitude?: Float; // P5-E.1
  openingHours: { weekday: Weekday; opens: string; closes: string }[]; // P5-E.1, HH:MM Africa/Accra (= UTC), Monday first; a weekday not listed is closed
  openingHoursText: string;  // P5-E.1, e.g. "Mon-Fri 08:00-17:00, Sat 09:00-13:00, Sun closed" ("Opening hours not set" when empty)
  isActive: boolean; // Only active locations accept orders
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `pickupLocations` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Response**: `[PickupLocationEntity!]!`, all locations sorted by name

---

#### `createPickupLocation` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: CreatePickupLocationInput!`
- **Response**: `PickupLocationEntity!`

**Input: `CreatePickupLocationInput`**

```typescript
{
  name: string;       // Required, non-empty, at most 100 characters.
  address: string;    // Required, non-empty, at most 200.
  city: string;       // Required, non-empty, at most 100.
  region: GhanaRegion; // Required (P5-E.1, replaces state).
  country?: string;   // Default GH; must be GH.
  contactPhone?: string;  // Ghana number in any common format; stored +233XXXXXXXXX
  instructions?: string;  // At most 500 characters
  ghanaPostGps?: string;  // GhanaPostGPS digital address
  latitude?: Float; longitude?: Float; // Together
  openingHours?: { weekday: Weekday; opens: "HH:MM"; closes: "HH:MM" }[]; // At most one per weekday, closing after opening
  isActive?: boolean; // Default true.
}
```

---

#### `updatePickupLocation` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: ID!`, `input: UpdatePickupLocationInput!` (all fields optional; `openingHours` replaces the week; `null` clears `contactPhone`, `instructions`, `ghanaPostGps`, coordinates)
- **Response**: `PickupLocationEntity!` (audited)
- **Possible Errors**: `NOT_FOUND`, `BAD_REQUEST` (invalid opening hours). Orders already placed keep their `pickupLocationSnapshot`.

---

#### `deletePickupLocation` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: ID!`
- **Response**: `PickupLocationEntity!`
- **Possible Errors**: `CONFLICT` if any order uses the location (deactivate it with `isActive: false` instead).

---

### 2.22 Store settings

One deployment serves one store. Its settings hold the names and tax registration printed on receipts, the currency every price, charge and refund is in, and support contacts.

#### `storeSettings`
- **Type**: Query
- **Auth Required**: No
- **Response**: `StoreSettings!`

```typescript
{
  id: string;
  legalName: string;
  tradingName: string;
  tin?: string;             // Taxpayer Identification Number
  vatRegistered: boolean;
  pricesIncludeTax: boolean; // true: product prices already include tax
  currency: Currency;        // The store currency; every Money field is in it
  supportEmail?: string;
  supportPhone?: string;
  returnWindowDays: number;  // P6-R.1: days after delivery goods may be returned in (default 14), unless their product type sets its own
  abandonedCartReminderDelayHours: number; // P6-G.2: hours a cart sits unchanged before the abandoned-cart reminder (default 4)
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

#### `updateStoreSettings` (SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: UpdateStoreSettingsInput!`
- **Response**: `StoreSettings!`
- **Side effects**: writes an audit entry (entity `Store`) with the changed fields.
- **Possible Errors**: `BAD_USER_INPUT` (validation), `FORBIDDEN` (`ADMIN` or `USER`).

```typescript
{
  legalName?: string;        // Non-blank, max 200. Cannot be null.
  tradingName?: string;      // Non-blank, max 200. Cannot be null.
  tin?: string | null;       // 1-20 letters, digits or hyphens (Ghana Card PINs such as GHA-123456789-0 are accepted); null clears it
  vatRegistered?: boolean;
  pricesIncludeTax?: boolean;
  supportEmail?: string | null; // Valid email; null clears it
  supportPhone?: string | null; // International format, e.g. +233244000000; null clears it
  returnWindowDays?: number;  // P6-R.1: 0-365. Cannot be null.
  abandonedCartReminderDelayHours?: number; // 1-72. Cannot be null.
}
```

The currency cannot be changed through the API.

---

### 2.22a Store features (P8-F)

The Owner can switch store-level features off. While one is off its operations below fail with `BAD_REQUEST`, `extensions: { reason: "FEATURE_DISABLED", feature: "<key>" }` (REST: the same `reason` and `feature` in the 400 body); everything else keeps working. Switching a feature off **never deletes** what it stored (points balances, reviews, referrals, wishlists, saved items, recently viewed lists, returns); switching it back on restores it. Read `storeFeatures` at start-up and hide the UI of features that are off. A change reaches every server within a few seconds at most (usually at once).

| Key | Refused while off | Also while off |
|---|---|---|
| `GUEST_CHECKOUT` | `createGuestCart`, `addToGuestCart`, `updateGuestCartItem`, `removeFromGuestCart`, `requestGuestPhoneVerification`, `verifyGuestPhone`, `guestCheckoutQuote`, `createGuestOrder` | `guestCart`, `guestOrder`, `verifyGuestPayment` and `POST /payment/guest/initialize` keep working, so orders already placed can be paid and tracked |
| `LOYALTY` | (no operation) | no points earned on completion; `redeemPoints` at checkout is `FEATURE_DISABLED`; referrals are not rewarded. `myLoyalty`, `loyaltySettings` (`enabled: false`) and the staff operations keep working; refunds still settle points |
| `REFERRALS` | `myReferrals`, `applyReferralCode` | `signUp` with a `referralCode` is refused before the account is created; a referral whose first order completes is `DISQUALIFIED` (`REFERRALS_DISABLED`) |
| `REVIEWS` | `createReview`, `updateReview`, `deleteReview`, `removeReviewPhoto`, `reportReview`, `POST /reviews/:reviewId/photos` | published reviews, ratings and staff moderation stay |
| `PRODUCT_QA` | `askProductQuestion`, `reportProductQuestion` | answered questions and staff answering/moderation stay |
| `RECENTLY_VIEWED` | `recordProductView` | `recentlyViewed` still lists what was recorded |
| `RETURNS` | `requestReturn`, `cancelReturn`, `POST /returns/orders/:orderId/photos` | `myReturns` and every staff return operation stay (open returns can be finished) |
| `ABANDONED_CART_REMINDERS` | (no operation) | the hourly job sends no reminders |
| `SAVED_FOR_LATER` | `saveCartItemForLater`, `moveSavedItemToCart`, `removeSavedItem` | `savedItems` stays |
| `WISHLIST` | `addToWishlist`, `removeFromWishlist`, `clearWishlist` | `wishlist` stays |
| `CASH_ON_DELIVERY` | (no operation) | the payment method switch (`updatePaymentMethods.cashOnDelivery`, `availablePaymentMethods.cashOnDelivery`): checkout refuses cash on delivery with `PAYMENT_METHOD_UNAVAILABLE` |

#### `storeFeatures`
- **Type**: Query · **Auth Required**: No
- **Response**: `[StoreFeature!]!` — every key above, in that order: `{ key: StoreFeatureKey, enabled: Boolean, description: String }`. All on by default.

#### `setStoreFeature` (`store.features.manage`: Owner only, recent step-up)
- **Type**: Mutation · **Args**: `input: SetStoreFeatureInput! { key: StoreFeatureKey!, enabled: Boolean! }`
- **Response**: `StoreFeature!`
- **Side effects**: audit entry (entity `StoreFeature`, id = the key, `changes.enabled { from, to }`). `CASH_ON_DELIVERY` sets the same switch as `updatePaymentMethods`.
- **Possible Errors**: `FORBIDDEN` (no permission; `reason: STEP_UP_REQUIRED` without a recent step-up), `UNAUTHENTICATED`.

**Breaking changes (P8-F)** `[breaking-api]`: `UpdateLoyaltySettingsInput.enabled` → removed: switch loyalty with `setStoreFeature(input: { key: LOYALTY, enabled })` (`loyaltySettings.enabled` still reports it). Redeeming points while loyalty is off is `FEATURE_DISABLED` (feature `LOYALTY`) instead of `LOYALTY_DISABLED`. New refusals on the operations in the table above while a feature is off.

---

### 2.23 Background jobs

Emails and Paystack webhook processing run in a separate worker process on BullMQ queues, with retries and exponential backoff. A job that fails its last attempt stays in its queue's failed set (kept 30 days) until a super admin retries it. Job data (addresses, tokens) is never returned.

```typescript
enum JobQueue { NOTIFICATIONS, WEBHOOKS, MAINTENANCE }

{                       // FailedJob
  queue: JobQueue;
  id: string;           // For outbox events, the event id; for webhook jobs, the stored webhook event id
  name: string;         // e.g. "order.placed.v1", "email.password_reset.v1", "paystack.webhook.v1", "payments.sweep"
  attemptsMade: number;
  maxAttempts: number;
  failedReason: string; // Last error, email addresses masked, max 500 characters
  createdAt: DateTime;
  failedAt?: DateTime;
}
```

#### `failedJobs` (SUPER_ADMIN)
- **Type**: Query
- **Args**: `queue: JobQueue!`, `first: Int = 20` (1 to 100)
- **Response**: `[FailedJob!]!`, newest first
- **Side effects**: writes an audit entry (entity `FailedJob`, action `VIEW`).
- **Possible Errors**: `BAD_USER_INPUT` (`first` out of range), `FORBIDDEN` (`ADMIN` or `USER`), `UNAUTHENTICATED`.

#### `retryFailedJob` (SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `queue: JobQueue!`, `jobId: ID!`
- **Response**: `FailedJob!`, as it was before the retry
- **Behaviour**: moves the job back to the queue with its attempt count reset, so it gets its full retries again. Sending is idempotent per job, so an email that already went out is not sent twice.
- **Side effects**: writes an audit entry (entity `FailedJob`, action `RETRY`).
- **Possible Errors**: `NOT_FOUND` (no such job), `CONFLICT` (the job is not in the failed set), `FORBIDDEN`, `UNAUTHENTICATED`.

---

### 2.24 Staff roles and permissions

Authorization is permission-based (ADR-0013). **Permissions** are fixed in code; **roles** are data: a named set of permissions. Each staff member has exactly one role in the store (a *membership*); customers have none. System roles are seeded and cannot be changed:

| Role (key) | Permissions | Two-factor required |
|---|---|---|
| Owner (`OWNER`) | Every permission, including any added later | Yes |
| Manager (`MANAGER`) | Everything the legacy `ADMIN` could do: every permission except `staff.manage`, `store.settings.manage`, `jobs.manage`, `customer.data.export` | Yes |
| Inventory clerk (`INVENTORY_CLERK`) | `catalog.product.read`, `catalog.product.write`, `catalog.taxonomy.write`, `catalog.media.upload`, `inventory.view`, `inventory.adjust` | No (may opt in) |
| Cashier (`CASHIER`) | `catalog.product.read`, `order.view`, `order.fulfil`, `payment.view`, `payment.record`, `cod.cash.manage` | No (may opt in) |
| Support (`SUPPORT`) | `order.view`, `return.manage`, `payment.view`, `user.view`, `review.moderate` | No (may opt in) |
| Rider (`RIDER`) | `delivery.ride` (P5-C.1: their own assigned deliveries only) | No (may opt in) |

A Pharmacist role comes with its vertical. The Owner can create **custom roles** from the catalogue (`createStaffRole`).

**Rules** (all enforced server-side, every change audited):
- Managing staff needs `staff.manage` (by default only the Owner).
- No escalation: you may only assign a role, or create/change a custom role, whose permissions you all hold, and only touch staff whose permissions you all hold.
- Only an Owner can assign the Owner role or change, demote, archive or delete an Owner.
- The last active Owner cannot be removed, demoted, archived or deleted (`FORBIDDEN`, "The store must keep at least one active Owner").
- Changes apply on the affected user's next request; no sign-out is needed.
- Role and permission changes are step-up actions (see [2.25](#225-two-factor-authentication-and-step-up)), and holders of `mfaRequired` roles must enrol two-factor authentication before any staff operation.

**Permission catalogue** (also returned by `staffPermissions`):

| Permission | Allows |
|---|---|
| `catalog.product.read` | `adminProducts`, `adminProduct`, `variant`, `variants`, `priceChanges`; the `Variant.priceHistory` field |
| `catalog.product.write` | `createProduct`, `updateProduct`, `archiveProduct`, `restoreProduct`, `permanentlyDeleteProduct`, `addTagToProduct`, `removeTagFromProduct`, `createVariant`, `updateVariant`, `deleteVariant` |
| `catalog.taxonomy.write` | create/update/delete brands, categories, sub-categories, tags and product types (with their attribute definitions); `addProductsToTag`, `removeProductsFromTag` |
| `catalog.media.upload` | `POST /upload/single-image`, `POST /upload/multiple-images` |
| `catalog.import` | `POST /imports/products`, `POST /imports/prices` (also step-up), the products/prices templates, `GET /imports/catalog/:id/report`, `catalogImportJobs`, `catalogImportJob`, `applyProductImport`, `applyPriceImport` (also step-up), `cancelCatalogImport` (P8-I; held by Owner and Manager) |
| `catalog.export` | `GET /exports/products`, `GET /exports/stock` (P8-I; held by Owner, Manager and Inventory clerk) |
| `inventory.import` | `POST /imports/stock`, `GET /imports/stock/template`, `GET /imports/stock/:id/report`, `stockImportJobs`, `stockImportJob`, `applyStockImport`, `cancelStockImport` (P8-I; held by Owner, Manager and Inventory clerk) |
| `inventory.view` | `stockMovements`, `stockLocations`, `stockLocation`, `stockTransfers`, `stockTransfer`, `stockInTransit`, `stockTakes`, `stockTake`, `stockTakeLines` (without expected quantities), `expiringStock`, `variantLots`; the `Variant.onHand`, `Variant.reserved` and `Variant.stockLevels` fields; `ShippingZone.fulfilmentLocations`, `PickupLocation.fulfilmentLocations` |
| `inventory.adjust` | `restockVariant`, `adjustVariantStock`, `openStockTake`, `recordStockTakeCounts`, `submitStockTake` |
| `inventory.alerts` | No operation: holders receive the low-stock digest email (P4-B.2; held by Owner, Manager and Inventory clerk) |
| `inventory.location.manage` | `createStockLocation`, `updateStockLocation`, `deleteStockLocation`, `setShippingZoneFulfilmentLocations`, `setPickupLocationFulfilmentLocations` (P4-A.1; held by Owner and Manager) |
| `inventory.stocktake.approve` | `approveStockTake`, `cancelStockTake`, `stockTakeVarianceReport`; the `StockTakeLine.expectedAtOpen`, `expectedQuantity` and `variance` fields (P4-B.1; held by Owner and Manager) |
| `inventory.transfer` | `createStockTransfer`, `dispatchStockTransfer`, `receiveStockTransfer`, `cancelStockTransfer` (P4-A.2; held by Owner, Manager and Inventory clerk) |
| `inventory.cost.view` | `variantCostHistory`, `setVariantCost` (with `purchasing.manage`); every cost field: `Variant.costPrice`, `StockMovement.unitCost`, purchase-order `unitCost`/`lineCost`/`cost`/`totalCost`/`receivedCost`, cost values in `expiringStock` and `stockTakeVarianceReport` (P4-E.1; held by Owner and Manager). Without it a selected cost field is `null` in `data` and adds one `FORBIDDEN` error per field (per object); the rest of the response resolves |
| `purchasing.view` | `suppliers`, `supplier`, `purchaseOrders`, `purchaseOrder` (P4-E.1; held by Owner, Manager and Inventory clerk) |
| `purchasing.manage` | `createSupplier`, `updateSupplier`, `deleteSupplier`, `createPurchaseOrder`, `updatePurchaseOrder`, `sendPurchaseOrder`, `cancelPurchaseOrder`, `closePurchaseOrder`, `setVariantCost` (P4-E.1; held by Owner and Manager) |
| `purchasing.receive` | `receivePurchaseOrder` (P4-E.1; held by Owner, Manager and Inventory clerk) |
| `order.view` | `getOrders`, `viewOrder`, `flaggedOrders` (P3-E.1) |
| `order.manage` | `adminCancelOrder`, `deleteOrder`, `clearOrderReviewFlags` (P3-E.1) |
| `order.fulfil` | `createShipment`, `cancelShipment`, `updateShipmentStatus`, `updateShipping`, `assignShipmentItemSerials`, `unassignShipmentItemSerials`, `riders`, `assignShipmentRider`, `unassignShipmentRider` (P1-O.2, P5-B.1, P5-C.1; held by Owner, Manager, Inventory clerk and Cashier) |
| `delivery.ride` | `myDeliveries`, `myDelivery`, `startMyDelivery`, `failMyDelivery`, `completeMyDelivery`, `POST /delivery/my-shipments/:shipmentId/photo` (P5-C.1/C.2; held by the Rider role; the Owner holds it but is never assigned deliveries) |
| `delivery.override` | `completeDelivery` with `overrideReason` (P5-C.2; held by Owner and Manager). `completeDelivery` itself and `POST /delivery/shipments/:shipmentId/photo` need `order.fulfil` |
| `order.refund` | `refundReturn`, `processPendingRefund`, `refundOrder` |
| `return.manage` | `returns`, `returnRequest`, `approveReturn`, `rejectReturn`, `receiveReturn`, `inspectReturn` (with `inventory.adjust`), `exchangeReturn`, `acceptReturnOutsidePolicy` (with `return.override`) (P6-R.1; held by Owner, Manager and Support) |
| `return.override` | `acceptReturnOutsidePolicy` (P6-R.1; held by Owner and Manager) |
| `payment.view` | `payments`, `getUserPayment`, `refunds`, any customer's `payment`, `disputes`, `dispute` (P3-E.2) |
| `payment.record` | `recordCodPayment` |
| `cod.cash.manage` | `unremittedCashCollections`, `recordCashRemittance`, `cashRemittances`, `codCashReport` (P3-B.3; held by Owner, Manager and Cashier) |
| `payment.manage` | `softDeletePayment`, `restorePayment` |
| `payment.dispute.manage` | `recordDispute`, `updateDisputeStatus`, `addDisputeNote` (P3-E.2; held by Owner and Manager) |
| `promotion.manage` | `promotions`, `promotion`, `createPromotion`, `updatePromotion`, `deletePromotion`, `createCouponCode`, `updateCouponCode`, `deleteCouponCode`, `redemptions` (P2-B.1) |
| `customer.group.manage` | `customerGroups`, `customerGroup` (with `members`), `createCustomerGroup`, `updateCustomerGroup`, `deleteCustomerGroup`, `addCustomerGroupMembers`, `removeCustomerGroupMembers` (P2-B.3; held by Owner and Manager) |
| `pricelist.manage` | `priceLists`, `priceList` (with `entries`), and with step-up `createPriceList`, `updatePriceList`, `deletePriceList`, `setPriceListEntries`, `removePriceListEntries` (P2-W.1; held by Owner and Manager) |
| `tax.manage` | `taxes`, `tax`, `createTax`, `updateTax`, `deleteTax` |
| `shipping.manage` | admin shipping zone, rate rule (with step-up) and pickup location queries and mutations |
| `review.moderate` | `adminDeleteReview` |
| `user.view` | `users`, `userById`, `userByEmail`, `userByProviderId`, `addresses(userId)`, other users' protected `User` fields |
| `user.manage` | `updateUser`, `removeUser`, `archiveUser`, `deArchiveUser` (customer accounts; staff accounts also need `staff.manage`) |
| `customer.data.export` | `addresses` without `userId` (every customer address) |
| `staff.view` | `staffRoles`, `staffPermissions`, `staffMembers` |
| `staff.manage` | `createUser`, `assignStaffRole`, `removeStaffRole`, `createStaffRole`, `updateStaffRole`, managing staff accounts |
| `report.view` | `salesReport`, `topProducts`, `topCategories`, `conversionReport`, `cohortReport`, `promotionPerformance`, `dashboardSummary`; with `inventory.cost.view`: `marginReport`, `inventoryValuation`; with `jobs.manage`: `rebuildAnalytics` |
| `store.settings.manage` | `updateStoreSettings` |
| `jobs.manage` | `failedJobs`, `retryFailedJob` |

Every other operation is public or open to any signed-in user, as its section says.

```typescript
{                          // StaffRole
  id: string;
  key: string;             // "OWNER", "MANAGER", ... or a custom key
  name: string;
  permissions: string[];   // Effective; the Owner always lists every permission
  isSystem: boolean;       // System roles cannot be changed
  mfaRequired: boolean;    // Holders must enrol two-factor authentication
  createdAt: DateTime;
  updatedAt: DateTime;
}
{ key: string; description: string }              // StaffPermission
{ user: User; role: StaffRole; updatedAt: DateTime } // StaffMember (updatedAt: when the role was assigned)
```

#### `staffRoles` / `staffPermissions` / `staffMembers` (`staff.view`)
- **Type**: Query
- **Response**: `[StaffRole!]!` (system roles first) / `[StaffPermission!]!` / `[StaffMember!]!`
- **Possible Errors**: `FORBIDDEN`, `UNAUTHENTICATED`.

#### `assignStaffRole` (`staff.manage`)
- **Type**: Mutation
- **Args**: `userId: ID!`, `roleKey: String!`
- **Response**: `StaffMember!`
- **Description**: Gives the user the role, replacing any role they had. Also sets the legacy `User.role` (`SUPER_ADMIN` for Owner, otherwise `ADMIN`).
- **Side effects**: audit entry (entity `StoreMembership`, entity id = the user id, action `ROLE_ASSIGN`, `details: { from, to }`).
- **Possible Errors**: `NOT_FOUND` (unknown user or role key), `FORBIDDEN` (escalation rules, last Owner), `UNAUTHENTICATED`.

#### `removeStaffRole` (`staff.manage`)
- **Type**: Mutation
- **Args**: `userId: ID!`
- **Response**: `User!` (now a customer, `role: "USER"`)
- **Side effects**: audit entry (entity `StoreMembership`, action `ROLE_REMOVE`, `details: { from }`).
- **Possible Errors**: `NOT_FOUND` ("This user has no staff role"), `FORBIDDEN`, `UNAUTHENTICATED`.

#### `createStaffRole` (`staff.manage`)
- **Type**: Mutation
- **Args**: `input: CreateStaffRoleInput!`
- **Response**: `StaffRole!`

```typescript
{
  key: string;             // Required. ^[A-Z][A-Z0-9_]{1,39}$, unique
  name: string;            // Required. 2-60 chars
  permissions: string[];   // Required, non-empty, unique; each from staffPermissions and held by you
  mfaRequired?: boolean;   // Default false
}
```

- **Side effects**: audit entry (entity `StaffRole`, action `CREATE`).
- **Possible Errors**: `BAD_REQUEST` ("Unknown permissions: …"), `CONFLICT` (key taken), `FORBIDDEN` (a permission you do not hold), `BAD_USER_INPUT`.

#### `updateStaffRole` (`staff.manage`)
- **Type**: Mutation
- **Args**: `key: String!`, `input: UpdateStaffRoleInput!` (`name?`, `permissions?` replaces the list, `mfaRequired?`)
- **Response**: `StaffRole!`
- **Description**: Changes a custom role; holders get the new permissions on their next request. You must hold every permission of the role before and after the change.
- **Side effects**: audit entry (entity `StaffRole`, action `UPDATE`, before and after).
- **Possible Errors**: `NOT_FOUND`, `FORBIDDEN` ("System roles cannot be changed", or a permission you do not hold), `BAD_REQUEST` (unknown permission).

---

### 2.25 Two-factor authentication and step-up

Time-based one-time passwords (RFC 6238: SHA1, 6 digits, 30-second steps, any authenticator app). Any signed-in user may enrol. Roles with `mfaRequired` (Owner and Manager) **must** enrol: until they do, every permission-guarded operation returns `FORBIDDEN` with `reason: "MFA_ENROLLMENT_REQUIRED"`; the enrolment mutations, their profile and other customer-level operations keep working. Codes are accepted one step either side of now, and each code works only once (a replay within its step is refused). The TOTP secret is stored encrypted; recovery codes are stored hashed.

**Enrolment flow**
1. `startMfaEnrollment` → `{ secret, otpauthUri }`. Draw `otpauthUri` as a QR code; show `secret` for manual entry.
2. The user scans it and types the current code: `confirmMfaEnrollment(code)` → `{ recoveryCodes }` (10 codes). Show them once and ask the user to store them; they are never returned again. Two-factor authentication is on from now, and this session counts as freshly verified.

**Sign-in flow** (password, Google or Facebook)
1. `signIn` fails with `UNAUTHENTICATED`, `reason: "MFA_REQUIRED"`, `extensions.mfaChallenge` (valid 5 minutes, not usable as an access token).
2. `completeMfaSignIn(input: { challenge, code })` with a 6-digit code or a recovery code (case, spaces and dashes ignored; each works once) → `AuthEntity`. The new session counts as freshly verified.

**Step-up.** These operations additionally need a two-factor verification **of the current session** in the last 10 minutes (`stepUp`, `completeMfaSignIn` or `confirmMfaEnrollment`), otherwise `FORBIDDEN` with `reason: "STEP_UP_REQUIRED"`. The operation is not performed; call `stepUp(code)` and retry. All are audited.

| Kind | Operations |
|---|---|
| Role and permission changes | `assignStaffRole`, `removeStaffRole`, `createStaffRole`, `updateStaffRole`, `createUser` with `role: ADMIN` |
| Refunds | `refundReturn`, `processPendingRefund`, `refundOrder` |
| Price changes | `updateProduct` when `isTaxable` is sent (it reprices every variant), `updateVariant` when `basePrice` is sent, every discount and coupon mutation, `createTax` / `updateTax` / `deleteTax`, `createRateRule` / `updateRateRule` / `deleteRateRule` (P5-A.1) |
| Data exports | `addresses` without `userId` |

A refreshed access token keeps its session, so a verification survives `refreshToken`; a new sign-in starts a new session. Tokens issued before this release have no session id: sign in again before stepping up.

```typescript
{ secret: string; otpauthUri: string }   // MfaEnrollment
{ recoveryCodes: string[] }              // MfaRecoveryCodes
{ validUntil: DateTime }                 // StepUpResult
User.mfaEnabled: boolean                 // The user themself or user.view
```

#### `startMfaEnrollment`
- **Type**: Mutation · **Auth**: any signed-in user · **Rate Limit**: 5/minute
- **Response**: `MfaEnrollment!`. Starting again before confirming replaces the secret.
- **Possible Errors**: `CONFLICT` (already enabled), `UNAUTHENTICATED`.

#### `confirmMfaEnrollment`
- **Type**: Mutation · **Auth**: any signed-in user · **Rate Limit**: 5/minute
- **Args**: `code: String!` (current 6-digit code)
- **Response**: `MfaRecoveryCodes!`
- **Side effects**: audit entry (entity `User`, action `MFA_ENABLE`).
- **Possible Errors**: `BAD_REQUEST` ("Invalid two-factor code", or "Start enrolment with startMfaEnrollment first"), `CONFLICT` (already enabled).

#### `completeMfaSignIn`
- **Type**: Mutation · **Auth Required**: No · **Rate Limit**: 5/minute
- **Args**: `input: CompleteMfaSignInInput!` = `{ challenge: string; code: string }` (code 6-32 chars)
- **Response**: `AuthEntity!`
- **Side effects**: using a recovery code writes an audit entry (action `MFA_RECOVERY_CODE_USED`).
- **Possible Errors**: `UNAUTHENTICATED` ("Invalid or expired challenge" → start again with `signIn`; "Invalid two-factor code" → ask again), `BAD_USER_INPUT`.

#### `stepUp`
- **Type**: Mutation · **Auth**: any signed-in user · **Rate Limit**: 5/minute
- **Args**: `code: String!` (6-digit code or recovery code)
- **Response**: `StepUpResult!`
- **Side effects**: audit entry (entity `User`, action `STEP_UP`, `details.method` `totp` or `recovery`).
- **Possible Errors**: `BAD_REQUEST` ("Invalid two-factor code", "Enrol two-factor authentication first"), `UNAUTHENTICATED` (token without a session id: sign in again).

### 2.26 Product types and attributes

Every product has a **product type** (ADR-0002) that defines the attributes it carries. Attributes marked `isVariantAxis` are chosen per variant (`Variant.optionValues`, e.g. size and colour); the others describe the product (`Product.attributes`, e.g. warranty or material). Both are JSON objects keyed by attribute key and are validated against the type when a product or variant is saved.

Two **system types** exist and are read-only: **General** (`id: "product_type_general"`, no attributes; the default for every product) and **Apparel** (`id: "product_type_apparel"`: `size` and `colour`, both TEXT variant axes, optional, filterable).

```typescript
{
  id: string; key: string; name: string; description?: string; isSystem: boolean; createdAt: DateTime; updatedAt: DateTime;
  attributes: AttributeDefinition[];          // in display order (position, then key)
}                                             // ProductType
{
  id: string; productTypeId: string;
  key: string;                                // lower-case, a-z 0-9 _, starts with a letter, <= 50 chars
  label: string; dataType: 'TEXT' | 'NUMBER' | 'BOOLEAN';
  unit?: string;                              // NUMBER only, e.g. "g", "GB"
  isRequired: boolean;
  allowedValues: string[];                    // empty = any value of the data type
  isVariantAxis: boolean; isFilterable: boolean; position: number;
}                                             // AttributeDefinition
```

#### `productTypes` / `productType`
- **Type**: Query · **Auth Required**: No
- **Args**: `productType(id: ID!)`
- **Response**: `[ProductType!]!` (by name) / `ProductType!`
- **Possible Errors**: `NOT_FOUND` (unknown id).

`Product.productType` and `Product.productTypeId` return the same type for a product.

**Setting a product's type and attributes:** `createProduct` and `updateProduct` take `productTypeId?: string` (default General) and `attributes?: JSONObject`. Attributes are checked against the type's non-axis definitions and stored normalised: TEXT is trimmed and matched case-insensitively to an allowed value; NUMBER takes a number, a decimal string or `{ value, unit }` in the definition's unit and is stored as a number; BOOLEAN takes `true`/`false` (or those strings). Unknown keys, variant axes, missing required attributes and wrong types are refused with `BAD_REQUEST` listing every problem, e.g. `Invalid attributes for product type "phone": warranty_months must be a number of months`. `updateProduct` replaces the whole map when `attributes` is sent; changing `productTypeId` re-checks the attributes and every variant's option values against the new type (`BAD_REQUEST` naming the variant that does not fit).

#### `createProductType`
- **Type**: Mutation · **Auth**: `catalog.taxonomy.write`
- **Args**: `input: CreateProductTypeInput!` = `{ key: string; name: string (1-100); description?: string (<= 500); attributes?: AttributeDefinitionInput[] (<= 50) }`
- `AttributeDefinitionInput` = `{ key; label (1-100); dataType; unit?: string (1-20); isRequired = false; allowedValues?: string[] (<= 200, each <= 100 chars); isVariantAxis = false; isFilterable = false; position = 0 (0-1000) }`
- **Response**: `ProductType!` · **Side effects**: audit entry (entity `ProductType`, action `CREATE`).
- **Possible Errors**: `CONFLICT` (key taken), `BAD_REQUEST` (repeated attribute keys), `BAD_USER_INPUT`, `FORBIDDEN`.

#### `updateProductType` / `deleteProductType`
- **Type**: Mutation · **Auth**: `catalog.taxonomy.write`
- **Args**: `id: ID!`; update also `input: UpdateProductTypeInput!` = `{ name?; description? }` (the key never changes)
- **Response**: `ProductType!` · **Side effects**: audit entry (`UPDATE` / `DELETE`).
- **Possible Errors**: `CONFLICT` (system type; delete of a type any product uses), `NOT_FOUND`, `FORBIDDEN`.

#### `setProductTypeReturnPolicy` (P6-R.1)
- **Type**: Mutation · **Auth**: `catalog.taxonomy.write`
- **Args**: `id: ID!`, `input: ProductTypeReturnPolicyInput!` = `{ returnable: Boolean!; returnWindowDays?: Int | null }` (0-365; null or omitted: the store's `returnWindowDays`). Allowed on system types too.
- **Response**: `ProductType!` (new fields `returnable: Boolean!`, `returnWindowDays: Int`) · **Side effects**: audit entry (`UPDATE` with the changes).
- `returnable: false` refuses every return of its products (`NOT_RETURNABLE`), e.g. perishables, hygiene and digital goods.

#### `addAttributeDefinition` / `updateAttributeDefinition` / `removeAttributeDefinition`
- **Type**: Mutation · **Auth**: `catalog.taxonomy.write`
- **Args**: `addAttributeDefinition(productTypeId: ID!, input: AttributeDefinitionInput!)`, `updateAttributeDefinition(attributeId: ID!, input: UpdateAttributeDefinitionInput!)` with `{ label?; unit?; isRequired?; allowedValues?; isFilterable?; position? }` (key, data type and variant-axis flag never change), `removeAttributeDefinition(attributeId: ID!)`
- **Response**: the whole `ProductType!` · **Side effects**: audit entry (entity `AttributeDefinition`).
- **Rules for a type that products use** (so stored values stay valid): new attributes must be optional; an attribute can be relabelled, reordered, made (un)filterable, made optional and given extra allowed values; making it required, changing its unit, narrowing its allowed values and removing it are refused with `CONFLICT`. System types refuse every change.
- **Possible Errors**: `CONFLICT`, `NOT_FOUND`, `BAD_USER_INPUT`, `FORBIDDEN`.

**Capability fields on Product** (typed, for rules later phases enforce; today they are stored and returned only): `requiresPrescription` (pharmacy checkout gate), `isPerishable` and `shelfLifeDays` (expiry tracking with the inventory ledger), `trackLots` (enforced since P4-C.1: lots with expiry, see [Lots and expiry](#lots-and-expiry-p4-c1)) and `trackSerials` (serial tracking, enforced since P4-D.1: see [Serial units](#serial-units-p4-d1)), `fulfilmentKind` (`PHYSICAL` | `DIGITAL` | `SERVICE`, for delivery rules) and `unitOfMeasure` (`EACH` | `KG` | `G` | `L` | `ML` | `M`, for weighable goods). `createProduct` / `updateProduct` accept them (all optional; defaults `false`, `PHYSICAL`, `EACH`; `shelfLifeDays` 1-3650). Physical sizes live on the variant: `weightGrams`, `lengthMm`, `widthMm`, `heightMm`.

### 2.27 Storefront content and SEO (P8-C)

All additions; nothing existing changes shape (not a breaking change). Staff reads need `content.view` (Owner, Manager, Support), staff writes `content.manage` (Owner, Manager); every content write is audited. Public reads are open (optional sign-in) and not cached server-side, so a change shows at once. Upload images first with `POST /upload/single-image` (see [14](#14-file-upload-cloudinary)) and pass the HTTPS URL.

**Slugs and SEO fields.** `Product`, `Category`, `SubCategory`, `Brand` and `Collection` have `slug: String!`, `metaTitle`, `metaDescription` and `ogImageUrl` (all nullable but `slug`). Slugs are unique per kind, lower-case ASCII words joined by hyphens (max 100). On create without a slug, one is made from the name (accents dropped, `&` read as "and", apostrophes dropped; a clash takes `-2`, `-3`, ...; a name with no Latin letters gets `product`, `category`, ...). Existing rows were given slugs the same way. The create/update inputs of these five take the four fields; `slug: null` is `BAD_REQUEST` (omit it to keep the slug), a slug of another entity of the same kind `CONFLICT`, a malformed one `BAD_USER_INPUT`. Changing the name never changes the slug. SEO fields of products use `catalog.product.write`, of categories, sub-categories and brands `catalog.taxonomy.write`.

| Query | Access | Notes |
|---|---|---|
| `productBySlug(slug)` | public | active, PUBLISHED product with this **current** slug, else null |
| `categoryBySlug(slug)`, `subCategoryBySlug(slug)`, `brandBySlug(slug)` | public | current slug only |
| `collection(slug)` | public | live collection (see below) with this current slug |
| `resolveSlug(type: SlugEntityType!, slug)` | public | `{ type id slug redirected }`: the entity with this slug, or the entity that **used to** have it (`redirected: true`: answer with a 301 to `/…/<slug>`). Null when unknown or not visible (draft product, collection not live) |

`SlugEntityType`: `PRODUCT`, `CATEGORY`, `SUB_CATEGORY`, `BRAND`, `COLLECTION`. When a slug changes, the old one keeps pointing at the entity, however many times it is renamed. If another entity of the same kind takes an old slug, the new owner wins and the old redirect is gone. Suggested page flow: `productBySlug(slug)`; on null, `resolveSlug(type: PRODUCT, slug)`; redirect when it returns a slug, else 404.

**Collections.** `type` is `MANUAL` (staff pick the products and their order) or `RULE` (products matching `rules`: `categoryId`, `subcategoryId`, `brandId`, `tagId`, `productTypeId`, `priceMin`/`priceMax` (as the product list filters), `onSale`, `inStock`; every rule set must match). `onSale: true` means a visitor sees a reduced price: a live automatic `PERCENT`/`AMOUNT_OFF`/`FIXED_PRICE` item promotion without coupon, customer group or first-order condition, with uses and units left. Live = `isActive` and inside `startsAt` (inclusive) / `endsAt` (exclusive).

| Operation | Access | Notes |
|---|---|---|
| `collection(slug)`, `collections` | public | live only; `collections` by name, at most 100 |
| `Collection.products(paginationArgs, sortArgs)` | public | `ProductConnection` of **published** products. MANUAL: staff order unless `sortArgs.sortBy` is given; RULE: newest first unless sorted. Cursors as the product list |
| `Collection.rules` | public | `CollectionRules` (null for MANUAL) |
| `Collection.productIds` | `content.view` field | the manual list in order, any status |
| `adminCollections`, `adminCollection(id)` | `content.view` | live or not |
| `createCollection(input)` | `content.manage` | `{ name type description imageUrl rules productIds isActive startsAt endsAt slug metaTitle metaDescription ogImageUrl }`; RULE needs at least one rule; MANUAL takes `productIds` (at most 500, no repeats). Unknown ids: `NOT_FOUND`; `priceMin` > `priceMax`, `endsAt` <= `startsAt`: `BAD_REQUEST` |
| `updateCollection(id, input)` | `content.manage` | same fields but `type` and `productIds`; `rules` replaces every rule (RULE only) |
| `setCollectionProducts(id, productIds)` | `content.manage` | replaces a MANUAL collection's list, in order |
| `deleteCollection(id)` | `content.manage` | banners linking to it lose their link; homepage sections showing it are left out |

**Banners.** `Banner { id title subtitle altText imageUrl mobileImageUrl placement position isActive startsAt endsAt link createdAt updatedAt }`. `placement` is a free key in upper case (`HOME_HERO`, `CATEGORY_TOP`, ...; `^[A-Z][A-Z0-9_]*$`, max 50). `link: BannerLink { type targetId slug path url }`, `BannerLinkType` `PRODUCT` / `CATEGORY` / `COLLECTION` (`targetId`; `slug` is the target's current slug), `PATH` (internal path starting with one `/`; a query is allowed; trailing `/` dropped) or `URL` (absolute **https** URL, max 2000). In public reads `link` is null when the linked product is not published or the collection not live; a deleted target removes the link.

| Operation | Access | Notes |
|---|---|---|
| `banners(placement)` | public | live banners by `position`, at most 20 |
| `adminBanners(placement?)` | `content.view` | all, by placement then position |
| `createBanner(input)` / `updateBanner(id, input)` / `deleteBanner(id)` | `content.manage` | `link: { type, targetId \| path \| url }` (exactly the field of its type); `link: null` on update removes it. Unsafe link: `BAD_REQUEST`; unknown target: `NOT_FOUND` |

**Homepage.** `homepage: [HomepageBlock]` (public) returns the live sections by `position` (at most 20), each `{ id type title products categories brands banners text }` with only the list of its type filled; a section left with nothing visible is omitted. `HomepageSectionType` and its `config` (`HomepageSectionConfigInput`, give only the fields of the type):

| Type | Config | Shows |
|---|---|---|
| `PRODUCT_CAROUSEL` | `collectionId`, `productLimit` 1-24 (12) | the first products of a **live** collection, published only |
| `CATEGORY_GRID` | `categoryIds` 1-24, in order | the categories that still exist |
| `BRAND_STRIP` | `brandIds` 1-24, in order | the brands that still exist |
| `BANNER_STRIP` | `bannerPlacement`, `bannerLimit` 1-10 (5) | live banners of the placement |
| `RICH_TEXT` | `text` 1-5000 characters | markdown: headings, bold, italics, lists, links to an internal path or https URL. No HTML, images or other link targets (`BAD_REQUEST`). **Render as markdown with HTML disabled** |

Staff: `homepageSections` (`content.view`, all), `createHomepageSection(input: { type title position config isActive startsAt endsAt })`, `updateHomepageSection(id, input)` (no `type`; a `config` replaces the whole config), `deleteHomepageSection(id)` (`content.manage`).

**Path redirects.** `resolvePath(path)` (public): `{ toPath statusCode }` after following up to 10 redirects (query and trailing `/` of the asked path ignored), `301` only when every hop is permanent, else `302`; null when no redirect starts there. Staff: `pathRedirects` (`content.view`), `createPathRedirect(input: { fromPath toPath statusCode })` (`content.manage`; internal paths only, `fromPath` without query; `statusCode` 301 (default) or 302; `fromPath` already redirecting: `CONFLICT`; a loop: `CONFLICT` with `reason: REDIRECT_LOOP`), `deletePathRedirect(id)`.


---

### 2.28 Bulk imports and exports

P8-I. Staff import products, prices and stock from **CSV** (UTF-8, header row, comma or semicolon separated; Excel's "CSV UTF-8") or **Excel .xlsx** (first sheet, or the sheet named in `sheet`), and export catalogue, stock and orders. Files go over REST (below); jobs are read, applied and cancelled in GraphQL. Nothing here is breaking (all new).

**Flow**: `POST /imports/<kind>` (multipart) → the job is `QUEUED` → the worker validates every row (dry run, nothing changes) → `VALIDATED` with a per-row report → staff call the apply mutation → `APPLYING` → `COMPLETED`. Upload with `apply=true` to skip the review: the valid rows are applied as soon as validation ends. `FAILED` with `error` set means the file could not be read (wrong columns, unreadable workbook) or a run used up its retries; a failed apply can be re-run with the same apply mutation (rows already applied are never applied twice). `CANCELLED`: cancel a `QUEUED` or `VALIDATED` job. Poll `catalogImportJob(id)` / `stockImportJob(id)` for progress.

**Limits**: 10 MB per file (`413` above), 10,000 data rows, 100 columns. The type is read from the bytes, never the file name: macro-enabled workbooks (.xlsm), legacy .xls and anything that is not UTF-8 text or an .xlsx workbook are refused with `400`. The file is stored privately (in the database, never on Cloudinary) only until validation has read it; jobs and their reports are deleted after 30 days.

**Rows**: blank cells leave a field unchanged (an import cannot clear a field); column names are case-insensitive and spaces become `_`. Each row in the report has `status` (`VALID`/`INVALID` after validation; `APPLIED`, `SKIPPED` (nothing to change) or `FAILED` (refused when applied) after), `action` (`CREATE`, `UPDATE`, `NONE`), `errors`, `warnings` and `entityId` (the variant, product or stock movement written). Applying re-checks every row against the catalogue as it is then; a row refused at that point is `FAILED` with the reason, the others still apply.

| Kind | Columns (required in bold) | Rules |
|---|---|---|
| `PRODUCTS` | **`sku`**, `product_id`, `product_key`, `name`, `description`, `short_description`, `product_type` (key), `category`, `subcategory`, `brand` (by name), `tags` (names separated by `\|`), `status` (`DRAFT`/`PUBLISHED`/`ARCHIVED`), `is_taxable`, `barcode`, `base_price`, `weight_grams`, `low_stock_threshold`, `is_active`, `attr.<key>` (product attributes), `option.<key>` (variant options) | Keyed by SKU (any letter case). An existing SKU updates its variant and product. A new SKU joins the product `product_id`, else a new product grouped by `product_key` (the SKU when blank); a new product needs `name`, a new SKU needs `base_price` (tax-exclusive; the selling price adds tax when the product is taxable). Attributes and options are checked against the product type exactly like `createProduct`. Categories, brands and tags must exist (never created). Not by import: changing an existing product's type or `is_taxable`, the price of an existing SKU (warning; use `PRICES`), removing tags, opening stock (use `STOCK`), images. The rows of one product are all-or-nothing. Variants created get `PriceChange` rows with source `IMPORT`. |
| `PRICES` | **`sku`**, **`base_price`**, `reason` | Sets the tax-exclusive `basePrice`; `price` follows (tax added for a taxable product). Records `PriceChange` rows with source `IMPORT` (the `reason`, else `Import <job id>`). Uploading and `applyPriceImport` need step-up. Unchanged prices are `SKIPPED`. |
| `STOCK` | **`sku`**, `location` (id or name; blank: the default location), `delta` or `count` (exactly one), `reason`, `note` | `delta`: a signed change with a reason (`DAMAGED`, `LOST`, `EXPIRED` remove; `FOUND` adds; `CORRECTION`, `OTHER` either way; `OTHER` needs a note). `count`: the counted quantity; the change is count minus on-hand (reason default `CORRECTION`). Written as `ADJUSTMENT` stock movements with `refType: "ImportJob"`, never below what is reserved. Lot- or serial-tracked products are refused per row (adjust them in the admin, naming lots/serials). |

#### `catalogImportJobs` / `stockImportJobs` (Query)
**Auth**: `catalog.import` / `inventory.import`. **Arguments**: `first: Int = 20` (max 100), `after: String` (job id). **Returns** `ImportJobPage { nodes: [ImportJob!]!, totalCount, hasNextPage }`, newest first; product and price jobs on the first, stock jobs on the second.

#### `catalogImportJob(id: ID!)` / `stockImportJob(id: ID!)` (Query)
**Auth**: as above (`NOT_FOUND` for a job of the other kind). **Returns** `ImportJob`:
```graphql
{ catalogImportJob(id: "…") {
    id kind status format fileName sheetName fileSize applyAfterValidation
    totalRows validRows invalidRows appliedRows skippedRows failedRows error
    createdById appliedById createdAt validatedAt completedAt cancelledAt
    rows(status: INVALID, first: 50, after: null) { totalCount hasNextPage nodes { id rowNumber sku status action errors warnings entityId appliedAt } }
} }
```

#### `applyProductImport(id)` / `applyPriceImport(id)` / `applyStockImport(id)` (Mutation)
**Auth**: `catalog.import` (prices: also step-up) / `inventory.import`. Starts applying a `VALIDATED` job (or re-runs a `FAILED` apply). **Returns** the `ImportJob` (`APPLYING`). **Errors**: `NOT_FOUND`, `CONFLICT` (not validated), `FORBIDDEN` + `STEP_UP_REQUIRED`. Audited.

#### `cancelCatalogImport(id)` / `cancelStockImport(id)` (Mutation)
**Auth**: `catalog.import` / `inventory.import`. Cancels a `QUEUED` or `VALIDATED` job. **Errors**: `NOT_FOUND`, `CONFLICT`. Audited.

#### REST: uploads, templates, reports and exports
All need a Bearer token; downloads take `?format=csv` (default) or `xlsx` and are sent as attachments. Text cells starting with `=`, `+`, `-`, `@`, tab or carriage return get a leading `'` in every download (formula injection), except plain numbers such as `-3`.

| Route | Permission | Notes |
|---|---|---|
| `POST /imports/products` | `catalog.import` | multipart: `file` (required), `sheet` (xlsx only), `apply` (`"true"`/`"false"`, default false). `201` with the job (same fields as `ImportJob`). `400` for a missing, empty, macro-enabled or unsupported file or a `sheet` on a CSV; `413` above 10 MB. Throttled (10 per minute). |
| `POST /imports/prices` | `catalog.import` + step-up | as above |
| `POST /imports/stock` | `inventory.import` | as above |
| `GET /imports/products/template`, `/imports/prices/template` | `catalog.import` | header and one example row |
| `GET /imports/stock/template` | `inventory.import` | |
| `GET /imports/catalog/:id/report`, `/imports/stock/:id/report` | `catalog.import` / `inventory.import` | columns `row, sku, status, action, errors, warnings, entity_id` |
| `GET /exports/products` | `catalog.export` | one row per variant: the products-import columns, `price`, and `on_hand.<location name>` per location |
| `GET /exports/stock` | `catalog.export` | `sku, product_name, location, on_hand, reserved, available` |
| `GET /exports/orders?from=…&to=…` | `order.view` | ISO dates, `[from, to)`, at most 366 days; one row per order (guest orders included): number, date, status, payment status and method, fulfilment, guest, units, totals, currency, delivery zone. No customer data. |
| `GET /exports/orders/with-customers?from=…&to=…` | `order.view` + `customer.data.export` + step-up | adds `customer_name`, `customer_email`, `customer_phone`, `delivery_address` |

Exports are built in one request, at most 50,000 rows (`400` above: narrow the range). Every export is audited (`EXPORT`).

New enum values: `PriceChangeSource.IMPORT`, `JobQueue.IMPORTS` (`failedJobs`/`retryFailedJob`).

---

### 2.29 Persisted queries, GET and CDN caching

P9-C. No schema change and nothing breaking: POST requests behave as before. What is new is how the storefront can make anonymous catalogue reads cacheable by a CDN.

**Automatic persisted queries (APQ).** Apollo's APQ protocol: send `extensions: { persistedQuery: { version: 1, sha256Hash: "<sha256 hex of the query text>" } }` without `query`; if the server does not know the hash it answers `PERSISTED_QUERY_NOT_FOUND`, and the client re-sends once with `query` and the same extension, which registers it. Registered queries are shared by every API instance and expire after 24 hours (a client then re-registers transparently). A hash that does not match the query text is refused (`400`). With Apollo Client: `createPersistedQueryLink({ sha256, useGETForHashedQueries: true })` before the `HttpLink`. There is no safelist yet: any client may register a query; the query limits (depth, aliases, cost) still apply.

**GET.** Queries may be sent as `GET /graphql?query=…` or `GET /graphql?operationName=…&variables=<JSON>&extensions=<JSON>` (URL-encoded). Mutations over GET are refused with `405`. Every GET must carry a non-empty `apollo-require-preflight` (or `x-apollo-operation-name`) header, or it is refused as a possible CSRF (`400`); both headers are allowed by CORS. Apollo Client: `new HttpLink({ uri, headers: { 'apollo-require-preflight': 'true' } })`.

**What a CDN may cache.** A response gets `Cache-Control: public, max-age=60, stale-while-revalidate=30` only when **all** of these hold: it is a GET, it has **no `Authorization` header** (any value), it is a query without errors, every root field is one of the public catalogue queries below, and every field it selects is catalogue data. Everything else gets `Cache-Control: private, no-store`: POSTs, signed-in requests (customer prices, price lists and group promotions differ per customer, so a signed-in response is never cached publicly), mutations, carts, orders and any account data.

| Public catalogue queries | |
|---|---|
| Products | `products`, `product`, `productBySlug`, `productFacets`, `searchSuggestions` |
| Categories and brands | `categories`, `category`, `categoryBySlug`, `subCategories`, `subCategory`, `subCategoryBySlug`, `brands`, `brand`, `brandBySlug` |
| Content | `collections`, `collection`, `homepage`, `banners`, `resolveSlug`, `resolvePath` |
| Store | `storeFeatures`, `loyaltySettings` |

Selecting any of these makes the response uncacheable even for a visitor: `Variant.customerPrice`, `Variant.priceTiers` (customer-specific), `Product.reviews` (use `productReviews` with POST), `Variant.priceHistory` and `Variant.stockLevels` (staff). So for cached product pages, query prices with `price`, `discountedPrice` and `appliedPromotion` (the visitor's view) anonymously, and fetch `customerPrice`/`priceTiers` separately with the customer's token. Mixing a public query with anything else in one document makes the whole response `private, no-store`.

**Freshness.** At most 60 seconds (plus 30 seconds served stale while the CDN revalidates). Catalogue changes (products, variants and prices, stock running out or coming back, categories, brands, tags, product types, collections, banners, the homepage, slugs and redirects, promotions, store settings and features) also purge the CDN within a few seconds once a CDN is configured. Cacheable responses carry `Surrogate-Key` (space separated) and `Cache-Tag` (comma separated) headers naming what they show (`catalogue`, `product:<id>`, `products`, `category:<id>`, `homepage`, ...) and `Vary: Authorization`; the frontend can ignore them.

---

## 3. REST API Reference

These endpoints are not in GraphQL. They use standard HTTP. Errors are JSON: `{ "statusCode": 400, "timestamp": "…", "path": "/payment/initialize", "message": "…" }`.

Bulk import uploads, templates, reports and the CSV/XLSX exports (`/imports/*`, `/exports/*`, P8-I) are listed in [2.28](#228-bulk-imports-and-exports).

### `POST /payment/initialize`

**Auth Required**: Yes (Bearer, any signed-in user; the order must be theirs)
**Rate Limit**: 5 requests/minute (`payment` throttler)
**Content-Type**: `application/json`

**Request Body**:

```typescript
{
  orderId: string;       // Required.
  paymentMethod: "CARD" | "MOBILE_MONEY"; // Required. Stored as Payment.paymentMethod; the checkout offers only that channel.
  currency?: "GHS";      // Optional. Any other value is rejected (400). Payments are always charged in GHS.
  idempotencyKey?: string; // Optional, 1-255 chars. Generate one per "Pay" click and resend it on network retries.
}
```

The amount is always the order total at the first initialization; any other field (e.g. `amount`) is rejected with 400.

**Breaking change (P3-A.2):** `paymentMethod` was any string (e.g. `"card"`); it must now be `CARD` or `MOBILE_MONEY` (400 otherwise). The method must be on offer (`availablePaymentMethods`): a switched-off method, or no Paystack configuration at all, is refused with 400 (`Card payment is not available at this store` / `Mobile money payment is not available at this store`) before any attempt is opened.

**Rules**:

- Only the owner's `PENDING`, non-deleted, online-payment order can be paid. A cancelled, processing, shipped or delivered order returns 400, a cash-on-delivery order returns 400, an already paid order returns 400 (`Payment for this order has already been completed`), a missing or deleted order returns 404, and another user's order returns 403.
- Each call without a known key opens a **new attempt** with its own reference. The previous pending attempt is marked `CANCELLED`; it is kept, and if the customer still completes that older checkout the payment is matched.
- Repeating an `idempotencyKey` for the same order returns the same attempt and the same `authorizationUrl` without opening a new checkout. It returns **409** if that attempt is still being set up (retry shortly) or is no longer `PENDING` (use a new key).
- If Paystack cannot open the checkout the request fails and the same key may be retried.
- **Velocity checks (P3-E.1):** too many payment attempts in a short time from the same account or IP address, or too many failed payments on the account, return **403** with `"reason": "VELOCITY_LIMIT"` before any attempt is opened. A repeated `idempotencyKey` is not counted as a new attempt.
- The checkout is opened with the provider the store configured for the method (Paystack), limited to that channel (`card` or `mobile_money`). Paystack's `callback_url` is the store's configured callback URL, else `PAYSTACK_CALLBACK_URL` (a frontend page; see [Section 8](#8-payment-integration-paystack)).

**Response** (`201`): the payment attempt plus `authorizationUrl`. Decimal amounts are JSON strings here.

```json
{
  "id": "clx_attempt",
  "orderId": "clx_order",
  "amount": "29.99",
  "currency": "GHS",
  "paymentMethod": "CARD",
  "status": "PENDING",
  "transactionId": "clx_order-1731900000000-a1b2c3d4",
  "paymentDetails": { "reference": "clx_order-1731900000000-a1b2c3d4", "access_code": "..." },
  "createdAt": "2026-11-18T10:00:00.000Z",
  "updatedAt": "2026-11-18T10:00:00.000Z",
  "deleted": false,
  "deletedAt": null,
  "order": { "id": "clx_order", "status": "PENDING", "...": "raw order record" },
  "authorizationUrl": "https://checkout.paystack.com/..."
}
```

`transactionId` is the Paystack reference that `verifyPayment` takes. **Frontend must redirect** the user to `authorizationUrl` to complete payment on Paystack.

---

### `POST /payment/guest/initialize`

**Auth Required**: No: the order access token from `createGuestOrder` authorises it (P6-G.1)
**Rate Limit**: 5 requests/minute (`payment` throttler)
**Content-Type**: `application/json`

**Request Body**:

```typescript
{
  orderAccessToken: string; // Required: createGuestOrder.orderAccessToken.
  paymentMethod: "CARD" | "MOBILE_MONEY"; // Required.
  currency?: "GHS";
  idempotencyKey?: string;  // Optional, 1-255 chars.
}
```

Same rules and response as [`POST /payment/initialize`](#post-paymentinitialize), with the guest order in place of the customer's: a token of no guest order is **404**; velocity checks count per verified phone and IP address. The checkout is opened with the order's `contactEmail`; a guest who gave none is sent to Paystack (which requires an email) as `guest-order-<orderId>@<FRONTEND_URL host>`. Confirm the payment after the redirect with `verifyGuestPayment`.

---

### `POST /payment/webhook`

**Auth Required**: No (verified by HMAC signature)
**Description**: Paystack webhook. Must be registered in Paystack dashboard.

**Headers required**:
- `x-paystack-signature: <hex HMAC-SHA512 of the raw request body, keyed with the store's Paystack secret key: the one set with setPaystackConfig, else PAYSTACK_SECRET_KEY>` (Paystack sends this automatically)
- `Content-Type: application/json`

**Body**: Paystack's event JSON, `{ event: string; data: { id?, reference?, amount?, currency?, status?, ... } }`. The signature is checked over the exact bytes received, so any proxy or gateway in front of the API must forward the body unmodified (no re-encoding, re-formatting or compression changes).

**Responses**:
- `200 OK`: the event is stored. A settling event is then processed by the background worker (queue `WEBHOOKS`, retried with exponential backoff); an unhandled type or a duplicate of an event already processed needs no processing.
- `400`: empty body, or a signed body that is not `{ event, data }` JSON.
- `401`: missing or invalid signature, or Paystack is not configured at all (no stored keys and no `PAYSTACK_SECRET_KEY`), so no signature can be checked. Nothing is stored.

The endpoint no longer answers `503` when processing fails: the stored event is retried by the queue, and the 5-minute payment sweep reprocesses any stored event still unprocessed.

**Handled Events** (each delivery is stored once per event type and Paystack `data.id`, or `data.reference` when there is no id; repeats are no-ops):
- `charge.success` → re-verifies the reference with Paystack; marks payment `CAPTURED`, order status → `CONFIRMED` (same rule as `verifyPayment`).
- `charge.failed` → re-verifies; marks payment `FAILED`.
- `charge.dispute.create` / `charge.dispute.remind` / `charge.dispute.resolve` (P3-E.2) → creates or updates the [dispute](#disputes-and-chargebacks-p3-e2) of the transaction (`data.transaction.reference`). Keyed per dispute id and `data.updatedAt`, so each reminder is processed once and a redelivery is a no-op. Only the validated dispute fields are stored (no customer or card data). A signed dispute body without a valid dispute id, transaction reference, amount (`refund_amount`, subunits) or currency gets `400` and nothing is stored.
- All other events: stored and acknowledged (`200 OK`) but not processed.

---

### `POST /upload/single-image`

**Auth Required**: Yes (Bearer, `ADMIN` or `SUPER_ADMIN`; customers get 403)
**Rate Limit**: 10 uploads/minute
**Content-Type**: `multipart/form-data`
**Field name**: `file`
**Limits**: JPEG, PNG or WebP only (detected from the file bytes, not the name or MIME type), at most 5 MB and 40 megapixels

**Response** (`201`):

```json
{
  "url": "https://res.cloudinary.com/your-cloud/image/upload/ecommerce/...",
  "public_id": "ecommerce/abc123"
}
```

**Errors**: 400 for a missing file, an unsupported format, an unreadable header or more than 40 megapixels; 413 for a file over 5 MB; 401/403 for auth.

---

### `POST /upload/multiple-images`

**Auth Required**: Yes (Bearer, `ADMIN` or `SUPER_ADMIN`)
**Rate Limit**: 10 uploads/minute
**Content-Type**: `multipart/form-data`
**Field name**: `files` (1–3 files)
**Limits**: same as single image, per file

**Response** (`201`):

```json
{
  "message": "Product images uploaded successfully",
  "files": [
    { "url": "https://res.cloudinary.com/...", "public_id": "ecommerce/abc123" },
    { "url": "https://res.cloudinary.com/...", "public_id": "ecommerce/abc456" }
  ]
}
```

**Errors**: as single image; one bad file rejects the whole request.

---

### `GET /health`

**Auth Required**: No
**Description**: Full dependency report (`@nestjs/terminus` format): database, Redis and Cloudinary. `200` when all are up, `503` if any is down. Redis is probed with `PING`.

---

### `GET /health/ready`

**Auth Required**: No
**Description**: Readiness: database and Redis only (a Cloudinary outage does not fail it). `200` or `503`.

---

### `GET /health/live`

**Auth Required**: No
**Description**: Liveness: checks no dependencies. Always `200` with `{ "status": "ok", "timestamp": "<ISO date>" }` while the process serves requests.

---

### `GET /`

**Auth Required**: Yes (Bearer; there is no `@Auth(AuthType.None)` on it)
**Description**: Returns the string `Hello World!`. Not used by the frontend.

---

## 4. Types & Enums

The GraphQL schema (`schema.gql`) is the contract; the database models behind it are not exposed and are not documented here. Generate client types from `schema.gql` (e.g. GraphQL Code Generator) rather than copying them by hand.

### Scalars

| Scalar | Format |
|---|---|
| `DateTime` | ISO 8601 string in UTC, e.g. `2026-11-18T09:54:33.000Z` |
| `JSON` | Any JSON value (used for address/pickup snapshots and `Payment.paymentDetails`) |
| `Decimal` | Exact decimal as a string, e.g. `"12.50"`, `"0.15"` (no exponent). Used for money inputs, tax rates and discount/coupon `value`. See [Money](#money) |
| `Float` | Only stock quantities (`OrderItem.quantity`) and address coordinates (`Address.latitude`/`longitude`); never money |

### Money

**Breaking change (P1-S.4):** every money field that was a `Float` is now a `Money` object, and every money input or argument that was a `Float` (or the `basePrice` string) is now a `Decimal` string. Field names are unchanged.

```graphql
type Money {
  amount: String!      # always exactly 2 decimal places, e.g. "480.00"
  currency: Currency!  # the store currency (storeSettings.currency), e.g. GHS
}
```

- **Reading money:** select `{ amount currency }`, e.g. `order { grandTotal { amount currency } }`. Keep `amount` as a string or parse it with a decimal library; do not add amounts as JS numbers.
- **Sending money (`Decimal` scalar):** a JSON string of digits with an optional leading `-` and decimal point, e.g. `"12.50"`. Exponent notation (`"1e3"`), `"NaN"`, `"Infinity"`, other text and JSON numbers (`12.5`) are rejected with `BAD_USER_INPUT`, as are money amounts with more than 2 decimal places, negative amounts and amounts of 1,000,000,000,000 or more. The client never chooses a currency: amounts are in the store currency.
- **Decimal outputs:** `Tax.rate` (e.g. `"0.15"`), `Coupon.value` and `Discount.value` (a percent for `PERCENTAGE`, an amount for `FLAT`, so not `Money`) are `Decimal` strings without trailing zeros (`"10"`, `"12.5"`).
- **Rounding:** one rule everywhere: half-up (half away from zero) to 2 decimal places, per line and per component (e.g. a 10% coupon on 59.98 is 6.00). This rule is pending confirmation by the store's tax adviser.

| Changed fields (output, `Float` → `Money`) |
|---|
| `Order.subtotal`, `discountTotal`, `taxTotal`, `shippingTotal`, `grandTotal`; `OrderAdjustment.amount` |
| `OrderItem.unitListPrice`, `unitDiscount`, `unitNet`, `unitTax`, `lineTotal`; `OrderLineTax.base`, `amount` |
| `CartItem.originalPrice` (`Cart.total`, `discountTotal`, `finalTotal` and `CartItem.discountedPrice` were also converted, then removed in P2-A.2) |
| `Variant.price` (`Product.price`, `basePrice`, `currentPrice`, `discountedPrice` were also converted, then removed in P1-V.3) |
| `Payment.amount`; `RefundEntity.amount`; `ReturnRequest.refundAmount` (was `ReturnRequestEntity`) |
| `Coupon.minimumOrderAmount`; `CouponValidation.discountAmount`; `Discount.minimumPurchase` |
| `ShippingZoneEntity.fee`; query `getShippingFee` (`Float!` → `Money!`; both removed in P5-A.1, see `RateRule.baseFee`) |
| `SalesReport.grossRevenue`, `refunds`, `netRevenue`, `totalRevenue`, `itemSales`, `averageOrderValue` (reshaped in P8-A, see [2.19](#219-analytics)) |
| `DashboardSummary.revenueToday`, `grossRevenueToday`, `refundsToday`; `TopProduct.totalRevenue`; `RevenueByCategoryEntity.totalRevenue` (both removed in P8-A) |

Money fields added since: `Variant.basePrice` (P1-V.4), `Variant.discountedPrice`, `Product.priceRange.min` / `max` (P1-V.3); the P8-A report amounts (`SalesFigures`, `MarginFigures`, `TopProduct`/`TopCategory`, `CohortMonth.netRevenue`, `InventoryValuation.value`, `PromotionPerformance`).

| Changed fields (output, `Float` → `Decimal`) |
|---|
| `Coupon.value`, `Discount.value`, `TaxEntity.rate` |

| Changed inputs and arguments (→ `Decimal`) |
|---|
| `CreateVariantInput.basePrice` / `UpdateVariantInput.basePrice` / `VariantFieldsInput.basePrice` (the product's `basePrice` input moved to its variants in P1-V.3; the variant `price` input became `basePrice` in P1-V.4) |
| `CreateCouponInput.value`, `minimumOrderAmount`; `UpdateCouponInput.value`, `minimumOrderAmount`; `ValidateCouponInput.orderTotal` |
| `CreateDiscountInput.value`, `minimumPurchase`; `UpdateDiscountInput.value`, `minimumPurchase` (both must be greater than 0) |
| `CreateShippingZoneInput.fee`, `UpdateShippingZoneInput.fee` (removed in P5-A.1: `CreateRateRuleInput.baseFee`, `freeAbove`, `weightBands.fee`) |
| `CreateTaxInput.rate`, `UpdateTaxInput.rate` (0 to 1, at most 6 decimal places) |
| `ApproveReturnInput.refundAmount` (removed in P6-R.1) |
| `ProductFilterArgs.priceMin`, `priceMax` |

### Enums

| Enum | Values | Used by |
|---|---|---|
| `Role` | `USER`, `ADMIN`, `SUPER_ADMIN` | `CreateUserInput.role`, `UserPaginateArgs.role` (`User.role` is a plain `String`) |
| `OrderStatus` | `PLACED`, `CONFIRMED`, `IN_FULFILMENT`, `COMPLETED`, `CANCELLED`, `EXPIRED`, `PAYMENT_REVIEW` | `Order.status`, `OrderStatusEvent.from/to` |
| `ShipmentStatus` | `PENDING`, `PICKING`, `PACKED`, `READY_FOR_PICKUP`, `OUT_FOR_DELIVERY`, `DELIVERED`, `FAILED_DELIVERY`, `RETURNED` | `Shipment.status`, `UpdateShipmentStatusInput.status` |
| `OrderPaymentStatus` | `PENDING`, `CAPTURED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `FAILED`, `CANCELLED` | `Order.paymentStatus` |
| `OrderAdjustmentType` | `DISCOUNT`, `COUPON` | `OrderAdjustment.type` |
| `FulfillmentType` | `DELIVERY`, `PICKUP` | `Order`, `CreateOrderInput` |
| `GhanaRegion` | `AHAFO`, `ASHANTI`, `BONO`, `BONO_EAST`, `CENTRAL`, `EASTERN`, `GREATER_ACCRA`, `NORTH_EAST`, `NORTHERN`, `OTI`, `SAVANNAH`, `UPPER_EAST`, `UPPER_WEST`, `VOLTA`, `WESTERN`, `WESTERN_NORTH` | `Address.region`, address inputs |
| `OrderPaymentMethod` | `ONLINE`, `CASH_ON_DELIVERY` | `Order`, `CreateOrderInput` |
| `PaymentStatus` | `PENDING`, `CAPTURED`, `FAILED`, `CANCELLED` | `Payment.status` |
| `ReturnStatus` (was `ReturnStatusEnum`) | `REQUESTED` (was `PENDING`), `APPROVED`, `REJECTED`, `RECEIVED`, `INSPECTED`, `REFUND_PENDING`, `REFUNDED`, `EXCHANGED`, `CANCELLED` | `ReturnRequest.status`, `CustomerReturn.status`, `returns(status)` |
| `ReturnReason` | `DAMAGED`, `DEFECTIVE`, `WRONG_ITEM`, `NOT_AS_DESCRIBED`, `CHANGED_MIND`, `SIZE_FIT`, `OTHER` | `ReturnLine.reason` |
| `ReturnResolution` | `REFUND`, `EXCHANGE` | `ReturnRequest.resolution`, `RequestReturnInput.resolution` |
| `RefundStatusEnum` | `PENDING` (recorded, not sent), `SENDING` (sent, outcome unknown if it stays), `PROCESSED` (accepted by Paystack), `FAILED` (refused, can be resent) | `RefundEntity.status`, `refunds(status)` |
| `StockMovementReason` | `OPENING_BALANCE`, `RECEIPT`, `SALE`, `RETURN_RESTOCK`, `ADJUSTMENT`, `TRANSFER`, `RESERVE`, `RELEASE` | `StockMovement.reason`, `stockMovements(reason)` |
| `DiscountType` | `PERCENTAGE`, `FLAT` | `Discount.type`, discount inputs |
| `DiscountTypeEnum` | `PERCENTAGE`, `FLAT` | `Coupon.discountType`, coupon inputs (a separate enum with the same values) |
| `ProductStatus` | `DRAFT`, `PUBLISHED`, `ARCHIVED` | `Product.status`, product inputs, `ProductFilterArgs.status` |
| `SearchSynonymKind` | `TWO_WAY`, `ONE_WAY` (P6-S.4) | `SearchSynonym.kind`, `SearchSynonymInput.kind` |
| `Currency` | `GHS`, `USD`, `EUR`, `GBP`, `NGN` | `Product.currency` (only products in the store currency, GHS, can be checked out) |
| `DeliveryOptions` | `LOCAL_DELIVERY`, `INTERNATIONAL_DELIVERY`, `SELECTED_REGIONS` | `Product.deliveryOptions` (informational; not enforced at checkout) |
| `ProductSortField` | `RELEVANCE` (P6-S.1), `CREATED_AT`, `NAME`, `UPDATED_AT` (`PRICE` and `QUANTITY` removed in P1-V.3) | `ProductSortArgs.sortBy` |
| `SortOrder` | `ASC`, `DESC` | `ProductSortArgs.sortOrder` |

### Where each object type is described

| Type | Section |
|---|---|
| `AuthEntity` | [2.1](#21-authentication-iam) |
| `User`, `UserConnection`, `UserEdge`, `PublicProfile` | [2.2](#22-users), [2.17](#217-reviews) |
| `Product`, `PriceRange`, `ProductConnection`, `ProductEdge`, `ProductFacets`, `FacetCount`, `AttributeFacet`, `AttributeFacetValue`, `AttributeFilterInput`, `SearchSuggestions`, `Suggestion` | [2.3](#23-products) |
| `ProductType`, `AttributeDefinition` | [2.26](#226-product-types-and-attributes) |
| `Category`, `SubCategory`, `Brand`, `Tag`, `Variant` | [2.4](#24-categories)–[2.8](#28-variants) |
| `Cart`, `CartItem`, `Wishlist` | [2.9](#29-cart), [2.10](#210-wishlist) |
| `Order`, `OrderItem` | [2.11](#211-orders) |
| `Payment` | [2.12](#212-payment) |
| `Coupon`, `CouponValidation`, `Discount` | [2.13](#213-coupons), [2.14](#214-discounts) |
| `StockMovement`, `StockMovementPage` | [2.15](#215-inventory) |
| `ReturnRequest`, `CustomerReturn`, `ReturnLine`, `RefundEntity` | [2.16](#216-returns) |
| `Review` | [2.17](#217-reviews) |
| `TaxEntity` | [2.18](#218-tax) |
| `SalesReport`, `SalesFigures`, `TopProduct`, `TopCategory`, `MarginReport`, `ConversionReport`, `Cohort`, `InventoryValuation`, `PromotionPerformance`, `AnalyticsRebuild`, `DashboardSummary` | [2.19](#219-analytics), [16](#16-analytics-queries) |
| `Address` | [2.20](#220-addresses) |
| `ShippingZoneEntity`, `PickupLocationEntity` | [2.21](#221-shipping-zones--pickup-locations) |
| `PageInfo`, `PaginationArgs` | [13](#13-pagination--filtering) |

### Relationships and deletion

- A **User** has one **Cart**, one **Wishlist**, many **Orders**, **Addresses**, **Reviews** and **ReturnRequests**.
- A **Product** has one **ProductType**, optionally belongs to one **Category**, **SubCategory** and **Brand**; has many **Tags**, **Variants** (at least one), **Reviews** and **Discounts**. A **Variant** (SKU) is what cart lines, order lines and inventory logs reference.
- An **Order** belongs to one **User**; a `DELIVERY` order references an **Address** and a `PICKUP` order a **PickupLocation** (both also snapshotted on the order); it has many **OrderItems**, payment attempts and **ReturnRequests**, and optionally one **Coupon**.
- A **Discount** can apply to many **Products**, **Variants** and **Categories**.
- A **Coupon** can be used once per user and once per order.
- Soft-deleted (hidden, not removed): orders (`deleteOrder`), payments (`softDeletePayment`), users (`archiveUser` deactivates). Everything else that has a delete operation is removed permanently; deleting something still referenced (e.g. an address or pickup location used by an order, a used coupon, a category with subcategories) is refused with `CONFLICT`.

---

## 5. Authentication & Authorization

### JWT Payload Structure

The access token payload (decoded):

```json
{
  "sub": "userId",
  "aud": "JWT_TOKEN_AUDIENCE value",
  "iss": "JWT_TOKEN_ISSUER value",
  "jti": "random UUID",
  "iat": 1704067200,
  "exp": 1704070800
}
```

The token carries no role: the server loads the user (role, `isActive`) from the database on every request. The refresh token has the same claims plus `sessionStart` (sign-in time, seconds), signed with `JWT_REFRESH_SECRET`. The reset token adds `"purpose": "password-reset"` and is signed with `JWT_RESET_SECRET`.

### Token TTLs (defaults, configurable)

| Token | Default TTL | Variable |
|---|---|---|
| Access token | 3600 seconds (1 hour) | `JWT_ACCESS_TOKEN_TTL` |
| Refresh token | 86400 seconds (24 hours), never past the session limit | `JWT_REFRESH_TOKEN_TTL` |
| Session (sign-in to last possible refresh) | 30 days | fixed |
| Reset token | 900 seconds (15 minutes) | `JWT_RESET_TOKEN_TTL` |
| Email verification token | 24 hours | fixed |

### Events that end every session of a user

Password change (`changeUserPassword`), password reset (`resetPassword`), a completed email change (`verifyEmail`), `archiveUser`, and replay of an already-rotated refresh token. Existing access tokens keep working until they expire (up to 1 hour), except for an archived user, whose access tokens stop working at once.

### Guards

1. **`AuthenticationGuard`** (global): reads `@Auth()` metadata; default `AuthType.Bearer`, `AuthType.None` makes an operation public.
2. **`AccessTokenGuard`**: verifies the JWT, loads the user, rejects missing/inactive users with `UNAUTHENTICATED`.
3. **`RolesGuard`** (global): compares `@Roles()` metadata with `user.role`. A method-level `@Roles` replaces the resolver-level one.
4. **`GqlThrottlerGuard`** (global): rate limits (see [Platform rules](#platform-rules)).
5. Field middleware: owner-or-admin fields (`User.email`, `User.emailVerified`, `User.pendingEmail`, `User.phoneNumber`, `User.addresses`, `User.orders`, `Order.user`) return `FORBIDDEN` for other users. Guards do not run on other nested fields.

### Roles

There is **no role hierarchy**. Each operation lists the roles it accepts, and a role not in the list gets `FORBIDDEN`. Most admin operations accept both `ADMIN` and `SUPER_ADMIN`; the exceptions are noted per operation (`createUser` is `SUPER_ADMIN` only; `getUserPayment`, `softDeletePayment`, `restorePayment`, `updateSubCategory`, `removeSubCategory` are `ADMIN` only; `cancelOrder`, `createReview`, `updateReview`, `deleteReview`, `verifyPayment`, `getMyPayments` are `USER` only).

### Account Lockout Mechanism

- On failed login: `User.failedLoginAttempts` is incremented.
- After 5 consecutive failures: the account is locked for 15 minutes.
- On locked account login: `UNAUTHENTICATED` error with remaining seconds.
- On successful login: the counter and lock are reset.

### Social Login Flow

**Google**:
1. Client obtains a Google OAuth **access token** (via Google Sign-In SDK).
2. Client calls `signInWithGoogle({ token })`.
3. Backend calls Google's `tokeninfo` and `userinfo` endpoints and verifies `aud === GOOGLE_CLIENT_ID`.
4. If an account is linked to that Google ID → return tokens.
5. If not, and no account has that email → create `User` + link → return tokens. The new account's email starts verified (Google must assert `email_verified`, otherwise `UNAUTHENTICATED`).
6. If an account with that email exists but is not linked → `CONFLICT` (sign in with the password; linking is not built yet).

**Facebook**: Same flow using Facebook's Graph API. Facebook does not assert that the email is verified, so new Facebook accounts start unverified.

### How Frontend Should Store and Send Tokens

**Storage recommendation**: Store `accessToken` in memory (JavaScript variable/state). Store `refreshToken` in an `HttpOnly; Secure; SameSite=Strict` cookie, or alternatively in `localStorage` (less secure but usable). **Never** store access tokens in `localStorage` if XSS is a concern.

**Refreshing**: allow one refresh at a time per browser (use a lock shared across tabs, e.g. `navigator.locks` or a `BroadcastChannel`), and replace the stored refresh token as soon as the response arrives. Sending an old refresh token after rotation logs the user out everywhere.

**Sending tokens**: All authenticated GraphQL requests must include:

```http
Authorization: Bearer <accessToken>
```

### Required Headers for Authenticated Requests

```http
Content-Type: application/json
Authorization: Bearer <accessToken>
```

For file uploads:
```http
Authorization: Bearer <accessToken>
# Content-Type is set automatically by the browser for multipart/form-data
```

---

## 6. Commerce Flows

### Product Browsing Flow

1. Frontend calls `query products(paginationArgs, filterArgs, sortArgs)` — **no auth required**.
2. Response includes cursor-paginated `ProductConnection` with `pageInfo.hasNextPage` and `pageInfo.totalCount`.
3. To load next page: call again with `after: lastCursor` from previous response.
4. Resolved fields (`priceRange`, `totalStock`, `inStock`, `variants` and their `discountedPrice`/`appliedPromotion`, `reviews`) are fetched via DataLoader only when requested.
5. To view a single product: call `query product(productId)` (returns `null` for anything not published). Show its `variants` (each with `optionValues`, `price`, `discountedPrice`, `available`) and let the customer pick one; a product without options has a single variant with `optionValues: {}`.

### Add to Cart Flow

1. User must be authenticated.
2. Frontend calls `mutation addToCart(input: { variantId, quantity })` with the chosen variant's `id`.
3. Backend checks the variant exists, is active and priced, its product is active and `PUBLISHED`, and the variant has enough available stock for the new line quantity (nothing is reserved until checkout).
4. If cart does not exist for user, it is created automatically.
5. If that variant is already in the cart, its line's quantity is incremented.
6. Returns updated `Cart` with all items. Stock is not reserved until `createOrder`.

### Cart Update Flow

1. To change quantity: `mutation updateCartItem(input: { cartItemId, quantity })`. Setting `quantity: 0` removes the item.
2. To remove an item directly: `mutation removeFromCart(cartItemId)`.
3. To empty the cart: `mutation clearCart`.
4. To show per-item discounted prices: `CartItem.variant.discountedPrice`. The totals checkout charges come from `checkoutQuote` once a fulfilment is chosen.

### Checkout Flow

1. Choose fulfilment:
   - `DELIVERY`: the user needs a saved address (`query userAddresses` or `mutation createAddress`). The fee comes with `checkoutQuote` (`delivery`, and `deliveryOptions` per service level); a `BAD_REQUEST` means either the address is incomplete (an address saved before P1-G without region, recipient or phone: ask the customer to complete it with `updateAddress`) or it is not served (`extensions.reason: "DELIVERY_UNAVAILABLE"`: offer pickup or another address).
   - `PICKUP`: list locations with `query activePickupLocations` (public).
2. Price the checkout: `query checkoutQuote(input: { fulfillmentType, shippingAddressId | pickupLocationId, couponCode? })`. Show its lines, coupon, tax, shipping and `grandTotal`; keep its `quoteHash`. Quote again after any change to the cart, fulfilment or coupon.
3. Create the order: `mutation createOrder(input: { fulfillmentType, shippingAddressId | pickupLocationId, couponCode?, contactEmail, contactPhone, paymentMethod?, quoteHash })`. On `CONFLICT` with `extensions.reason: "QUOTE_CHANGED"`, re-run step 2 and ask the customer to confirm the new total.
4. Backend, in one transaction, re-prices the cart from current prices, discounts, coupon, tax rates and shipping, checks it matches `quoteHash`, checks each variant is still sellable and in stock → creates the `Order` (`PLACED` for `ONLINE`, `CONFIRMED` for `CASH_ON_DELIVERY`) with each line's `sku` and `optionValues` → decrements each variant's stock → clears cart → sends confirmation email. A `BAD_REQUEST` naming a variant means the customer must remove or change that cart line.
5. `ONLINE`: continue with the Order Placement Flow within 1 hour, or the order expires. `CASH_ON_DELIVERY`: done; staff fulfil it (`updateShipmentStatus`) and record the cash with `recordCodPayment`.

### Order Placement Flow

1. Order is created (see Checkout Flow above).
2. Frontend initiates payment: `POST /payment/initialize` with `{ orderId, paymentMethod: "CARD" | "MOBILE_MONEY", idempotencyKey }` (`currency` may be omitted; if sent it must be `"GHS"`). Only `PENDING` online orders can be paid.
3. Backend opens a new payment attempt with `status = PENDING` (any earlier pending attempt becomes `CANCELLED`) and returns `authorizationUrl`.
4. Frontend redirects user to `authorizationUrl`.
5. After payment, Paystack redirects the browser to the frontend page configured as `PAYSTACK_CALLBACK_URL`, with `?reference=…` (and `trxref`) in the query string.
6. That page calls `mutation verifyPayment(verifyPaymentInput: { reference })` and shows the result, reading the order's `status` too.

### Payment Flow (Paystack)

See [Section 8](#8-payment-integration-paystack) for full details.

### Webhook Handling Flow

1. Paystack POSTs to `POST /payment/webhook`.
2. Backend verifies the HMAC-SHA512 signature over the raw body using `PAYSTACK_SECRET_KEY` (constant-time compare). A bad signature gets `401` and nothing is stored.
3. The event is stored in the webhook inbox (`WebhookEvent`). A repeat of an event already processed gets `200` and changes nothing.
4. A settling event is queued for the background worker and the backend answers `200 OK` at once. The order may therefore still be `PENDING` for a moment after Paystack's call.
5. On `charge.success` the worker runs the same verification as `verifyPayment` (amount and currency must match; a payment for a cancelled or expired order moves it to `PAYMENT_REVIEW`, one for an already-paid order changes nothing; both are queued for refund). On a valid payment: payment `status → CAPTURED`, order `status → CONFIRMED`, confirmation email queued once.
6. On `charge.failed`: payment `status → FAILED`.
7. Unhandled events are stored and answered `200 OK`.
8. If processing fails (for example Paystack's verify API is down), the worker retries the stored event with exponential backoff; the 5-minute payment sweep is the safety net for anything still unprocessed.

### Inventory Deduction Flow

- On `createOrder`: each line's quantity is **reserved** on its variant's stock with a conditional update inside the order transaction (only while enough is available, the variant is active and its product active and `PUBLISHED`), recorded as a `RESERVE` stock movement.
- On online payment success, or dispatch (`updateShipmentStatus` to `OUT_FOR_DELIVERY` / `READY_FOR_PICKUP`) for cash on delivery: the reservations are consumed (`SALE`).
- On `cancelOrder`, `adminCancelOrder` or expiry: each reservation is released once (`RELEASE`, or `RETURN_RESTOCK` for a paid order not yet dispatched). `deleteOrder` never moves stock.
- Low stock: when a change takes a variant's available stock down to its `lowStockThreshold` (default 5), an `inventory.low_stock.v1` event is raised once; the worker logs it as a warning.

### Return Flow (P6-R.1)

1. Customer (optional photos via `POST /returns/orders/:orderId/photos`): `requestReturn(input: { orderId, resolution, lines: [{ orderItemId, quantity, reason, note?, photoPublicIds?, exchangeVariantId? }] })` → `REQUESTED`. Only delivered units within the return window of their product type.
2. Staff: `approveReturn` → `APPROVED` (or `rejectReturn` with a reason → `REJECTED`). The customer may `cancelReturn` until the goods arrive.
3. Staff: `receiveReturn` (units that arrived per line) → `RECEIVED`.
4. Staff: `inspectReturn` (restock / write off per line; restocked units go back at the order's location) → `INSPECTED`.
5. Staff: `refundReturn` → `REFUND_PENDING` → `REFUNDED` (cash on delivery: `REFUNDED` at once), or `exchangeReturn` → `EXCHANGED` with a replacement order.

Cancelling a paid online order records a `PENDING` refund (reason `ORDER_CANCELLED`) for staff to send with `processPendingRefund`.

### Review Submission Flow

1. Show "Write a review" for products the customer received (a delivered shipment or a completed order); others get `REVIEW_NOT_VERIFIED_PURCHASE`.
2. Call `mutation createReview(input: { productId, score, title?, comment? })`, then upload photos (up to 4) with `POST /reviews/:reviewId/photos`.
3. To update: `mutation updateReview(input: { id, score?, title?, comment? })` (`null` clears a text field).
4. To delete: `mutation deleteReview(reviewId)`: permanently deletes the review.
5. Product pages read `Product.rating` and `Product.reviews(first)`, then page with `productReviews(productId, sort, first, after)`.

---

## 7. Order Lifecycle

```
                createOrder()  →  PLACED (stock reserved)
                   |  payment confirmed (ONLINE) or at once (CASH_ON_DELIVERY)
                   ↓
               CONFIRMED  ── 1 hour unpaid (ONLINE, from PLACED) ──→ EXPIRED
                   |      ── cancelOrder / adminCancelOrder ──────→ CANCELLED
     first updateShipmentStatus step
                   ↓
             IN_FULFILMENT ── adminCancelOrder (goods still in the shop) → CANCELLED
                   |
     shipment DELIVERED (or recordCodPayment for COD)
                   ↓
               COMPLETED
                   |
           requestReturn() (delivered units, per line)
                   ↓
    Return: REQUESTED → APPROVED → RECEIVED → INSPECTED → REFUND_PENDING → REFUNDED | EXCHANGED
                |           |
             REJECTED / CANCELLED

    CANCELLED / EXPIRED ── payment arrives anyway ──→ PAYMENT_REVIEW ── its refund processed ──→ CANCELLED
```

### Status Transitions

| From | To | Trigger | Actor |
|---|---|---|---|
| *(none)* | `PLACED` | `createOrder` | Customer |
| `PLACED` | `CONFIRMED` | Confirmed online payment (`verifyPayment`, webhook, or the 5-minute reconciliation sweep); `createOrder` with `CASH_ON_DELIVERY` | System |
| `PLACED` | `EXPIRED` | Hourly expiry of unpaid `ONLINE` orders | System |
| `PLACED`, `CONFIRMED` | `CANCELLED` | `cancelOrder` / `adminCancelOrder` | Customer or staff (`order.manage`) |
| `CONFIRMED` | `IN_FULFILMENT` | First `updateShipmentStatus` step | Staff (`order.fulfil`) |
| `IN_FULFILMENT` | `COMPLETED` | `updateShipmentStatus(DELIVERED)` of the last shipment (every unit delivered or refunded; also `cancelShipment` of the last open one), or `recordCodPayment` for COD | Staff (`order.fulfil` / `payment.record`) |
| `IN_FULFILMENT` | `CANCELLED` | `adminCancelOrder` while every shipment is `PENDING`/`PICKING`/`PACKED`/`RETURNED`/`CANCELLED` | Staff (`order.manage`) |
| `CANCELLED`, `EXPIRED` | `PAYMENT_REVIEW` | A payment captured after the order closed (refund queued) | System |
| `PAYMENT_REVIEW` | `CANCELLED` | That payment's refund processed (`processPendingRefund`) | Staff (`order.refund`) |
| `COMPLETED` | — | Final | — |

The tables are enforced in code (`src/order/order-status.ts`, `src/order/shipment-status.ts`, `src/payment/payment-intent-status.ts`): every change is a conditional write in one transaction with its side effects and history event; any other change returns `CONFLICT`, and concurrent changes to the same order let exactly one succeed.

---

## 8. Payment Integration (Paystack)

### Step-by-Step Payment Flow

```
Frontend                       Backend                          Paystack
   |                              |                                 |
   |-- POST /payment/initialize ->|                                 |
   |   { orderId, paymentMethod,  |                                 |
   |     idempotencyKey }         |-- transaction/initialize ------>|
   |                              |<- { authorization_url } --------|
   |<- { ...attempt, authorizationUrl, transactionId }              |
   |                              |                                 |
   |-- redirect to authorizationUrl ------------------------------->|
   |                              |                     (user pays) |
   |                              |<- POST /payment/webhook --------|
   |                              |   { event: "charge.success" }   |
   |<- browser redirected to PAYSTACK_CALLBACK_URL?reference=… -----|
   |   (a frontend page)          |                                 |
   |-- mutation verifyPayment({ reference }) ->|                    |
   |<- Payment { status: "COMPLETED", order { status } }            |
```

### Payment Initialization

**Endpoint**: `POST /payment/initialize` (see [Section 3](#post-paymentinitialize)).

The backend calls Paystack's transaction initialize with the order owner's email, the payment intent's amount (the order total when payment was first initialized) converted to pesewas, currency `GHS`, the attempt's own reference, `channels` limited to the chosen method, and `callback_url` = the store's configured callback URL, else `PAYSTACK_CALLBACK_URL`. The customer never sends an amount.

### Webhook Security

The webhook validates the Paystack signature:

```
HMAC-SHA512(rawBody, PAYSTACK_SECRET_KEY) === x-paystack-signature header
```

The comparison is constant-time and uses the exact request bytes, so the body must reach the API unmodified.

**Frontend note**: You do **not** call the webhook. It is server-to-server only.

### Events Handled

| Event | Action |
|---|---|
| `charge.success` | Re-verified with Paystack; on a valid payment `Payment.status → CAPTURED`, `Order.status → CONFIRMED` |
| `charge.failed` | Re-verified; `Payment.status → FAILED` |
| All others | Stored, acknowledged (200 OK), not processed |

A background sweep every 5 minutes also re-checks open attempts with Paystack and processes stored webhook events that failed, so a payment completes even if the webhook and the callback page both fail.

### Frontend Payment Confirmation Strategy

**Option A (recommended)**: On the callback page, call `mutation verifyPayment({ reference })`. The mutation checks with Paystack directly and updates the payment record. If the attempt is still `PENDING` (e.g. MoMo approval), call it again after a few seconds.

**Option B**: Poll `query order(orderId)` (or `payment(id)`) every few seconds until the order leaves `PENDING` (max 3–5 polls with backoff). This works because the webhook often fires before the user returns to the frontend.

**Option C**: Rely on the webhook and the reconciliation sweep — the order page shows the latest order status on load.

---

## 9. Inventory Rules

Stock is held per **variant and location** (ADR-0008) as `onHand` (units in the store) and `reserved` (units held for open orders); `available = onHand - reserved` is what can be sold. All stock is at the store's default location for now. A product has no stock of its own: `Product.totalStock` (available units over active variants) and `Product.inStock` (an active variant has available stock) are computed summaries. Every change is one `StockMovement` in the ledger (see [2.15](#215-inventory)).

### Reservations

- `createOrder` **reserves** each line (`RESERVE`): the units stay on hand but stop being available. The order fails (`BAD_REQUEST`, nothing written) if any line cannot be reserved, so the last unit is sold once.
- An `ONLINE` order's reservation is **consumed** (`SALE`: on-hand and reserved both go down) when its payment succeeds (verify, webhook or the reconciliation sweep).
- A `CASH_ON_DELIVERY` order's reservation is consumed when its shipment is dispatched (`updateShipmentStatus` to `OUT_FOR_DELIVERY` or `READY_FOR_PICKUP`), once. It does not expire.
- Cancelling an order (customer, admin, or the hourly expiry of unpaid `ONLINE` orders) **releases** each reservation exactly once: an unconsumed hold is given back (`RELEASE`); a paid order cancelled before dispatch puts its units back on hand (`RETURN_RESTOCK`), since they never left the store. Cancel is not possible after dispatch.
- A payment that arrives after its order expired does not take stock: the order moves to `PAYMENT_REVIEW` and the payment is flagged for review (`ORDER_NOT_PAYABLE`) and refunded.

### Other stock changes

- `restockVariant`: a delivery (`RECEIPT`), or returned goods with `returnRequestId` (`RETURN_RESTOCK`). A new variant's opening stock (from `createProduct` or `createVariant`) is a `RECEIPT` ("Initial stock"). Lot-tracked products (P4-C.1) receive into a lot with its expiry and have no opening stock.
- Expired lots (P4-C.1) are not sellable and are written off hourly (`ADJUSTMENT`, `EXPIRED`); see [Lots and expiry](#lots-and-expiry-p4-c1).
- `adjustVariantStock`: `ADJUSTMENT` by a signed delta, never below the reserved units.
- Not on `approveReturn`, `processRefund` or `deleteOrder`: returned goods are restocked with `restockVariant`.

### Out-of-Stock Handling

- On-hand stock never goes negative and reserved never exceeds on hand (conditional updates plus database checks).
- Adding to cart and creating an order check the variant's available stock (`BAD_REQUEST` if insufficient). Adding to cart does not reserve.
- Show availability per variant from `Variant.available`, and on product cards from `Product.inStock` / `totalStock`.
- `ProductFilterArgs.inStock: true` returns only products with an active variant that has available stock; `false` those with none.

### Low Stock Logic

- Each variant has a `lowStockThreshold` (default 5), set on `createProduct` (`variants`), `createVariant` or `updateVariant`.
- When a stock change takes a variant's available stock from above its threshold to at or below it, the backend raises an `inventory.low_stock.v1` event once (not again until stock rises above the threshold and falls again). The worker logs it as a warning for alerting; no email is sent yet. The former 6-hourly scan is gone.
- `dashboardSummary.lowStockVariantCount` counts active variants of active products whose available stock is at or below their threshold; `lowStockProductCount` counts active products with at least one of them.

---

## 10. Promotions System

One pricing engine (`src/pricing/price.ts`, ADR-0005) prices `Variant.discountedPrice`, `checkoutQuote` and `createOrder`, so an order's `grandTotal` is exactly the `checkoutQuote.grandTotal` whose `quoteHash` it was sent. An order is priced once, when it is created.

### Which promotions are candidates

A promotion is considered when it is `isActive`, `startsAt <= now <= endsAt` (or no `endsAt`), it has uses left (`usedCount < usageLimit`) and units left (`unitsUsed < unitCap`, P2-B.4) and the customer has uses left (their reserved uses `< perCustomerLimit`), it is open to the customer (`firstOrderOnly`: no earlier order counts; `customerGroupIds`: a member of one of them), and, when it `requiresCoupon`, the order entered one of its codes.

- **First order** (P2-B.3): an earlier order counts when it reached `CONFIRMED` or a later status (`IN_FULFILMENT`, `COMPLETED`), or `PAYMENT_REVIEW` (the payment was received), at any point of its history, even if it was cancelled or refunded afterwards. An online order cancelled or expired before payment does not count. A cash-on-delivery order is `CONFIRMED` when placed, so it counts at once.
- **Product pages** (`Variant.discountedPrice`) never show coupon promotions. To a visitor they show only promotions open to everyone; to a signed-in customer (optional sign-in, P2-W.1) also their customer-group promotions and, while they have no earlier order, first-order promotions.

### What a promotion takes off

- Item promotions (`SKU`, `PRODUCT`, `CATEGORY`, `BRAND`) apply to each unit of the lines they target: `PERCENT` → price × value / 100, `AMOUNT_OFF` → value, `FIXED_PRICE` → price - value (nothing when the price is already lower); rounded half-up to 2 dp, never more than the unit price.
- Cart promotions (`CART`) come off the merchandise subtotal after item promotions, before shipping: `PERCENT` of it or `AMOUNT_OFF`, never more than it. The amount is allocated to the lines by largest remainder (`checkoutQuote` `allocations`), so refunds per line are exact.
- `minimumQuantity`: the targeted units in the cart (every unit for CART). `minimumSpend`: for a cart promotion, the subtotal after item promotions (before shipping); for an item promotion, the list-price subtotal (before any promotion).

### Combining (P2-B.2, `pricingVersion` 2)

- **Stacking groups**: promotions in one `stackingGroup` do not combine. On each line, every group contributes the item promotion saving the most on one unit (at the list price); the groups' winners then all apply, one after the other, lowest `priority` first, each on what the unit still costs, so a unit never goes below zero. Cart promotions work the same way on the subtotal after item promotions: one winner per group, applied one after the other on what is left, each allocated to the lines. Group names count per level: an item promotion and a cart promotion in the same group do combine.
- **Exclusive**: when an `exclusive` promotion saves anything on the cart, it applies alone: no other promotion (item, cart or coupon) does. When several do, the one saving the most on the whole cart wins.
- **Ties** between equal savings go to the lowest `priority` number, then the oldest promotion.
- **Minimum spend** of a cart promotion is measured on the subtotal after item promotions (before shipping; prices include tax). An item promotion's minimum spend is measured on the list-price subtotal (it applies before item promotions do).
- One coupon code per order. A code whose promotion loses (to an exclusive one, or to a better promotion of its group) takes nothing off and is not recorded on the order; it is not an error.
- Existing discounts and coupons were migrated into group "default" at priority 0, so a line still gets only the best of them and a coupon still stacks on top.

### Coupon codes

- Entered as `couponCode` in `checkoutQuote` and `createOrder` (any letter case); they unlock their promotion.
- A code that cannot be used fails with `BAD_REQUEST` and the reason (inactive, not started, expired, no uses left, already used by the caller, minimum not reached, "This coupon does not apply to any item in your cart"); an unknown code with `NOT_FOUND`.

### Limits and redemptions

- Placing an order records one `RESERVED` redemption per promotion it applies and takes one use of each (and of the coupon code) inside the order transaction, with a conditional update: when none is left, `createOrder` fails with `CONFLICT` and `reason: PROMOTION_LIMIT_REACHED` (or `PROMOTION_CUSTOMER_LIMIT_REACHED` for the caller's own limit) and nothing is recorded. Get a new quote.
- Cancelling or expiring an order **before payment** gives its uses back (redemptions `RELEASED`, counts decremented), once. A paid order keeps its uses when it is cancelled and refunded (P2-B.3).

### Flash sales (P2-B.4, `pricingVersion` 3)

- A flash sale is an item promotion with a time window (`startsAt`/`endsAt`) and a `unitCap`: the units that may be sold at its price across all orders. There is no separate flag.
- When a cart wants more units than are left, the units left get the promotional price and the rest the normal price: the cart line becomes two quote lines (and two order items) with the same `cartItemId` / variant, the reduced units first. Across several targeted lines the units left go to the units the promotion saves the most on (then by variant).
- The units an order bought at the price are taken at placement inside the order transaction with a conditional update (`unitsUsed + n <= unitCap`) and recorded on its redemption (`units`). If fewer are left than the quote reduced, `createOrder` fails with `CONFLICT` + `reason: PROMOTION_UNITS_SOLD_OUT` and nothing is recorded. They are given back with the use when the order is cancelled or expires before payment, and kept when a paid order is refunded.
- A sold-out flash sale is no longer a candidate; its coupon code fails with "This offer has sold out". Product pages show it only while it has units left.

### BXGY, volume tiers and spend X save Y (P2-B.5)

All three are **mix and match**: they count the targeted units of every line together (any variants, products, categories or brands among the promotion's targets), not line by line. They compete in stacking groups, exclusivity and priority exactly like the other types: within a group each unit gets the offer saving the most on it.

- **BXGY** (item scopes): every unit of the targets counts towards `buyQuantity`; every unit of the reward targets (`rewardTargetIds`, default the targets) can be a reward. It applies as many times as the cart allows (at most `maxApplications`, and within a `unitCap`, counted in reward units), each time giving the **cheapest** reward units not yet rewarded `value`% off (100 = free), as long as enough other buy units pay for them: a unit is never both bought and rewarded. The saving is on the reward lines (`OrderAdjustment` per line); a line with some rewarded units is split. Redemption `units` = the reward units.
- **TIERED, item scopes (volume)**: the tier is the highest `minimumQuantity` the targeted units reach together; every targeted unit gets it as `tierValueType` (e.g. 3+ → 10%, 6+ → 15%).
- **TIERED, CART (spend X save Y)**: the tier is the highest `minimumSpend` reached by the subtotal after item promotions (as for a minimum spend); it comes off the cart as `PERCENT` or `AMOUNT_OFF` and is allocated to the lines.
- Product pages (`discountedPrice`) never show BXGY or tiered promotions: they depend on the cart.
- **Breaking change (P2-B.5):** `Promotion.value` and `CouponCodeValidation.value` are nullable (null for TIERED).

### B2B price lists (P2-W.1, `pricingVersion` 4)

Price lists come before promotions: they set the price a unit costs, which promotions may then reduce.

- **Which price**: a line's unit price is the lowest price the customer's open lists give its variant for the cart's quantity **of that variant** (lines of other variants do not count towards its tiers). A list is open when it `isActive`, is in its schedule (`startsAt`/`endsAt`, each optional), and the customer belongs to one of its `customerGroupIds`. Within a list the entry's highest break the quantity reaches applies (`minQuantity` at `price`, then each tier from its `minQuantity`).
- **Minimum quantity (MOQ)**: below an entry's `minQuantity` the normal price applies; nothing is refused.
- **Overlap**: across lists the lowest unit price wins; equal prices go to the lowest `priority` number, then the oldest list.
- **Never above normal**: when the best list price is not below the variant's `price`, the normal price applies and the line counts as not price-listed (`fromPriceList: false`, promotions as usual).
- **Promotions on top**: on a line priced from a list with `allowPromotions: true`, promotions work as on any line, from the list price. With `allowPromotions: false` (the default) the line is left out of promotions entirely: it gets no item promotion; its amount and units do not count towards any `minimumSpend` or `minimumQuantity` (item, cart or free shipping) and it takes no share of a cart promotion (`allocations` 0). A free-shipping promotion without a minimum still applies to the order. A coupon code on a cart whose every line is left out fails with `BAD_REQUEST` "This coupon does not apply to any item in your cart".
- `checkoutQuote` shows the price on `QuoteLine.unitListPrice` with `fromPriceList: true`; `subtotal` uses those prices. The quote hash covers the list, the break reached and `allowPromotions`, so a change to them before `createOrder` gives `CONFLICT` + `QUOTE_CHANGED`. The order item stores the price as `unitListPrice` (and the list id internally).

### Free shipping (P2-B.6)

- Type `FREE_SHIPPING`, scope `CART`: with no `value` it waives the delivery fee; with a `value` it takes that amount off the fee (never below zero). `shippingZoneIds` limits it to deliveries to those zones (`[]` = every zone).
- It is the **shipping level**, applied after item and cart promotions, with its own stacking: one winner per `stackingGroup`, applied in `priority` order on what is left of the fee. An `exclusive` free shipping competes with the other exclusives on what it saves (the fee).
- `minimumSpend` is measured on the subtotal after item **and** cart promotions (before shipping; prices include tax); `minimumQuantity` on the cart's units.
- Pickup orders have no fee: it does nothing there (not an error), even for a zone-limited coupon code.
- A coupon code unlocks it like any promotion (`requiresCoupon`). A zone-limited code used for a delivery outside its zones fails with `BAD_REQUEST` "This coupon does not cover delivery to your area".
- The saving appears in `checkoutQuote.shippingAdjustments` and becomes an `OrderAdjustment` with `target: SHIPPING` (no `orderItemId`); `shippingTotal` (quote and order) is the fee after it, and `grandTotal = subtotal - discountTotal + shippingTotal`. `discountTotal` stays merchandise only. Refunds and returns keep reading the stored values.
- A shipping zone a free-shipping promotion is limited to cannot be deleted (`CONFLICT`): take it off the promotion first.
- The quote hash covers the delivery zone (`createOrder` with another address in another zone gets `QUOTE_CHANGED`).

---

## 11. Tax & Currency

### Tax Calculation

- Taxes are named rates (`TaxEntity { name, rate, isActive }`, e.g. VAT 0.15) with no country or region.
- Prices live on the variant. A variant of a taxable product has `price = basePrice × (1 + sum of active tax rates)`, stored on the variant and recomputed whenever a tax is created, updated or deleted, the variant's `basePrice` changes, or the product's `isTaxable` changes. Variants of non-taxable products: `price = basePrice`. Variants without a `basePrice` keep their stored price.
- Checkout charges `Variant.price` (minus any discount); no tax is added at checkout, and orders carry no tax breakdown. The shipping address country is not used for tax.

### Currency

- All charges are in the **store currency** (`storeSettings.currency`, GHS). `createOrder` refuses products whose `currency` is not the store currency, and `POST /payment/initialize` accepts only `currency` equal to it (or none); any other value is a 400 `currency must be GHS; payments are charged in GHS only`.
- `Product.currency` can hold `USD`, `EUR`, `GBP`, `NGN`, but there is no conversion: no API operation converts amounts. (A `CurrencyService` with hard-coded rates exists in the code but is not used by any operation.)

### Rounding

Every amount is stored with 2 decimals and returned as `Money` with exactly 2 decimals. Discounts, coupons and tax-inclusive prices are rounded half-up to 2 decimals per line and per component, so `validateCoupon` returns `6.00` for 10% of 59.98 (it used to return `5.998`). See [Money](#money).

---

## 12. Error Handling Standard

### Global Error Format

GraphQL errors follow the standard Apollo format:

```json
{
  "errors": [
    {
      "message": "Human-readable error message",
      "locations": [{ "line": 2, "column": 3 }],
      "path": ["operationName"],
      "extensions": {
        "code": "ERROR_CODE",
        "status": 400
      }
    }
  ],
  "data": null
}
```

### Error Code Mapping

| HTTP Status / NestJS Exception | GraphQL `extensions.code` |
|---|---|
| `400 BadRequestException` | `BAD_REQUEST` |
| `401 UnauthorizedException` | `UNAUTHENTICATED` |
| `403 ForbiddenException` | `FORBIDDEN` |
| `404 NotFoundException` | `NOT_FOUND` |
| `409 ConflictException` | `CONFLICT` |
| Validation Pipe failures | `BAD_USER_INPUT` |
| Duplicate value (Prisma `P2002`) | `CONFLICT` |
| Record still referenced, e.g. deleting a category that has sub-categories (Prisma `P2003`) | `CONFLICT` |
| Record not found (Prisma `P2025`) | `NOT_FOUND` |
| Query too deep (> 8), too many aliases (> 15) or too costly (> 3000), HTTP 400 | `GRAPHQL_VALIDATION_FAILED` |
| Any other 4xx (e.g. 422 wishlist full, 413, 429 rate limit) | `BAD_REQUEST`, with the real status in `extensions.status` |
| Schema errors: unknown field or argument, wrong type, missing required value (HTTP 400) | `GRAPHQL_VALIDATION_FAILED` / `BAD_USER_INPUT` (Apollo) |
| Any 5xx, and unexpected errors (incl. a null returned for a non-null field) | `INTERNAL_SERVER_ERROR` (message "Internal server error"; `extensions.status` carries e.g. 503 for a provider outage) |

**`extensions.reason`** narrows some `FORBIDDEN` / `UNAUTHENTICATED` errors so the frontend can react (details in [2.25](#225-two-factor-authentication-and-step-up)):

| `code` | `reason` | Meaning | What to do |
|---|---|---|---|
| `UNAUTHENTICATED` | `MFA_REQUIRED` | Password or social sign-in succeeded; second factor needed. `extensions.mfaChallenge` holds the challenge (5 minutes) | Ask for a code, call `completeMfaSignIn` |
| `FORBIDDEN` | `MFA_ENROLLMENT_REQUIRED` | The staff role requires two-factor authentication and the user has not enrolled | Run the enrolment flow, then retry |
| `FORBIDDEN` | `STEP_UP_REQUIRED` | Sensitive action without a two-factor verification in the last 10 minutes | Ask for a code, call `stepUp`, retry |

REST endpoints return the same `reason` field in their JSON error body.

**Query cost:** each field costs 1; a list costs its page size (`first`, or 10 when not given) times the cost of its fields. A page of 50 products with variants and reviews costs about 2,800.

### Production vs. Development

In **production**: only errors with codes `BAD_USER_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `BAD_REQUEST`, `GRAPHQL_VALIDATION_FAILED`, `GRAPHQL_PARSE_FAILED` expose their real message. All other errors return `{ "message": "Internal server error", "extensions": { "code": "INTERNAL_SERVER_ERROR" } }`.

Outside production every message is returned unmasked, and Apollo's default may add `extensions.stacktrace` in development; never rely on it.

Switch on `extensions.code`; use `extensions.status` to tell apart the 4xx cases that share `BAD_REQUEST` (e.g. 429 = slow down). Refresh the access token only on `UNAUTHENTICATED`.

### Validation Error Format

When `class-validator` fails, the error has code `BAD_USER_INPUT`:

```json
{
  "errors": [
    {
      "message": "Password must contain at least one uppercase letter...",
      "extensions": {
        "code": "BAD_USER_INPUT",
        "status": 400
      }
    }
  ]
}
```

### Sample Error Responses

**Auth error**:
```json
{
  "errors": [{
    "message": "Invalid email or password",
    "extensions": { "code": "UNAUTHENTICATED", "status": 401 }
  }]
}
```

**Not found**:
```json
{
  "errors": [{
    "message": "Product \"clx123\" not found",
    "extensions": { "code": "NOT_FOUND", "status": 404 }
  }]
}
```

**Locked account**:
```json
{
  "errors": [{
    "message": "Account is temporarily locked due to too many failed attempts. Try again in 843 seconds.",
    "extensions": { "code": "UNAUTHENTICATED", "status": 401 }
  }]
}
```

**Coupon validation failure**:
```json
{
  "errors": [{
    "message": "Order total must be at least 50 to use this coupon",
    "extensions": { "code": "BAD_REQUEST", "status": 400 }
  }]
}
```

---

## 13. Pagination & Filtering

### Strategy: Cursor-Based Pagination

Only `products`, `adminProducts` and `users` are paginated (relay-style). A user cursor is the record's `id`; a product cursor is an opaque keyset cursor (P6-S.1) valid only with the same `sortArgs`.

**`PaginationArgs`** (products; `UserPaginateArgs` has the same fields plus filters):

```typescript
{
  first: number;       // Page size. Default 12. Min 1. Max 100. (Omitting paginationArgs entirely on products gives 10.)
  after?: string;      // Cursor of the last edge of the previous page (users: its id).
  orderBy?: string;    // Users only (whitelisted field name). Ignored for products.
  orderInAsc?: boolean;// Users only. Default true.
}
```

**`PageInfo`**:

```typescript
{
  hasNextPage: boolean;
  hasPreviousPage: boolean; // true whenever `after` was sent
  pageSize: number;
  totalCount: number;       // Total matching records (all pages)
}
```

### Fetching Subsequent Pages

```graphql
query {
  products(
    paginationArgs: { first: 12, after: "clx1234lastCursor" }
    sortArgs: { sortBy: CREATED_AT, sortOrder: DESC }
  ) {
    edges {
      cursor
      node { id name price { amount currency } }
    }
    pageInfo {
      hasNextPage
      totalCount
    }
  }
}
```

### Sorting

- **Products**: `sortArgs: ProductSortArgs { sortBy: RELEVANCE | CREATED_AT | NAME | UPDATED_AT, sortOrder: ASC | DESC }`, default `RELEVANCE` with search text, else `CREATED_AT DESC`; ties always go by id (price and stock sorts were removed in P1-V.3). `paginationArgs.orderBy`/`orderInAsc` are ignored.
- **Users**: `filter.orderBy` (one of `id`, `name`, `email`, `phoneNumber`, `role`, `isActive`, `createdAt`, `updatedAt`, `lastLoginAt`, `profilePicture`) and `filter.orderInAsc`.

### Filtering Options per Resource

**Products** (`ProductFilterArgs`): `categoryId`, `categoryName`, `subCategoryName`, `subcategoryId`, `isActive` (default `true`, admin only), `status` (admin only), `search`, `createdAfter` (ISO date), `priceMin`, `priceMax`, `brand` (exact name), `brandId`, `productTypeId`, `inStock` (`true` = an active variant a customer can buy now, `false` = none), `tagId`, `tagName`, `attributes` (P6-S.2, AND across keys, OR within one). All filters combine; with `inStock: true` the price bounds and the stock must hold for the same active variant. See [2.3](#23-products).

**Users** (`UserPaginateArgs`): `email` (partial), `phoneNumber` (exact), `role`, `isActive`, `name` (partial), `createdAfter`.

**Other resources** (orders, payments, reviews, returns, refunds, coupons, discounts, zones, locations) return full lists (`stockMovements` is paginated, see [2.15](#215-inventory)) without pagination. `refunds` accepts an optional `status` filter.

---

## 14. File Upload (Cloudinary)

### Upload Endpoints

Both endpoints are REST (not GraphQL) and accept `ADMIN`/`SUPER_ADMIN` tokens only. Full reference in [Section 3](#post-uploadsingle-image).

#### Single Image
```http
POST /upload/single-image
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <image file>
```

#### Multiple Images (max 3)
```http
POST /upload/multiple-images
Authorization: Bearer <token>
Content-Type: multipart/form-data

files: <image1>
files: <image2>
files: <image3>
```

### Accepted Formats

JPEG, PNG and WebP only, identified from the file content (magic bytes), not the file name or MIME type. Anything else is rejected with 400.

### Limits

5 MB per file (413 above that) and at most 40 megapixels (400).

### Processing

Images are resized to **500×500 pixels** with `fit: 'contain'` and a white background before upload.

### Folder Structure

All images are stored in the `ecommerce` Cloudinary folder.

### Response Shape

```json
// Single image
{ "url": "https://res.cloudinary.com/cloud/image/upload/ecommerce/...", "public_id": "ecommerce/abc123" }

// Multiple images
{
  "message": "Product images uploaded successfully",
  "files": [
    { "url": "https://...", "public_id": "ecommerce/abc123" },
    { "url": "https://...", "public_id": "ecommerce/abc456" }
  ]
}
```

Use the returned `url` values in `images`, `logo` or `image` fields of the product, brand and category inputs.

### Rate Limit

10 uploads per minute per IP (`upload` throttler).

---

## 15. Notifications System

Messages go out by email (Resend) and SMS (Hubtel), rendered from versioned templates (P6-N.1). Every message is recorded as a `Notification` row (template key and version, category, channel, status `QUEUED` → `SENT` | `FAILED` | `SKIPPED`, provider message id); no rendered body is stored. Orders are named by their order number (`#10042`) and amounts are shown as `GHS 1,255.50`.

### Types of notifications

| Trigger | Message | Channel | Recipient |
|---|---|---|---|
| `signUp`, `resendVerificationEmail` | Email verification token (valid 24 hours) | Email | The address being verified |
| First successful `verifyEmail` of an account | Welcome | Email | User |
| Email change requested (`updateMyProfile` / `updateUser` with a new email) | Verification token to the new address, and a notice (new address masked) to the current one | Email | Both addresses |
| `forgotPassword` for an existing account | **A link** `FRONTEND_URL/reset-password#token=<token>` (valid 15 minutes; the token is in the URL fragment, so it never reaches a server log). The reset page reads the token from `location.hash` and calls `resetPassword(resetToken, newPassword)`. (P6-N.1: was the bare token in the body.) | Email | Requesting address |
| `requestPhoneVerification` | 6-digit code | SMS | The profile phone |
| Order created | Receipt: order number, lines, discount, delivery fee, total, how to pay | Email | Account email (not `contactEmail`) |
| Online payment confirmed (webhook, `verifyPayment` or sweep), once per order | Payment received | Email | Account email |
| Shipment `OUT_FOR_DELIVERY` | Out for delivery (carrier and tracking number when set) | Email | Account email |
| `updateShipping` with a tracking number | Your order has shipped (tracking number) | Email | Account email |
| Order `COMPLETED` | Order complete | Email | Account email |
| Shipment `OUT_FOR_DELIVERY` (with the delivery code for a rider's shipment) or `DELIVERED`; one SMS per shipment and milestone | "Your order #1042 is out for delivery with DHL. Tracking number: …" / "… has been delivered" | SMS | The account's verified phone, else the delivery address phone, else the checkout contact phone (Ghana numbers only; none usable: the row is `SKIPPED`) |
| Shipment `READY_FOR_PICKUP` | Ready for pickup: point, address, opening hours, contact | Email + SMS | Account email; the order's contact phone |
| A refund processed | Refund: amount, reason label, refunded lines and delivery fee | Email | Account email |

Not sent: cancellations, expiries, refunds that failed or are still pending, other fulfilment steps.

### Categories, preferences and consent (P6-N.1)

- `TRANSACTIONAL` (everything above): always sent; cannot be switched off.
- `MARKETING` (promotions, abandoned-cart reminders): **opt-in only** per channel (`EMAIL`, `SMS`), as the Data Protection Act 843 requires. SMS marketing also needs a verified phone. Consent is checked again when each message is sent, so a withdrawal takes effect at once (the message is recorded `SKIPPED` with `NO_CONSENT`).

```graphql
type NotificationPreferenceEntity { category: NotificationCategory!  channel: NotificationChannel!  enabled: Boolean!  locked: Boolean! }
enum NotificationCategory { TRANSACTIONAL MARKETING }
enum NotificationChannel { EMAIL SMS IN_APP }
enum ConsentSource { CHECKOUT ACCOUNT_SETTINGS STAFF_REQUEST EMAIL_LINK }

query { myNotificationPreferences { category channel enabled locked } }          # any signed-in user
mutation { updateNotificationPreference(input: {
  category: MARKETING, channel: EMAIL, enabled: true,
  source: CHECKOUT            # optional: CHECKOUT (the opt-in box at checkout) or ACCOUNT_SETTINGS (default)
}) { category channel enabled locked } }                                         # returns every preference
```

`updateNotificationPreference` errors (`BAD_REQUEST` + `extensions.reason`): `TRANSACTIONAL_ALWAYS_ON` (switching a transactional channel off), `CHANNEL_NOT_AVAILABLE` (marketing on `IN_APP`), `PHONE_NOT_VERIFIED` (opting in to SMS marketing without a verified phone). Naming another `source` is `BAD_USER_INPUT`. Repeating the current choice changes nothing.

Every marketing change is written to an append-only consent ledger (channel, granted/withdrawn, source, time). Staff:

- `recordCustomerConsent(input: { userId, channel, granted }): [NotificationPreferenceEntity!]!`: a customer's request by phone or in store (`user.manage`; source `STAFF_REQUEST`, staff id kept). Same refusals.
- `customerConsentHistory(userId: ID!): [ConsentEventEntity!]!`: the ledger, newest first (`user.view`). `ConsentEventEntity { id category channel action(GRANTED|WITHDRAWN) source actorId createdAt }`.

### In-app feed (P6-N.4)

Besides email/SMS, these events add an entry to the customer's feed: order placed, payment received, out for delivery, delivered, ready for pickup, refund sent. Poll it (no subscriptions); entries are kept 90 days. Every operation needs a signed-in user and sees only their own entries.

```graphql
type InAppNotification {
  id: ID!  title: String!  body: String!
  templateKey: String!            # e.g. order.placed, payment.received, shipment.delivered, refund.processed
  refType: String  refId: ID      # "Order" + the order id: link to the order page
  readAt: DateTime                # null while unread
  createdAt: DateTime!
}
query { myNotifications(first: 20, after: ID, unreadOnly: false) { totalCount hasNextPage nodes { id title body templateKey refType refId readAt createdAt } } }   # newest first; first 1-50; after = last node id of the previous page (an unknown id: BAD_REQUEST)
query { unreadNotificationCount }                       # Int
mutation { markNotificationsRead(ids: ["..."]) }        # Int: how many changed; up to 100 ids; ids not yours or already read are ignored
mutation { markAllNotificationsRead }                   # Int
```

### Asynchronous, queued and retried

Messages are sent by the background worker, never on the request path, so they do not block or fail the request and may arrive a few seconds later. Messages that follow an order or payment change are written to the outbox in the same database transaction as the change. A failed send (including one the provider rejects) is retried with exponential backoff, up to 6 attempts; after that the job is listed by `failedJobs` and can be retried with `retryFailedJob`. A message is sent at most once, even when its job runs again. Without an email provider (development and test only; production refuses to start without `RESEND_API_KEY` and `RESEND_FROM_EMAIL`) emails are recorded `SKIPPED` with `NOT_CONFIGURED`.

---

## 16. Analytics Queries

Staff only (see [2.19](#219-analytics) for permissions and shapes). Amounts are GHS.

### How the figures are computed

Reports read **daily rollups** (UTC days = Ghana time), not live order data. A maintenance job rebuilds today and the 7 days before every 15 minutes, so reports lag by at most 15 minutes and late events (cash recorded days after it was collected, a payment settling late) still land on the right day. `rebuildAnalytics` queues a rebuild of any range of up to 731 days (after a data correction, or once after deploying P8-A to fill history). `refreshedAt` is when the oldest day of the range was last computed; `daysNotComputed` counts days with no rollup yet (future days, or before a backfill), reported as zeros. `inventoryValuation` and the dashboard's low-stock counts are live.

### Definitions

- **Paid order**: an order with an accepted payment: an online payment captured for it, or cash collected for a cash-on-delivery order. Unpaid checkouts, orders cancelled before payment, cash-on-delivery orders not collected yet and payments held for review (e.g. a late payment on a cancelled order, refunded automatically) are never sales. Guest orders count like any other.
- **Recognised**: a paid order counts on the day of its first accepted payment (settlement, or when the cash was collected), whenever it was placed.
- **Gross revenue**: Σ `grandTotal` of the orders paid. Split: `itemSales` (what the lines were charged, tax included, after product discounts and their share of cart discounts and loyalty points) + `shipping` (delivery fees after free shipping); `grossRevenue = itemSales + shipping` (orders placed before P1-O.1 without line shares also subtract their coupon). Discounts: `itemDiscounts` (product promotions), `orderDiscounts` (cart promotions and coupons), `loyaltyDiscounts` (points redeemed), `shippingDiscounts` (free shipping). `tax` is the tax included in the orders.
- **Refunds**: refunds with status `PROCESSED` against accepted payments, counted on the day they were processed; pending, sending and failed refunds are not deducted. Returns and cancellations reach revenue only through their refunds, so nothing is counted twice.
- **Net revenue** = gross revenue - refunds. **Average order value** = net revenue / paid orders.
- **Products and categories**: `sales` is the lines' share of `itemSales` (Σ over products = `itemSales` of the same days), `refunds` the line refunds processed in the period, `netSales = sales - refunds`. Categories are the products' current categories; archived products are labelled.
- **Margins**: each order line keeps the variant's weighted-average unit cost from the moment its stock was consumed (`OrderItem.unitCost`: online payment captured, cash-on-delivery dispatch); later cost changes never change past margins. Net sales are tax-exclusive (line charge minus its tax) net of line refunds (refunded amount × the line's tax-exclusive share). COGS = units sold × unit cost, minus units put back in stock (paid order cancelled before dispatch, returned goods restocked) × that cost, on the day they came back. `grossMargin = costedNetSales - cogs`. Lines whose cost was unknown when sold are reported in `unknownCostUnits`/`unknownCostNetSales` and left out of the margin, never counted at zero cost. Refunds not attributed to lines are `unallocatedRefunds` (in net revenue, not in margins).
- **Conversion** (no tracking pixel): `cartsStarted` = add-to-cart calls that put the first item into an empty cart (account or guest), `checkoutQuotes` = checkout quotes given (`checkoutQuote`, `guestCheckoutQuote`; refusals not counted), both counted per day in Redis; `ordersPlaced` = orders created that day (admin-deleted excluded); `paidOrders` as above. Each step counts on its own day, so ratios over a short period can exceed 1; a ratio is null when the step before is 0.
- **Cohorts**: a customer is an account, or the verified phone of a guest order not attached to an account. A cohort is the customers whose first paid order fell in the month; `repeatCustomers` paid for at least one more order since (any time). `months[offset]` gives the customers active that month, their paid orders and their paid totals minus refunds processed that month.
- **Inventory valuation**: on-hand units × the variant's current cost price, per stock location; variants without a cost price are counted apart (`unknownCostUnits`, `unknownCostVariants`).
- **Promotion performance**: per promotion and coupon code, the paid orders it applied to, what it took off them (goods and delivery fee), their `grandTotal`, and the units bought at its price (flash sales, BXGY, tiers).

---

## 17. Environment Variables Required

Backend configuration, validated at startup (`src/config/env.validation.ts`); listed here because some values shape frontend behaviour (`ALLOWED_ORIGINS`, `PAYSTACK_CALLBACK_URL`). In production, placeholder secret values and a JWT secret reused across the three JWT variables are rejected.

### Database

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |

### Server

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | ❌ | `3000` | HTTP port |
| `NODE_ENV` | ✅ | — | `development`, `production` or `test`; the app refuses to start without it |
| `ROLE` | ❌ | `api` | `api` serves GraphQL/REST; `worker` runs the background jobs (emails, webhook processing, repeatable jobs) from the same image and serves only `/health/live` and `/health/ready` on `PORT`. Run at least one of each. |
| `ALLOWED_ORIGINS` | Production only | — | Comma-separated allowed CORS origins (your frontend URLs). |

### JWT

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | ✅ | — | Access token secret. Min 32 chars. |
| `JWT_REFRESH_SECRET` | ✅ | — | Refresh token secret. Min 32 chars. |
| `JWT_RESET_SECRET` | ✅ | — | Password reset token secret. Min 32 chars. |
| `JWT_TOKEN_AUDIENCE` | ✅ | — | JWT `aud` claim value |
| `JWT_TOKEN_ISSUER` | ✅ | — | JWT `iss` claim value |
| `JWT_ACCESS_TOKEN_TTL` | ❌ | `3600` | Access token TTL in seconds |
| `JWT_REFRESH_TOKEN_TTL` | ❌ | `86400` | Refresh token TTL in seconds |
| `JWT_RESET_TOKEN_TTL` | ❌ | `900` | Reset token TTL in seconds |
| `MFA_ENCRYPTION_KEY` | ✅ | — | AES-256-GCM key for TOTP secrets at rest, recovery-code and phone-verification-code hashing: 64 hex characters (`openssl rand -hex 32`). A key made of a repeated pattern is rejected in production. Changing it invalidates every enrolment. |

### OAuth

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth app secret |
| `FACEBOOK_APP_ID` | ✅ | Facebook App ID |
| `FACEBOOK_APP_SECRET` | ✅ | Facebook App Secret |

### SMS (Hubtel)

All three or none. Without them, outside production the phone verification SMS is not sent (a log line with the masked number records it); in production `requestPhoneVerification` fails.

| Variable | Required | Description |
|---|---|---|
| `HUBTEL_CLIENT_ID` | ❌ | Hubtel SMS API client id |
| `HUBTEL_CLIENT_SECRET` | ❌ | Hubtel SMS API client secret |
| `HUBTEL_SENDER_ID` | ❌ | Registered sender id shown to recipients (1-11 letters, digits or spaces) |

### Paystack

| Variable | Required | Description |
|---|---|---|
| `PAYSTACK_SECRET_KEY` | ✅ | Paystack secret key (starts with `sk_`) |
| `PAYSTACK_CALLBACK_URL` | ❌ | URI of the **frontend** page Paystack redirects to after payment; that page calls `verifyPayment` |

### Cloudinary

| Variable | Required | Description |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` | ✅ | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | ✅ | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | ✅ | Cloudinary API secret |

### Redis

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_HOST` | ✅ | — | Redis host, required in every environment (cache, rate limits, job queues). Startup fails without it or when Redis is unreachable. |
| `REDIS_PORT` | ❌ | `6379` | Redis port |
| `REDIS_PASSWORD` | ❌ | — | Redis password |
| `REDIS_DB` | ❌ | `0` | Redis logical database (0–15), to keep stacks sharing one server apart |

### Email (Resend)

| Variable | Required | Description |
|---|---|---|
| `RESEND_API_KEY` | ❌ | Resend API key. Without it no email is sent (a warning is logged). |
| `RESEND_FROM_EMAIL` | ❌ | Sender email address |

### Logging

| Variable | Required | Default | Options |
|---|---|---|---|
| `LOG_LEVEL` | ❌ | `info` | `error`, `warn`, `info`, `debug` |

### Tracing (OpenTelemetry)

| Variable | Required | Default | Description |
|---|---|---|---|
| `OTEL_ENABLED` | ❌ | `false` | `"true"` or `"false"` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ❌ | `http://localhost:4318/v1/traces` | OTLP collector endpoint |
| `OTEL_SERVICE_NAME` | ❌ | `emma-commerce-backend` | Service name in traces |

---

## 18. Frontend Integration Guide

### API Layer Structure (Recommended)

```
src/
├── api/
│   ├── graphql/
│   │   ├── client.ts          # Apollo Client configuration
│   │   ├── auth/
│   │   │   ├── mutations.ts   # signIn, signUp, refreshToken, signOut, etc.
│   │   │   └── fragments.ts
│   │   ├── products/
│   │   │   ├── queries.ts
│   │   │   ├── mutations.ts
│   │   │   └── fragments.ts
│   │   ├── cart/
│   │   ├── orders/
│   │   ├── payment/
│   │   └── ...
│   └── rest/
│       ├── payment.ts         # POST /payment/initialize
│       └── upload.ts          # POST /upload/*
├── store/
│   ├── auth.ts                # JWT token state
│   └── cart.ts                # Optimistic cart state
```

### Apollo Client Configuration

```typescript
import { ApolloClient, InMemoryCache, createHttpLink, from, fromPromise } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';

const httpLink = createHttpLink({ uri: '/graphql' });

const authLink = setContext((_, { headers }) => {
  const token = getAccessToken(); // from memory/store
  return {
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
});

const errorLink = onError(({ graphQLErrors, operation, forward }) => {
  if (graphQLErrors?.some(e => e.extensions?.code === 'UNAUTHENTICATED')) {
    // refreshAccessToken() must share one in-flight refresh across calls and tabs (see below)
    return fromPromise(refreshAccessToken()).flatMap(() => forward(operation));
  }
});

export const client = new ApolloClient({
  link: from([errorLink, authLink, httpLink]),
  cache: new InMemoryCache(),
});
```

### Auth Refresh Strategy

1. Store `accessToken` in memory (React state/Zustand/Redux).
2. Store `refreshToken` in `localStorage` or an `HttpOnly` cookie.
3. On a GraphQL error with `extensions.code === 'UNAUTHENTICATED'` (and not for the refresh call itself):
   - Run **one** `mutation refreshToken({ refreshToken })` at a time for the whole browser (a lock shared across tabs); other requests wait for it.
   - On success: store the new `refreshToken` immediately, update the in-memory `accessToken`, retry the original operation.
   - On failure ("Invalid or expired refresh token", "Session has expired, please sign in again", "Account is inactive"): clear all tokens and go to the login page.
4. On app load: if a `refreshToken` exists, call the refresh mutation to restore the session.
5. Sessions end after 30 days, and after a password change/reset, a completed email change or account archival; expect to send the user to sign in.

### Optimistic UI Updates (Cart)

For `addToCart`, `updateCartItem`, and `removeFromCart`, use Apollo's `optimisticResponse`:

```typescript
client.mutate({
  mutation: ADD_TO_CART,
  variables: { input: { variantId, quantity } },
  optimisticResponse: {
    addToCart: {
      __typename: 'Cart',
      id: existingCartId,
      items: [...existingItems, { __typename: 'CartItem', id: 'temp-id', variantId, productId, quantity, ... }],
    },
  },
  update(cache, { data }) {
    // Update cart query in cache with real response
  },
});
```

### Payment Redirect Handling

```typescript
// 1. Initialize payment (REST). One idempotency key per "Pay" click; reuse it on network retries.
const res = await fetch('/payment/initialize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ orderId, paymentMethod: 'CARD', idempotencyKey }),
});
if (!res.ok) throw new Error((await res.json()).message);
const { authorizationUrl, transactionId } = await res.json();

// 2. Optional: remember the reference in case the redirect loses it
sessionStorage.setItem('pendingReference', transactionId);

// 3. Redirect user
window.location.href = authorizationUrl;

// 4. On the callback page (PAYSTACK_CALLBACK_URL, a frontend route)
const reference =
  new URLSearchParams(location.search).get('reference') ?? sessionStorage.getItem('pendingReference');
const { data } = await client.mutate({
  mutation: VERIFY_PAYMENT, // verifyPayment(verifyPaymentInput: { reference }) { id status order { id status } }
  variables: { verifyPaymentInput: { reference } },
});
const payment = data.verifyPayment;
if (payment.status === 'CAPTURED' && payment.order.status === 'CONFIRMED') {
  // Paid: show the order confirmation
} else if (payment.status === 'PENDING') {
  // Not decided yet (e.g. MoMo approval): retry verifyPayment shortly
} else {
  // FAILED/CANCELLED, or paid after the order was cancelled (PAYMENT_REVIEW, refund queued): show the order status
}
```

### When to Refetch Queries

| Action | Refetch |
|---|---|
| `addToCart`, `updateCartItem`, `removeFromCart` | `cart` query (or use Apollo cache update) |
| `createOrder` | `userOrders`, `cart` (now empty) |
| `cancelOrder` | `userOrders`, `order(orderId)` |
| `verifyPayment` | `order(orderId)`, `getMyPayments` |
| `createReturnRequest` | `myReturnRequests` |
| `addToWishlist`, `removeFromWishlist` | `wishlist` |
| `createAddress`, `updateAddress`, `deleteAddress` | `userAddresses` |

### Cache Invalidation Strategy

Use Apollo's `refetchQueries` or `cache.evict` / `cache.gc` explicitly. Key queries to invalidate:

```typescript
// After cart mutations
refetchQueries: [{ query: CART_QUERY }]

// After order creation
refetchQueries: [{ query: USER_ORDERS_QUERY }, { query: CART_QUERY }]

// After product updates (admin)
refetchQueries: [{ query: ADMIN_PRODUCTS_QUERY }]
```

### Recommended State Management

- **Auth state**: Zustand or Redux Toolkit (access token in memory, refresh in localStorage).
- **Cart state**: Apollo InMemoryCache (single source of truth, driven by `cart` query).
- **UI state**: Local component state or Zustand.

### GraphQL Fragment Suggestions

```graphql
fragment ProductSummary on Product {
  id name currency isActive status images categoryId inStock totalStock
  priceRange { min { amount currency } max { amount currency } }
  category { id name }
  brand { id name logo }
}

fragment VariantOption on Variant {
  id sku optionValues available image
  price { amount currency } discountedPrice { amount currency }
}

fragment CartItemFull on CartItem {
  id variantId productId quantity originalPrice { amount currency } discountedPrice { amount currency }
  variant { id sku optionValues available price { amount currency } }
  product { id name images currency }
}

fragment OrderSummary on Order {
  id orderNumber status fulfillmentType paymentMethod
  subtotal { amount currency } discountTotal { amount currency } taxTotal { amount currency } shippingTotal { amount currency } grandTotal { amount currency } createdAt
  items { id quantity variantId sku optionValues productName unitListPrice { amount currency } unitDiscount { amount currency } lineTotal { amount currency } product { id name } }
}

fragment AuthTokens on AuthEntity {
  accessToken refreshToken
}
```

### Suggested TypeScript Shared Types

Prefer generating these from `schema.gql`. Hand-written equivalents:

```typescript
// Enums (mirror schema.gql exactly)
export type Role = 'USER' | 'ADMIN' | 'SUPER_ADMIN';
export type OrderStatus =
  | 'PLACED' | 'CONFIRMED' | 'IN_FULFILMENT' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'PAYMENT_REVIEW';
export type ShipmentStatus =
  | 'PENDING' | 'PICKING' | 'PACKED' | 'READY_FOR_PICKUP' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED_DELIVERY' | 'RETURNED';
export type OrderPaymentStatus = 'PENDING' | 'CAPTURED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'FAILED' | 'CANCELLED';
export type FulfillmentType = 'DELIVERY' | 'PICKUP';
export type OrderPaymentMethod = 'ONLINE' | 'CASH_ON_DELIVERY';
export type PaymentStatus = 'PENDING' | 'CAPTURED' | 'FAILED' | 'CANCELLED';
export type DiscountType = 'PERCENTAGE' | 'FLAT';      // also DiscountTypeEnum (coupons)
export type ReturnStatusEnum = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REFUND_PENDING' | 'REFUNDED';
export type RefundStatusEnum = 'PENDING' | 'SENDING' | 'PROCESSED' | 'FAILED';
export type StockMovementReason =
  | 'OPENING_BALANCE' | 'RECEIPT' | 'SALE' | 'RETURN_RESTOCK' | 'ADJUSTMENT' | 'TRANSFER' | 'RESERVE' | 'RELEASE';
export type Currency = 'GHS' | 'USD' | 'EUR' | 'GBP' | 'NGN';
export type ProductStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type DeliveryOptions = 'LOCAL_DELIVERY' | 'INTERNATIONAL_DELIVERY' | 'SELECTED_REGIONS';
export type ProductSortField = 'RELEVANCE' | 'CREATED_AT' | 'NAME' | 'UPDATED_AT';
export type SortOrder = 'ASC' | 'DESC';

// Auth
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

// Pagination
export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  pageSize: number;
  totalCount: number;
}
export interface Connection<T> {
  edges: Array<{ cursor: string; node: T }>;
  pageInfo: PageInfo;
}
```

---

## 19. Example Complete User Journey

### Scenario: User registers → logs in → browses → adds to cart → applies coupon → checkout → pays → reviews

---

### Step 1 — Register

```graphql
mutation {
  signUp(input: {
    name: "Jane Doe"
    email: "jane@example.com"
    password: "Secret@123"
  }) {
    accessToken
    refreshToken
  }
}
```

**Response**:
```json
{
  "data": {
    "signUp": {
      "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiJ9..."
    }
  }
}
```

*Action*: Store both tokens. A verification email with a token is sent; the frontend page that receives it calls `verifyEmail(input: { token })`, after which the welcome email is sent. Unverified users can still shop.

---

### Step 2 — Log In (subsequent visits)

```graphql
mutation {
  signIn(input: {
    email: "jane@example.com"
    password: "Secret@123"
  }) {
    accessToken
    refreshToken
  }
}
```

---

### Step 3 — Browse Products

```graphql
query {
  products(
    paginationArgs: { first: 12 }
    filterArgs: { categoryName: "Electronics" }
    sortArgs: { sortBy: CREATED_AT, sortOrder: DESC }
  ) {
    edges {
      cursor
      node {
        id
        name
        priceRange { min { amount currency } max { amount currency } }
        inStock
        images
        currency
        brand { name }
        category { id name }
      }
    }
    pageInfo {
      hasNextPage
      totalCount
    }
  }
}
```

*No auth required.*

---

### Step 4 — View Product Details

```graphql
query {
  product(productId: "clx_product_abc123") {
    id name description images inStock totalStock
    priceRange { min { amount currency } max { amount currency } }
    variants {
      id sku optionValues available
      price { amount currency } discountedPrice { amount currency }
      appliedPromotion { name description endsAt }
    }
    reviews { score comment user { displayName } }
    category { id name }
    brand { id name }
  }
}
```

The customer picks one of `variants` (e.g. size and colour from `optionValues`); its `id` is what goes into the cart. A product without options has one variant with `optionValues: {}`.

---

### Step 5 — Create Address (if first time) and check delivery

```http
Authorization: Bearer <accessToken>
```

```graphql
mutation {
  createAddress(input: {
    recipientName: "Ama Mensah"
    phone: "024 412 3456"
    region: GREATER_ACCRA
    street: "123 Main Street"
    city: "Accra"
    area: "Osu"
    landmark: "Opposite the Total filling station"
    ghanaPostGps: "GA-123-4567"
  }) {
    id recipientName phone region street city area landmark ghanaPostGps country
  }
}
```

```graphql
query {
  checkoutQuote(input: { fulfillmentType: DELIVERY, shippingAddressId: "clx_address_xyz" }) {
    shippingTotal { amount currency }
    deliveryOptions { serviceLevel fee { amount currency } }
  }
}
```

A `BAD_REQUEST` here means the address is incomplete (complete it with `updateAddress`) or no shipping zone covers it (`DELIVERY_UNAVAILABLE`): offer pickup (`activePickupLocations`) instead.

---

### Step 6 — Add to Cart

```graphql
mutation {
  addToCart(input: {
    variantId: "clx_variant_abc123_m_red"
    quantity: 2
  }) {
    id
    items {
      id variantId productId quantity originalPrice { amount currency }
      variant { sku optionValues }
      product { name images }
    }
  }
}
```

---

### Step 7 — Quote the Checkout

```graphql
query {
  checkoutQuote(input: { fulfillmentType: DELIVERY, shippingAddressId: "clx_address_xyz", couponCode: "SAVE10" }) {
    quoteHash
    lines {
      cartItemId sku quantity unitListPrice { amount currency } unitDiscount { amount currency } lineTotal { amount currency }
      adjustments { sourceId amount { amount currency } }
    }
    adjustments { type code amount { amount currency } allocations { cartItemId amount { amount currency } } }
    subtotal { amount currency } discountTotal { amount currency } taxTotal { amount currency }
    shippingTotal { amount currency } grandTotal { amount currency }
  }
}
```

`createOrder` charges exactly `grandTotal` when it is sent this `quoteHash`; see [Section 10](#10-promotions-system).

---

### Step 8 — Check a Coupon Code

```graphql
query {
  validateCouponCode(code: "save10") {
    code type value scope
    minimumSpend { amount currency }
    promotion { name description endsAt }
  }
}
```

**Success Response**:
```json
{
  "data": {
    "validateCouponCode": {
      "code": "SAVE10", "type": "PERCENT", "value": "10", "scope": "CART",
      "minimumSpend": null,
      "promotion": { "name": "Ten percent off", "description": null, "endsAt": null }
    }
  }
}
```

Then call `checkoutQuote` with `couponCode: "save10"` to show the exact saving.

---

### Step 9 — Create Order

```graphql
mutation {
  createOrder(input: {
    fulfillmentType: DELIVERY
    shippingAddressId: "clx_address_xyz"
    contactEmail: "jane@example.com"
    contactPhone: "+233201234567"
    couponCode: "SAVE10"
    quoteHash: "<checkoutQuote.quoteHash from step 7>"
  }) {
    id orderNumber status paymentMethod
    subtotal { amount currency } discountTotal { amount currency } taxTotal { amount currency } shippingTotal { amount currency } grandTotal { amount currency }
    items {
      id quantity variantId sku optionValues productName unitListPrice { amount currency } unitDiscount { amount currency } lineTotal { amount currency }
      product { name }
    }
  }
}
```

**Response** (shipping fee 15.00 from the zone covering Accra):
```json
{
  "data": {
    "createOrder": {
      "id": "clx_order_789",
      "orderNumber": 10042,
      "status": "PENDING",
      "paymentMethod": "ONLINE",
      "subtotal": { "amount": "59.98", "currency": "GHS" },
      "shippingTotal": { "amount": "15.00", "currency": "GHS" },
      "grandTotal": { "amount": "68.98", "currency": "GHS" },
      "items": [...]
    }
  }
}
```

*Side effects*: each variant's stock decremented, cart cleared, coupon use recorded, confirmation email sent. Pay within 1 hour or the order is cancelled automatically.

---

### Step 10 — Initialize Payment (REST)

```http
POST /payment/initialize
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "orderId": "clx_order_789",
  "paymentMethod": "CARD",
  "idempotencyKey": "6f1c2a9e-0d1b-4c55-9a0e-3b7f2f4d8e11"
}
```

**Response** (abridged):
```json
{
  "id": "clx_attempt_1",
  "orderId": "clx_order_789",
  "amount": "68.98",
  "currency": "GHS",
  "status": "PENDING",
  "transactionId": "clx_order_789-1731900000000-a1b2c3d4",
  "authorizationUrl": "https://checkout.paystack.com/abc123"
}
```

*Action*: Redirect user to `authorizationUrl`.

---

### Step 11 — User Pays on Paystack

User completes payment. Paystack fires the webhook to `POST /payment/webhook` → backend marks the payment `CAPTURED`, order → `CONFIRMED`.

Paystack redirects the browser to the frontend callback page (`PAYSTACK_CALLBACK_URL`), e.g. `https://shop.example.com/checkout/callback?trxref=clx_order_789-1731900000000-a1b2c3d4&reference=clx_order_789-1731900000000-a1b2c3d4`.

---

### Step 12 — Frontend Confirms Payment

```graphql
mutation {
  verifyPayment(verifyPaymentInput: {
    reference: "clx_order_789-1731900000000-a1b2c3d4"
  }) {
    id status amount { amount currency } currency
    order {
      id status grandTotal { amount currency }
    }
  }
}
```

**Response**:
```json
{
  "data": {
    "verifyPayment": {
      "id": "clx_attempt_1",
      "status": "COMPLETED",
      "amount": { "amount": "68.98", "currency": "GHS" },
      "currency": "GHS",
      "order": {
        "id": "clx_order_789",
        "status": "CONFIRMED",
        "grandTotal": { "amount": "68.98", "currency": "GHS" }
      }
    }
  }
}
```

---

### Step 13 — User Receives Order (Admin updates status)

Staff create the shipment (everything unshipped, or chosen lines to split the order), set its tracking details (`updateShipping`, emails the customer) and move it; the order follows (`IN_FULFILMENT`, then `COMPLETED`):
```graphql
mutation { createShipment(input: { orderId: "clx_order_789" }) { id items { orderItemId quantity } } }

mutation {
  updateShipmentStatus(input: {
    shipmentId: "clx_shipment_1"
    status: OUT_FOR_DELIVERY
  }) { id status shipments { status trackingNumber } }
}
```

Then:
```graphql
mutation {
  updateShipmentStatus(input: {
    shipmentId: "clx_shipment_1"
    status: DELIVERED
  }) { id status timeline { from to createdAt } }
}
```

---

### Step 14 — Leave a Review

```graphql
mutation {
  createReview(input: {
    productId: "clx_product_abc123"
    score: 5
    comment: "Great quality, fast delivery!"
  }) {
    id score comment
    user { displayName }
    product { name }
  }
}
```

---

**End of complete user journey.**

---

*Checked against `schema.gql` and the resolvers, November 2026.*
