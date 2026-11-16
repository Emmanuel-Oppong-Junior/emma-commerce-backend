# ADR-0015 — Notifications

Status: **Proposed** · Date: 2026-11-16

## Context
Email is the only channel today. It is sent through Resend, fire-and-forget on the request path:
- **Errors are ignored:** Resend returns `{error}` instead of throwing, and the code never checks it (NOT-01).
- **No retries** (NOT-03).
- **Payment confirmation never sent:** it has no callers (NOT-05).
- **Unescaped templates:** template HTML is not escaped, which allows phishing (SEC-02).

SMS is the most reliable channel in Ghana and WhatsApp is widely used. The research notes cover SMS gateways (Hubtel, mNotify, Arkesel; sender ID registration) and WhatsApp Business API access through BSPs.

## Recommendation
- **`NotificationService.notify(recipient, templateKey, data)`.** It writes a `Notification` row inside the business transaction, through the outbox (ADR-0009). Channel workers render and send it, with retries and a dead-letter queue, and record the provider message ID and status. Delivery webhooks update the status.
- **Channels sit behind ports:** email (Resend), SMS (Hubtel or mNotify, chosen on price and sender-ID support), WhatsApp (via a BSP, template messages) and in-app (a `Notification` feed queried by the user).
- **Templates** are versioned, localised (en, later Twi), auto-escaped (e.g. MJML/Handlebars with escaping), and include an SMS variant within 160/306 characters.
- **Preferences:** `NotificationPreference(userId, category, channel, enabled)`. Transactional messages (OTP, receipts, delivery) cannot be switched off; marketing needs explicit opt-in (Act 843).
- **Phone verification by OTP** is required before COD orders (fraud control) and before SMS marketing.

## Reversibility
Cheap.
