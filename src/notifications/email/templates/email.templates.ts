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

export function orderConfirmationEmailHtml(orderId: string, totalAmount: string): string {
  return `<h1>Order Confirmed</h1><p>Your order <strong>#${escapeHtml(orderId)}</strong> has been placed successfully. Total: <strong>${escapeHtml(totalAmount)}</strong>.</p>`;
}

export function orderStatusEmailHtml(orderId: string, status: string, trackingNumber?: string): string {
  const tracking = trackingNumber ? `<p>Tracking number: <strong>${escapeHtml(trackingNumber)}</strong></p>` : '';
  return `<h1>Order Update</h1><p>Your order <strong>#${escapeHtml(orderId)}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>${tracking}`;
}

export interface ReadyForPickupEmail {
  orderNumber: number;
  pickupName: string;
  address: string;
  hours: string;
  contactPhone: string | null;
  instructions: string | null;
}

export function readyForPickupEmailHtml(notice: ReadyForPickupEmail): string {
  const contact = notice.contactPhone ? `<p>Questions? Call ${escapeHtml(notice.contactPhone)}.</p>` : '';
  const instructions = notice.instructions ? `<p>${escapeHtml(notice.instructions)}</p>` : '';
  return (
    `<h1>Ready for pickup</h1><p>Your order <strong>#${escapeHtml(notice.orderNumber)}</strong> is ready to collect at ` +
    `<strong>${escapeHtml(notice.pickupName)}</strong>, ${escapeHtml(notice.address)}.</p>` +
    `<p>Opening hours: ${escapeHtml(notice.hours)}</p>${instructions}${contact}` +
    `<p>Bring your order number #${escapeHtml(notice.orderNumber)}.</p>`
  );
}

export function paymentConfirmationEmailHtml(orderId: string, amount: string): string {
  return `<h1>Payment Confirmed</h1><p>We received your payment of <strong>${escapeHtml(amount)}</strong> for order <strong>#${escapeHtml(orderId)}</strong>.</p>`;
}

export interface RefundEmail {
  amount: string;
  currency: string;
  reasonLabel: string;
  lines: { productName: string; quantity: number }[];
  includesShipping: boolean;
}

export function refundEmailHtml(orderId: string, refund: RefundEmail): string {
  const items = [
    ...refund.lines.map((line) => `${escapeHtml(line.quantity)} × ${escapeHtml(line.productName)}`),
    ...(refund.includesShipping ? ['Delivery fee'] : []),
  ];
  const list = items.length > 0 ? `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '';
  return `<h1>Refund Sent</h1><p>We refunded <strong>${escapeHtml(refund.currency)} ${escapeHtml(refund.amount)}</strong> for order <strong>#${escapeHtml(orderId)}</strong>.</p><p>Reason: ${escapeHtml(refund.reasonLabel)}</p>${list}`;
}

export interface LowStockDigestSection {
  locationName: string;
  items: { productName: string; sku: string; available: number }[];
}

export function lowStockDigestEmailHtml(sections: LowStockDigestSection[]): string {
  const body = sections
    .map((section) => {
      const rows = section.items
        .map(
          (item) =>
            `<tr><td>${escapeHtml(item.productName)}</td><td>${escapeHtml(item.sku)}</td><td>${escapeHtml(item.available)}</td></tr>`,
        )
        .join('');
      return `<h2>${escapeHtml(section.locationName)}</h2><table><tr><th>Product</th><th>SKU</th><th>Available</th></tr>${rows}</table>`;
    })
    .join('');
  return `<h1>Low stock</h1><p>These variants went low since the last digest and are still at or below their low-stock level.</p>${body}`;
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
