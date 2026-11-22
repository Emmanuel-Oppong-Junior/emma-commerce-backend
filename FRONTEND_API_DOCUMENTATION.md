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
   - [Wishlist](#210-wishlist)
   - [Orders](#211-orders)
   - [Payment](#212-payment)
   - [Promotions and coupon codes](#213-promotions-and-coupon-codes)
   - [Inventory](#215-inventory)
   - [Returns](#216-returns)
   - [Reviews](#217-reviews)
   - [Tax](#218-tax)
   - [Analytics](#219-analytics)
   - [Addresses](#220-addresses)
   - [Shipping Zones & Pickup Locations](#221-shipping-zones--pickup-locations)
   - [Store settings](#222-store-settings)
   - [Background jobs](#223-background-jobs)
   - [Staff roles and permissions](#224-staff-roles-and-permissions)
   - [Two-factor authentication and step-up](#225-two-factor-authentication-and-step-up)
   - [Product types and attributes](#226-product-types-and-attributes)
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
| Background jobs | BullMQ on Redis, run by a separate `ROLE=worker` process. Repeatable jobs, each run once per cluster: unpaid-order expiry (hourly), payment reconciliation sweep (every 5 minutes), Paystack daily diff (01:30 UTC), stock ledger reconciliation (02:30 UTC, reports only). Low-stock alerts are events raised by stock changes (`inventory.low_stock.v1`), not a scan |
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

PostgreSQL via Prisma. Full-text search is enabled (`fullTextSearchPostgres` preview feature).

---

## 2. GraphQL API Reference

**GraphQL Endpoint**: `POST /graphql`

### Platform rules

**Auth.** Every operation requires `Authorization: Bearer <accessToken>` unless marked **Auth Required: No** (public). A missing, invalid or expired token, or a deactivated account, gives `UNAUTHENTICATED`. The account (and its role) is re-read from the database on every request.

**Permissions.** Staff operations need a permission (e.g. `order.refund`), granted by the user's staff role (see [2.24](#224-staff-roles-and-permissions)). Customers have no staff role and no permissions. The labels in this reference still say `ADMIN` and `SUPER_ADMIN`: `ADMIN` means the **Manager** role (every legacy ADMIN account became a Manager) and `SUPER_ADMIN` the **Owner** role; the exact permission of every operation is in the table in [2.24](#224-staff-roles-and-permissions). The Owner holds every permission, so nothing locks an Owner out any more (the former `ADMIN`-only operations `getUserPayment`, `softDeletePayment`, `restorePayment`, `updateSubCategory` and `removeSubCategory` now accept the Owner too). A few self-service operations (`cancelOrder`, `verifyPayment`, `getMyPayments`, `createReview`, `updateReview`, `deleteReview`) are for customers only and refuse any staff account with `FORBIDDEN`. Permissions are re-read with the account on every request, so a role change applies on the caller's next request. A missing permission is `FORBIDDEN`.

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
- **Response**: `User!`. An unknown ID returns an error (the resolver returns null for a non-null field), not `NOT_FOUND`.

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
- **Response**: `User!` for the caller, with `addresses` and `orders` available.

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
  after?: string;       // Cursor (product ID from previous page)
  orderBy?: string;     // Ignored for products; use sortArgs
  orderInAsc?: boolean; // Ignored for products; use sortArgs
}

// ProductFilterArgs
{
  categoryId?: string;
  categoryName?: string;      // Exact, case-insensitive
  subCategoryName?: string;   // See note below
  subcategoryId?: string;
  isActive?: boolean;         // Default true; ignored by public queries
  status?: ProductStatus;     // DRAFT | PUBLISHED | ARCHIVED; ignored by public queries
  search?: string;            // Full-text match on name/description, or partial tag name
  createdAfter?: string;      // ISO date string
  priceMin?: Decimal;         // Inclusive, compared with an active variant's price
  priceMax?: Decimal;         // Inclusive, compared with an active variant's price
  brand?: string;             // Brand name, exact, case-insensitive
  inStock?: boolean;          // true = an active variant has available stock (on hand, not reserved); false or omitted = no filter
  tagId?: string;
  tagName?: string;           // Exact, case-insensitive
}

// ProductSortArgs
{
  sortBy: ProductSortField;   // CREATED_AT (default) | NAME | UPDATED_AT
  sortOrder: SortOrder;       // DESC (default) | ASC
}
```

`priceMin`, `priceMax` and `inStock` match a product when **one** active variant satisfies every condition given (e.g. `priceMax: "50", inStock: true` needs a variant that costs at most 50 and is in stock). There is no price or stock sort.

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
  // trackSerials, fulfilmentKind, unitOfMeasure)
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
  timeline: OrderStatusEvent[];                // Status history, oldest first (the customer's tracking timeline)
  shipments: Shipment[];                       // One per order for now; empty until the first fulfilment step
  fulfillmentType: FulfillmentType;            // DELIVERY | PICKUP
  paymentMethod: OrderPaymentMethod;           // ONLINE | CASH_ON_DELIVERY
  contactEmail: string;
  contactPhone: string;
  currency: Currency;                          // GHS
  pricingVersion: Int;                         // The pricing rules it was priced with: 4 since P2-W.1 (B2B price lists), 3 since P2-B.4 (flash sales), 2 since P2-B.2 (promotion stacking), 1 before it; all have the full price and tax snapshot. 0: placed before P1-O.1 (parts may be null)
  subtotal?: Money;                            // Σ unitListPrice × quantity, before any discount, tax included
  discountTotal?: Money;                       // Product discounts + coupon (= minus the sum of `adjustments`)
  taxTotal?: Money;                            // Tax included in the line totals; null on pricingVersion 0
  shippingTotal?: Money;                       // Shipping charged; 0 for PICKUP
  grandTotal: Money;                           // Amount charged: subtotal - discountTotal + shippingTotal
  adjustments: OrderAdjustment[];              // Product discounts (per line) and the coupon, as placed
  shippingAddressId?: string;                  // Set for DELIVERY orders
  shippingAddressSnapshot?: JSON;              // DELIVERY: { recipientName, phone, region, street, city, area, landmark, ghanaPostGps, latitude, longitude, zipCode, country } at order time; orders placed before Ghana addresses (P1-G) hold { street, city, state, zipCode, country } instead
  pickupLocationId?: string;                   // Set for PICKUP orders
  pickupLocationSnapshot?: JSON;               // PICKUP: { name, address, city, state, country } at order time
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
  createdAt: DateTime;
  updatedAt: DateTime;
  product: Product;
  variant: Variant;           // The variant now (use sku/optionValues for what was ordered)
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

**Breaking change (P1-O.2):** `OrderStatus` values `PENDING`/`PROCESSING`/`SHIPPED`/`DELIVERED` → `PLACED`/`CONFIRMED`/`IN_FULFILMENT`/`COMPLETED`; new `EXPIRED` and `PAYMENT_REVIEW` (an expiry is now `EXPIRED`, not `CANCELLED`). `Order.trackingNumber` and `Order.carrier` → `Order.shipments[0].trackingNumber` / `.carrier`. `updateOrderStatus` and `UpdateOrderStatusInput` removed: use `updateShipmentStatus` for fulfilment and `adminCancelOrder` to cancel. New: `Order.timeline`, `Order.shipments`, `Order.paymentStatus`, `ShipmentStatus`, `OrderPaymentStatus`.

---

#### `userOrders`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: All orders of the current user.
- **Response**: `[Order!]!`

---

#### `orders` (ADMIN, SUPER_ADMIN only)
- **Type**: Query
- **Description**: All orders in the system (not paginated).
- **Response**: `[Order!]!`

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
}
```

**Payment method not offered (P3-A.2):** `checkoutQuote` and `createOrder` fail with `BAD_REQUEST` and `extensions.reason: "PAYMENT_METHOD_UNAVAILABLE"` before anything else when the store does not offer the payment method: `CASH_ON_DELIVERY` while cash on delivery is switched off, or `ONLINE` while no online method is on offer (card and mobile money both off, or Paystack not configured). Read `availablePaymentMethods` to show only what is offered. The payment method does not change the price or the `quoteHash`.

**`CheckoutQuote` Object Type**:

```typescript
{
  quoteHash: string;                 // 64 hex chars. Send to createOrder.
  currency: Currency;                // GHS
  pricingVersion: number;            // The pricing rules used (4 since P2-W.1: B2B price lists); the order stores it
  lines: QuoteLine[];                // In cart order. P2-B.4: a cart line whose units pay different prices (a flash sale reduced only some) has two or more lines with the same cartItemId, the reduced units first
  adjustments: QuoteOrderAdjustment[]; // The cart promotions that take something off
  shippingAdjustments: QuoteAdjustment[]; // P2-B.6: the free-shipping promotions taken off the delivery fee (already in shippingTotal)
  subtotal: Money;                   // Σ unitListPrice × quantity, before any discount, tax included
  discountTotal: Money;              // Item promotions + cart promotions (merchandise only; shipping savings are in shippingTotal)
  taxTotal: Money;                   // Tax included in the line totals
  shippingTotal: Money;              // The delivery fee after free-shipping promotions (P2-B.6); 0 for pickup
  grandTotal: Money;                 // What createOrder charges: subtotal - discountTotal + shippingTotal
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
  quoteHash: string;                      // Required. checkoutQuote's quoteHash for the same fulfilment and coupon.
}
```

**What happens** (all in one database transaction):
1. The cart row is locked (a second `createOrder` for the same cart waits, then finds the cart empty: `NOT_FOUND`). The cart must hold 1–50 items; the account must be active.
2. `DELIVERY`: the address must belong to the caller and have a region, recipient name and phone (addresses saved before those fields existed may lack them). The shipping fee comes from the active shipping zone whose cities include the address city (case-insensitive, extra spaces ignored). No zone → rejected; delivery is never free by default. `PICKUP`: the location must exist and be active; shipping fee 0.
3. The cart's variants are share-locked, then the prices, promotions, coupon code, the caller's redemptions, tax rates and store currency are read and the cart is priced by the pricing engine (see [10](#10-promotions-system)), exactly as `checkoutQuote` does: each line from its **variant**'s current `price` (tax-inclusive) minus its item promotions. Every variant must still be sellable (active, priced, product active and `PUBLISHED`), its product priced in the store currency (GHS), and have enough stock.
4. A coupon code, if given, must be usable (code and promotion active, started, not expired, uses left overall and for the caller, its minimums reached); it unlocks its promotion. Cart promotions come off the lines after item promotions, before shipping, never more than them.
5. The resulting quote's hash must equal `quoteHash`; otherwise `CONFLICT` / `QUOTE_CHANGED` and nothing is written.
6. `grandTotal = Σ lineTotal - cart promotions + shippingTotal` (the fee after free-shipping promotions, P2-B.6), the quote's `grandTotal`. This is the amount Paystack is asked for. The order stores the quote as its snapshot: `subtotal`, `discountTotal`, `taxTotal`, `shippingTotal`, one `OrderAdjustment` per item promotion on a line and one per cart promotion, and per line the tax its price includes (`unitNet`, `unitTax`, `taxLines`), with the engine's `pricingVersion` (4).
7. The order is saved with each line's snapshot (`productName`, `sku`, `optionValues`, prices, tax lines); each line re-checks its variant and reserves its quantity with a conditional update (a `RESERVE` stock movement; if any line fails, the whole order fails and nothing is written); each applied promotion (and the coupon code) has one use taken with a conditional update and a `RESERVED` redemption recorded (none left: `CONFLICT`, see below); the cart is emptied.
8. Status: `PLACED` for `ONLINE` (until paid); `CASH_ON_DELIVERY` orders move straight on to `CONFIRMED` (both steps are in the timeline).
9. A confirmation email goes to the account's email (not `contactEmail`) after the response.

No tax is added at checkout; tax is already inside each variant's `price`, and the order records how much (see "How the totals add up").

**Possible Errors**:
- `CONFLICT` with `extensions.reason: "QUOTE_CHANGED"` — the cart no longer prices to the quote (see above). Call `checkoutQuote` again.
- `CONFLICT` with `extensions.reason: "PROMOTION_LIMIT_REACHED"` (a promotion or the coupon code has no use left) or `"PROMOTION_CUSTOMER_LIMIT_REACHED"` (the caller used up their uses) — another order took the last use meanwhile; nothing was recorded. Call `checkoutQuote` again.
- `CONFLICT` with `extensions.reason: "PROMOTION_UNITS_SOLD_OUT"` (P2-B.4) — a flash sale has fewer units left at its price than the quote reduced (another order took them meanwhile); nothing was recorded. Call `checkoutQuote` again: it shows the units still left at the promotional price.
- `NOT_FOUND` — No cart, empty cart (also the second of two simultaneous submits), shipping address not found for the caller, variant no longer exists (`Variant "<id>" not found`), unknown coupon code.
- `BAD_REQUEST` — Missing `shippingAddressId`/`pickupLocationId` for the chosen type; "Complete the delivery address (region, recipient name and phone) before checkout" (send the customer to `updateAddress` for that address); more than 50 items; account inactive; a variant that cannot be sold (the `addToCart` messages followed by `; remove it from the cart`, e.g. `"Tee" (TEE-M-RED) is no longer sold; remove it from the cart`); a product priced in another currency (`"<product>" is priced in USD; only GHS products can be checked out`); insufficient stock (`Insufficient stock for "<product>" (<sku>): M available, N requested`); the variant sold out or was taken off sale while the order was being placed (`Variant "<sku>" is out of stock or no longer on sale — please review your cart`); delivery city not covered by any active shipping zone (offer pickup or another address); pickup location missing or inactive; coupon code inactive, not started, expired, at its usage limit, already used by the caller, below its minimums, or for items not in the cart.
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
- **Description**: Cancel any `PLACED`, `CONFIRMED` or `IN_FULFILMENT` order. During fulfilment only while the goods are still in the shop (shipment `PENDING`, `PICKING`, `PACKED` or `RETURNED`); once dispatched (`OUT_FOR_DELIVERY`, `READY_FOR_PICKUP`) or `DELIVERED` → `CONFLICT`. Same effects as `cancelOrder`, plus an audit entry with the actor and reason.
- **Response**: `Order!`
- **Possible Errors**: `NOT_FOUND`, `CONFLICT`.

---

#### `updateShipmentStatus` (permission `order.fulfil`)
- **Type**: Mutation
- **Args**: `input: UpdateShipmentStatusInput!` — `{ orderId: ID!, status: ShipmentStatus!, reason?: String (max 500) }`
- **Response**: `Order!`
- **Description**: Moves the order's shipment to its next fulfilment step; the shipment is created (`PENDING`) on the first step. Only `CONFIRMED` or `IN_FULFILMENT` orders (an unpaid online order cannot be fulfilled) → otherwise `CONFLICT`.

**Shipment steps** (`src/order/shipment-status.ts`): `PENDING → PICKING → PACKED → READY_FOR_PICKUP | OUT_FOR_DELIVERY → DELIVERED | FAILED_DELIVERY`; `FAILED_DELIVERY → OUT_FOR_DELIVERY | READY_FOR_PICKUP` (retry) `| RETURNED`. Steps before dispatch may be skipped forward (e.g. `PENDING → PACKED`). A `PICKUP` order is dispatched to `READY_FOR_PICKUP`, a `DELIVERY` order to `OUT_FOR_DELIVERY`; any other step → `CONFLICT`.

**In the same transaction**: the first step moves a `CONFIRMED` order to `IN_FULFILMENT`; dispatch consumes a cash-on-delivery order's reserved stock (once: a retried delivery does not consume again) and emails the customer; `DELIVERED` completes the order (`COMPLETED`) and emails the customer. A cash-on-delivery order is delivered by recording its cash (`recordCodPayment`): `DELIVERED` here → `BAD_REQUEST`. Each step is written to the shipment's `events`, the order's `timeline` when the order moves, and the audit log (actor, reason). Concurrent steps: one wins, the other gets `CONFLICT`.

---

#### `updateShipping` (permission `order.fulfil`)
- **Type**: Mutation
- **Args**: `input: UpdateShippingInput!`
- **Response**: `Order!`
- **Description**: Sets carrier and tracking number on the order's shipment (created if needed) of a `CONFIRMED` or `IN_FULFILMENT` order (otherwise `CONFLICT`). Does not change any status. When a `trackingNumber` is sent, a "shipped" email with the tracking number goes to the customer.

**Input: `UpdateShippingInput`**

```typescript
{
  orderId: string;        // Required.
  trackingNumber?: string;
  carrier?: string;
}
```

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

#### `recordCodPayment` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `orderId: String!`
- **Description**: Records that the grand total was collected in cash. In one step it captures the payment (attempt `CAPTURED`, provider `CASH_ON_DELIVERY`, amount = `grandTotal`, GHS), stores who recorded it, delivers the shipment (`DELIVERED`), completes the order (`COMPLETED`, customer emailed) and writes an audit entry.
- **Rules**: only a non-deleted cash-on-delivery order in `IN_FULFILMENT` whose shipment has been dispatched (`OUT_FOR_DELIVERY`, or `READY_FOR_PICKUP` at the counter). Repeating the call for the same order (double click) records nothing more.
- **Response**: `Payment!`

**Possible Errors**:
- `NOT_FOUND` — order does not exist or is deleted.
- `BAD_REQUEST` — the order is an `ONLINE` order.
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

#### `softDeletePayment` / `restorePayment` (ADMIN only)
- **Type**: Mutation
- **Roles**: `ADMIN` only (a `SUPER_ADMIN` gets `FORBIDDEN`)
- **Args**: `id: String!`
- **Response**: `Payment!`
- **Note**: There is no `removePayment`. Payment records are financial history and cannot be deleted; `softDeletePayment` only hides one, `restorePayment` un-hides it. `NOT_FOUND` for an unknown ID.

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

### 2.15 Inventory

Inventory writes need `inventory.adjust` and the ledger query `inventory.view`; see [2.24](#224-staff-roles-and-permissions). **Stock is held per variant (the SKU) and location** (ADR-0008): each store has one default location, where all stock lives for now. A variant shows `available` (on hand minus reserved for open orders; public), `onHand` and `reserved` (staff with `inventory.view`, through the admin `variant` / `variants` queries; `FORBIDDEN` otherwise). `Product.totalStock` and `Product.inStock` summarise the **available** stock of its active variants. Every stock change writes one entry to the append-only stock ledger (`StockMovement`); manual changes also write an audit entry (entity `Variant`, action `STOCK_ADJUSTMENT`). On-hand stock can never go below zero, and reserved stock never above on-hand stock.

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
  note?: string;               // The reason text given by staff, or e.g. "Order cancelled"
  createdAt: DateTime;
}
```

**`StockMovementReason`**: `RECEIPT` (delivery or opening stock of a new variant), `RESERVE` (held for an order line), `SALE` (a hold consumed: online payment captured or cash-on-delivery order dispatched), `RELEASE` (hold given back on cancel or expiry), `RETURN_RESTOCK` (returned goods, or a paid order cancelled before dispatch), `ADJUSTMENT`, `OPENING_BALANCE` (stock the old inventory log did not explain, migration only), `TRANSFER` (not used yet).

---

#### `restockVariant`
- **Type**: Mutation
- **Args**: `input: RestockVariantInput!`
- **Response**: `StockMovement!` (reason `RECEIPT`, or `RETURN_RESTOCK` with `returnRequestId`)
- **Description**: Add stock to a variant at the default location: a delivery, or goods returned by a customer once received and inspected.

**Input: `RestockVariantInput`**

```typescript
{
  variantId: string;        // Required.
  quantity: number;         // Required. Integer >= 1.
  reason?: string;          // Max 500 chars. Default "Manual restock" ("Returned goods restocked" with returnRequestId).
  returnRequestId?: string; // The return request the goods came back under; recorded as RETURN_RESTOCK referencing it.
}
```

**Possible Errors**: `NOT_FOUND` (`Variant "<id>" not found`, `Return request "<id>" not found`).

---

#### `adjustVariantStock`
- **Type**: Mutation
- **Args**: `input: AdjustVariantStockInput!`
- **Response**: `StockMovement!` (reason `ADJUSTMENT`)
- **Description**: Change a variant's on-hand stock by a signed amount, e.g. damage, loss or a stock count correction. Units reserved for open orders cannot be adjusted away.

**Input: `AdjustVariantStockInput`**

```typescript
{
  variantId: string;  // Required.
  delta: number;      // Required. Non-zero integer; negative removes stock.
  reason: string;     // Required. 1–500 chars. Stored as the movement's note.
}
```

**Possible Errors**: `NOT_FOUND` (variant); `BAD_REQUEST` (`Cannot remove N units from variant "<id>": only M available`).

---

#### `stockMovements`
- **Type**: Query (`inventory.view`)
- **Args**: `variantId?: ID`, `productId?: ID` (every variant of the product), `reason?: StockMovementReason`, `first: Int = 50` (1–100), `after?: ID` (the id of the last movement of the previous page)
- **Response**: `StockMovementPage! { nodes: [StockMovement!]!, totalCount: Int!, hasNextPage: Boolean! }`, newest first

---

### 2.16 Returns

---

#### `createReturnRequest`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `input: CreateReturnRequestInput!`
- **Description**: Submit a return request for one of the caller's own orders. Order must be `COMPLETED` (delivered or collected). A new request is allowed only if every earlier request for the order was rejected.
- **Possible Errors**: `NOT_FOUND` (not the caller's order), `BAD_REQUEST` (not delivered, or an open request exists).

**Input: `CreateReturnRequestInput`**

```typescript
{
  orderId: string; // Required.
  reason: string;  // Required. Min 10 chars.
}
```

**Response: `ReturnRequestEntity`** (status enum type: `ReturnStatusEnum`)

```typescript
{
  id: string;
  orderId: string;
  userId: string;
  reason: string;
  status: ReturnStatusEnum;  // PENDING | APPROVED | REJECTED | REFUND_PENDING | REFUNDED
  refundAmount?: Money;
  adminNote?: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `approveReturn` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: ApproveReturnInput!`
- **Response**: `ReturnRequestEntity!`

**Input: `ApproveReturnInput`**

```typescript
{
  returnRequestId: string; // Required.
  refundAmount: Decimal;     // Required. Min 0.
  adminNote?: string;      // Optional.
}
```

**Side effects**: Sets `status = APPROVED` and the refund amount. Stock is not touched. Only a `PENDING` request can be approved (`BAD_REQUEST` otherwise); if another admin approves or rejects it at the same moment, one wins and the other gets `CONFLICT`. The same applies to `rejectReturn`.

---

#### `rejectReturn` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: RejectReturnInput!`
- **Response**: `ReturnRequestEntity!`

**Input: `RejectReturnInput`**

```typescript
{
  returnRequestId: string; // Required.
  adminNote?: string;      // Optional.
}
```

---

#### `processRefund` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `returnRequestId: ID!`
- **Response**: `ReturnRequestEntity!`
- **Description**: Refund the approved amount through Paystack and move the request from `APPROVED` to `REFUNDED`. **Moves money only, never stock:** a cancelled order already had its stock restored at cancellation, and physically returned goods are put back with `restockVariant` (the order line's `variantId`) once received and inspected.
- **How it runs**: the request is first claimed (`APPROVED → REFUND_PENDING`) and a `Refund` record is created, then Paystack is called once. On success the refund becomes `PROCESSED` (with Paystack's refund id in `providerRef`) and the request `REFUNDED`.
- **Limits**: the amount must be greater than 0, and all refunds on the payment (including an auto-refund queued for a flagged payment) cannot exceed what was captured; otherwise `BAD_REQUEST` and nothing changes. Only Paystack payments can be refunded (cash-on-delivery: `BAD_REQUEST`).
- **Errors and retries**:
  - Double-click or a second admin: `CONFLICT`; Paystack is never called twice.
  - Paystack refused the refund: `BAD_REQUEST` ("Nothing was refunded"). The request stays `REFUND_PENDING` and its refund is `FAILED`; call `processRefund` again to retry.
  - Paystack timed out or answered unreadably: an error, and the refund stays `SENDING` because Paystack may have created it. Further calls get `CONFLICT`. Check the Paystack dashboard; there is no in-app way to resolve this yet.
  - Already `REFUNDED`, or not approved: `BAD_REQUEST`.

---

#### `processPendingRefund` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `refundId: ID!`
- **Response**: `RefundEntity`
- **Description**: Sends a `PENDING` refund through Paystack, or resends a `FAILED` one. Used for auto-refunds that payment verification queues when money arrives for a cancelled, already-paid or wrong-amount payment (these are never sent automatically). A refund linked to a return request also completes that request. Same cap, claim and error rules as `processRefund`: a second call gets `CONFLICT`.

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
                              // orders placed before tax was recorded and for auto-refunds of charges that never paid the order
  currency: string;
  status: RefundStatusEnum;   // PENDING | SENDING | PROCESSED | FAILED
  providerRef?: string;       // Paystack refund id
  failureReason?: string;     // why the last send failed, or "Outcome unknown: ..."
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `myReturnRequests`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Response**: `[ReturnRequestEntity!]!`

---

#### `returnRequests` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Response**: `[ReturnRequestEntity!]!`

---

### 2.17 Reviews

> **Privacy:** `Review.user` is a `PublicProfile { displayName }` (first name + last initial, or "Customer"). Reviewer email, phone, addresses and orders are not reachable from reviews. Separately, `User.email`, `User.emailVerified`, `User.pendingEmail`, `User.phoneNumber`, `User.addresses`, `User.orders` and `Order.user` return a `FORBIDDEN` error unless the caller is that user or an ADMIN/SUPER_ADMIN.

The review queries and mutations below require a signed-in user. Guests can still read reviews through `Product.reviews` on the public `products`/`product` queries (field resolvers are not role-checked).

---

#### `review`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `reviewId: String!`
- **Response**: `Review!` (`NOT_FOUND` if unknown)

**`Review` Object Type**:

```typescript
{
  id: string;
  score: number;       // 1–5
  comment?: string;
  productId: string;
  userId: string;
  user: PublicProfile; // { displayName } only, e.g. "Kwame A." ("Customer" if no name)
  product: Product;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `productReviews`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `productId: String!`
- **Response**: `[Review!]!`

---

#### `userReviews`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: Reviews written by the current user.
- **Response**: `[Review!]!`

---

#### `createReview`
- **Type**: Mutation
- **Roles**: `USER` only
- **Args**: `input: CreateReviewInput!`
- **Response**: `Review!`
- **Description**: One review per user per product. Buying the product is not required.

**Input: `CreateReviewInput`**

```typescript
{
  productId: string;  // Required.
  score: number;      // Required. Integer 1–5.
  comment?: string;   // Optional.
}
```

**Possible Errors**: `NOT_FOUND` (product), `BAD_REQUEST` ("You have already reviewed product …").

---

#### `updateReview`
- **Type**: Mutation
- **Roles**: `USER` only
- **Args**: `input: UpdateReviewInput!`
- **Response**: `Review!`

**Input: `UpdateReviewInput`**

```typescript
{
  id: string;          // Required. The review ID.
  score?: number;      // Optional. 1–5.
  comment?: string;    // Optional.
  productId?: string;  // Optional.
}
```

**Possible Errors**: `NOT_FOUND` (review), `BAD_REQUEST` ("You can only modify your own reviews").

---

#### `deleteReview`
- **Type**: Mutation
- **Roles**: `USER` only
- **Args**: `reviewId: String!`
- **Response**: `Review!`
- **Description**: Permanently deletes one of the caller's own reviews (hard delete). Same errors as `updateReview`.

---

#### `adminDeleteReview` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `reviewId: String!`
- **Response**: `Review!`
- **Description**: Permanently deletes any review (moderation). `NOT_FOUND` if unknown.

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

All analytics queries: `ADMIN`, `SUPER_ADMIN` only. Every figure uses one revenue definition, described under [16. Analytics Queries](#16-analytics-queries).

---

#### `salesReport`
- **Type**: Query
- **Args**: `startDate: DateTime!`, `endDate: DateTime!` (both inclusive, top-level arguments: `salesReport(startDate: "…", endDate: "…")`)
- **Response: `SalesReport`**:
```typescript
{
  grossRevenue: Money;      // Payments accepted for orders in the period
  refunds: Money;           // Refunds processed in the period
  netRevenue: Money;        // grossRevenue - refunds
  totalRevenue: Money;      // Deprecated: same value as netRevenue
  itemSales: Money;         // Item sales of the orders paid in the period
  orderCount: number;       // Orders paid in the period
  averageOrderValue: Money; // grossRevenue / orderCount
}
```

---

#### `topProducts`
- **Type**: Query
- **Args**: `limit: Int!` (default 10, 1–100; may be omitted)
- **Response**: `[TopProduct!]!` (paid orders, all time)

```typescript
{
  productId: string;
  productName: string;
  totalQuantitySold: number; // Units sold in paid orders
  totalRevenue: Money;       // Item sales in paid orders
}
```

---

#### `revenueByCategory`
- **Type**: Query
- **Response**: `[RevenueByCategoryEntity!]!` (paid orders, all time)

```typescript
{
  categoryId?: string;
  categoryName?: string;
  totalRevenue: Money; // Item sales in paid orders
  orderCount: number;  // Paid orders containing this category
}
```

---

#### `dashboardSummary`
- **Type**: Query
- **Response: `DashboardSummary`**:

```typescript
{
  totalUsers: number;
  ordersToday: number;       // Orders paid today
  revenueToday: Money;       // Net revenue today
  grossRevenueToday: Money;  // Payments accepted today
  refundsToday: Money;       // Refunds processed today
  lowStockProductCount: number;  // Active products with at least one active variant at or below its low-stock level
  lowStockVariantCount: number;  // Active variants of active products at or below their low-stock level
}
```

A variant is low on stock when its available stock (on hand minus reserved) is at or below its `lowStockThreshold` (default 5; set on `createVariant`/`updateVariant`/`createProduct`, read on `Variant.lowStockThreshold`).

---

### 2.20 Addresses

**Breaking change (P1-G):** addresses are Ghana addresses. `state` is gone, replaced by the required `region` enum (`GhanaRegion`); `zipCode` is optional; `recipientName`, `phone`, `area`, `landmark`, `ghanaPostGps`, `latitude` and `longitude` are new; `country` must be `GH`. New addresses need `recipientName`, `phone` and `region`. Addresses saved before this change can have `region`, `recipientName` and `phone` set to `null`: checkout and `getShippingFee` refuse them with `BAD_REQUEST` "Complete the delivery address (region, recipient name and phone) before checkout" until the customer fills them in with `updateAddress`.

**Formats**:
- `phone`: a Ghana number written as `0XXXXXXXXX`, `233XXXXXXXXX`, `+233XXXXXXXXX` or `00233XXXXXXXXX`, where the nine-digit national number does not start with 0. Spaces, dashes, dots and parentheses are ignored (`024 412 3456`, `(024) 412-3456`). It is stored and returned in E.164 form, `+233XXXXXXXXX`. Anything else (another country, too short or long, letters) is `BAD_USER_INPUT`.
- `ghanaPostGps`: a GhanaPostGPS digital address, two letters, 3–4 digits, then 4 digits; case, spaces and hyphens are free (`GA1234567`, `ga-123-4567`, `AK 484 9321`). Stored and returned as `XX-NNN-NNNN` or `XX-NNNN-NNNN` (`GA-123-4567`). Anything else is `BAD_USER_INPUT`.
- `region`: one of the 16 regions: `AHAFO`, `ASHANTI`, `BONO`, `BONO_EAST`, `CENTRAL`, `EASTERN`, `GREATER_ACCRA`, `NORTH_EAST`, `NORTHERN`, `OTI`, `SAVANNAH`, `UPPER_EAST`, `UPPER_WEST`, `VOLTA`, `WESTERN`, `WESTERN_NORTH`.
- `country`: optional, defaults to `GH`; if sent it must be `GH` (any case, surrounding spaces ignored), otherwise `BAD_USER_INPUT`. The store delivers in Ghana only.
- `latitude` / `longitude`: optional `Float`s, sent together (or both `null` to clear them); latitude −90..90, longitude −180..180. Stored with 6 decimal places.
- `city` is the city or town; it is what shipping zones match (case-insensitive, extra spaces ignored).

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

A **shipping zone** has a fee and a list of cities. At checkout a `DELIVERY` order pays the fee of the active zone that lists the address city (case-insensitive, extra spaces ignored); if no active zone lists it, delivery is refused. Each city belongs to at most one zone. A **pickup location** is where a `PICKUP` order is collected (no shipping fee).

---

#### `activeShippingZones`
- **Type**: Query
- **Auth Required**: No
- **Response**: `[ShippingZoneEntity!]!`, active zones sorted by name

**`ShippingZoneEntity` Object Type**:

```typescript
{
  id: string;
  name: string;      // Unique
  cities: string[];  // Stored normalised (lower-case, single spaces)
  fee: Money;        // GHS
  isActive: boolean;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `getShippingFee`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `addressId: ID!`
- **Response**: `Money!`, the fee `createOrder` would charge for delivery to that address
- **Possible Errors**: `NOT_FOUND` (not the caller's address); `BAD_REQUEST` "Complete the delivery address (region, recipient name and phone) before checkout" for an address saved before those fields existed; `BAD_REQUEST` ("Delivery is not available to city …") when no active zone covers the city.

---

#### `shippingZones` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Response**: `[ShippingZoneEntity!]!`, all zones sorted by name

---

#### `shippingZone` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `id: ID!`
- **Response**: `ShippingZoneEntity!` (`NOT_FOUND` if unknown)

---

#### `createShippingZone` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: CreateShippingZoneInput!`
- **Response**: `ShippingZoneEntity!`

**Input: `CreateShippingZoneInput`**

```typescript
{
  name: string;       // Required. Unique.
  cities: string[];   // Required. No blank entries; duplicates are merged.
  fee: Decimal;         // Required. Min 0.
  isActive?: boolean; // Default true.
}
```

**Possible Errors**: `CONFLICT` ("Cities already covered by another shipping zone: …", active or not; or the name is taken), `BAD_REQUEST` (blank city).

---

#### `updateShippingZone` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: ID!`, `input: UpdateShippingZoneInput!` (`name?`, `cities?` replaces the whole list, `fee?`, `isActive?`)
- **Response**: `ShippingZoneEntity!`
- **Possible Errors**: `NOT_FOUND`, `CONFLICT` (city overlap or name taken), `BAD_REQUEST` (blank city).

---

#### `deleteShippingZone` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: ID!`
- **Response**: `ShippingZoneEntity!`
- **Description**: Existing orders keep the fee they were charged.

---

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
  state: string;
  country: string;
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
  name: string;       // Required, non-empty.
  address: string;    // Required, non-empty.
  city: string;       // Required, non-empty.
  state: string;      // Required, non-empty.
  country: string;    // Required, non-empty.
  isActive?: boolean; // Default true.
}
```

---

#### `updatePickupLocation` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: ID!`, `input: UpdatePickupLocationInput!` (all fields optional)
- **Response**: `PickupLocationEntity!`
- **Possible Errors**: `NOT_FOUND`. Orders already placed keep their `pickupLocationSnapshot`.

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
}
```

The currency cannot be changed through the API.

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
| Cashier (`CASHIER`) | `catalog.product.read`, `order.view`, `payment.view`, `payment.record` | No (may opt in) |
| Support (`SUPPORT`) | `order.view`, `return.manage`, `payment.view`, `user.view`, `review.moderate` | No (may opt in) |

Pharmacist and Rider roles come with their verticals. The Owner can create **custom roles** from the catalogue (`createStaffRole`).

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
| `inventory.view` | `stockMovements`; the `Variant.onHand` and `Variant.reserved` fields |
| `inventory.adjust` | `restockVariant`, `adjustVariantStock` |
| `order.view` | `getOrders`, `viewOrder` |
| `order.manage` | `adminCancelOrder`, `deleteOrder` |
| `order.fulfil` | `updateShipmentStatus`, `updateShipping` (P1-O.2; held by Owner, Manager, Inventory clerk and Cashier) |
| `order.refund` | `approveReturn` (with `return.manage`), `processRefund`, `processPendingRefund` |
| `return.manage` | `returnRequests`, `rejectReturn`, `approveReturn` (with `order.refund`) |
| `payment.view` | `payments`, `getUserPayment`, `refunds`, any customer's `payment` |
| `payment.record` | `recordCodPayment` |
| `payment.manage` | `softDeletePayment`, `restorePayment` |
| `promotion.manage` | `promotions`, `promotion`, `createPromotion`, `updatePromotion`, `deletePromotion`, `createCouponCode`, `updateCouponCode`, `deleteCouponCode`, `redemptions` (P2-B.1) |
| `customer.group.manage` | `customerGroups`, `customerGroup` (with `members`), `createCustomerGroup`, `updateCustomerGroup`, `deleteCustomerGroup`, `addCustomerGroupMembers`, `removeCustomerGroupMembers` (P2-B.3; held by Owner and Manager) |
| `pricelist.manage` | `priceLists`, `priceList` (with `entries`), and with step-up `createPriceList`, `updatePriceList`, `deletePriceList`, `setPriceListEntries`, `removePriceListEntries` (P2-W.1; held by Owner and Manager) |
| `tax.manage` | `taxes`, `tax`, `createTax`, `updateTax`, `deleteTax` |
| `shipping.manage` | admin shipping zone and pickup location queries and mutations |
| `review.moderate` | `adminDeleteReview` |
| `user.view` | `users`, `userById`, `userByEmail`, `userByProviderId`, `addresses(userId)`, other users' protected `User` fields |
| `user.manage` | `updateUser`, `removeUser`, `archiveUser`, `deArchiveUser` (customer accounts; staff accounts also need `staff.manage`) |
| `customer.data.export` | `addresses` without `userId` (every customer address) |
| `staff.view` | `staffRoles`, `staffPermissions`, `staffMembers` |
| `staff.manage` | `createUser`, `assignStaffRole`, `removeStaffRole`, `createStaffRole`, `updateStaffRole`, managing staff accounts |
| `report.view` | `salesReport`, `topProducts`, `revenueByCategory`, `dashboardSummary` |
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
| Refunds | `approveReturn`, `processRefund`, `processPendingRefund` |
| Price changes | `updateProduct` when `isTaxable` is sent (it reprices every variant), `updateVariant` when `basePrice` is sent, every discount and coupon mutation, `createTax` / `updateTax` / `deleteTax` |
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

#### `addAttributeDefinition` / `updateAttributeDefinition` / `removeAttributeDefinition`
- **Type**: Mutation · **Auth**: `catalog.taxonomy.write`
- **Args**: `addAttributeDefinition(productTypeId: ID!, input: AttributeDefinitionInput!)`, `updateAttributeDefinition(attributeId: ID!, input: UpdateAttributeDefinitionInput!)` with `{ label?; unit?; isRequired?; allowedValues?; isFilterable?; position? }` (key, data type and variant-axis flag never change), `removeAttributeDefinition(attributeId: ID!)`
- **Response**: the whole `ProductType!` · **Side effects**: audit entry (entity `AttributeDefinition`).
- **Rules for a type that products use** (so stored values stay valid): new attributes must be optional; an attribute can be relabelled, reordered, made (un)filterable, made optional and given extra allowed values; making it required, changing its unit, narrowing its allowed values and removing it are refused with `CONFLICT`. System types refuse every change.
- **Possible Errors**: `CONFLICT`, `NOT_FOUND`, `BAD_USER_INPUT`, `FORBIDDEN`.

**Capability fields on Product** (typed, for rules later phases enforce; today they are stored and returned only): `requiresPrescription` (pharmacy checkout gate), `isPerishable` and `shelfLifeDays` (expiry tracking with the inventory ledger), `trackLots` and `trackSerials` (lot and serial tracking), `fulfilmentKind` (`PHYSICAL` | `DIGITAL` | `SERVICE`, for delivery rules) and `unitOfMeasure` (`EACH` | `KG` | `G` | `L` | `ML` | `M`, for weighable goods). `createProduct` / `updateProduct` accept them (all optional; defaults `false`, `PHYSICAL`, `EACH`; `shelfLifeDays` 1-3650). Physical sizes live on the variant: `weightGrams`, `lengthMm`, `widthMm`, `heightMm`.

---

## 3. REST API Reference

These endpoints are not in GraphQL. They use standard HTTP. Errors are JSON: `{ "statusCode": 400, "timestamp": "…", "path": "/payment/initialize", "message": "…" }`.

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
| `Payment.amount`; `RefundEntity.amount`; `ReturnRequestEntity.refundAmount` |
| `Coupon.minimumOrderAmount`; `CouponValidation.discountAmount`; `Discount.minimumPurchase` |
| `ShippingZoneEntity.fee`; query `getShippingFee` (`Float!` → `Money!`) |
| `SalesReport.grossRevenue`, `refunds`, `netRevenue`, `totalRevenue`, `itemSales`, `averageOrderValue` |
| `DashboardSummary.revenueToday`, `grossRevenueToday`, `refundsToday`; `TopProduct.totalRevenue`; `RevenueByCategoryEntity.totalRevenue` |

Money fields added since: `Variant.basePrice` (P1-V.4), `Variant.discountedPrice`, `Product.priceRange.min` / `max` (P1-V.3).

| Changed fields (output, `Float` → `Decimal`) |
|---|
| `Coupon.value`, `Discount.value`, `TaxEntity.rate` |

| Changed inputs and arguments (→ `Decimal`) |
|---|
| `CreateVariantInput.basePrice` / `UpdateVariantInput.basePrice` / `VariantFieldsInput.basePrice` (the product's `basePrice` input moved to its variants in P1-V.3; the variant `price` input became `basePrice` in P1-V.4) |
| `CreateCouponInput.value`, `minimumOrderAmount`; `UpdateCouponInput.value`, `minimumOrderAmount`; `ValidateCouponInput.orderTotal` |
| `CreateDiscountInput.value`, `minimumPurchase`; `UpdateDiscountInput.value`, `minimumPurchase` (both must be greater than 0) |
| `CreateShippingZoneInput.fee`, `UpdateShippingZoneInput.fee` |
| `CreateTaxInput.rate`, `UpdateTaxInput.rate` (0 to 1, at most 6 decimal places) |
| `ApproveReturnInput.refundAmount` |
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
| `ReturnStatusEnum` | `PENDING`, `APPROVED`, `REJECTED`, `REFUND_PENDING`, `REFUNDED` | `ReturnRequestEntity.status` |
| `RefundStatusEnum` | `PENDING` (recorded, not sent), `SENDING` (sent, outcome unknown if it stays), `PROCESSED` (accepted by Paystack), `FAILED` (refused, can be resent) | `RefundEntity.status`, `refunds(status)` |
| `StockMovementReason` | `OPENING_BALANCE`, `RECEIPT`, `SALE`, `RETURN_RESTOCK`, `ADJUSTMENT`, `TRANSFER`, `RESERVE`, `RELEASE` | `StockMovement.reason`, `stockMovements(reason)` |
| `DiscountType` | `PERCENTAGE`, `FLAT` | `Discount.type`, discount inputs |
| `DiscountTypeEnum` | `PERCENTAGE`, `FLAT` | `Coupon.discountType`, coupon inputs (a separate enum with the same values) |
| `ProductStatus` | `DRAFT`, `PUBLISHED`, `ARCHIVED` | `Product.status`, product inputs, `ProductFilterArgs.status` |
| `Currency` | `GHS`, `USD`, `EUR`, `GBP`, `NGN` | `Product.currency` (only products in the store currency, GHS, can be checked out) |
| `DeliveryOptions` | `LOCAL_DELIVERY`, `INTERNATIONAL_DELIVERY`, `SELECTED_REGIONS` | `Product.deliveryOptions` (informational; not enforced at checkout) |
| `ProductSortField` | `CREATED_AT`, `NAME`, `UPDATED_AT` (`PRICE` and `QUANTITY` removed in P1-V.3) | `ProductSortArgs.sortBy` |
| `SortOrder` | `ASC`, `DESC` | `ProductSortArgs.sortOrder` |

### Where each object type is described

| Type | Section |
|---|---|
| `AuthEntity` | [2.1](#21-authentication-iam) |
| `User`, `UserConnection`, `UserEdge`, `PublicProfile` | [2.2](#22-users), [2.17](#217-reviews) |
| `Product`, `PriceRange`, `ProductConnection`, `ProductEdge` | [2.3](#23-products) |
| `ProductType`, `AttributeDefinition` | [2.26](#226-product-types-and-attributes) |
| `Category`, `SubCategory`, `Brand`, `Tag`, `Variant` | [2.4](#24-categories)–[2.8](#28-variants) |
| `Cart`, `CartItem`, `Wishlist` | [2.9](#29-cart), [2.10](#210-wishlist) |
| `Order`, `OrderItem` | [2.11](#211-orders) |
| `Payment` | [2.12](#212-payment) |
| `Coupon`, `CouponValidation`, `Discount` | [2.13](#213-coupons), [2.14](#214-discounts) |
| `StockMovement`, `StockMovementPage` | [2.15](#215-inventory) |
| `ReturnRequestEntity`, `RefundEntity` | [2.16](#216-returns) |
| `Review` | [2.17](#217-reviews) |
| `TaxEntity` | [2.18](#218-tax) |
| `SalesReport`, `TopProduct`, `RevenueByCategoryEntity`, `DashboardSummary` | [2.19](#219-analytics), [16](#16-analytics-queries) |
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
   - `DELIVERY`: the user needs a saved address (`query userAddresses` or `mutation createAddress`). Show the fee with `query getShippingFee(addressId)`; a `BAD_REQUEST` means either the address is incomplete (an address saved before P1-G without region, recipient or phone: ask the customer to complete it with `updateAddress`) or the city is not served (offer pickup or another address).
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

### Return Request Flow

1. User submits: `mutation createReturnRequest(input: { orderId, reason })`. Order must be `COMPLETED`.
2. `ReturnRequest` created with `status = PENDING`.
3. Admin reviews: `mutation approveReturn(input: { returnRequestId, refundAmount, adminNote? })` → status → `APPROVED`.
4. Admin rejects: `mutation rejectReturn(input: { returnRequestId, adminNote? })` → status → `REJECTED`.
5. Admin processes the refund through Paystack: `mutation processRefund(returnRequestId)` → status → `REFUND_PENDING` while it is sent, then `REFUNDED`. If Paystack refuses, it stays `REFUND_PENDING` and can be retried.
6. Returned goods are put back in stock manually with `restockVariant` (the order line's `variantId`) once received.

Cancelling a paid online order creates a return request automatically ("Automatic refund request for cancelled paid order") for staff to approve and refund.

### Review Submission Flow

1. User must be authenticated with the `USER` role.
2. Call `mutation createReview(input: { productId, score, comment? })`. `score` must be 1–5; one review per product.
3. To update: `mutation updateReview(input: { id, score?, comment? })`.
4. To delete: `mutation deleteReview(reviewId)` — permanently deletes the review.

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
           createReturnRequest()
                   ↓
    ReturnRequest: PENDING → APPROVED → REFUND_PENDING → REFUNDED
                     |
                  REJECTED

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
| `IN_FULFILMENT` | `COMPLETED` | `updateShipmentStatus(DELIVERED)`, or `recordCodPayment` for COD | Staff (`order.fulfil` / `payment.record`) |
| `IN_FULFILMENT` | `CANCELLED` | `adminCancelOrder` while the shipment is `PENDING`/`PICKING`/`PACKED`/`RETURNED` | Staff (`order.manage`) |
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

- `restockVariant`: a delivery (`RECEIPT`), or returned goods with `returnRequestId` (`RETURN_RESTOCK`). A new variant's opening stock (from `createProduct` or `createVariant`) is a `RECEIPT` ("Initial stock").
- `adjustVariantStock`: `ADJUSTMENT` by a signed delta, never below the reserved units.
- Not on `approveReturn`, `processRefund` or `deleteOrder`: returned goods are restocked with `restockVariant`.

### Out-of-Stock Handling

- On-hand stock never goes negative and reserved never exceeds on hand (conditional updates plus database checks).
- Adding to cart and creating an order check the variant's available stock (`BAD_REQUEST` if insufficient). Adding to cart does not reserve.
- Show availability per variant from `Variant.available`, and on product cards from `Product.inStock` / `totalStock`.
- `ProductFilterArgs.inStock: true` returns only products with an active variant that has available stock.

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

Only `products`, `adminProducts` and `users` are paginated (relay-style). The cursor is the record's `id`.

**`PaginationArgs`** (products; `UserPaginateArgs` has the same fields plus filters):

```typescript
{
  first: number;       // Page size. Default 12. Min 1. Max 100. (Omitting paginationArgs entirely on products gives 10.)
  after?: string;      // Cursor: the ID of the last item from the previous page.
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

- **Products**: `sortArgs: ProductSortArgs { sortBy: CREATED_AT | NAME | UPDATED_AT, sortOrder: ASC | DESC }`, default `CREATED_AT DESC` (price and stock sorts were removed in P1-V.3). `paginationArgs.orderBy`/`orderInAsc` are ignored.
- **Users**: `filter.orderBy` (one of `id`, `name`, `email`, `phoneNumber`, `role`, `isActive`, `createdAt`, `updatedAt`, `lastLoginAt`, `profilePicture`) and `filter.orderInAsc`.

### Filtering Options per Resource

**Products** (`ProductFilterArgs`): `categoryId`, `categoryName`, `subCategoryName`, `subcategoryId`, `isActive` (default `true`, admin only), `status` (admin only), `search`, `createdAfter` (ISO date), `priceMin`, `priceMax`, `brand` (exact name), `inStock` (`true` = an active variant in stock), `tagId`, `tagName`. `priceMin`/`priceMax`/`inStock` must all hold for the same active variant.

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

### Types of Notifications

All notifications are **email-only** via Resend. There are no in-app notifications, push notifications, or real-time subscriptions in this system.

| Trigger | Email | Recipient |
|---|---|---|
| `signUp`, `resendVerificationEmail` | Email verification token (valid 24 hours) | The address being verified |
| First successful `verifyEmail` of an account | Welcome email | User |
| Email change requested (`updateMyProfile` / `updateUser` with a new email) | Verification token to the new address, and a notice to the current address | Both addresses |
| Order created | Order confirmation | Account email (not `contactEmail`) |
| Shipment dispatched (`OUT_FOR_DELIVERY` / `READY_FOR_PICKUP`), order `COMPLETED` (`updateShipmentStatus(DELIVERED)` or `recordCodPayment`), or `updateShipping` with a tracking number | Status update (with tracking number when set) | Account email |
| Online payment confirmed (webhook, `verifyPayment` or sweep), once per order | Payment confirmation | Account email |
| `forgotPassword` for an existing account | Password reset token | Requesting address |

Not emailed: cancellations, expiries, refunds, other fulfilment steps.

### Asynchronous, queued and retried

Emails are sent by the background worker, never on the request path, so they do not block or fail the request and may arrive a few seconds later. Emails that follow an order or payment change are written to the outbox in the same database transaction as the change, so an email is queued exactly when the change commits. A failed send (including one the email provider rejects) is retried with exponential backoff, up to 6 attempts; after that the job is listed by `failedJobs` and can be retried with `retryFailedJob`. A job's email is sent at most once, even when it is retried. Without `RESEND_API_KEY` no email is sent (the worker logs a warning).

### No GraphQL Mutations for Notifications

There are no `markAsRead`, `getNotifications`, or notification subscription GraphQL operations. Notification state is purely email-based.

---

## 16. Analytics Queries

All analytics are `ADMIN`/`SUPER_ADMIN` only. Amounts are GHS.

### Revenue definition

Revenue comes from the payment ledger, not from order status:

- **Paid order**: an order with an accepted payment, meaning an online payment that settled for the order, or cash collected for a cash-on-delivery order. Unpaid online checkouts, cancelled orders and cash-on-delivery orders not yet collected are not paid orders.
- **Gross revenue**: the accepted payments (the order total: items + shipping - coupon discount). A payment is counted when it was accepted: when the online payment settled, or when the cash was collected. Payments captured but not accepted for their order (for example a late payment on a cancelled order) are never revenue; they are refunded automatically.
- **Refunds**: refunds with status `PROCESSED` against accepted payments, counted when they were processed. Pending, sending or failed refunds are not deducted.
- **Net revenue**: gross revenue - refunds.
- **Order count** and **average order value** (gross revenue / order count) cover the orders paid in the period.

The dashboard's "today" figures are `salesReport` from the start of today (server time) until now.

### Product and category breakdowns

`topProducts` and `revenueByCategory` cover the same population (paid orders), all time. Their `totalRevenue` is **item sales**: unit price paid × quantity, after item-level discounts but before the order-level coupon, without shipping, and before refunds (refunds are recorded per order, not per item). Relation to the sales report over the same paid orders:

```
itemSales    = sum of topProducts.totalRevenue over all products = sum of revenueByCategory.totalRevenue
grossRevenue = itemSales + shipping fees - coupon discounts
netRevenue   = grossRevenue - refunds
```

`salesReport.itemSales` is the item sales of the orders paid in the requested period, so an all-time `salesReport` reconciles with the breakdowns.

### `salesReport(startDate, endDate)`

Both dates are inclusive.

```typescript
{
  grossRevenue: Money;          // Accepted payments in the period
  refunds: Money;               // Processed refunds in the period
  netRevenue: Money;            // grossRevenue - refunds
  totalRevenue: Money;          // Deprecated: same value as netRevenue
  itemSales: Money;             // Item sales of the orders paid in the period
  orderCount: number;           // Orders paid in the period
  averageOrderValue: Money;     // grossRevenue / orderCount (0 when there are no paid orders)
}
```

### `topProducts(limit?)`

Returns the best-selling products of paid orders by quantity, descending:

```typescript
[{
  productId: string;
  productName: string;
  totalQuantitySold: number;
  totalRevenue: Money;          // Item sales
}]
```

Default `limit`: 10. Max: 100.

### `revenueByCategory()`

Returns item sales of paid orders grouped by category, highest first:

```typescript
[{
  categoryId?: string;
  categoryName?: string;
  totalRevenue: Money;          // Item sales
  orderCount: number;           // Paid orders containing this category
}]
```

### `dashboardSummary()`

Snapshot of key admin metrics:

```typescript
{
  totalUsers: number;
  ordersToday: number;          // Orders paid today
  revenueToday: Money;          // Net revenue today
  grossRevenueToday: Money;     // Accepted payments today
  refundsToday: Money;          // Processed refunds today
  lowStockProductCount: number; // Active products with at least one active variant at or below its low-stock level
  lowStockVariantCount: number; // Active variants of active products at or below their low-stock level (default 5)
}
```

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
| `MFA_ENCRYPTION_KEY` | ✅ | — | AES-256-GCM key for TOTP secrets at rest and recovery-code hashing: 64 hex characters (`openssl rand -hex 32`). A key made of a repeated pattern is rejected in production. Changing it invalidates every enrolment. |

### OAuth

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth app secret |
| `FACEBOOK_APP_ID` | ✅ | Facebook App ID |
| `FACEBOOK_APP_SECRET` | ✅ | Facebook App Secret |

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
export type ProductSortField = 'CREATED_AT' | 'NAME' | 'UPDATED_AT';
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
  getShippingFee(addressId: "clx_address_xyz") { amount currency }
}
```

A `BAD_REQUEST` here means the address is incomplete (complete it with `updateAddress`) or no shipping zone covers the city: offer pickup (`activePickupLocations`) instead.

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

Staff set the tracking details (`updateShipping`, emails the customer) and move the shipment; the order follows (`IN_FULFILMENT`, then `COMPLETED`):
```graphql
mutation {
  updateShipmentStatus(input: {
    orderId: "clx_order_789"
    status: OUT_FOR_DELIVERY
  }) { id status shipments { status trackingNumber } }
}
```

Then:
```graphql
mutation {
  updateShipmentStatus(input: {
    orderId: "clx_order_789"
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
