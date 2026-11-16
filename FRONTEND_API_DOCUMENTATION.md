# Emma Commerce Backend — Complete Frontend Technical Documentation

> Generated from actual source code. Every type, field name, enum value, validation rule, and flow described here is extracted directly from the codebase.

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
3. [REST API Reference](#3-rest-api-reference)
4. [Prisma Data Models](#4-prisma-data-models)
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
| ORM | Prisma v5 |
| Database | PostgreSQL |
| Auth | JWT (Access + Refresh Tokens) stored in `RefreshToken` table |
| Hashing | bcrypt |
| Payments | Paystack |
| File Storage | Cloudinary (images resized to 500×500 before upload via sharp) |
| Caching | Redis (optional, falls back to in-memory) |
| Email | Resend |
| Logging | Winston (via custom `LoggerService`) |
| Tracing | OpenTelemetry (OTLP/HTTP exporter, opt-in via `OTEL_ENABLED=true`) |
| Scheduling | `@nestjs/schedule` (cron jobs for low-stock checks every 6 hours) |
| Rate Limiting | `@nestjs/throttler` with per-named-throttler rules |

### GraphQL Approach

**Code-first.** The schema is auto-generated to `schema.gql` on startup. NestJS `@ObjectType()` and `@InputType()` decorators define the schema. Apollo Server v4 is the driver.

- Playground: **disabled in production**, Apollo Sandbox served in development.
- Introspection: **disabled in production**.
- Error formatting: internal errors are masked in production; validation/auth/business logic errors are always forwarded.

### Auth Strategy

- **Default**: all routes require Bearer JWT unless decorated with `@Auth(AuthType.None)`.
- Access token: short-lived (default 1 hour, `JWT_ACCESS_TOKEN_TTL`).
- Refresh token: longer-lived (default 24 hours, `JWT_REFRESH_TOKEN_TTL`), stored **hashed** in the `RefreshToken` database table.
- Refresh tokens are **rotated** on use — old token is revoked, new pair is issued atomically.
- Password reset tokens: 15-minute TTL signed with separate secret (`JWT_RESET_SECRET`).
- **Account lockout**: 5 consecutive failed logins trigger a 15-minute lockout (tracked in `User.failedLoginAttempts` and `User.lockedUntil`).

### Payment Integration

- Paystack is used exclusively.
- Payment is initiated via a **REST POST** endpoint (`POST /payment/initialize`).
- Frontend redirects user to Paystack's `authorizationUrl`.
- Paystack calls the **webhook** (`POST /payment/webhook`) with `charge.success` or `charge.failed` events.
- Frontend can also poll/call `verifyPayment` GraphQL mutation after redirect callback.

### File Storage (Cloudinary)

All images are uploaded via authenticated REST endpoints (`POST /upload/single-image`, `POST /upload/multiple-images`). Images are resized to **500×500** pixels (contain mode, white background) before upload. Folder: `ecommerce`.

### Observability

- Winston logger logs all HTTP requests (middleware), GraphQL operations (interceptor), and errors.
- OpenTelemetry: activate with `OTEL_ENABLED=true`; exports traces to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318/v1/traces`).

### Database

PostgreSQL via Prisma. Full-text search is enabled (`fullTextSearchPostgres` preview feature).

---

## 2. GraphQL API Reference

**GraphQL Endpoint**: `POST /graphql`

**Default Auth**: All operations require `Authorization: Bearer <accessToken>` unless marked **Auth Required: No**.

**Rate Limiting**: Global limit — 120 requests/minute per IP.

---

### 2.1 Authentication (IAM)

All auth mutations are `@Auth(AuthType.None)` — **no token required** unless noted.

---

#### `signUp`
- **Type**: Mutation
- **Auth Required**: No
- **Rate Limit**: 5 requests/minute
- **Description**: Register a new user account with email and password. Sends a welcome email. Returns token pair immediately.

**Input: `SignUpInput`**

```typescript
{
  name: string;      // Required. 2–50 chars. Trimmed and lowercased.
  email: string;     // Required. Valid email. Trimmed and lowercased.
  password: string;  // Required. 8–64 chars. Must contain: uppercase, lowercase, digit, special char (@$!%*?&_-#).
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
- **Auth Required**: No
- **Rate Limit**: 5 requests/minute
- **Description**: Authenticate with email and password. Account lockout enforced after 5 failed attempts (15-minute cooldown).

**Input: `SignInInput`**

```typescript
{
  email: string;     // Required. Valid email.
  password: string;  // Required. 8–16 chars.
}
```

**Response: `AuthEntity`** (same as `signUp`)

**Possible Errors**:
- `UNAUTHENTICATED` — Invalid email or password.
- `UNAUTHENTICATED` — Account locked (includes remaining lock time in seconds in message).

---

#### `refreshToken`
- **Type**: Mutation
- **Auth Required**: No (uses refresh token)
- **Rate Limit**: Not throttled (gated by token validity)
- **Description**: Issue new access + refresh token pair. Old refresh token is immediately revoked (rotation). Account must be active.

**Input: `RefreshTokenInput`**

```typescript
{
  refreshToken: string; // Required. The current valid refresh token.
}
```

**Response: `AuthEntity`**

**Possible Errors**:
- `UNAUTHENTICATED` — Token invalid, revoked, expired, or account inactive.

---

#### `signOut`
- **Type**: Mutation
- **Auth Required**: Yes (Bearer)
- **Rate Limit**: Not throttled
- **Description**: Revoke the provided refresh token. Idempotent — succeeds even if token not found.

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
- **Auth Required**: No
- **Rate Limit**: 5 requests/minute
- **Description**: Authenticate via Google OAuth access token. If the user does not exist, a new account is created automatically.

**Input: `SocialLoginInput`**

```typescript
{
  token: string; // Google OAuth access token obtained client-side.
}
```

**Response: `AuthEntity`**

**Flow**:
1. Backend validates token against Google's tokeninfo endpoint.
2. Verifies `aud` matches `GOOGLE_CLIENT_ID`.
3. Looks up existing user by provider ID.
4. Creates account if new (no password required).
5. Returns token pair.

**Possible Errors**:
- `UNAUTHENTICATED` — Invalid Google token or token not issued for this app.
- `UNAUTHENTICATED` — Google account has no email.

---

#### `signInWithFacebook`
- **Type**: Mutation
- **Auth Required**: No
- **Rate Limit**: 5 requests/minute
- **Description**: Authenticate via Facebook access token. Same upsert behavior as Google.

**Input: `SocialLoginInput`**

```typescript
{
  token: string; // Facebook access token obtained client-side.
}
```

**Response: `AuthEntity`**

---

#### `forgotPassword`
- **Type**: Mutation
- **Auth Required**: No
- **Rate Limit**: 3 requests/hour
- **Description**: Send a password reset email. Always returns `true` even if the email is not found (prevents user enumeration).

**Input: `ForgotPasswordInput`**

```typescript
{
  email: string; // Required. Valid email.
}
```

**Response**: `Boolean` (always `true`)

**Note**: The reset token is a signed JWT (15-minute TTL, `JWT_RESET_SECRET`) delivered in the email. The token is stored **hashed** in `User.passwordResetToken`.

---

#### `resetPassword`
- **Type**: Mutation
- **Auth Required**: No
- **Rate Limit**: 3 requests/hour
- **Description**: Reset password using the token from the email.

**Input: `ResetPasswordInput`**

```typescript
{
  resetToken: string;  // The JWT token from the password reset email.
  newPassword: string; // Min 8 chars.
}
```

**Response**: `Boolean`

**Possible Errors**:
- `UNAUTHENTICATED` — Token invalid, expired, or already used.

---

### 2.2 Users

Default resolver-level auth: `@Auth(AuthType.Bearer)` + `@Roles(Role.SUPER_ADMIN)` (unless overridden).

---

#### `createUser` (SUPER_ADMIN only)
- **Type**: Mutation
- **Roles**: `SUPER_ADMIN`
- **Description**: Manually create a user account.

**Input: `CreateUserInput`** (inherits `SignUpInput` fields + `role`)

---

#### `usersConnection` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Roles**: `ADMIN`, `SUPER_ADMIN`
- **Description**: Paginated, filtered list of users.

**Input: `UserPaginateArgs`** (extends `PaginationArgs`)

```typescript
{
  first?: number;         // Page size, 1–100, default 12
  after?: string;         // Cursor (product ID)
  orderBy?: string;       // Field to order by
  orderInAsc?: boolean;   // Ascending order? Default true
  email?: string;         // Partial match, case-insensitive
  phoneNumber?: string;   // Exact match
  role?: Role;            // USER | ADMIN | SUPER_ADMIN
  isActive?: boolean;     // Active status filter
  name?: string;          // Partial match, case-insensitive
  createdAfter?: Date;    // Filter users created after this date
}
```

**Response: `UserConnection`**

```typescript
{
  edges: [{ node: User, cursor: string }];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    pageSize: number;
  };
}
```

---

#### `userById` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `id: String!`
- **Response**: `User`

---

#### `userByEmail` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `email: String!`
- **Response**: `User`

---

#### `updateMyProfile` (USER, ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Auth Required**: Yes
- **Description**: Update the currently authenticated user's own profile.

**Input: `UpdateUserInput`**

```typescript
{
  name?: string;           // Optional. 2–50 chars.
  email?: string;          // Optional. Valid email.
  phoneNumber?: string;    // Optional. No specific format enforced.
  profilePicture?: string; // Optional. Must be a valid URL.
}
```

**Response**: `User`

---

#### `changeUserPassword` (USER, ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Auth Required**: Yes

**Input: `ChangeUserPasswordInput`**

```typescript
{
  oldPassword: string; // 8–16 chars. Must verify against current password.
  newPassword: string; // 8–16 chars. Must contain uppercase, lowercase, digit.
}
```

**Response**: `User`

---

#### `removeUser` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `id: String!`
- **Description**: Permanently deletes a user.

---

**`User` Object Type**:

```typescript
{
  id: string;
  name: string | null;
  email: string;
  phoneNumber?: string;
  authProvider?: string;
  isActive: boolean;
  profilePicture?: string;
  role: string;           // "USER" | "ADMIN" | "SUPER_ADMIN"
  createdAt: DateTime;
  updatedAt: DateTime;
  lastLoginAt?: DateTime;
  addresses?: Address[];
  orders?: Order[];
}
```

---

### 2.3 Products

---

#### `products`
- **Type**: Query
- **Auth Required**: No
- **Description**: Cursor-paginated, filtered product list.

**Input: `PaginationArgs` + `ProductFilterArgs`**

```typescript
// PaginationArgs
{
  first?: number;       // Default 12, max 100
  after?: string;       // Cursor (product ID from previous page)
  orderBy?: string;     // Field to sort by
  orderInAsc?: boolean; // Default true
}

// ProductFilterArgs
{
  categoryId?: string;
  categoryName?: string;
  subCategoryName?: string;
  subcategoryId?: string;
  isActive?: boolean;         // Default true
  search?: string;            // Partial match against name, description, tags
  createdAfter?: string;      // ISO date string
  priceMin?: number;          // Inclusive minimum price
  priceMax?: number;          // Inclusive maximum price
  brand?: string;             // Exact brand name match
  inStock?: boolean;          // Filter by in-stock status
  tagId?: string;
  tagName?: string;
}
```

**Response: `ProductConnection`**

```typescript
{
  edges: [{
    cursor: string;
    node: Product;
  }];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    pageSize: number;
  };
}
```

**`Product` Object Type**:

```typescript
{
  id: string;
  name: string;
  images: string[];             // Array of HTTPS URLs
  description?: string;
  price: Float;                 // Base price (Decimal, rendered as Float)
  currentPrice?: Float;         // Current selling price (may differ after manual update)
  currency?: string;            // Default "GHS"
  discountedPrice?: Float;      // Resolved field: price after active discount, or null
  appliedDiscount?: Discount;   // Resolved field: the active Discount object, or null
  sku?: string;
  quantity: number;             // Total stock count
  isActive: boolean;
  categoryId: string;
  subcategoryId?: string;
  category?: Category;
  subcategory?: SubCategory;
  brand?: Brand;
  variants?: Variant[];         // Resolved via DataLoader
  discounts?: Discount[];
  reviews?: Review[];           // Resolved via DataLoader
  tags?: Tag[];
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**Example Response**:
```json
{
  "data": {
    "products": {
      "edges": [
        {
          "cursor": "clx1234abc",
          "node": {
            "id": "clx1234abc",
            "name": "Cotton T-Shirt",
            "price": 29.99,
            "discountedPrice": 24.99,
            "isActive": true,
            "quantity": 50,
            "images": ["https://res.cloudinary.com/..."],
            "currency": "GHS"
          }
        }
      ],
      "pageInfo": {
        "hasNextPage": true,
        "hasPreviousPage": false,
        "pageSize": 12
      }
    }
  }
}
```

---

#### `product`
- **Type**: Query
- **Auth Required**: No
- **Args**: `productId: String!`
- **Response**: `Product | null`

---

#### `createProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Roles**: `ADMIN`, `SUPER_ADMIN`

**Input: `CreateProductInput`**

```typescript
{
  name: string;          // Required. 1–255 chars.
  images?: string[];     // Optional. Max 10 HTTPS URLs.
  description?: string;  // Optional. Max 5000 chars.
  price: string;         // Required. Decimal string e.g. "29.99". Avoids float rounding.
  sku?: string;          // Optional. 1–50 chars, alphanumeric + hyphens only.
  quantity: number;      // Required. Positive integer.
  isActive: boolean;     // Default false.
  categoryId?: string;   // Required. Parent category ID.
  subcategoryId?: string;// Optional. Subcategory ID.
  brandId?: string;      // Optional. Brand ID.
}
```

**Response**: `Product`

**Possible Errors**:
- `BAD_USER_INPUT` — Validation failure.
- `NOT_FOUND` — Category or brand not found.

---

#### `updateProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`, `updateProductInput: UpdateProductInput`
- **Response**: `Product`

`UpdateProductInput` has the same fields as `CreateProductInput`, all optional.

---

#### `permanentlyDeleteProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`
- **Response**: `Product`

---

#### `archiveProduct` / `restoreProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`
- **Description**: `archiveProduct` sets `status = ARCHIVED`, `isActive = false`. `restoreProduct` sets `status = PUBLISHED`, `isActive = true`.
- **Response**: `Product`

---

#### `addTagToProduct` / `removeTagFromProduct` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation
- **Args**: `productId: String!`, `tagId: String!`
- **Response**: `Product`

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
  products: Product[];
  subcategories: SubCategory[];
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `category`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `id: String!`
- **Response**: `Category | null`

---

#### `createCategory` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation

**Input: `CreateCategoryInput`**

```typescript
{
  name: string;          // Required. 2–50 chars. Alphanumeric, spaces, hyphens only.
  image?: string;        // Optional. HTTPS URL.
  description?: string;  // Optional. Max 500 chars.
}
```

---

#### `updateCategory` (ADMIN, SUPER_ADMIN)
- **Args**: `id: String!`, `input: UpdateCategoryInput` (all fields optional)

---

#### `removeCategory` (ADMIN, SUPER_ADMIN)
- **Args**: `id: String!`

---

### 2.5 SubCategories

---

#### `subCategories`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Response**: `[SubCategory!]!`

**`SubCategory` Object Type**:

```typescript
{
  id: string;
  name: string;
  description?: string;
  image?: string;
  categoryId: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `subCategory`
- **Type**: Query
- **Args**: `id: String!`

---

#### `createSubCategory` (ADMIN, SUPER_ADMIN)

**Input: `CreateSubCategoryInput`**

```typescript
{
  name: string;          // Required. 2–50 chars. Alphanumeric, spaces, hyphens.
  categoryId: string;    // Required. Parent category ID.
  image?: string;        // Optional. HTTPS URL.
  description?: string;  // Optional. Max 500 chars.
}
```

**Constraint**: `(name, categoryId)` must be unique.

---

### 2.6 Brands

---

#### `brands`
- **Type**: Query
- **Auth Required**: No
- **Response**: `[Brand]`

**`Brand` Object Type**:

```typescript
{
  id: string;
  name: string;
  description?: string;
  logo?: string;              // HTTPS URL
  products?: Product[];
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

**Input: `CreateBrandInput`**

```typescript
{
  name: string;          // Required. Max 255 chars.
  description?: string;  // Optional.
  logo?: string;         // Optional. HTTPS URL with TLD.
}
```

---

#### `updateBrand` / `deleteBrand` (ADMIN, SUPER_ADMIN)
- **Args**: `id: String!`, `input: UpdateBrandInput` (all optional)

---

### 2.7 Tags

---

#### `tags`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
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
- **Args**: `tagId: String!`

---

#### `createTag` (ADMIN, SUPER_ADMIN)
- **Args**: `name: String!`
- **Response**: `Tag`

---

#### `updateTag` (ADMIN, SUPER_ADMIN)
- **Args**: `tagId: String!`, `name: String!`

---

#### `deleteTag` (ADMIN, SUPER_ADMIN)
- **Args**: `tagId: String!`

---

#### `addProductsToTag` / `removeProductsFromTag` (ADMIN, SUPER_ADMIN)

**Input** (second arg name is `updateDiscountInput` — this is the actual arg name in GraphQL):

```typescript
// AddProductsToTagDto
{
  productIds: string[]; // Array of product IDs to add
}

// RemoveProductsFromTagDto
{
  productIds: string[]; // Array of product IDs to remove
}
```

---

### 2.8 Variants

---

#### `variant`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `variantId: String!`
- **Response**: `Variant`

**`Variant` Object Type**:

```typescript
{
  id: string;
  size?: string;
  color?: string;
  quantity: number;
  price: Float;
  productId: string;
  product: Product;
  discountId?: string;
}
```

---

#### `productVariants`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `productId: String!`
- **Response**: `[Variant!]!`

---

#### `variants`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: All variants (admin use).

---

#### `createVariant` (ADMIN, SUPER_ADMIN)

**Input: `CreateVariantInput`**

```typescript
{
  size?: string;       // Optional.
  color?: string;      // Optional.
  quantity: number;    // Required. Min 0.
  price: Float;        // Required. Min 0.
  productId: string;   // Required.
  discountId?: string; // Optional.
}
```

---

#### `updateVariant` (ADMIN, SUPER_ADMIN)

**Input: `UpdateVariantInput`**: all `CreateVariantInput` fields optional, plus:

```typescript
{
  id: string; // Required. ID of the variant to update.
}
```

---

#### `deleteVariant` (ADMIN, SUPER_ADMIN)
- **Args**: `variantId: String!`

---

### 2.9 Cart

All cart operations require `Bearer` JWT. Any role (USER, ADMIN, SUPER_ADMIN) can access.

---

#### `cart`
- **Type**: Query
- **Auth Required**: Yes
- **Description**: Retrieve the current user's cart.
- **Response**: `Cart | null`

**`Cart` Object Type**:

```typescript
{
  id: string;
  userId: string;
  items: CartItem[];
  total?: Float;           // Sum of originalPrice × quantity for all items
  discountTotal?: Float;   // Sum of discounts applied
  finalTotal?: Float;      // total - discountTotal
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
  variant?: Variant;
  originalPrice?: Float;     // Price per unit at time of add
  discountedPrice?: Float;   // Discounted price per unit, if applicable
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

**Input: `AddToCartInput`**

```typescript
{
  productId: string; // Required.
  quantity: number;  // Required. Positive integer.
}
```

**Note**: To add a product **variant** to the cart, use `productId` of the parent product. If the product has variants that need to be differentiated (size/color), the current `AddToCartInput` does **not** include `variantId` — the variant association is stored in `CartItem.variantId` but the input only takes `productId`. Check the cart service for variant resolution logic.

**Response**: `Cart`

**Possible Errors**:
- `NOT_FOUND` — Product not found.
- `BAD_REQUEST` — Insufficient stock.

---

#### `updateCartItem`
- **Type**: Mutation
- **Auth Required**: Yes

**Input: `UpdateCartItemInput`**

```typescript
{
  cartItemId: string; // Required.
  quantity: number;   // Required. Integer. Min 0. Setting to 0 removes the item.
}
```

**Response**: `Cart`

---

#### `removeFromCart`
- **Type**: Mutation
- **Auth Required**: Yes
- **Args**: `cartItemId: String!`
- **Response**: `Cart`

---

#### `clearCart`
- **Type**: Mutation
- **Auth Required**: Yes
- **Response**: `Cart` (empty)

---

#### `cartWithDiscount`
- **Type**: Query
- **Auth Required**: Yes
- **Description**: Returns the cart with all active discounts applied to items.
- **Response**: `Cart`

---

### 2.10 Wishlist

All wishlist operations require `Bearer` JWT.

---

#### `wishlist`
- **Type**: Query
- **Auth Required**: Yes
- **Description**: Get or lazily create the user's wishlist.
- **Response**: `Wishlist`

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
- **Response**: `Wishlist`

---

#### `removeFromWishlist`
- **Type**: Mutation
- **Auth Required**: Yes
- **Args**: `productId: String!`
- **Response**: `Wishlist`

---

#### `clearWishlist`
- **Type**: Mutation
- **Auth Required**: Yes
- **Response**: `Wishlist` (empty products array)

---

### 2.11 Orders

All order operations require `Bearer` JWT.

---

#### `order`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `orderId: String!`
- **Description**: Retrieve a specific order. Users can only see their own orders.
- **Response**: `Order`

**`Order` Object Type**:

```typescript
{
  id: string;
  userId: string;
  totalAmount: Float;                          // Final total including tax
  discountTotal?: Float;                       // Total discount from product/category discounts
  finalTotal?: Float;                          // totalAmount after all discounts
  couponDiscount?: Float;                      // Coupon discount applied at checkout
  status: OrderStatus;                         // PENDING | PROCESSING | SHIPPED | DELIVERED | CANCELLED
  shippingAddressId: string;
  shippingAddressSnapshot?: JSON;              // Snapshot of address at order time
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
  variantId?: string;
  quantity: number;
  priceAtOrder: Float;        // Price per unit at the time of the order
  originalPrice?: Float;
  discountAmount?: Float;
  appliedDiscount?: Discount;
  createdAt: DateTime;
  updatedAt: DateTime;
  product: Product;
}
```

**`OrderStatus` Enum**:

```
PENDING       — Order created, awaiting payment
PROCESSING    — Payment received, order is being processed
SHIPPED       — Order has been dispatched
DELIVERED     — Order delivered to customer
CANCELLED     — Order cancelled
```

---

#### `userOrders`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: All orders for the current user.
- **Response**: `[Order!]!`

---

#### `orders` (ADMIN, SUPER_ADMIN only)
- **Type**: Query
- **Description**: All orders in the system.
- **Response**: `[Order!]!`

---

#### `viewOrder` (ADMIN, SUPER_ADMIN only)
- **Type**: Query
- **Args**: `id: String!`
- **Description**: Retrieve any order by ID (no ownership check).

---

#### `createOrder`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: Create an order from the user's current cart. Validates stock. Applies tax. Optionally applies coupon. Clears cart on success.

**Input: `CreateOrderInput`**

```typescript
{
  shippingAddressId: string; // Required. Must be one of the user's saved addresses.
  couponCode?: string;       // Optional. Coupon to apply.
}
```

**What happens internally**:
1. Cart is loaded and validated (must not be empty).
2. Shipping address is verified (must belong to the user).
3. Stock availability for each item is verified.
4. Tax is calculated per item based on country from the shipping address.
5. Coupon (if provided) is validated and applied.
6. Order rows are created in a transaction.
7. Inventory is decremented atomically.
8. Cart is cleared.
9. Confirmation email is sent asynchronously.

**Response**: `Order`

**Possible Errors**:
- `NOT_FOUND` — Cart empty, shipping address not found.
- `BAD_REQUEST` — Insufficient stock for one or more items, invalid/expired coupon.

---

#### `cancelOrder`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `orderId: String!`
- **Description**: Cancel the order. Restores reserved stock. Users can only cancel their own orders.
- **Response**: `Order`

---

#### `updateOrderStatus` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation

**Input: `UpdateOrderStatusInput`**

```typescript
{
  orderId: string;        // Required.
  status: OrderStatus;    // Required. PENDING | PROCESSING | SHIPPED | DELIVERED | CANCELLED
}
```

**Side effects**: When status transitions to `SHIPPED` or `DELIVERED`, a status update email is sent to the customer.

---

#### `updateShipping` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation

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
- **Description**: Soft-delete an order. Sets `deleted = true`, `deletedAt = now()`. Restores stock.

---

#### `finalizeOrder`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `id: String!`
- **Description**: Snapshot and apply active discounts to the order as permanent `OrderItem.discountAmount` values. Call this after `createOrder` to lock in discount values.

---

### 2.12 Payment

---

#### `verifyPayment`
- **Type**: Mutation (GraphQL)
- **Roles**: `USER`
- **Description**: Verify a Paystack payment by reference and update status. Enforces ownership — only the order owner can verify.

**Input: `VerifyPaymentInput`**

```typescript
{
  reference: string; // Paystack transaction reference (from callback URL query param).
}
```

**Response**: `Payment`

**`Payment` Object Type**:

```typescript
{
  id: string;
  orderId: string;
  order: Order;
  amount: Float;
  currency: string;
  paymentMethod: string;
  status: PaymentStatus;     // PENDING | COMPLETED | FAILED
  transactionId?: string;
  paymentDetails?: string;   // JSON string with full Paystack response
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**`PaymentStatus` Enum**: `PENDING`, `COMPLETED`, `FAILED`

---

#### `getMyPayments`
- **Type**: Query
- **Roles**: `USER`
- **Response**: `[Payment!]!`

---

#### `getUserPayment` (ADMIN only)
- **Type**: Query
- **Args**: `userId: String!`
- **Response**: `[Payment!]!`

---

#### `payment`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `id: String!`
- **Description**: Users can only access their own payments. Admins can access any.

---

#### `softDeletePayment` / `restorePayment` / `removePayment` (ADMIN only)
- **Type**: Mutation
- **Args**: `id: String!`

---

### 2.13 Coupons

---

#### `coupons` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Response**: `[Coupon!]!`

**`Coupon` Object Type**:

```typescript
{
  id: string;
  code: string;
  discountType: DiscountType;    // PERCENTAGE | FLAT
  value: Float;
  usageLimit?: number;           // null = unlimited
  usedCount: number;
  expiresAt?: DateTime;
  isActive: boolean;
  minimumOrderAmount?: Float;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `coupon` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `id: ID!`

---

#### `createCoupon` (ADMIN, SUPER_ADMIN)

**Input: `CreateCouponInput`**

```typescript
{
  code: string;                   // Required. Max 50 chars.
  discountType: DiscountType;     // Required. PERCENTAGE | FLAT
  value: Float;                   // Required. Min 0.
  usageLimit?: number;            // Optional. Min 1 if provided.
  expiresAt?: DateTime;           // Optional.
  isActive?: boolean;             // Default true.
  minimumOrderAmount?: Float;     // Optional. Min 0.
}
```

---

#### `updateCoupon` (ADMIN, SUPER_ADMIN)
- **Args**: `id: ID!`, `input: UpdateCouponInput` (all fields optional)

---

#### `deleteCoupon` (ADMIN, SUPER_ADMIN)
- **Args**: `id: ID!`

---

#### `validateCoupon`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: Validate a coupon code before applying to order. Checks: existence, active status, expiry, usage limit, per-user usage, minimum order amount.

**Input: `ValidateCouponInput`**

```typescript
{
  code: string;        // Required.
  orderTotal: Float;   // Required. Current order total to check minimumOrderAmount.
}
```

**Response: `CouponValidation`**

```typescript
{
  valid: boolean;
  discountAmount?: Float;   // Amount that will be deducted
  message?: string;         // e.g., "Coupon applied. You save 10."
}
```

**Possible Errors** (thrown as GraphQL errors):
- `BAD_REQUEST` — Coupon not found, expired, inactive, usage limit reached, already used by this user, order total below minimum.

---

### 2.14 Discounts

Discounts are applied automatically to products/variants/categories. They differ from coupons: discounts are backend-configured, category/product-wide; coupons are user-applied codes.

---

#### `discount` (ADMIN, SUPER_ADMIN)
- **Type**: Query (returns `[Discount!]!`)

---

#### `createDiscount` (ADMIN, SUPER_ADMIN)

**Input: `CreateDiscountInput`**

```typescript
{
  name: string;               // Required.
  description?: string;       // Optional.
  type: DiscountType;         // Required. PERCENTAGE | FLAT
  value: Float;               // Required. Positive number.
  startDate: DateTime;        // Required. ISO datetime.
  endDate: DateTime;          // Required. Must be after startDate.
  isActive: boolean;          // Default false.
  products?: string[];        // Optional. Array of product IDs.
  variants?: string[];        // Optional. Array of variant IDs.
  categories?: string[];      // Optional. Array of category IDs.
  minimumPurchase?: Float;    // Optional. Minimum cart value to qualify.
}
```

**`Discount` Object Type**:

```typescript
{
  id: string;
  name: string;
  description?: string;
  type: DiscountType;         // PERCENTAGE | FLAT
  value: Float;
  startDate: DateTime;
  endDate: DateTime;
  isActive: boolean;
  products: Product[];
  variants: Variant[];
  categories: Category[];
  minimumPurchase?: Float;
}
```

---

#### `updateDiscount` (ADMIN, SUPER_ADMIN)
- **Input: `UpdateDiscountInput`** — all fields from `CreateDiscountInput` optional, plus `id: string` (required).

---

#### `addToDiscount` / `removeFromDiscount` (ADMIN, SUPER_ADMIN)

**Input: `ModifyDiscountItemsInput`**

```typescript
{
  discountId: string;        // Required.
  products?: string[];       // Optional. Product IDs to add/remove.
  variants?: string[];       // Optional. Variant IDs to add/remove.
  categories?: string[];     // Optional. Category IDs to add/remove.
}
```

---

#### `removeDiscount` (ADMIN, SUPER_ADMIN)
- **Args**: `id: String!`

---

### 2.15 Inventory

All inventory operations: `ADMIN`, `SUPER_ADMIN` only.

---

#### `restockProduct`
- **Type**: Mutation

**Input: `RestockProductInput`**

```typescript
{
  productId: string;  // Required.
  quantity: number;   // Required. Integer. Min 1.
  reason?: string;    // Optional.
}
```

**Response: `InventoryLogEntity`**

```typescript
{
  id: string;
  productId: string;
  variantId?: string;
  action: InventoryAction;     // RESTOCK | ORDER_DEDUCTION | RETURN_RESTORE | ADJUSTMENT
  quantityChange: number;
  quantityAfter: number;
  reason?: string;
  actorId?: string;
  createdAt: DateTime;
}
```

---

#### `restockVariant`
- **Type**: Mutation

**Input: `RestockVariantInput`**

```typescript
{
  variantId: string;  // Required.
  quantity: number;   // Required. Min 1.
  reason?: string;    // Optional.
}
```

---

#### `productInventoryLogs`
- **Type**: Query
- **Args**: `productId: ID!`
- **Response**: `[InventoryLogEntity!]!`

---

#### `variantInventoryLogs`
- **Type**: Query
- **Args**: `variantId: ID!`
- **Response**: `[InventoryLogEntity!]!`

---

### 2.16 Returns

---

#### `createReturnRequest`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: Submit a return request for a delivered order. Order must be in `DELIVERED` status.

**Input: `CreateReturnRequestInput`**

```typescript
{
  orderId: string; // Required.
  reason: string;  // Required. Min 10 chars.
}
```

**Response: `ReturnRequestEntity`**

```typescript
{
  id: string;
  orderId: string;
  userId: string;
  reason: string;
  status: ReturnStatus;      // PENDING | APPROVED | REJECTED | REFUNDED
  refundAmount?: Float;
  adminNote?: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `approveReturn` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation

**Input: `ApproveReturnInput`**

```typescript
{
  returnRequestId: string; // Required.
  refundAmount: Float;     // Required. Min 0.
  adminNote?: string;      // Optional.
}
```

**Side effects**: Sets `ReturnStatus = APPROVED`, records inventory restore log.

---

#### `rejectReturn` (ADMIN, SUPER_ADMIN)
- **Type**: Mutation

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
- **Description**: Move status from `APPROVED` to `REFUNDED`. Actual refund disbursement is handled externally.

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

> **Privacy:** `Review.user` is a `PublicProfile { displayName }` (first name + last initial, or "Customer"). Reviewer email, phone, addresses and orders are not reachable from reviews. Separately, `User.email`, `User.phoneNumber`, `User.addresses`, `User.orders` and `Order.user` return a `FORBIDDEN` error unless the caller is that user or an ADMIN/SUPER_ADMIN.

---

#### `review`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `reviewId: String!`
- **Response**: `Review`

**`Review` Object Type**:

```typescript
{
  id: string;
  score: number;      // 1–5
  comment?: string;
  productId: string;
  userId: string;
  user: PublicProfile; // { displayName } only, e.g. "Kwame A." ("Customer" if no name)
  product: Product;   // Resolved via DataLoader
}
```

---

#### `productReviews`
- **Type**: Query
- **Args**: `productId: String!`
- **Response**: `[Review!]!`

---

#### `userReviews`
- **Type**: Query
- **Auth Required**: Yes
- **Description**: Reviews written by the current user.

---

#### `createReview`
- **Type**: Mutation
- **Roles**: `USER` (only regular users can create)

**Input: `CreateReviewInput`**

```typescript
{
  productId: string;  // Required.
  score: number;      // Required. Integer 1–5.
  comment?: string;   // Optional.
}
```

---

#### `updateReview`
- **Type**: Mutation
- **Roles**: `USER`

**Input: `UpdateReviewInput`**

```typescript
{
  reviewId: string;   // Required.
  score?: number;     // Optional. 1–5.
  comment?: string;   // Optional.
}
```

---

#### `deleteReview`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `reviewId: String!`
- **Description**: Soft-delete: sets `deleted = true`, `deletedAt = now()`.

---

### 2.18 Tax

All tax operations: `ADMIN`, `SUPER_ADMIN` only.

---

#### `taxRates`
- **Type**: Query
- **Response**: `[TaxRateEntity!]!`

**`TaxRateEntity` Object Type**:

```typescript
{
  id: string;
  country: string;    // Country name or ISO code
  region?: string;    // Optional. State/province.
  rate: Float;        // Decimal 0–1 (e.g., 0.15 = 15%). Stored as Decimal(5,4).
  isActive: boolean;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**Unique constraint**: `(country, region)`.

---

#### `taxRate`
- **Type**: Query
- **Args**: `id: ID!`

---

#### `createTaxRate`

**Input: `CreateTaxRateInput`**

```typescript
{
  country: string;   // Required.
  region?: string;   // Optional.
  rate: Float;       // Required. 0 ≤ rate ≤ 1.
  isActive?: boolean;// Default true.
}
```

---

#### `updateTaxRate` / `deleteTaxRate`
- **Args**: `id: ID!`, `input: UpdateTaxRateInput` (all optional)

---

### 2.19 Analytics

All analytics queries: `ADMIN`, `SUPER_ADMIN` only.

---

#### `salesReport`
- **Type**: Query
- **Args** (`@ArgsType`):
```typescript
{
  startDate: DateTime; // Required.
  endDate: DateTime;   // Required.
}
```
- **Response: `SalesReport`**:
```typescript
{
  totalRevenue: Float;
  orderCount: number;
  averageOrderValue: Float;
}
```

---

#### `topProducts`
- **Type**: Query
- **Args**: `limit?: number` (default 10, 1–100)
- **Response**: `[TopProduct!]!`

```typescript
{
  productId: string;
  productName: string;
  totalQuantitySold: number;
  totalRevenue: Float;
}
```

---

#### `revenueByCategory`
- **Type**: Query
- **Response**: `[RevenueByCategoryEntity!]!`

```typescript
{
  categoryId?: string;
  categoryName?: string;
  totalRevenue: Float;
  orderCount: number;
}
```

---

#### `dashboardSummary`
- **Type**: Query
- **Response: `DashboardSummary`**:

```typescript
{
  totalUsers: number;
  ordersToday: number;
  revenueToday: Float;
  lowStockProductCount: number;
  lowStockVariantCount: number;
}
```

---

### 2.20 Addresses

---

#### `address`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Args**: `addressId: String!`
- **Description**: Users can only access their own addresses.

**`Address` Object Type**:

```typescript
{
  id: string;
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  userId: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

---

#### `userAddresses`
- **Type**: Query
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`
- **Description**: All addresses for the authenticated user.
- **Response**: `[Address!]!`

---

#### `addresses` (ADMIN, SUPER_ADMIN)
- **Type**: Query
- **Args**: `userId?: String` (ADMIN must supply; SUPER_ADMIN can omit to get all)

---

#### `createAddress`
- **Type**: Mutation
- **Roles**: `USER`, `ADMIN`, `SUPER_ADMIN`

**Input: `CreateAddressInput`**

```typescript
{
  street: string;   // Required. Max 255 chars.
  city: string;     // Required. Max 100 chars.
  state: string;    // Required. Max 100 chars.
  zipCode: string;  // Required. Max 20 chars.
  country: string;  // Required. Max 100 chars.
}
```

---

#### `updateAddress`
- **Args**: `addressId: String!`, `input: UpdateAddressInput` (all optional)

---

#### `deleteAddress`
- **Args**: `addressId: String!`

---

## 3. REST API Reference

These endpoints are not in GraphQL. They use standard HTTP.

### `POST /payment/initialize`

**Auth Required**: Yes (Bearer)
**Rate Limit**: 5 requests/minute (`payment` throttler)
**Content-Type**: `application/json`

**Request Body**:

```typescript
{
  orderId: string;       // Required.
  paymentMethod: string; // Required. e.g., "card"
  currency: string;      // Required. e.g., "GHS"
}
```

**Response**:

```json
{
  "id": "paymentId",
  "orderId": "orderId",
  "amount": 29.99,
  "currency": "GHS",
  "paymentMethod": "card",
  "status": "PENDING",
  "authorizationUrl": "https://checkout.paystack.com/..."
}
```

**Frontend must redirect** the user to `authorizationUrl` to complete payment on Paystack.

---

### `GET /payment/callback`

**Auth Required**: No
**Description**: Paystack redirect callback URL. Frontend should configure Paystack's callback URL to point here (or query `?reference=xxx`).

**Query Params**:

```typescript
{
  reference: string; // Paystack transaction reference
}
```

**Response**: Payment object.

---

### `POST /payment/webhook`

**Auth Required**: No (verified by HMAC signature)
**Description**: Paystack webhook. Must be registered in Paystack dashboard.

**Headers required**:
- `x-paystack-signature: <HMAC-SHA512 of raw body>` (Paystack sends this automatically)

**Body (PaystackWebhookDto)**:

```typescript
{
  event: "charge.success" | "charge.failed";
  data: {
    reference: string;
    amount: number;       // In kobo/pesewas (smallest unit)
    currency: string;
    status: string;
  };
}
```

**Handled Events**:
- `charge.success` → marks payment `COMPLETED`, order status → `PROCESSING`.
- `charge.failed` → marks payment `FAILED`.
- All other events: acknowledged (`200 OK`) but not processed.

---

### `POST /upload/single-image`

**Auth Required**: Yes (Bearer)
**Rate Limit**: 10 uploads/minute
**Content-Type**: `multipart/form-data`
**Field name**: `file`
**Max size**: 5 MB

**Response**:

```json
{
  "url": "https://res.cloudinary.com/your-cloud/image/upload/ecommerce/...",
  "public_id": "ecommerce/abc123"
}
```

---

### `POST /upload/multiple-images`

**Auth Required**: Yes (Bearer)
**Rate Limit**: 10 uploads/minute
**Content-Type**: `multipart/form-data`
**Field name**: `files` (max 3 files)
**Max size per file**: 5 MB

**Response**:

```json
{
  "message": "Product images uploaded successfully",
  "files": [
    { "url": "https://res.cloudinary.com/...", "public_id": "ecommerce/abc123" },
    { "url": "https://res.cloudinary.com/...", "public_id": "ecommerce/abc456" }
  ]
}
```

---

### `GET /health`

**Auth Required**: No
**Description**: Health check endpoint. Returns status of database, Redis, and Cloudinary.

---

## 4. Prisma Data Models

### `User`

```prisma
model User {
  id                    String          @id @default(cuid())
  name                  String?
  email                 String          @unique
  password              String?                           // Null for social-only accounts
  phoneNumber           String?         @unique
  role                  Role            @default(USER)
  isActive              Boolean         @default(true)
  createdAt             DateTime        @default(now())
  updatedAt             DateTime        @updatedAt
  lastLoginAt           DateTime?
  profilePicture        String?
  failedLoginAttempts   Int             @default(0)       // Incremented on failed login
  lockedUntil           DateTime?                         // Set 15 min in future after 5 failed attempts
  passwordResetToken    String?                           // Hashed reset token
  passwordResetTokenExp DateTime?
  addresses             Address[]
  reviews               Review[]
  cart                  Cart?
  order                 Order[]
  authProvider          AuthProvider[]
  auditLog              AuditLog[]
  wishlist              WishList?
  refreshTokens         RefreshToken[]
  couponUsages          CouponUsage[]
  returnRequests        ReturnRequest[]
}
```

**Delete behavior**: User deletion cascades to Address, Review, Cart, AuthProvider, WishList, RefreshToken, CouponUsage. Orders reference is `RESTRICT` (cannot delete user with orders).

---

### `RefreshToken`

```prisma
model RefreshToken {
  id        String   @id @default(cuid())
  userId    String
  tokenHash String   @unique   // SHA-256 hash of the raw token
  expiresAt DateTime
  revoked   Boolean  @default(false)
  createdAt DateTime @default(now())
  user      User     @relation(... onDelete: Cascade)
  @@index([userId])
  @@index([tokenHash])
}
```

---

### `AuthProvider`

```prisma
model AuthProvider {
  id         String   @id @default(cuid())
  userId     String
  provider   String               // "google" | "facebook"
  providerId String   @unique     // OAuth provider's user ID
  user       User     @relation(... onDelete: Cascade)
  createdAt  DateTime @default(now())
  @@unique([provider, providerId])
  @@unique([userId, provider])
}
```

---

### `Address`

```prisma
model Address {
  id        String   @id @default(cuid())
  street    String
  city      String
  state     String
  zipCode   String
  country   String
  userId    String
  user      User     @relation(... onDelete: Cascade)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  Order     Order[]
  @@index([userId])
}
```

---

### `Category`

```prisma
model Category {
  id            String        @id @default(cuid())
  name          String        @unique
  description   String?       @db.Text
  image         String?
  products      Product[]
  subcategories SubCategory[]
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  discount      Discount?     @relation(...)
  discountId    String?
  @@index([discountId])
}
```

---

### `SubCategory`

```prisma
model SubCategory {
  id          String    @id @default(cuid())
  name        String
  description String?   @db.Text
  image       String?
  categoryId  String
  category    Category  @relation(...)
  products    Product[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  @@unique([name, categoryId])   // Name must be unique within a category
}
```

---

### `Brand`

```prisma
model Brand {
  id          String    @id @default(cuid())
  name        String    @unique @db.VarChar(255)
  description String?   @db.Text
  logo        String?
  products    Product[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}
```

---

### `Tag`

```prisma
model Tag {
  id        String    @id @default(cuid())
  name      String    @unique
  products  Product[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

---

### `Product`

```prisma
model Product {
  id               String          @id @default(cuid())
  name             String          @db.VarChar(255)
  description      String?         @db.Text
  shortDescription String?         @db.VarChar(500)
  price            Decimal?        @db.Decimal(10, 2)
  currentPrice     Decimal?        @db.Decimal(10, 2)
  currency         Currency?       @default(GHS)
  taxRate          Decimal?        @default(0.00) @db.Decimal(5, 2)
  isTaxable        Boolean         @default(false)
  sku              String?         @unique
  barcode          String?         @unique
  quantity         Int             @default(0)
  stockStatus      StockStatus?    @default(IN_STOCK)
  lowStockAlert    Int?            @default(5)
  images           String[]
  attachments      String[]
  isActive         Boolean         @default(true)
  status           ProductStatus?  @default(DRAFT)
  publishedAt      DateTime?
  deliveryOptions  DeliveryOptions[] @default([LOCAL_DELIVERY])
  selectedDeliveryRegions String[]
  expiryDate       DateTime?
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt
  categoryId       String?
  subcategoryId    String?
  tags             Tag[]
  reviews          Review[]
  variants         Variant[]
  discounts        Discount[]
  cartItem         CartItem[]
  orderItem        OrderItem[]
  wishlist         WishList[]
  brand            Brand?
  brandId          String?
  inventoryLogs    InventoryLog[]
  @@index([sku])
  @@index([brandId])
  @@index([categoryId])
  @@index([subcategoryId])
  @@index([isActive, status])
}
```

**Enums**:

```
ProductStatus: DRAFT | PUBLISHED | ARCHIVED
StockStatus:   IN_STOCK | OUT_OF_STOCK | PREORDER | BACKORDER
Currency:      GHS | USD | EUR | GBP | NGN
DeliveryOptions: LOCAL_DELIVERY | INTERNATIONAL_DELIVERY | SELECTED_REGIONS
```

---

### `Variant`

```prisma
model Variant {
  id                String         @id @default(cuid())
  size              String?
  color             String?
  quantity          Int            @default(0)
  price             Decimal        @db.Decimal(10, 2)
  productId         String
  product           Product        @relation(...)
  cartItem          CartItem[]
  orderItem         OrderItem[]
  discount          Discount?
  discountId        String?
  lowStockThreshold Int?           @default(5)
  inventoryLogs     InventoryLog[]
  @@index([productId])
  @@index([discountId])
}
```

---

### `Cart` and `CartItem`

```prisma
model Cart {
  id        String     @id @default(cuid())
  userId    String     @unique       // One cart per user
  user      User       @relation(... onDelete: Cascade)
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  items     CartItem[]
}

model CartItem {
  id              String    @id @default(cuid())
  cartId          String
  productId       String
  variantId       String?
  quantity        Int       @default(1)
  originalPrice   Decimal?  @db.Decimal(10, 2)
  discountedPrice Decimal?  @db.Decimal(10, 2)
  discountId      String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  cart            Cart      @relation(... onDelete: Cascade)
  product         Product   @relation(... onDelete: Restrict)
  variant         Variant?  @relation(... onDelete: Restrict)
  discount        Discount?
  @@index([cartId, productId])
  @@index([variantId])
}
```

---

### `Order` and `OrderItem`

```prisma
model Order {
  id                      String      @id @default(cuid())
  userId                  String
  totalAmount             Decimal     @db.Decimal(10, 2)
  discountTotal           Decimal?
  totalWithOutDiscount    Decimal?
  status                  OrderStatus @default(PENDING)
  shippingAddressId       String
  shippingAddressSnapshot Json?       // Snapshot of address at order time
  trackingNumber          String?
  carrier                 String?
  couponId                String?
  couponDiscount          Decimal?    @db.Decimal(10, 2)
  createdAt               DateTime    @default(now())
  updatedAt               DateTime    @updatedAt
  deleted                 Boolean     @default(false)
  deletedAt               DateTime?
  items                   OrderItem[]
  payment                 Payment?
  returnRequests          ReturnRequest[]
  @@index([userId])
  @@index([userId, status])
  @@index([deleted])
  @@index([trackingNumber])
}

model OrderItem {
  id             String    @id @default(cuid())
  orderId        String
  productId      String
  variantId      String?
  quantity       Int       @default(1)
  priceAtOrder   Decimal   @db.Decimal(10, 2)  // Price per unit at time of order
  originalPrice  Decimal   @db.Decimal(10, 2)
  discountAmount Decimal?  @db.Decimal(10, 2)
  discountId     String?
  createdAt      DateTime  @default(now())
  @@index([productId, orderId])
}
```

**`OrderStatus` Enum**: `PENDING | PROCESSING | SHIPPED | DELIVERED | CANCELLED`

---

### `Payment`

```prisma
model Payment {
  id             String        @id @default(cuid())
  orderId        String        @unique              // One payment per order
  order          Order         @relation(... onDelete: Cascade)
  amount         Decimal       @db.Decimal(10, 2)
  currency       String        @default("GHS")
  paymentMethod  String
  status         PaymentStatus @default(PENDING)
  transactionId  String?                            // Paystack reference
  paymentDetails Json?                              // Full Paystack response
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
  deleted        Boolean       @default(false)
  deletedAt      DateTime?
}
```

**`PaymentStatus`**: `PENDING | COMPLETED | FAILED`

---

### `Discount`

```prisma
model Discount {
  id              String       @id @default(cuid())
  name            String
  description     String?
  type            DiscountType            // PERCENTAGE | FLAT
  value           Decimal
  startDate       DateTime
  endDate         DateTime
  isActive        Boolean      @default(false)
  minimumPurchase Decimal?     @db.Decimal(10, 2)
  products        Product[]    // M2M
  variants        Variant[]    // M2M
  categories      Category[]   // M2M
  orderItems      OrderItem[]
  cartItems       CartItem[]
  @@index([startDate, endDate, isActive])
}
```

---

### `Coupon` and `CouponUsage`

```prisma
model Coupon {
  id                 String        @id @default(cuid())
  code               String        @unique @db.VarChar(50)
  discountType       DiscountType               // PERCENTAGE | FLAT
  value              Decimal       @db.Decimal(10, 2)
  usageLimit         Int?                       // Null = unlimited
  usedCount          Int           @default(0)
  expiresAt          DateTime?
  isActive           Boolean       @default(true)
  minimumOrderAmount Decimal?      @db.Decimal(10, 2)
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  usages             CouponUsage[]
  orders             Order[]
  @@index([code])
  @@index([isActive, expiresAt])
}

model CouponUsage {
  id        String   @id @default(cuid())
  couponId  String
  userId    String
  orderId   String   @unique          // Each order can only use one coupon
  coupon    Coupon   @relation(...)
  user      User     @relation(... onDelete: Cascade)
  createdAt DateTime @default(now())
  @@unique([couponId, userId])         // Each user can use a given coupon only once
  @@index([userId])
  @@index([couponId])
}
```

---

### `WishList`

```prisma
model WishList {
  id        String    @id @default(cuid())
  userId    String    @unique    // One wishlist per user
  user      User      @relation(... onDelete: Cascade)
  products  Product[]            // M2M
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

---

### `Review`

```prisma
model Review {
  id        String    @id @default(cuid())
  score     Int                   // 1–5
  comment   String?
  productId String
  userId    String
  deleted   Boolean   @default(false)
  deletedAt DateTime?
  user      User      @relation(... onDelete: Cascade)
  product   Product   @relation(... onDelete: Cascade)
  @@index([productId])
  @@index([userId])
}
```

**Soft delete**: `deleted` flag + `deletedAt` timestamp.

---

### `ReturnRequest`

```prisma
model ReturnRequest {
  id           String       @id @default(cuid())
  orderId      String
  userId       String
  reason       String       @db.Text
  status       ReturnStatus @default(PENDING)
  refundAmount Decimal?     @db.Decimal(10, 2)
  adminNote    String?      @db.Text
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt
  order        Order        @relation(... onDelete: Restrict)
  user         User         @relation(... onDelete: Restrict)
  @@index([orderId])
  @@index([userId])
  @@index([status])
}
```

**`ReturnStatus`**: `PENDING | APPROVED | REJECTED | REFUNDED`

---

### `InventoryLog`

```prisma
model InventoryLog {
  id             String          @id @default(cuid())
  productId      String
  variantId      String?
  action         InventoryAction   // RESTOCK | ORDER_DEDUCTION | RETURN_RESTORE | ADJUSTMENT
  quantityChange Int               // Positive = added, negative = removed
  quantityAfter  Int               // Stock level after the change
  reason         String?
  actorId        String?           // Admin/system user who triggered this
  createdAt      DateTime          @default(now())
  product        Product           @relation(... onDelete: Cascade)
  variant        Variant?          @relation(... onDelete: SetNull)
  @@index([productId])
  @@index([variantId])
  @@index([action])
  @@index([createdAt])
}
```

---

### `TaxRate`

```prisma
model TaxRate {
  id        String   @id @default(cuid())
  country   String
  region    String?
  rate      Decimal  @db.Decimal(5, 4)   // e.g., 0.1500 = 15%
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([country, region])
  @@index([country])
}
```

---

### `AuditLog`

```prisma
model AuditLog {
  id        String   @id @default(cuid())
  entity    String               // e.g., "Order", "Product"
  entityId  String
  action    String               // e.g., "STATUS_CHANGE", "CREATED"
  userId    String?              // Who performed the action (admin)
  details   Json?                // Before/after state, extra context
  createdAt DateTime @default(now())
  @@index([entity, entityId])
  @@index([userId])
}
```

---

### Entity Relationship Summary

- A **User** has one **Cart**, one **WishList**, many **Orders**, many **Addresses**, many **Reviews**, many **RefreshTokens**, many **CouponUsages**, many **ReturnRequests**, many **AuthProviders**.
- A **Product** belongs to one **Category**, one **SubCategory**, one **Brand**; has many **Tags** (M2M), many **Variants**, many **Reviews**, many **Discounts** (M2M); appears in **CartItems**, **OrderItems**, **WishLists**.
- An **Order** belongs to one **User**, references one **Address** (snapshot also stored), has many **OrderItems**, one **Payment**, many **ReturnRequests**, optionally one **Coupon**.
- A **Discount** can apply to many **Products**, **Variants**, and **Categories** (M2M).
- A **Coupon** tracks per-user usage via **CouponUsage** (unique per coupon+user, one coupon per order).

---

## 5. Authentication & Authorization

### JWT Payload Structure

The access token payload (decoded):

```json
{
  "sub": "userId",       // User's cuid string
  "aud": "JWT_TOKEN_AUDIENCE value",
  "iss": "JWT_TOKEN_ISSUER value",
  "iat": 1704067200,
  "exp": 1704070800
}
```

The refresh token payload is the same structure, signed with `JWT_REFRESH_SECRET`.
The reset token payload adds `"purpose": "password-reset"`.

### Token TTLs (defaults, all configurable)

| Token | Default TTL | Variable |
|---|---|---|
| Access token | 3600 seconds (1 hour) | `JWT_ACCESS_TOKEN_TTL` |
| Refresh token | 86400 seconds (24 hours) | `JWT_REFRESH_TOKEN_TTL` |
| Reset token | 900 seconds (15 minutes) | `JWT_RESET_TOKEN_TTL` |

### Guards

1. **`AuthenticationGuard`** (applied globally via `APP_GUARD`): checks for `@Auth()` metadata. Default is `AuthType.Bearer`. Falls through to `AccessTokenGuard`.
2. **`AccessTokenGuard`**: verifies JWT, extracts user, attaches to `request[REQUEST_USER_KEY]`.
3. **`RolesGuard`** (applied globally): checks `@Roles()` metadata against `user.role`.
4. **`GqlThrottlerGuard`** (applied globally): enforces rate limits per named throttler.

### Role Hierarchy

```
SUPER_ADMIN  > ADMIN  > USER
```

`SUPER_ADMIN` passes all `@Roles()` checks that include `SUPER_ADMIN`. Guards check membership, not hierarchy — a `SUPER_ADMIN` decorator on a resolver accepts only `SUPER_ADMIN`, not `ADMIN`. Multi-role decorators like `@Roles(Role.ADMIN, Role.SUPER_ADMIN)` explicitly include both.

### Account Lockout Mechanism

- On failed login: `User.failedLoginAttempts` is incremented.
- After 5 consecutive failures: `User.lockedUntil` is set to 15 minutes in the future.
- On locked account login: `UNAUTHENTICATED` error with remaining seconds.
- On successful login: `failedLoginAttempts` is reset to 0.

### Social Login Flow

**Google**:
1. Client obtains a Google OAuth access token (via Google Sign-In SDK).
2. Client calls `signInWithGoogle({ token })`.
3. Backend calls Google's `tokeninfo` and `userinfo` endpoints.
4. Backend verifies `aud === GOOGLE_CLIENT_ID`.
5. If `AuthProvider(provider="google", providerId=googleId)` exists → return tokens.
6. If not → create new `User` + `AuthProvider` → return tokens.

**Facebook**: Same flow using Facebook's Graph API endpoints.

### How Frontend Should Store and Send Tokens

**Storage recommendation**: Store `accessToken` in memory (JavaScript variable/state). Store `refreshToken` in an `HttpOnly; Secure; SameSite=Strict` cookie, or alternatively in `localStorage` (less secure but usable). **Never** store access tokens in `localStorage` if XSS is a concern.

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

1. Frontend calls `query products(paginationArgs, filterArgs)` — **no auth required**.
2. Response includes cursor-paginated `ProductConnection` with `pageInfo.hasNextPage`.
3. To load next page: call again with `after: lastCursor` from previous response.
4. Resolved fields (`discountedPrice`, `appliedDiscount`, `variants`, `reviews`) are fetched via DataLoader only when requested.
5. To view a single product: call `query product(productId)`.

### Add to Cart Flow

1. User must be authenticated.
2. Frontend calls `mutation addToCart(input: { productId, quantity })`.
3. Backend checks product exists and has sufficient stock.
4. If cart does not exist for user, it is created automatically.
5. If item already in cart, quantity is incremented.
6. Returns updated `Cart` with all items.

### Cart Update Flow

1. To change quantity: `mutation updateCartItem(input: { cartItemId, quantity })`. Setting `quantity: 0` removes the item.
2. To remove an item directly: `mutation removeFromCart(cartItemId)`.
3. To empty the cart: `mutation clearCart`.
4. To see cart with active discounts applied: `query cartWithDiscount`.

### Checkout Flow

1. User must have at least one saved address (`query userAddresses` or `mutation createAddress`).
2. Optionally validate coupon: `mutation validateCoupon(input: { code, orderTotal })`.
3. Create order: `mutation createOrder(input: { shippingAddressId, couponCode? })`.
4. Backend validates stock, applies tax, applies coupon → creates `Order` with `status = PENDING` → decrements inventory → clears cart → sends confirmation email.
5. Frontend receives `Order.id`.

### Order Placement Flow

1. Order is created (see Checkout Flow above).
2. Frontend initiates payment: `POST /payment/initialize` with `{ orderId, paymentMethod, currency }`.
3. Backend creates `Payment` record with `status = PENDING` and returns `authorizationUrl`.
4. Frontend redirects user to `authorizationUrl`.
5. After payment, Paystack redirects to `GET /payment/callback?reference=xxx`.
6. Frontend calls `mutation verifyPayment({ reference })` to confirm status.

### Payment Flow (Paystack)

See [Section 8](#8-payment-integration-paystack) for full details.

### Webhook Handling Flow

1. Paystack POSTs to `POST /payment/webhook`.
2. Backend verifies HMAC-SHA512 signature using `PAYSTACK_SECRET_KEY`.
3. On `charge.success`: payment `status → COMPLETED`, order `status → PROCESSING`, confirmation email sent.
4. On `charge.failed`: payment `status → FAILED`.
5. Always responds `200 OK` to Paystack (even for unhandled events).

### Inventory Deduction Flow

- On `createOrder`: for each order item, product/variant quantity is decremented atomically in a Prisma transaction. An `InventoryLog` record is created with `action = ORDER_DEDUCTION`.
- On `cancelOrder` or `deleteOrder`: stock is restored. `InventoryLog` with `action = RETURN_RESTORE` (or similar) is created.
- Low-stock check: cron job runs every 6 hours, logs warnings for products/variants at or below their `lowStockAlert` / `lowStockThreshold`.

### Return Request Flow

1. User submits: `mutation createReturnRequest(input: { orderId, reason })`. Order must be `DELIVERED`.
2. `ReturnRequest` created with `status = PENDING`.
3. Admin reviews: `mutation approveReturn(input: { returnRequestId, refundAmount, adminNote? })` → status → `APPROVED`.
4. Admin rejects: `mutation rejectReturn(input: { returnRequestId, adminNote? })` → status → `REJECTED`.
5. Admin processes refund (external): `mutation processRefund(returnRequestId)` → status → `REFUNDED`.

### Review Submission Flow

1. User must be authenticated with `USER` role.
2. Call `mutation createReview(input: { productId, score, comment? })`. `score` must be 1–5.
3. To update: `mutation updateReview(input: { reviewId, score?, comment? })`.
4. To delete: `mutation deleteReview(reviewId)` — soft-deletes the review.

---

## 7. Order Lifecycle

```
         createOrder()
              ↓
          PENDING ──────────────────────────────────────────────────────→ CANCELLED
              |                                                           (user or admin)
       Paystack webhook
       charge.success
              ↓
         PROCESSING ──────────────────────────────────────────────────→ CANCELLED
              |                                                           (admin only)
       updateOrderStatus(SHIPPED)
              ↓
           SHIPPED ──────────────────────────────────────────────────→ CANCELLED
              |                                                           (admin only)
       updateOrderStatus(DELIVERED)
              ↓
          DELIVERED
              |
       createReturnRequest()
              ↓
    ReturnRequest: PENDING → APPROVED → REFUNDED
                              |
                           REJECTED
```

### Status Transitions

| From | To | Trigger | Actor |
|---|---|---|---|
| *(none)* | `PENDING` | `createOrder` | USER |
| `PENDING` | `PROCESSING` | Paystack webhook `charge.success` | Webhook |
| `PENDING` | `CANCELLED` | `cancelOrder` | USER or ADMIN |
| `PROCESSING` | `SHIPPED` | `updateOrderStatus` | ADMIN |
| `PROCESSING` | `CANCELLED` | `updateOrderStatus` | ADMIN |
| `SHIPPED` | `DELIVERED` | `updateOrderStatus` | ADMIN |
| `SHIPPED` | `CANCELLED` | `updateOrderStatus` | ADMIN |
| `DELIVERED` | — | (can only trigger return) | USER |

**Note**: The service does not enforce these transition guards explicitly (no "state machine"); it will update status to any valid `OrderStatus` enum value when called by an admin. Only user-facing `cancelOrder` restricts to the user's own order.

---

## 8. Payment Integration (Paystack)

### Step-by-Step Payment Flow

```
Frontend                     Backend                      Paystack
   |                            |                             |
   |-- POST /payment/initialize → |                             |
   |   { orderId, paymentMethod, |                             |
   |     currency }              |                             |
   |                            |-- Paystack.transaction.initialize() →|
   |                            |← { authorizationUrl, reference } ----|
   |← { ...payment, authorizationUrl }                        |
   |                            |                             |
   |-- redirect to authorizationUrl ─────────────────────────→|
   |                            |                             |
   |                            |                   (user pays)
   |                            |                             |
   |                            |← POST /payment/webhook ------|
   |                            |   { event: "charge.success",|
   |                            |     data: { reference } }    |
   |                            |                             |
   |← GET /payment/callback?reference=xxx ────────────────────|
   |                            |                             |
   |-- mutation verifyPayment({ reference }) → |              |
   |← updated Payment with status: "COMPLETED" |              |
```

### Payment Initialization

**Endpoint**: `POST /payment/initialize`
**Auth**: Bearer token required.

The backend calls Paystack's `transaction.initialize` with:
- `email`: The order owner's email address.
- `amount`: `Order.totalAmount` (treated as the amount in the smallest currency unit by Paystack — verify this matches your currency configuration).
- `metadata`: includes `orderId`, `paymentMethod`, `currency`.

### Webhook Security

The webhook validates the Paystack signature:

```
HMAC-SHA512(rawBody, PAYSTACK_SECRET_KEY) === x-paystack-signature header
```

**Frontend note**: You do **not** call the webhook. It is server-to-server only.

### Events Handled

| Event | Action |
|---|---|
| `charge.success` | `Payment.status → COMPLETED`, `Order.status → PROCESSING` |
| `charge.failed` | `Payment.status → FAILED` |
| All others | Acknowledged (200 OK), ignored |

### Frontend Payment Confirmation Strategy

**Option A (recommended)**: After Paystack callback redirect, call `mutation verifyPayment({ reference })`. The mutation checks with Paystack directly and updates the payment record.

**Option B**: Poll `query payment(id)` every few seconds until `status !== "PENDING"` (max 3–5 polls with exponential backoff). This works because the webhook often fires before the user returns to the frontend.

**Option C**: Rely solely on the webhook — the order page can show the latest order status on load.

---

## 9. Inventory Rules

### When Stock Reduces

- `createOrder`: each `OrderItem.quantity` is deducted from `Product.quantity` (or `Variant.quantity` if variant is specified). This happens **at order creation time**, not at payment time.
- Logged with `InventoryAction.ORDER_DEDUCTION`.

### When Stock Restores

- `cancelOrder` or `deleteOrder`: all order item quantities are restored.
- `approveReturn`: restores stock for the returned items.
- Logged with `InventoryAction.RETURN_RESTORE`.
- Admin `restockProduct` / `restockVariant`: manual top-up. Logged with `InventoryAction.RESTOCK`.

### Out-of-Stock Handling

- `Product.stockStatus` can be: `IN_STOCK`, `OUT_OF_STOCK`, `PREORDER`, `BACKORDER`.
- `ProductFilterArgs.inStock` can filter out-of-stock products from listings.
- Adding to cart/creating an order enforces a stock check — throws `BAD_REQUEST` if insufficient.

### Low Stock Logic

- `Product.lowStockAlert` (default: 5): threshold for product-level low stock.
- `Variant.lowStockThreshold` (default: 5): threshold for variant-level low stock.
- A **cron job** runs every 6 hours (`EVERY_6_HOURS`) and logs warnings for items at or below their threshold.
- No automatic emails or notifications to users for low stock — only server-side logging.

### Reserved Stock

There is **no reserved/held stock** concept. Stock is decremented immediately on order creation. If a user abandons their order, stock is not automatically restored (only on explicit cancel).

---

## 10. Discounts System

### Discount vs. Coupon

| | Discount | Coupon |
|---|---|---|
| Scope | Product / Variant / Category | Order-level |
| Applied | Automatically (if active & date range valid) | User enters a code at checkout |
| Model | `Discount` | `Coupon` |
| Stacking | Discounts from different assignments can stack | One coupon per order |

### Discount Application

- A `Discount` must have `isActive = true` and current date must be within `[startDate, endDate]`.
- Discounts are M2M: a discount can apply to many products, variants, and categories simultaneously.
- On `cartWithDiscount` or on checkout, the discount service evaluates each cart item and applies the best matching discount.
- `DiscountType.PERCENTAGE`: `discountedPrice = price - (price × value / 100)`.
- `DiscountType.FLAT`: `discountedPrice = price - value`.
- `minimumPurchase`: the total cart value must meet or exceed this for the discount to apply.

### Coupon Logic

- Applied at `createOrder` time via `couponCode` parameter.
- Validation logic (enforced in `CouponsService.validateCoupon`):
  1. Coupon exists and `isActive = true`.
  2. Not expired (`expiresAt` is null or in the future).
  3. Usage limit not exceeded (`usedCount < usageLimit` or `usageLimit` is null).
  4. User has not already used this coupon (`CouponUsage` unique on `[couponId, userId]`).
  5. Order total ≥ `minimumOrderAmount`.
- Coupon discount is saved in `Order.couponDiscount` and a `CouponUsage` record is created.
- `Coupon.usedCount` is incremented on use.

### Stacking Rules

- Discounts and coupons can be combined (they are applied at different levels).
- Multiple product/variant/category discounts: only one discount is applied per cart item (the service applies the first matching discount, checking product first, then variant, then category).

---

## 11. Tax & Currency

### Tax Calculation

- Each country (and optionally region) has a `TaxRate` record with a `rate` (0.0–1.0).
- At `createOrder`, the shipping address's `country` is used to look up the applicable tax rate.
- For each taxable item (`Product.isTaxable = true`), the tax is calculated and added.
- Tax is factored into `Order.totalAmount`.

### Currency

Fixed exchange rates are hardcoded in `CurrencyService`:

```typescript
const RATES: Record<string, number> = {
  GHS: 1,       // Base currency
  USD: 0.068,
  EUR: 0.063,
  GBP: 0.053,
  NGN: 110,
};
```

Conversion formula:
```
converted = Math.round((amount / fromRate) * toRate * 100) / 100
```

Supported currencies: `GHS`, `USD`, `EUR`, `GBP`, `NGN`.

**Note**: These are static rates. There is no external rate feed integration.

### Rounding Strategy

`Math.round(...* 100) / 100` — rounds to 2 decimal places (standard banker's rounding approximation).

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
| `500 InternalServerError` | `INTERNAL_SERVER_ERROR` |

### Production vs. Development

In **production**: only errors with codes `BAD_USER_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `BAD_REQUEST` expose their real message. All other errors return `{ "message": "Internal server error", "extensions": { "code": "INTERNAL_SERVER_ERROR" } }`.

In **development**: full error details (including stack traces) are returned.

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

Products and Users use **cursor pagination** (relay-style). The cursor is the record's `id` (cuid string).

**`PaginationArgs`**:

```typescript
{
  first: number;       // Page size. Default 12. Min 1. Max 100.
  after?: string;      // Cursor: the ID of the last item from the previous page.
  orderBy?: string;    // Field name to sort by.
  orderInAsc?: boolean;// Default true (ascending).
}
```

**`PageInfo`**:

```typescript
{
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  pageSize: number;
}
```

### Fetching Subsequent Pages

```graphql
query {
  products(
    paginationArgs: { first: 12, after: "clx1234lastCursor" }
    filterArgs: { isActive: true }
  ) {
    edges {
      cursor
      node { id name price }
    }
    pageInfo {
      hasNextPage
      pageSize
    }
  }
}
```

### Sorting Options (Products)

`orderBy` accepts any `Product` field name (e.g., `"createdAt"`, `"price"`, `"name"`). `orderInAsc: true` for ascending, `false` for descending.

### Filtering Options per Resource

**Products** (`ProductFilterArgs`): `categoryId`, `categoryName`, `subCategoryName`, `subcategoryId`, `isActive` (default `true`), `search` (name/description/tags partial match), `createdAfter` (ISO date), `priceMin`, `priceMax`, `brand` (exact name), `inStock`, `tagId`, `tagName`.

**Users** (`UserPaginateArgs`): `email` (partial), `phoneNumber` (exact), `role`, `isActive`, `name` (partial), `createdAfter`.

**Other resources** (orders, reviews, returns, inventory logs) use simple flat queries without pagination args — they return full lists.

---

## 14. File Upload (Cloudinary)

### Upload Endpoints

Both endpoints are REST (not GraphQL).

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

Any image format accepted by `sharp` and Cloudinary (JPEG, PNG, WebP, GIF, etc.). The server resizes using `sharp` before uploading.

### Max Size

5 MB per file (enforced by Multer).

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

### Rate Limit

10 uploads per minute per user (`upload` throttler).

---

## 15. Notifications System

### Types of Notifications

All notifications are **email-only** via Resend. There are no in-app notifications, push notifications, or real-time subscriptions in this system.

| Trigger | Template | Recipient |
|---|---|---|
| User registers | Welcome email | New user |
| Order created | Order confirmation | Order owner |
| Order status → SHIPPED | Shipping update (with tracking number) | Order owner |
| Order status → DELIVERED | Delivery confirmation | Order owner |
| Payment webhook success | Payment confirmation | Order owner |
| `forgotPassword` called | Password reset link | Requesting user |

### Asynchronous

All emails fire asynchronously — they do **not** block the GraphQL response. Email failures are silently caught (logged but not propagated).

### No GraphQL Mutations for Notifications

There are no `markAsRead`, `getNotifications`, or notification subscription GraphQL operations. Notification state is purely email-based.

### Mark as Read

Not applicable — this system does not have in-app notification records.

---

## 16. Analytics Queries

All analytics are `ADMIN`/`SUPER_ADMIN` only.

### `salesReport(startDate, endDate)`

Returns aggregate sales data for the date range:

```typescript
{
  totalRevenue: Float;          // Sum of all order amounts in the period
  orderCount: number;           // Count of orders in the period
  averageOrderValue: Float;     // totalRevenue / orderCount
}
```

### `topProducts(limit?)`

Returns best-selling products by quantity, descending:

```typescript
[{
  productId: string;
  productName: string;
  totalQuantitySold: number;
  totalRevenue: Float;
}]
```

Default `limit`: 10. Max: 100.

### `revenueByCategory()`

Returns revenue grouped by category:

```typescript
[{
  categoryId?: string;
  categoryName?: string;
  totalRevenue: Float;
  orderCount: number;
}]
```

### `dashboardSummary()`

Snapshot of key admin metrics:

```typescript
{
  totalUsers: number;
  ordersToday: number;
  revenueToday: Float;
  lowStockProductCount: number;
  lowStockVariantCount: number;
}
```

---

## 17. Environment Variables Required

### Database

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |

### Server

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | ❌ | `3000` | HTTP port |
| `NODE_ENV` | ❌ | `development` | `development`, `production`, `test` |
| `ALLOWED_ORIGINS` | ❌ | See note | Comma-separated allowed CORS origins. Required in production. |

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
| `PAYSTACK_CALLBACK_URL` | ❌ | Redirect URL after payment completion |

### Cloudinary

| Variable | Required | Description |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` | ✅ | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | ✅ | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | ✅ | Cloudinary API secret |

### Redis (optional)

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_HOST` | ❌ | — | Redis host. Falls back to in-memory if absent. |
| `REDIS_PORT` | ❌ | `6379` | Redis port |
| `REDIS_PASSWORD` | ❌ | — | Redis password |

### Email (Resend)

| Variable | Required | Description |
|---|---|---|
| `RESEND_API_KEY` | ❌ | Resend API key. Emails silently fail if absent. |
| `RESEND_FROM_EMAIL` | ❌ | Sender email address |

### Logging

| Variable | Required | Default | Options |
|---|---|---|---|
| `LOG_LEVEL` | ❌ | `info` | `error`, `warn`, `info`, `debug` |

### Tracing (OpenTelemetry)

| Variable | Required | Default | Description |
|---|---|---|---|
| `OTEL_ENABLED` | ❌ | `false` | Set to `"true"` to enable |
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
import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client';
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
    // Attempt token refresh, then retry
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
2. Store `refreshToken` in `localStorage` or `HttpOnly` cookie.
3. On Apollo error with `UNAUTHENTICATED`:
   - Call `mutation refreshToken({ refreshToken })`.
   - On success: update in-memory `accessToken`, store new `refreshToken`, retry original operation.
   - On failure: redirect to login page, clear all stored tokens.
4. On app load: if `refreshToken` exists, call the refresh mutation to restore session.

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
// 1. Initialize payment (REST)
const { authorizationUrl, id: paymentId } = await fetch('/payment/initialize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ orderId, paymentMethod: 'card', currency: 'GHS' }),
}).then(r => r.json());

// 2. Store paymentId/reference for later verification
sessionStorage.setItem('pendingReference', reference);

// 3. Redirect user
window.location.href = authorizationUrl;

// 4. On callback page (after redirect back)
const reference = new URLSearchParams(location.search).get('reference');
const { data } = await client.mutate({
  mutation: VERIFY_PAYMENT,
  variables: { verifyPaymentInput: { reference } },
});
if (data.verifyPayment.status === 'COMPLETED') {
  // Show success, navigate to order confirmation
}
```

### When to Refetch Queries

| Action | Refetch |
|---|---|
| `addToCart`, `updateCartItem`, `removeFromCart` | `cart` query (or use Apollo cache update) |
| `createOrder` | `userOrders`, `cart` (should be empty) |
| `cancelOrder` | `userOrders`, `order(orderId)` |
| `verifyPayment` | `payment(id)`, `order(orderId)` |
| `createReturnRequest` | `myReturnRequests` |
| `addToWishlist`, `removeFromWishlist` | `wishlist` |
| `createAddress` | `userAddresses` |

### Cache Invalidation Strategy

Use Apollo's `refetchQueries` or `cache.evict` / `cache.gc` explicitly. Key queries to invalidate:

```typescript
// After cart mutations
refetchQueries: [{ query: CART_QUERY }]

// After order creation
refetchQueries: [{ query: USER_ORDERS_QUERY }, { query: CART_QUERY }]

// After product updates (admin)
refetchQueries: [{ query: PRODUCTS_QUERY }]
```

### Recommended State Management

- **Auth state**: Zustand or Redux Toolkit (access token in memory, refresh in localStorage).
- **Cart state**: Apollo InMemoryCache (single source of truth, driven by `cart` query).
- **UI state**: Local component state or Zustand.

### GraphQL Fragment Suggestions

```graphql
fragment ProductSummary on Product {
  id name price currentPrice discountedPrice currency isActive
  images quantity categoryId
  category { id name }
  brand { id name logo }
}

fragment CartItemFull on CartItem {
  id productId quantity originalPrice discountedPrice
  product { id name images price currency }
  variant { id size color price quantity }
}

fragment OrderSummary on Order {
  id status totalAmount couponDiscount createdAt
  items { id quantity priceAtOrder product { id name } }
}

fragment AuthTokens on AuthEntity {
  accessToken refreshToken
}
```

### Suggested TypeScript Shared Types

```typescript
// Enums (mirror Prisma/GraphQL enums exactly)
export type Role = 'USER' | 'ADMIN' | 'SUPER_ADMIN';
export type OrderStatus = 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'COMPLETED' | 'FAILED';
export type DiscountType = 'PERCENTAGE' | 'FLAT';
export type ReturnStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REFUNDED';
export type InventoryAction = 'RESTOCK' | 'ORDER_DEDUCTION' | 'RETURN_RESTORE' | 'ADJUSTMENT';
export type Currency = 'GHS' | 'USD' | 'EUR' | 'GBP' | 'NGN';
export type StockStatus = 'IN_STOCK' | 'OUT_OF_STOCK' | 'PREORDER' | 'BACKORDER';
export type ProductStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

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

*Action*: Store both tokens. A welcome email is sent asynchronously.

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
    filterArgs: { isActive: true, categoryName: "Electronics" }
  ) {
    edges {
      cursor
      node {
        id
        name
        price
        discountedPrice
        images
        currency
        brand { name }
        category { id name }
      }
    }
    pageInfo {
      hasNextPage
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
    id name description price currentPrice
    discountedPrice appliedDiscount { name type value }
    images sku quantity stockStatus
    variants { id size color price quantity }
    reviews { score comment user { displayName } }
    category { id name }
    brand { id name }
  }
}
```

---

### Step 5 — Create Address (if first time)

```http
Authorization: Bearer <accessToken>
```

```graphql
mutation {
  createAddress(input: {
    street: "123 Main Street"
    city: "Accra"
    state: "Greater Accra"
    zipCode: "GA-123-4567"
    country: "Ghana"
  }) {
    id street city state zipCode country
  }
}
```

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
      id productId quantity originalPrice discountedPrice
      product { name images }
    }
    total discountTotal finalTotal
  }
}
```

---

### Step 7 — View Cart with Discounts

```graphql
query {
  cartWithDiscount {
    id total discountTotal finalTotal
    items {
      id quantity originalPrice discountedPrice
      product { name }
      appliedDiscount { name type value }
    }
  }
}
```

---

### Step 8 — Validate Coupon

```graphql
mutation {
  validateCoupon(input: {
    code: "SAVE10"
    orderTotal: 59.98
  }) {
    valid
    discountAmount
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
      "discountAmount": 5.998,
      "message": "Coupon applied. You save 5.998."
    }
  }
}
```

---

### Step 9 — Create Order

```graphql
mutation {
  createOrder(input: {
    shippingAddressId: "clx_address_xyz"
    couponCode: "SAVE10"
  }) {
    id status totalAmount couponDiscount
    items {
      id quantity priceAtOrder
      product { name }
    }
  }
}
```

**Response**:
```json
{
  "data": {
    "createOrder": {
      "id": "clx_order_789",
      "status": "PENDING",
      "totalAmount": 53.98,
      "couponDiscount": 5.998,
      "items": [...]
    }
  }
}
```

*Side effects*: inventory decremented, cart cleared, confirmation email sent.

---

### Step 10 — Initialize Payment (REST)

```http
POST /payment/initialize
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "orderId": "clx_order_789",
  "paymentMethod": "card",
  "currency": "GHS"
}
```

**Response**:
```json
{
  "id": "pay_xyz",
  "orderId": "clx_order_789",
  "amount": 53.98,
  "status": "PENDING",
  "authorizationUrl": "https://checkout.paystack.com/pay_ref_abc"
}
```

*Action*: Redirect user to `authorizationUrl`.

---

### Step 11 — User Pays on Paystack

User completes payment. Paystack fires webhook to `POST /payment/webhook` → backend marks payment `COMPLETED`, order → `PROCESSING`.

Paystack redirects user back to `GET /payment/callback?reference=pay_ref_abc`.

---

### Step 12 — Frontend Confirms Payment

```graphql
mutation {
  verifyPayment(verifyPaymentInput: {
    reference: "pay_ref_abc"
  }) {
    id status amount currency
    order {
      id status totalAmount
    }
  }
}
```

**Response**:
```json
{
  "data": {
    "verifyPayment": {
      "id": "pay_xyz",
      "status": "COMPLETED",
      "amount": 53.98,
      "order": {
        "id": "clx_order_789",
        "status": "PROCESSING"
      }
    }
  }
}
```

---

### Step 13 — User Receives Order (Admin updates status)

Admin calls:
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

*Documentation generated from source code — April 2026.*
