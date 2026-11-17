const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

export function welcomeEmailHtml(name: string): string {
  return `<h1>Welcome${name ? `, ${escapeHtml(name)}` : ''}!</h1><p>Thanks for joining Emma Commerce. Start shopping today.</p>`;
}

export function orderConfirmationEmailHtml(orderId: string, totalAmount: number): string {
  return `<h1>Order Confirmed</h1><p>Your order <strong>#${escapeHtml(orderId)}</strong> has been placed successfully. Total: <strong>${escapeHtml(totalAmount)}</strong>.</p>`;
}

export function orderStatusEmailHtml(orderId: string, status: string, trackingNumber?: string): string {
  const tracking = trackingNumber ? `<p>Tracking number: <strong>${escapeHtml(trackingNumber)}</strong></p>` : '';
  return `<h1>Order Update</h1><p>Your order <strong>#${escapeHtml(orderId)}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>${tracking}`;
}

export function paymentConfirmationEmailHtml(orderId: string, amount: number): string {
  return `<h1>Payment Confirmed</h1><p>We received your payment of <strong>${escapeHtml(amount)}</strong> for order <strong>#${escapeHtml(orderId)}</strong>.</p>`;
}

export function passwordResetEmailHtml(resetToken: string): string {
  return `<h1>Password Reset</h1><p>Use the token below to reset your password. It expires in 15 minutes.</p><p><strong>${escapeHtml(resetToken)}</strong></p>`;
}

export function emailVerificationEmailHtml(verificationToken: string, expiresInHours: number): string {
  return `<h1>Confirm your email address</h1><p>Use the token below to confirm this email address for your Emma Commerce account. It expires in ${escapeHtml(expiresInHours)} hours.</p><p><strong>${escapeHtml(verificationToken)}</strong></p><p>If you did not request this, you can ignore this email.</p>`;
}

export function emailChangeRequestedEmailHtml(maskedNewEmail: string): string {
  return `<h1>Email change requested</h1><p>Someone asked to change the email address of your Emma Commerce account to <strong>${escapeHtml(maskedNewEmail)}</strong>. The change takes effect only once the new address is confirmed.</p><p>If this was not you, reset your password now and contact support.</p>`;
}
