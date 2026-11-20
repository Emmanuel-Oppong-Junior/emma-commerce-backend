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
   - [Coupons](#213-coupons)
   - [Discounts](#214-discounts)
   - [Inventory](#215-inventory)
   - [Returns](#216-returns)
   - [Reviews](#217-reviews)
   - [Tax](#218-tax)
   - [Analytics](#219-analytics)
   - [Addresses](#220-addresses)
   - [Shipping Zones & Pickup Locations](#221-shipping-zones--pickup-locations)
   - [Store settings](#222-store-settings)
3. [REST API Reference](#3-rest-api-reference)
4. [Types & Enums](#4-types--enums)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [Commerce Flows](#6-commerce-flows)
7. [Order Lifecycle](#7-order-lifecycle)
8. [Payment Integration (Paystack)](#8-payment-integration-paystack)
9. [Inventory Rules](#9-inventory-rules)
10. [Discounts System](#10-discounts-system)
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
| Scheduling | `@nestjs/schedule`: unpaid-order expiry (hourly), payment reconciliation sweep (every 5 minutes), Paystack daily diff (01:30 UTC), low-stock log check (every 6 hours) |
| Rate Limiting | `@nestjs/throttler` with per-named-throttler rules |

### GraphQL Approach

**Code-first.** The schema is auto-generated to `schema.gql` on startup. NestJS `@ObjectType()` and `@InputType()` decorators define the schema. Apollo Server v4 is the driver.

- Landing page: Apollo Sandbox outside production, disabled in production.
- Introspection: **disabled in production**.
- Error formatting: internal errors are masked in production; validation/auth/business logic errors are always forwarded.

### Auth Strategy

- **Default**: all routes require Bearer JWT unless decorated with `@Auth(AuthType.None)`.
- Access token: short-lived (default 1 hour, `JWT_ACCESS_TOKEN_TTL`).
- Refresh token: longer-lived (default 24 hours, `JWT_REFRESH_TOKEN_TTL`), stored **hashed** in the `RefreshToken` database table.
- Refresh tokens are **rotated** on use — old token is revoked, new pair is issued atomically. Replaying a used refresh token signs the user out everywhere (see [Section 5](#5-authentication--authorization)).
- A session can be refreshed for at most **30 days** after sign-in; then the user must sign in again.
- Password reset tokens: 15-minute TTL signed with separate secret (`JWT_RESET_SECRET`).
- **Account lockout**: 5 consecutive failed logins trigger a 15-minute lockout (tracked in `User.failedLoginAttempts` and `User.lockedUntil`).

### Payment Integration

- Paystack is used exclusively.
- Payment is initiated via a **REST POST** endpoint (`POST /payment/initialize`).
- Frontend redirects user to Paystack's `authorizationUrl`.
- After payment Paystack redirects the browser to `PAYSTACK_CALLBACK_URL`, which must be a **frontend page** (the backend has no callback route). That page calls the `verifyPayment` GraphQL mutation with the `reference` query parameter.
- Paystack also calls the **webhook** (`POST /payment/webhook`) with `charge.success` or `charge.failed` events, and a background sweep re-checks open payments every 5 minutes.

### File Storage (Cloudinary)

Images are uploaded via REST endpoints for ADMIN/SUPER_ADMIN only (`POST /upload/single-image`, `POST /upload/multiple-images`). Images are resized to **500×500** pixels (contain mode, white background) before upload. Folder: `ecommerce`.

### Observability

- Winston logger logs all HTTP requests (middleware), GraphQL operations (interceptor), and errors.
- OpenTelemetry: activate with `OTEL_ENABLED=true`; exports traces to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318/v1/traces`).

### Database

PostgreSQL via Prisma. Full-text search is enabled (`fullTextSearchPostgres` preview feature).

---

## 2. GraphQL API Reference

**GraphQL Endpoint**: `POST /graphql`

### Platform rules

**Auth.** Every operation requires `Authorization: Bearer <accessToken>` unless marked **Auth Required: No** (public). A missing, invalid or expired token, or a deactivated account, gives `UNAUTHENTICATED`. The account (and its role) is re-read from the database on every request.

**Roles** are checked by exact membership, not hierarchy: an operation listed as `ADMIN` only (e.g. `getUserPayment`, `updateSubCategory`) refuses a `SUPER_ADMIN` with `FORBIDDEN`. "Any signed-in user" means `USER`, `ADMIN` or `SUPER_ADMIN`.

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

Resolver default: `SUPER_ADMIN` only, overridden per operation below. Super admin accounts are never listed by `users` and can never be created, changed, archived or deleted through the API. An `ADMIN` may manage `USER` accounts only; acting on any `ADMIN` account (including their own via `updateUser`/`removeUser`) is `FORBIDDEN`, only a `SUPER_ADMIN` may.

---

#### `createUser` (SUPER_ADMIN only)
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
  role: Role;              // Default USER. USER or ADMIN; SUPER_ADMIN is refused.
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
  role: string;            // "USER" | "ADMIN" | "SUPER_ADMIN"
  createdAt: DateTime;
  updatedAt: DateTime;
  lastLoginAt?: DateTime;
  addresses?: Address[];   // Owner or admin only.
  orders?: Order[];        // Owner or admin only.
}
```

Reading an "owner or admin only" field of another user as a `USER` gives `FORBIDDEN` for that field.

---

### 2.3 Products

> **Visibility:** the public `products` and `product` queries only ever return products that are active **and** `PUBLISHED`; `isActive`/`status` sent in `filterArgs` cannot widen that. `product` returns `null` for a draft, archived or inactive product. Admins list and open products in any state with `adminProducts` / `adminProduct`. Nested `products` on `Category`, `SubCategory` and `Brand` also return published products only, newest first, capped by `first` (default 20, 1–100; anything else is an error).

> **Price:** admins enter `basePrice`. `price` is what customers pay and what checkout charges: `basePrice × (1 + sum of active tax rates)` when `isTaxable`, otherwise `basePrice`. It is recomputed when `basePrice`/`isTaxable` change and whenever a tax is created, updated or deleted. Product discounts are shown via `discountedPrice` and charged at checkout (see [Section 10](#10-discounts-system)).

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
  priceMin?: Decimal;          // Inclusive, compared with price
  priceMax?: Decimal;          // Inclusive, compared with price
  brand?: string;             // Brand name, exact, case-insensitive
  inStock?: boolean;          // See note below
  tagId?: string;
  tagName?: string;           // Exact, case-insensitive
}

// ProductSortArgs
{
  sortBy: ProductSortField;   // CREATED_AT (default) | NAME | PRICE | QUANTITY | UPDATED_AT
  sortOrder: SortOrder;       // DESC (default) | ASC
}
```

Known filter defects (do not rely on them yet): `subCategoryName` compares the subcategory name with the `categoryName` value, and `inStock: true` does not exclude out-of-stock products. Use `subcategoryId` instead.

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
  basePrice?: Money;            // Admin-entered price before tax
  price?: Money;                // Tax-inclusive selling price (charged at checkout)
  currentPrice?: Money;         // Not set by any API operation (null unless set in the database)
  currency?: Currency;          // Default GHS; only GHS products can be checked out
  isTaxable: boolean;
  discountedPrice?: Money;      // price after the best active discount; null when no discount applies
  appliedDiscount?: Discount;   // The discount behind discountedPrice, or null
  discounts?: Discount[];
  sku?: string;
  barcode?: string;
  quantity: number;             // Stock
  lowStockAlert?: number;
  stockStatus?: StockStatus;    // Stored as entered; not updated automatically from quantity
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
  variants?: Variant[];
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
    filterArgs: { categoryId: "clx_cat" }
    sortArgs: { sortBy: PRICE, sortOrder: ASC }
  ) {
    edges { cursor node { id name price { amount currency } discountedPrice { amount currency } currency images } }
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
  basePrice: Decimal;            // Required. e.g. "29.99" (at most 2 decimal places). There is no `price` input.
  quantity: number;              // Required. Integer >= 0 (initial stock).
  isActive: boolean;             // Default false.
  isTaxable: boolean;            // Default false.
  status?: ProductStatus;        // Default DRAFT. Must be PUBLISHED (and isActive true) to appear publicly.
  shortDescription?: string;     // Max 500 chars.
  description?: string;          // Max 5000 chars.
  images?: string[];             // Max 10 HTTPS URLs.
  attachments?: string[];        // URLs.
  currency?: Currency;           // Default GHS.
  sku?: string;                  // 1–50 chars, letters, digits and hyphens. Unique.
  barcode?: string;              // 1–100 chars. Unique.
  lowStockAlert?: number;        // Integer 0–10000. Default 5.
  stockStatus?: StockStatus;     // Default IN_STOCK.
  deliveryOptions?: DeliveryOptions[];   // Default [LOCAL_DELIVERY].
  selectedDeliveryRegions?: string[];    // Region names when deliveryOptions includes SELECTED_REGIONS.
  expiryDate?: DateTime;
  categoryId?: string;           // Optional.
  subcategoryId?: string;        // Must belong to categoryId.
  brandId?: string;
}
```

**Possible Errors**:
- `BAD_USER_INPUT` — Validation failure.
- `NOT_FOUND` — Category or subcategory not found.
- `CONFLICT` — SKU already in use, subcategory does not belong to the category, or another unique value (barcode) already used.

---

#### `updateProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`, `updateProductInput: UpdateProductInput!`
- **Response**: `Product!`

`UpdateProductInput` has the `CreateProductInput` fields, all optional, **except `quantity`**: stock cannot be set here (sending it is a schema error, HTTP 400). Change stock with `restockProduct` or `adjustProductStock`. Omitted fields, including `isActive` and `isTaxable`, are left unchanged. Changing `isTaxable` on a product that has no `basePrice` (e.g. older seeded products) without also sending `basePrice` fails with `BAD_REQUEST`, instead of setting the price to 0.00.

---

#### `permanentlyDeleteProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`
- **Response**: `Product!`
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

Resolver default: `ADMIN`, `SUPER_ADMIN`; reads are open to any signed-in user. Variants cannot be put in the cart or bought yet: cart and order items reference the product only, and stock is taken from the product. Until variant checkout exists, a product with at least one variant cannot be sold at all: `addToCart` and `createOrder` reject it with `BAD_REQUEST` naming the product. Products without variants sell normally. Adding the first variant to a product takes it off sale; deleting its last variant puts it back.

---

#### `variant`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user)
- **Args**: `variantId: String!`
- **Response**: `Variant!` (`NOT_FOUND` if unknown)

**`Variant` Object Type**:

```typescript
{
  id: string;
  size?: string;
  color?: string;
  quantity: Float;
  price: Money;
  productId: string;
  product: Product;
  discountId?: string;
}
```

---

#### `productVariants`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user)
- **Args**: `productId: String!`
- **Response**: `[Variant!]!`

---

#### `variants`
- **Type**: Query
- **Auth Required**: Yes (any signed-in user; the schema description says "admin only", but `USER` is allowed)
- **Response**: `[Variant!]!`, all variants

---

#### `createVariant` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: CreateVariantInput!`
- **Response**: `Variant!`

**Input: `CreateVariantInput`**

```typescript
{
  productId: string;   // Required.
  price: Decimal;        // Required. Min 0.
  quantity: Float;     // Required. Min 0 (initial stock).
  size?: string;
  color?: string;
  discountId?: string;
}
```

**Possible Errors**: `NOT_FOUND` (product).

---

#### `updateVariant` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: UpdateVariantInput!`
- **Response**: `Variant!`

**Input: `UpdateVariantInput`**

```typescript
{
  id: string;          // Required. Variant to update.
  price?: Decimal;
  size?: string;
  color?: string;
  productId?: string;
  discountId?: string;
}
```

There is no `quantity` (sending it is a schema error, HTTP 400). Change stock with `restockVariant` or `adjustVariantStock`.

---

#### `deleteVariant` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `variantId: String!`
- **Response**: `Variant!`

---

### 2.9 Cart

All cart operations require `Bearer` JWT. Any role (USER, ADMIN, SUPER_ADMIN) can access; each user has one cart.

---

#### `cart`
- **Type**: Query
- **Auth Required**: Yes
- **Description**: Retrieve the current user's cart. Item prices are the product `price` and totals are not filled in; use `cartWithDiscount` for the prices and totals checkout will charge.
- **Response**: `Cart | null` (`null` until the first item is added)

**`Cart` Object Type**:

```typescript
{
  id: string;
  userId: string;
  items: CartItem[];
  total?: Money;           // Set by cartWithDiscount: sum of price × quantity
  discountTotal?: Money;   // Set by cartWithDiscount: product discounts
  finalTotal?: Money;      // Set by cartWithDiscount: total - discountTotal; what createOrder charges for the items
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**`CartItem` Object Type**:

```typescript
{
  id: string;
  productId: string;
  product: Product;
  variant?: Variant;         // Always null today (variants cannot be added)
  originalPrice?: Money;
  discountedPrice?: Money;
  appliedDiscount?: Discount;
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
- **Description**: Adds the product, or increases the quantity if it is already in the cart. Creates the cart if needed. Stock is checked but not reserved.

**Input: `AddToCartInput`**

```typescript
{
  productId: string; // Required.
  quantity: number;  // Required. Positive integer.
}
```

There is no `variantId`: variants cannot be added to the cart, and a product that has any variant is rejected (see [Variants](#28-variants)).

**Possible Errors**:
- `NOT_FOUND` — Product not found.
- `BAD_REQUEST` — Product not active, the product has variants ("... comes in variants and cannot be bought until variant checkout is available"), or the resulting cart quantity exceeds stock.

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

**Possible Errors**: `NOT_FOUND` (item not in the caller's cart), `BAD_REQUEST` (exceeds stock).

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

#### `cartWithDiscount`
- **Type**: Query
- **Auth Required**: Yes
- **Description**: Returns the cart priced exactly as `createOrder` will charge it: each item's `originalPrice` (list price), `discountedPrice` (unit price after the best active discount) and the cart's `total`, `discountTotal`, `finalTotal`. `createOrder` charges `finalTotal` for the items, plus shipping, minus any coupon (see [Section 10](#10-discounts-system)).
- **Response**: `Cart!`
- **Possible Errors**: `NOT_FOUND` (no cart yet); `BAD_REQUEST` if a product in the cart has no price. A discount whose `minimumPurchase` the cart does not reach is not applied.

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

> **Status rules:** an order can only move `PENDING → PROCESSING | CANCELLED`, `PROCESSING → SHIPPED | CANCELLED`, `SHIPPED → DELIVERED`. `DELIVERED` and `CANCELLED` are final. Any other change, including cancelling an order twice, fails with `CONFLICT`. If two requests change the same order at once, one succeeds and the other gets `CONFLICT` ("was changed by another request; reload it and try again"). An unpaid `ONLINE` order leaves `PENDING` only through a confirmed payment. Cash-on-delivery orders start in `PROCESSING`.

> **Unpaid orders expire:** every hour, `PENDING` `ONLINE` orders older than 1 hour are cancelled (stock and coupon use given back) if they have no payment attempt, or only pending/failed/abandoned attempts untouched for 1 hour.

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
  status: OrderStatus;                         // PENDING | PROCESSING | SHIPPED | DELIVERED | CANCELLED
  fulfillmentType: FulfillmentType;            // DELIVERY | PICKUP
  paymentMethod: OrderPaymentMethod;           // ONLINE | CASH_ON_DELIVERY
  contactEmail: string;
  contactPhone: string;
  subtotal?: Money;                            // Sum of item prices charged, after product discounts (null on older orders)
  shippingFee?: Money;                         // Delivery fee charged; 0 for PICKUP (null on older orders)
  couponDiscount?: Money;                      // Coupon discount applied at checkout
  totalAmount: Money;                          // Amount charged: subtotal + shippingFee - couponDiscount
  discountTotal?: Money;                       // Product discounts taken off at checkout (null on older orders)
  finalTotal?: Money;                          // Never populated (always null)
  shippingAddressId?: string;                  // Set for DELIVERY orders
  shippingAddressSnapshot?: JSON;              // DELIVERY: { recipientName, phone, region, street, city, area, landmark, ghanaPostGps, latitude, longitude, zipCode, country } at order time; orders placed before Ghana addresses (P1-G) hold { street, city, state, zipCode, country } instead
  pickupLocationId?: string;                   // Set for PICKUP orders
  pickupLocationSnapshot?: JSON;               // PICKUP: { name, address, city, state, country } at order time
  trackingNumber?: string;
  carrier?: string;
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
  variantId?: string;         // Always null today
  quantity: Float;
  priceAtOrder: Money;        // Unit price charged: originalPrice - discountAmount
  originalPrice?: Money;      // List price per unit at the time of the order
  discountAmount?: Money;     // Product discount taken off one unit at checkout (0 if none)
  appliedDiscount?: Discount;
  createdAt: DateTime;
  updatedAt: DateTime;
  product: Product;
}
```

**`OrderStatus` Enum**:

```
PENDING       — Order created, awaiting online payment
PROCESSING    — Paid online, or a cash-on-delivery order being prepared
SHIPPED       — Dispatched, or ready at the pickup counter
DELIVERED     — Delivered or collected (for COD: cash recorded)
CANCELLED     — Cancelled (by the customer, an admin, or expiry)
```

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

#### `createOrder`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `input: CreateOrderInput!`
- **Response**: `Order!`
- **Description**: Create an order from the caller's cart, for delivery to a saved address or for pickup. Stock is taken immediately; the cart is emptied.

**Input: `CreateOrderInput`**

```typescript
{
  fulfillmentType: FulfillmentType;       // Required. DELIVERY | PICKUP
  shippingAddressId?: string;             // Required for DELIVERY: one of the caller's addresses
  pickupLocationId?: string;              // Required for PICKUP: an active pickup location
  contactEmail: string;                   // Required. Valid email.
  contactPhone: string;                   // Required. Valid phone number in international format (e.g. +233…).
  couponCode?: string;                    // Optional. Case-insensitive.
  paymentMethod?: OrderPaymentMethod;     // Default ONLINE (Paystack). CASH_ON_DELIVERY to pay on delivery/pickup.
}
```

**What happens**:
1. The cart must exist and hold 1–50 items; the account must be active.
2. `DELIVERY`: the address must belong to the caller and have a region, recipient name and phone (addresses saved before those fields existed may lack them). The shipping fee comes from the active shipping zone whose cities include the address city (case-insensitive, extra spaces ignored). No zone → rejected; delivery is never free by default. `PICKUP`: the location must exist and be active; shipping fee 0.
3. Each item is priced exactly as `cartWithDiscount` shows it: the product's current `price` (tax-inclusive) minus the best active product or category discount. `subtotal` equals the cart's `finalTotal` and `discountTotal` the cart's `discountTotal`. Every product must have a price in GHS and enough stock.
4. A coupon, if given, is validated against `subtotal` (after product discounts, before shipping) and its use is recorded.
5. `totalAmount = max(0, subtotal + shippingFee - couponDiscount)`. This is the amount Paystack is asked for.
6. Stock is decremented (logged as `ORDER_DEDUCTION`), the order is saved and the cart emptied, all in one transaction.
7. Status: `PENDING` for `ONLINE`, `PROCESSING` for `CASH_ON_DELIVERY`.
8. A confirmation email goes to the account's email (not `contactEmail`) after the response.

No tax is added at checkout; tax is already inside each product's `price`.

**Possible Errors**:
- `NOT_FOUND` — No cart, empty cart, shipping address not found for the caller, product no longer exists, unknown coupon code.
- `BAD_REQUEST` — Missing `shippingAddressId`/`pickupLocationId` for the chosen type; "Complete the delivery address (region, recipient name and phone) before checkout" (send the customer to `updateAddress` for that address); more than 50 items; account inactive; insufficient stock; product not priced in GHS or without a price; a product in the cart has variants (the message names it; remove it from the cart); delivery city not covered by any active shipping zone (offer pickup or another address); pickup location missing or inactive; coupon inactive, expired, at its usage limit, already used by the caller, or below its minimum order amount.
- `BAD_USER_INPUT` — Invalid `contactEmail`/`contactPhone` or enum value.

**Example**:
```graphql
mutation {
  createOrder(input: {
    fulfillmentType: DELIVERY
    shippingAddressId: "clx_address_xyz"
    contactEmail: "jane@example.com"
    contactPhone: "+233201234567"
    couponCode: "SAVE10"
  }) {
    id orderNumber status paymentMethod subtotal { amount currency } shippingFee { amount currency } couponDiscount { amount currency } totalAmount { amount currency }
  }
}
```

---

#### `cancelOrder`
- **Type**: Mutation
- **Roles**: `USER` only (admins use `adminCancelOrder`; an ADMIN token gets `FORBIDDEN`)
- **Args**: `orderId: String!`
- **Description**: Cancel one of the caller's own orders. Only `PENDING` or `PROCESSING` orders can be cancelled; otherwise `CONFLICT`. Stock and the coupon use are given back exactly once. If the order was paid online, a refund request (return request) is opened automatically for staff to process.
- **Response**: `Order!`
- **Possible Errors**: `NOT_FOUND` (not the caller's order), `CONFLICT`.

---

#### `adminCancelOrder` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `orderId: String!`
- **Description**: Cancel any order. Same rules and effects as `cancelOrder` (only `PENDING`/`PROCESSING`, stock and coupon restored once, refund request for paid online orders), plus an audit entry.
- **Response**: `Order!`
- **Possible Errors**: `NOT_FOUND`, `CONFLICT`.

---

#### `updateOrderStatus` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: UpdateOrderStatusInput!`
- **Response**: `Order!`

**Input: `UpdateOrderStatusInput`**

```typescript
{
  orderId: string;        // Required.
  status: OrderStatus;    // Required. PENDING | PROCESSING | SHIPPED | DELIVERED | CANCELLED
}
```

**Rules**: the change must follow the status rules above, otherwise `CONFLICT`. Admins cannot move an unpaid `ONLINE` order to `PROCESSING` (only a confirmed payment can); cash-on-delivery orders are not affected. Setting `CANCELLED` performs a full cancel (stock restored, refund request for paid online orders), the same as `adminCancelOrder`. For cash-on-delivery orders use `recordCodPayment` to reach `DELIVERED`.

**Side effects**: When status transitions to `SHIPPED` or `DELIVERED`, a status update email is sent to the customer.

---

#### `updateShipping` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: UpdateShippingInput!`
- **Response**: `Order!`
- **Description**: Sets carrier and tracking number. Does not change the status. When a `trackingNumber` is sent, a "shipped" email with the tracking number goes to the customer.

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
- **Description**: Soft-delete a finished order (`DELIVERED` or `CANCELLED` only). Sets `deleted = true`, `deletedAt = now()`. **Never moves stock.** An open order returns `CONFLICT` (cancel it first, which restores its stock); deleting twice also returns `CONFLICT`.

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
  - The payment counts only if Paystack reports `success` for exactly the attempt's amount and currency (GHS). Then the attempt becomes `COMPLETED` and the order moves `PENDING → PROCESSING`.
  - A success for a different amount or currency returns `status: FAILED`; the order stays `PENDING` and can be paid again. The captured money is queued for refund.
  - A success that arrives after the order was cancelled (or already paid by another attempt) returns `status: COMPLETED` but the order is **not** changed; the money is queued for refund and the payment flagged for staff. Read the order's own `status` to decide what to show.
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
  paymentMethod: string;     // Channel sent at initialize (e.g. "card"), or "CASH_ON_DELIVERY"
  status: PaymentStatus;     // PENDING | COMPLETED | FAILED | ABANDONED
  transactionId?: string;    // Paystack reference of this attempt
  paymentDetails?: JSON;     // Sanitised provider data: { reference, access_code } after initialize; { reference, status, amount, currency, channel, paid_at, gateway_response } after verification
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**`PaymentStatus` Enum**: `PENDING`, `COMPLETED`, `FAILED`, `ABANDONED` (an attempt replaced by a retry before it was paid; a late payment on its reference is still accepted)

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
- **Description**: Records that the order total was collected in cash. In one step it marks the payment `COMPLETED` (provider `CASH_ON_DELIVERY`, amount = order total, GHS), stores who recorded it, moves the order to `DELIVERED` and writes an audit entry.
- **Rules**: only a non-deleted cash-on-delivery order in `SHIPPED` (out for delivery, or ready at the pickup counter). A pickup order must be moved to `SHIPPED` with `updateOrderStatus` before cash is recorded; `PROCESSING` → `DELIVERED` is not an allowed step. Repeating the call for the same order (double click) records nothing more.
- **Response**: `Payment!`

**Possible Errors**:
- `NOT_FOUND` — order does not exist or is deleted.
- `BAD_REQUEST` — the order is an `ONLINE` order.
- `CONFLICT` — the order is not `SHIPPED` (e.g. `PENDING`, `PROCESSING`, `CANCELLED`, already `DELIVERED`), or its payment was already recorded.

---

#### `softDeletePayment` / `restorePayment` (ADMIN only)
- **Type**: Mutation
- **Roles**: `ADMIN` only (a `SUPER_ADMIN` gets `FORBIDDEN`)
- **Args**: `id: String!`
- **Response**: `Payment!`
- **Note**: There is no `removePayment`. Payment records are financial history and cannot be deleted; `softDeletePayment` only hides one, `restorePayment` un-hides it. `NOT_FOUND` for an unknown ID.

---

### 2.13 Coupons

Coupon codes are stored upper-case and matched case-insensitively.

---

#### `coupons` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Response**: `[Coupon!]!`

**`Coupon` Object Type**:

```typescript
{
  id: string;
  code: string;
  discountType: DiscountTypeEnum; // PERCENTAGE | FLAT
  value: Decimal;
  usageLimit?: number;            // null = unlimited
  usedCount: number;
  expiresAt?: DateTime;
  isActive: boolean;
  minimumOrderAmount?: Money;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `coupon` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `id: ID!`
- **Response**: `Coupon!` (`NOT_FOUND` if unknown)

---

#### `createCoupon` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `input: CreateCouponInput!`
- **Response**: `Coupon!`

**Input: `CreateCouponInput`**

```typescript
{
  code: string;                   // Required. Max 50 chars. Stored upper-case; unique (CONFLICT).
  discountType: DiscountTypeEnum; // Required. PERCENTAGE | FLAT
  value: Decimal;                   // Required. Min 0. Percent (PERCENTAGE) or GHS amount (FLAT).
  usageLimit?: number;            // Optional. Min 1 if provided.
  expiresAt?: DateTime;           // Optional.
  isActive: boolean;              // Default true.
  minimumOrderAmount?: Decimal;     // Optional. Min 0.
}
```

---

#### `updateCoupon` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: ID!`, `input: UpdateCouponInput!` (all `CreateCouponInput` fields optional)
- **Response**: `Coupon!`

---

#### `deleteCoupon` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: ID!`
- **Response**: `Coupon!`
- **Possible Errors**: `NOT_FOUND`; `CONFLICT` once the coupon has been used (deactivate it with `updateCoupon` instead).

---

#### `validateCoupon`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `input: ValidateCouponInput!`
- **Response**: `CouponValidation!`
- **Description**: Check a coupon before checkout. Checks: existence, active status, expiry, usage limit, minimum order amount, and that the caller has not used it. It does not reserve the coupon; `createOrder` checks again (a coupon that reached its limit in the meantime fails there with `BAD_REQUEST`). A use is given back when its order is cancelled or expires.

**Input: `ValidateCouponInput`**

```typescript
{
  code: string;        // Required.
  orderTotal: Decimal;   // Required. Min 0. Use `cartWithDiscount.finalTotal` (createOrder applies the coupon to the subtotal after product discounts, before shipping).
}
```

**Response: `CouponValidation`** (only returned when valid; failures are errors)

```typescript
{
  valid: boolean;           // Always true when returned
  discountAmount?: Money;   // PERCENTAGE: orderTotal × value / 100, rounded half-up to 2 dp; FLAT: min(value, orderTotal)
  message?: string;         // e.g., "Coupon applied. You save 10.00."
}
```

**Possible Errors**:
- `NOT_FOUND` — Unknown coupon code.
- `BAD_REQUEST` — Inactive, expired, usage limit reached, order total below minimum, already used by this user.

---

### 2.14 Discounts

Discounts are admin-configured price reductions attached to products, variants or categories. They differ from coupons (codes a customer enters). They are shown on products (`discountedPrice`, `appliedDiscount`) and in `cartWithDiscount`, and `createOrder` charges the same prices (see [Section 10](#10-discounts-system)).

---

#### `discounts` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Response**: `[Discount!]!`

---

#### `discount` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `id: ID!`
- **Response**: `Discount!` (`NOT_FOUND` if unknown)

---

#### `createDiscount` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `createDiscountInput: CreateDiscountInput!`
- **Response**: `Discount!`

**Input: `CreateDiscountInput`**

```typescript
{
  name: string;               // Required.
  description?: string;
  type: DiscountType;         // Required. PERCENTAGE | FLAT
  value: Decimal;               // Required. >= 0; at most 100 for PERCENTAGE.
  startDate: DateTime;        // Required.
  endDate: DateTime;          // Required. Must be after startDate.
  isActive: boolean;          // Default false.
  products?: string[];        // Product IDs. Default [].
  variants?: string[];        // Variant IDs. Default [].
  categories?: string[];      // Category IDs. Default [].
  minimumPurchase?: Decimal;    // Minimum cart total for cartWithDiscount.
}
```

**Possible Errors**: `BAD_REQUEST` (end before start, percentage over 100, negative value, unknown product/variant/category IDs).

**`Discount` Object Type**:

```typescript
{
  id: string;
  name: string;
  description?: string;
  type: DiscountType;         // PERCENTAGE | FLAT
  value: Decimal;
  startDate: DateTime;
  endDate: DateTime;
  isActive: boolean;
  products?: Product[];
  variants?: Variant[];
  categories?: Category[];
  minimumPurchase?: Money;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `updateDiscount` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `updateDiscountInput: UpdateDiscountInput!`
- **Response**: `Discount!`
- **Input: `UpdateDiscountInput`** — `id: ID!` plus the `CreateDiscountInput` fields, all optional. An omitted `isActive` leaves the discount as it is; omitted `products`/`variants`/`categories` default to `[]`, which leaves the linked items unchanged.

---

#### `addToDiscount` / `removeFromDiscount` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `modifyDiscountItemsInput: ModifyDiscountItemsInput!`
- **Response**: `Discount!`

**Input: `ModifyDiscountItemsInput`**

```typescript
{
  discountId: string;        // Required.
  products?: string[];       // Product IDs to add/remove. Default [].
  variants?: string[];       // Variant IDs to add/remove. Default [].
  categories?: string[];     // Category IDs to add/remove. Default [].
}
```

---

#### `removeDiscount` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: ID!`
- **Response**: `Discount!`

---

### 2.15 Inventory

All inventory operations: `ADMIN`, `SUPER_ADMIN` only. Every stock change writes an `InventoryLogEntity`. Stock can never go below zero.

---

#### `restockProduct`
- **Type**: Mutation
- **Args**: `input: RestockProductInput!`
- **Response**: `InventoryLogEntity!` (action `RESTOCK`)

**Input: `RestockProductInput`**

```typescript
{
  productId: string;  // Required.
  quantity: number;   // Required. Integer >= 1.
  reason?: string;
}
```

**Response: `InventoryLogEntity`**

```typescript
{
  id: string;
  productId: string;
  variantId?: string;
  action: InventoryActionEnum; // RESTOCK | ORDER_DEDUCTION | RETURN_RESTORE | ADJUSTMENT
  quantityChange: number;      // Signed
  quantityAfter: number;       // Stock after the change
  reason?: string;
  actorId?: string;
  createdAt: DateTime;
}
```

**Possible Errors**: `NOT_FOUND` (product).

---

#### `restockVariant`
- **Type**: Mutation
- **Args**: `input: RestockVariantInput!`
- **Response**: `InventoryLogEntity!`

**Input: `RestockVariantInput`**

```typescript
{
  variantId: string;  // Required.
  quantity: number;   // Required. Integer >= 1.
  reason?: string;
}
```

---

#### `adjustProductStock`
- **Type**: Mutation
- **Args**: `input: AdjustProductStockInput!`
- **Response**: `InventoryLogEntity!` (action `ADJUSTMENT`)
- **Description**: Change a product's stock by a signed amount, e.g. damage, loss or a stock count correction.

**Input: `AdjustProductStockInput`**

```typescript
{
  productId: string;  // Required.
  delta: number;      // Required. Non-zero integer; negative removes stock.
  reason: string;     // Required. 1–500 chars.
}
```

**Possible Errors**: `NOT_FOUND` (product); `BAD_REQUEST` ("Cannot remove N units … only M in stock").

---

#### `adjustVariantStock`
- **Type**: Mutation
- **Args**: `input: AdjustVariantStockInput!` (`variantId`, `delta`, `reason`; same rules as `adjustProductStock`)
- **Response**: `InventoryLogEntity!`

---

#### `inventoryLogs`
- **Type**: Query
- **Response**: `[InventoryLogEntity!]!`, all logs, newest first

---

#### `productInventoryLogs`
- **Type**: Query
- **Args**: `productId: ID!`
- **Response**: `[InventoryLogEntity!]!`, newest first

---

#### `variantInventoryLogs`
- **Type**: Query
- **Args**: `variantId: ID!`
- **Response**: `[InventoryLogEntity!]!`, newest first

---

### 2.16 Returns

---

#### `createReturnRequest`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `input: CreateReturnRequestInput!`
- **Description**: Submit a return request for one of the caller's own orders. Order must be in `DELIVERED` status. A new request is allowed only if every earlier request for the order was rejected.
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
- **Description**: Refund the approved amount through Paystack and move the request from `APPROVED` to `REFUNDED`. **Moves money only, never stock:** a cancelled order already had its stock restored at cancellation, and physically returned goods are put back with `restockProduct` once received and inspected.
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

Taxes are named, Ghana-wide rates (e.g. VAT, NHIS levy) with no country or region. The sum of the **active** rates is built into the `price` of every taxable product (`price = basePrice × (1 + sum)`); creating, updating or deleting a tax recomputes all taxable product prices in the same transaction, so if the reprice fails the mutation returns an error and neither the tax change nor any price is saved. Prices are rounded to 2 decimal places, half away from zero (basePrice 10.10 at 15% → 11.62), the same way whether the price was set by a product edit or a tax change. No tax is added at checkout and orders do not show a tax line.

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
}
```

---

#### `updateTax`
- **Type**: Mutation
- **Args**: `id: ID!`, `input: UpdateTaxInput!` (`name?`, `rate?` 0–1, `isActive?`)
- **Response**: `TaxEntity!`

---

#### `deleteTax`
- **Type**: Mutation
- **Args**: `id: ID!`
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
  lowStockProductCount: number;
  lowStockVariantCount: number;
}
```

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
  paymentMethod: string; // Required. Paystack channel label, e.g. "card" or "mobile_money"; stored as Payment.paymentMethod.
  currency?: "GHS";      // Optional. Any other value is rejected (400). Payments are always charged in GHS.
  idempotencyKey?: string; // Optional, 1-255 chars. Generate one per "Pay" click and resend it on network retries.
}
```

The amount is always the order total at the first initialization; any other field (e.g. `amount`) is rejected with 400.

**Rules**:

- Only the owner's `PENDING`, non-deleted, online-payment order can be paid. A cancelled, processing, shipped or delivered order returns 400, a cash-on-delivery order returns 400, an already paid order returns 400 (`Payment for this order has already been completed`), a missing or deleted order returns 404, and another user's order returns 403.
- Each call without a known key opens a **new attempt** with its own reference. The previous pending attempt is marked `ABANDONED`; it is kept, and if the customer still completes that older checkout the payment is matched.
- Repeating an `idempotencyKey` for the same order returns the same attempt and the same `authorizationUrl` without opening a new checkout. It returns **409** if that attempt is still being set up (retry shortly) or is no longer `PENDING` (use a new key).
- If Paystack cannot open the checkout the request fails and the same key may be retried.
- Paystack's `callback_url` is `PAYSTACK_CALLBACK_URL` (a frontend page; see [Section 8](#8-payment-integration-paystack)).

**Response** (`201`): the payment attempt plus `authorizationUrl`. Decimal amounts are JSON strings here.

```json
{
  "id": "clx_attempt",
  "orderId": "clx_order",
  "amount": "29.99",
  "currency": "GHS",
  "paymentMethod": "card",
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
- `x-paystack-signature: <hex HMAC-SHA512 of the raw request body, keyed with PAYSTACK_SECRET_KEY>` (Paystack sends this automatically)
- `Content-Type: application/json`

**Body**: Paystack's event JSON, `{ event: string; data: { id?, reference?, amount?, currency?, status?, ... } }`. The signature is checked over the exact bytes received, so any proxy or gateway in front of the API must forward the body unmodified (no re-encoding, re-formatting or compression changes).

**Responses**:
- `200 OK`: the event is stored and either processed or needs no processing (unhandled type, or a duplicate of an event already processed).
- `400`: empty body, or a signed body that is not `{ event, data }` JSON.
- `401`: missing or invalid signature. Nothing is stored.
- `503`: the event is stored but processing failed after three in-process attempts. Paystack retries the delivery, and the retry processes the stored event.

**Handled Events** (each delivery is stored once per event type and Paystack `data.id`, or `data.reference` when there is no id; repeats are no-ops):
- `charge.success` → re-verifies the reference with Paystack; marks payment `COMPLETED`, order status → `PROCESSING` (same rule as `verifyPayment`).
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
| `Float` | Only stock quantities (`Variant.quantity`, `OrderItem.quantity`, `CreateVariantInput.quantity`) and address coordinates (`Address.latitude`/`longitude`); never money |

### Money

**Breaking change (P1-S.4):** every money field that was a `Float` is now a `Money` object, and every money input or argument that was a `Float` (or the `basePrice` string) is now a `Decimal` string. Field names are unchanged.

```graphql
type Money {
  amount: String!      # always exactly 2 decimal places, e.g. "480.00"
  currency: Currency!  # the store currency (storeSettings.currency), e.g. GHS
}
```

- **Reading money:** select `{ amount currency }`, e.g. `order { totalAmount { amount currency } }`. Keep `amount` as a string or parse it with a decimal library; do not add amounts as JS numbers.
- **Sending money (`Decimal` scalar):** a JSON string of digits with an optional leading `-` and decimal point, e.g. `"12.50"`. Exponent notation (`"1e3"`), `"NaN"`, `"Infinity"`, other text and JSON numbers (`12.5`) are rejected with `BAD_USER_INPUT`, as are money amounts with more than 2 decimal places, negative amounts and amounts of 1,000,000,000,000 or more. The client never chooses a currency: amounts are in the store currency.
- **Decimal outputs:** `Tax.rate` (e.g. `"0.15"`), `Coupon.value` and `Discount.value` (a percent for `PERCENTAGE`, an amount for `FLAT`, so not `Money`) are `Decimal` strings without trailing zeros (`"10"`, `"12.5"`).
- **Rounding:** one rule everywhere: half-up (half away from zero) to 2 decimal places, per line and per component (e.g. a 10% coupon on 59.98 is 6.00). This rule is pending confirmation by the store's tax adviser.

| Changed fields (output, `Float` → `Money`) |
|---|
| `Order.subtotal`, `shippingFee`, `totalAmount`, `discountTotal`, `finalTotal`, `couponDiscount` |
| `OrderItem.originalPrice`, `discountAmount`, `priceAtOrder` |
| `Cart.total`, `discountTotal`, `finalTotal`; `CartItem.originalPrice`, `discountedPrice` |
| `Product.price`, `basePrice`, `currentPrice`, `discountedPrice`; `Variant.price` |
| `Payment.amount`; `RefundEntity.amount`; `ReturnRequestEntity.refundAmount` |
| `Coupon.minimumOrderAmount`; `CouponValidation.discountAmount`; `Discount.minimumPurchase` |
| `ShippingZoneEntity.fee`; query `getShippingFee` (`Float!` → `Money!`) |
| `SalesReport.grossRevenue`, `refunds`, `netRevenue`, `totalRevenue`, `itemSales`, `averageOrderValue` |
| `DashboardSummary.revenueToday`, `grossRevenueToday`, `refundsToday`; `TopProduct.totalRevenue`; `RevenueByCategoryEntity.totalRevenue` |

| Changed fields (output, `Float` → `Decimal`) |
|---|
| `Coupon.value`, `Discount.value`, `TaxEntity.rate` |

| Changed inputs and arguments (→ `Decimal`) |
|---|
| `CreateProductInput.basePrice` / `UpdateProductInput.basePrice` (`String` → `Decimal`) |
| `CreateVariantInput.price` / `UpdateVariantInput.price` |
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
| `OrderStatus` | `PENDING`, `PROCESSING`, `SHIPPED`, `DELIVERED`, `CANCELLED` | `Order.status`, `UpdateOrderStatusInput.status` |
| `FulfillmentType` | `DELIVERY`, `PICKUP` | `Order`, `CreateOrderInput` |
| `GhanaRegion` | `AHAFO`, `ASHANTI`, `BONO`, `BONO_EAST`, `CENTRAL`, `EASTERN`, `GREATER_ACCRA`, `NORTH_EAST`, `NORTHERN`, `OTI`, `SAVANNAH`, `UPPER_EAST`, `UPPER_WEST`, `VOLTA`, `WESTERN`, `WESTERN_NORTH` | `Address.region`, address inputs |
| `OrderPaymentMethod` | `ONLINE`, `CASH_ON_DELIVERY` | `Order`, `CreateOrderInput` |
| `PaymentStatus` | `PENDING`, `COMPLETED`, `FAILED`, `ABANDONED` | `Payment.status` |
| `ReturnStatusEnum` | `PENDING`, `APPROVED`, `REJECTED`, `REFUND_PENDING`, `REFUNDED` | `ReturnRequestEntity.status` |
| `RefundStatusEnum` | `PENDING` (recorded, not sent), `SENDING` (sent, outcome unknown if it stays), `PROCESSED` (accepted by Paystack), `FAILED` (refused, can be resent) | `RefundEntity.status`, `refunds(status)` |
| `InventoryActionEnum` | `RESTOCK`, `ORDER_DEDUCTION`, `RETURN_RESTORE`, `ADJUSTMENT` | `InventoryLogEntity.action` |
| `DiscountType` | `PERCENTAGE`, `FLAT` | `Discount.type`, discount inputs |
| `DiscountTypeEnum` | `PERCENTAGE`, `FLAT` | `Coupon.discountType`, coupon inputs (a separate enum with the same values) |
| `ProductStatus` | `DRAFT`, `PUBLISHED`, `ARCHIVED` | `Product.status`, product inputs, `ProductFilterArgs.status` |
| `StockStatus` | `IN_STOCK`, `OUT_OF_STOCK`, `PREORDER`, `BACKORDER` | `Product.stockStatus` |
| `Currency` | `GHS`, `USD`, `EUR`, `GBP`, `NGN` | `Product.currency` (only `GHS` products can be checked out) |
| `DeliveryOptions` | `LOCAL_DELIVERY`, `INTERNATIONAL_DELIVERY`, `SELECTED_REGIONS` | `Product.deliveryOptions` (informational; not enforced at checkout) |
| `ProductSortField` | `CREATED_AT`, `NAME`, `PRICE`, `QUANTITY`, `UPDATED_AT` | `ProductSortArgs.sortBy` |
| `SortOrder` | `ASC`, `DESC` | `ProductSortArgs.sortOrder` |

### Where each object type is described

| Type | Section |
|---|---|
| `AuthEntity` | [2.1](#21-authentication-iam) |
| `User`, `UserConnection`, `UserEdge`, `PublicProfile` | [2.2](#22-users), [2.17](#217-reviews) |
| `Product`, `ProductConnection`, `ProductEdge` | [2.3](#23-products) |
| `Category`, `SubCategory`, `Brand`, `Tag`, `Variant` | [2.4](#24-categories)–[2.8](#28-variants) |
| `Cart`, `CartItem`, `Wishlist` | [2.9](#29-cart), [2.10](#210-wishlist) |
| `Order`, `OrderItem` | [2.11](#211-orders) |
| `Payment` | [2.12](#212-payment) |
| `Coupon`, `CouponValidation`, `Discount` | [2.13](#213-coupons), [2.14](#214-discounts) |
| `InventoryLogEntity` | [2.15](#215-inventory) |
| `ReturnRequestEntity`, `RefundEntity` | [2.16](#216-returns) |
| `Review` | [2.17](#217-reviews) |
| `TaxEntity` | [2.18](#218-tax) |
| `SalesReport`, `TopProduct`, `RevenueByCategoryEntity`, `DashboardSummary` | [2.19](#219-analytics), [16](#16-analytics-queries) |
| `Address` | [2.20](#220-addresses) |
| `ShippingZoneEntity`, `PickupLocationEntity` | [2.21](#221-shipping-zones--pickup-locations) |
| `PageInfo`, `PaginationArgs` | [13](#13-pagination--filtering) |

### Relationships and deletion

- A **User** has one **Cart**, one **Wishlist**, many **Orders**, **Addresses**, **Reviews** and **ReturnRequests**.
- A **Product** optionally belongs to one **Category**, **SubCategory** and **Brand**; has many **Tags**, **Variants**, **Reviews** and **Discounts**.
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
4. Resolved fields (`discountedPrice`, `appliedDiscount`, `variants`, `reviews`) are fetched via DataLoader only when requested.
5. To view a single product: call `query product(productId)` (returns `null` for anything not published).

### Add to Cart Flow

1. User must be authenticated.
2. Frontend calls `mutation addToCart(input: { productId, quantity })`.
3. Backend checks the product exists, is active and has enough stock for the new cart quantity.
4. If cart does not exist for user, it is created automatically.
5. If item already in cart, quantity is incremented.
6. Returns updated `Cart` with all items. Stock is not reserved until `createOrder`.

### Cart Update Flow

1. To change quantity: `mutation updateCartItem(input: { cartItemId, quantity })`. Setting `quantity: 0` removes the item.
2. To remove an item directly: `mutation removeFromCart(cartItemId)`.
3. To empty the cart: `mutation clearCart`.
4. To show prices and totals with discounts: `query cartWithDiscount` (checkout charges the same `finalTotal`).

### Checkout Flow

1. Choose fulfilment:
   - `DELIVERY`: the user needs a saved address (`query userAddresses` or `mutation createAddress`). Show the fee with `query getShippingFee(addressId)`; a `BAD_REQUEST` means either the address is incomplete (an address saved before P1-G without region, recipient or phone: ask the customer to complete it with `updateAddress`) or the city is not served (offer pickup or another address).
   - `PICKUP`: list locations with `query activePickupLocations` (public).
2. Optionally validate a coupon: `mutation validateCoupon(input: { code, orderTotal: <cartWithDiscount.finalTotal> })`.
3. Create the order: `mutation createOrder(input: { fulfillmentType, shippingAddressId | pickupLocationId, contactEmail, contactPhone, couponCode?, paymentMethod? })`.
4. Backend validates stock, prices items as `cartWithDiscount` does, applies the coupon to that subtotal, adds the shipping fee → creates the `Order` (`PENDING` for `ONLINE`, `PROCESSING` for `CASH_ON_DELIVERY`) → decrements inventory → clears cart → sends confirmation email.
5. `ONLINE`: continue with the Order Placement Flow within 1 hour, or the order expires. `CASH_ON_DELIVERY`: done; staff ship it and record the cash with `recordCodPayment`.

### Order Placement Flow

1. Order is created (see Checkout Flow above).
2. Frontend initiates payment: `POST /payment/initialize` with `{ orderId, paymentMethod, idempotencyKey }` (`currency` may be omitted; if sent it must be `"GHS"`). Only `PENDING` online orders can be paid.
3. Backend opens a new payment attempt with `status = PENDING` (any earlier pending attempt becomes `ABANDONED`) and returns `authorizationUrl`.
4. Frontend redirects user to `authorizationUrl`.
5. After payment, Paystack redirects the browser to the frontend page configured as `PAYSTACK_CALLBACK_URL`, with `?reference=…` (and `trxref`) in the query string.
6. That page calls `mutation verifyPayment(verifyPaymentInput: { reference })` and shows the result, reading the order's `status` too.

### Payment Flow (Paystack)

See [Section 8](#8-payment-integration-paystack) for full details.

### Webhook Handling Flow

1. Paystack POSTs to `POST /payment/webhook`.
2. Backend verifies the HMAC-SHA512 signature over the raw body using `PAYSTACK_SECRET_KEY` (constant-time compare). A bad signature gets `401` and nothing is stored.
3. The event is stored in the webhook inbox (`WebhookEvent`). A repeat of an event already processed gets `200` and changes nothing.
4. On `charge.success`: the same verification as `verifyPayment` runs (amount and currency must match; a payment for a cancelled or already-paid order never moves the order and is queued for refund). On a valid payment: payment `status → COMPLETED`, order `status → PROCESSING`, confirmation email sent once.
5. On `charge.failed`: payment `status → FAILED`.
6. Unhandled events are stored and answered `200 OK`.
7. If processing fails (for example Paystack's verify API is down), it is retried in-process up to three attempts; if it still fails the backend answers `503`, the event stays stored as unprocessed, and Paystack's redelivery processes it.

### Inventory Deduction Flow

- On `createOrder`: each item's quantity is decremented from the **product** stock with a conditional update inside the order transaction (never below zero). An `InventoryLog` record is created with `action = ORDER_DEDUCTION`.
- On `cancelOrder`, `adminCancelOrder`, `updateOrderStatus(CANCELLED)` or expiry: stock is restored once, logged as `RETURN_RESTORE`. `deleteOrder` never moves stock.
- Low-stock check: a cron job every 6 hours logs warnings (server log only) for products/variants at or below their threshold.

### Return Request Flow

1. User submits: `mutation createReturnRequest(input: { orderId, reason })`. Order must be `DELIVERED`.
2. `ReturnRequest` created with `status = PENDING`.
3. Admin reviews: `mutation approveReturn(input: { returnRequestId, refundAmount, adminNote? })` → status → `APPROVED`.
4. Admin rejects: `mutation rejectReturn(input: { returnRequestId, adminNote? })` → status → `REJECTED`.
5. Admin processes the refund through Paystack: `mutation processRefund(returnRequestId)` → status → `REFUND_PENDING` while it is sent, then `REFUNDED`. If Paystack refuses, it stays `REFUND_PENDING` and can be retried.
6. Returned goods are put back in stock manually with `restockProduct` once received.

Cancelling a paid online order creates a return request automatically ("Automatic refund request for cancelled paid order") for staff to approve and refund.

### Review Submission Flow

1. User must be authenticated with the `USER` role.
2. Call `mutation createReview(input: { productId, score, comment? })`. `score` must be 1–5; one review per product.
3. To update: `mutation updateReview(input: { id, score?, comment? })`.
4. To delete: `mutation deleteReview(reviewId)` — permanently deletes the review.

---

## 7. Order Lifecycle

```
                createOrder()
          ONLINE ↓          ↓ CASH_ON_DELIVERY
            PENDING ─────────┼────────────────────────────→ CANCELLED
               |             |       (customer, admin, or 1-hour expiry)
   payment confirmed         |
 (verifyPayment / webhook /  |
  reconciliation sweep)      |
               ↓             ↓
            PROCESSING ────────────────────────────────────→ CANCELLED
               |                                (customer or admin)
     updateOrderStatus(SHIPPED)
               ↓
             SHIPPED
               |
     updateOrderStatus(DELIVERED)  — or recordCodPayment for COD
               ↓
            DELIVERED
               |
       createReturnRequest()
               ↓
    ReturnRequest: PENDING → APPROVED → REFUND_PENDING → REFUNDED
                     |
                  REJECTED
```

### Status Transitions

| From | To | Trigger | Actor |
|---|---|---|---|
| *(none)* | `PENDING` | `createOrder` with `ONLINE` | Customer |
| *(none)* | `PROCESSING` | `createOrder` with `CASH_ON_DELIVERY` | Customer |
| `PENDING` | `PROCESSING` | Confirmed online payment (`verifyPayment`, webhook, or the 5-minute reconciliation sweep) | System |
| `PENDING` | `CANCELLED` | `cancelOrder` / `adminCancelOrder` / `updateOrderStatus(CANCELLED)` / hourly expiry | Customer, admin, system |
| `PROCESSING` | `SHIPPED` | `updateOrderStatus` | Admin |
| `PROCESSING` | `CANCELLED` | `cancelOrder` / `adminCancelOrder` / `updateOrderStatus(CANCELLED)` | Customer or admin |
| `SHIPPED` | `DELIVERED` | `updateOrderStatus`, or `recordCodPayment` for COD | Admin |
| `DELIVERED`, `CANCELLED` | — | Final | — |

The table is enforced (`src/order/order-status.ts`): any other change returns `CONFLICT`, and concurrent changes to the same order let exactly one succeed. A `SHIPPED` order cannot be cancelled. An admin cannot move an unpaid `ONLINE` order to `PROCESSING`.

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

The backend calls Paystack's transaction initialize with the order owner's email, the payment intent's amount (the order total when payment was first initialized) converted to pesewas, currency `GHS`, the attempt's own reference, and `callback_url = PAYSTACK_CALLBACK_URL`. The customer never sends an amount.

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
| `charge.success` | Re-verified with Paystack; on a valid payment `Payment.status → COMPLETED`, `Order.status → PROCESSING` |
| `charge.failed` | Re-verified; `Payment.status → FAILED` |
| All others | Stored, acknowledged (200 OK), not processed |

A background sweep every 5 minutes also re-checks open attempts with Paystack and processes stored webhook events that failed, so a payment completes even if the webhook and the callback page both fail.

### Frontend Payment Confirmation Strategy

**Option A (recommended)**: On the callback page, call `mutation verifyPayment({ reference })`. The mutation checks with Paystack directly and updates the payment record. If the attempt is still `PENDING` (e.g. MoMo approval), call it again after a few seconds.

**Option B**: Poll `query order(orderId)` (or `payment(id)`) every few seconds until the order leaves `PENDING` (max 3–5 polls with backoff). This works because the webhook often fires before the user returns to the frontend.

**Option C**: Rely on the webhook and the reconciliation sweep — the order page shows the latest order status on load.

---

## 9. Inventory Rules

### When Stock Reduces

- `createOrder`: each `OrderItem.quantity` is deducted from `Product.quantity` (variants are not purchasable). This happens **at order creation time**, not at payment time. Logged as `ORDER_DEDUCTION`.
- `adjustProductStock` / `adjustVariantStock` with a negative `delta`. Logged as `ADJUSTMENT`.

### When Stock Restores

- Cancelling an order (customer, admin, or expiry): all its item quantities, once. Logged as `RETURN_RESTORE`.
- `restockProduct` / `restockVariant`: manual top-up. Logged as `RESTOCK`.
- `adjustProductStock` / `adjustVariantStock` with a positive `delta`. Logged as `ADJUSTMENT`.
- Not on `approveReturn`, `processRefund` or `deleteOrder`: returned goods are restocked manually.

### Out-of-Stock Handling

- Stock can never go negative (conditional updates plus a database check).
- Adding to cart and creating an order check stock (`BAD_REQUEST` if insufficient).
- `Product.stockStatus` (`IN_STOCK`, `OUT_OF_STOCK`, `PREORDER`, `BACKORDER`) is whatever the admin set; it is not derived from `quantity`. Use `quantity` to show availability.
- `ProductFilterArgs.inStock` does not currently filter anything out (known defect).

### Low Stock Logic

- `Product.lowStockAlert` (default 5) and the variant's internal threshold (default 5, not exposed in GraphQL).
- A cron job every 6 hours logs warnings for items at or below their threshold. No emails or notifications.
- `dashboardSummary.lowStockProductCount` / `lowStockVariantCount` report the counts.

### Reserved Stock

There is no separate reservation: stock is decremented on order creation. An unpaid `ONLINE` order gives its stock back when it expires after 1 hour or is cancelled.

---

## 10. Discounts System

### Discount vs. Coupon

| | Discount | Coupon |
|---|---|---|
| Scope | Product / Variant / Category | Order subtotal |
| Applied | Shown automatically on products and in `cartWithDiscount` | Entered as `couponCode` at checkout |
| Charged at checkout | Yes (`Order.discountTotal`, per item `discountAmount`) | Yes (`Order.couponDiscount`) |
| Type | `Discount` | `Coupon` |

### Discount Application

- A `Discount` applies when `isActive = true` and now is within `[startDate, endDate]`.
- For a product, the candidates are its own discounts and its category's discounts. The **best** one is the one that saves the most money on one unit at the current price (on a GHS 50 item, GHS 8 off beats 10% off; on GHS 1,000, 30% off beats GHS 50 off). On an equal saving the first candidate is kept.
- Unit discount: `PERCENTAGE` → `price × value / 100`, `FLAT` → `value`, rounded half-up to 2 decimal places and never more than the price. `discountedPrice = price - unit discount`; line total = `discountedPrice × quantity`.
- `minimumPurchase`: in the cart and at checkout a discount applies only when the cart's list-price `total` (all items, before discounts) reaches its minimum; otherwise it is skipped and the next best discount applies. Product pages (`discountedPrice`) do not check minimums.
- **Checkout charges the same prices**: product pages, `cartWithDiscount` and `createOrder` use one pricing function, so `Order.subtotal` equals `cartWithDiscount.finalTotal` at the moment of checkout. An order is priced once, when it is created; nothing re-prices an existing order.

### Coupon Logic

- Applied at `createOrder` via `couponCode`, against the order subtotal (after product discounts, before shipping).
- Checks (`CouponsService.validateCoupon`, repeated inside the order transaction):
  1. Coupon exists (`NOT_FOUND`) and `isActive = true`.
  2. Not expired (`expiresAt` is null or in the future).
  3. Usage limit not reached (`usedCount < usageLimit`, or `usageLimit` is null).
  4. User has not already used this coupon.
  5. Subtotal ≥ `minimumOrderAmount`.
- Discount: `PERCENTAGE` → subtotal × value / 100; `FLAT` → min(value, subtotal). Saved in `Order.couponDiscount`; `Coupon.usedCount` increments.
- Cancelling or expiring the order gives the use back (usage record removed, `usedCount` decremented).

### Stacking Rules

- One coupon per order. Product discounts are applied first; the coupon is computed on the discounted subtotal (and its `minimumOrderAmount` checked against it). Shipping is added last.
- Only one discount is shown per product (the best one, as above).

---

## 11. Tax & Currency

### Tax Calculation

- Taxes are named rates (`TaxEntity { name, rate, isActive }`, e.g. VAT 0.15) with no country or region.
- A taxable product's `price = basePrice × (1 + sum of active tax rates)`, stored on the product and recomputed whenever a tax is created, updated or deleted, or the product's `basePrice`/`isTaxable` changes. Non-taxable products: `price = basePrice`.
- Checkout charges `price`; no tax is added at checkout, and orders carry no tax breakdown. The shipping address country is not used for tax.

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

- **Products**: `sortArgs: ProductSortArgs { sortBy: CREATED_AT | NAME | PRICE | QUANTITY | UPDATED_AT, sortOrder: ASC | DESC }`, default `CREATED_AT DESC`. `paginationArgs.orderBy`/`orderInAsc` are ignored.
- **Users**: `filter.orderBy` (one of `id`, `name`, `email`, `phoneNumber`, `role`, `isActive`, `createdAt`, `updatedAt`, `lastLoginAt`, `profilePicture`) and `filter.orderInAsc`.

### Filtering Options per Resource

**Products** (`ProductFilterArgs`): `categoryId`, `categoryName`, `subCategoryName` (defective, see [2.3](#23-products)), `subcategoryId`, `isActive` (default `true`, admin only), `status` (admin only), `search`, `createdAfter` (ISO date), `priceMin`, `priceMax`, `brand` (exact name), `inStock` (no effect today), `tagId`, `tagName`.

**Users** (`UserPaginateArgs`): `email` (partial), `phoneNumber` (exact), `role`, `isActive`, `name` (partial), `createdAfter`.

**Other resources** (orders, payments, reviews, returns, refunds, inventory logs, coupons, discounts, zones, locations) return full lists without pagination. `refunds` accepts an optional `status` filter.

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
| Order status → `SHIPPED` or `DELIVERED` (`updateOrderStatus`), or `updateShipping` with a tracking number | Status update (with tracking number when set) | Account email |
| Online payment confirmed (webhook, `verifyPayment` or sweep), once per order | Payment confirmation | Account email |
| `forgotPassword` for an existing account | Password reset token | Requesting address |

Not emailed: cash-on-delivery collection (`recordCodPayment`), cancellations, refunds.

### Asynchronous

All emails are sent after the response — they do **not** block or fail the request. Email failures, including sends the email provider rejects, are logged as errors and not propagated. Without `RESEND_API_KEY` no email is sent.

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
  lowStockProductCount: number;
  lowStockVariantCount: number;
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
  variables: { input: { productId, quantity } },
  optimisticResponse: {
    addToCart: {
      __typename: 'Cart',
      id: existingCartId,
      items: [...existingItems, { __typename: 'CartItem', id: 'temp-id', productId, quantity, ... }],
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
  body: JSON.stringify({ orderId, paymentMethod: 'card', idempotencyKey }),
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
if (payment.status === 'COMPLETED' && payment.order.status === 'PROCESSING') {
  // Paid: show the order confirmation
} else if (payment.status === 'PENDING') {
  // Not decided yet (e.g. MoMo approval): retry verifyPayment shortly
} else {
  // FAILED/ABANDONED, or paid after the order was cancelled (refund queued): show the order status
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
  id name price { amount currency } discountedPrice { amount currency } currency isActive status
  images quantity categoryId
  category { id name }
  brand { id name logo }
}

fragment CartItemFull on CartItem {
  id productId quantity originalPrice { amount currency } discountedPrice { amount currency }
  product { id name images price { amount currency } currency quantity }
}

fragment OrderSummary on Order {
  id orderNumber status fulfillmentType paymentMethod
  subtotal { amount currency } shippingFee { amount currency } couponDiscount { amount currency } totalAmount { amount currency } createdAt
  items { id quantity priceAtOrder { amount currency } product { id name } }
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
export type OrderStatus = 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
export type FulfillmentType = 'DELIVERY' | 'PICKUP';
export type OrderPaymentMethod = 'ONLINE' | 'CASH_ON_DELIVERY';
export type PaymentStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'ABANDONED';
export type DiscountType = 'PERCENTAGE' | 'FLAT';      // also DiscountTypeEnum (coupons)
export type ReturnStatusEnum = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REFUND_PENDING' | 'REFUNDED';
export type RefundStatusEnum = 'PENDING' | 'SENDING' | 'PROCESSED' | 'FAILED';
export type InventoryActionEnum = 'RESTOCK' | 'ORDER_DEDUCTION' | 'RETURN_RESTORE' | 'ADJUSTMENT';
export type Currency = 'GHS' | 'USD' | 'EUR' | 'GBP' | 'NGN';
export type StockStatus = 'IN_STOCK' | 'OUT_OF_STOCK' | 'PREORDER' | 'BACKORDER';
export type ProductStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type DeliveryOptions = 'LOCAL_DELIVERY' | 'INTERNATIONAL_DELIVERY' | 'SELECTED_REGIONS';
export type ProductSortField = 'CREATED_AT' | 'NAME' | 'PRICE' | 'QUANTITY' | 'UPDATED_AT';
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
        price { amount currency }
        discountedPrice { amount currency }
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
    id name description price { amount currency } currentPrice { amount currency }
    discountedPrice { amount currency } appliedDiscount { name type value }
    images sku quantity stockStatus
    variants { id size color price { amount currency } quantity }
    reviews { score comment user { displayName } }
    category { id name }
    brand { id name }
  }
}
```

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
    productId: "clx_product_abc123"
    quantity: 2
  }) {
    id
    items {
      id productId quantity
      product { name images price { amount currency } }
    }
  }
}
```

---

### Step 7 — View Cart with Discounts

```graphql
query {
  cartWithDiscount {
    id total { amount currency } discountTotal { amount currency } finalTotal { amount currency }
    items {
      id quantity originalPrice { amount currency } discountedPrice { amount currency }
      product { name }
      appliedDiscount { name type value }
    }
  }
}
```

`createOrder` charges `finalTotal` for these items (plus shipping, minus any coupon); see [Section 10](#10-discounts-system).

---

### Step 8 — Validate Coupon

```graphql
mutation {
  validateCoupon(input: {
    code: "SAVE10"
    orderTotal: "59.98"
  }) {
    valid
    discountAmount { amount currency }
    message
  }
}
```

**Success Response**:
```json
{
  "data": {
    "validateCoupon": {
      "valid": true,
      "discountAmount": { "amount": "6.00", "currency": "GHS" },
      "message": "Coupon applied. You save 6.00."
    }
  }
}
```

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
  }) {
    id orderNumber status paymentMethod
    subtotal { amount currency } shippingFee { amount currency } couponDiscount { amount currency } totalAmount { amount currency }
    items {
      id quantity priceAtOrder { amount currency }
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
      "shippingFee": { "amount": "15.00", "currency": "GHS" },
      "couponDiscount": { "amount": "6.00", "currency": "GHS" },
      "totalAmount": { "amount": "68.98", "currency": "GHS" },
      "items": [...]
    }
  }
}
```

*Side effects*: inventory decremented, cart cleared, coupon use recorded, confirmation email sent. Pay within 1 hour or the order is cancelled automatically.

---

### Step 10 — Initialize Payment (REST)

```http
POST /payment/initialize
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "orderId": "clx_order_789",
  "paymentMethod": "card",
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

User completes payment. Paystack fires the webhook to `POST /payment/webhook` → backend marks the payment `COMPLETED`, order → `PROCESSING`.

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
      id status totalAmount { amount currency }
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
        "status": "PROCESSING",
        "totalAmount": { "amount": "68.98", "currency": "GHS" }
      }
    }
  }
}
```

---

### Step 13 — User Receives Order (Admin updates status)

Admin sets the tracking details (`updateShipping`, emails the customer) and then the status:
```graphql
mutation {
  updateOrderStatus(input: {
    orderId: "clx_order_789"
    status: SHIPPED
  }) { id status trackingNumber }
}
```

Then:
```graphql
mutation {
  updateOrderStatus(input: {
    orderId: "clx_order_789"
    status: DELIVERED
  }) { id status }
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
