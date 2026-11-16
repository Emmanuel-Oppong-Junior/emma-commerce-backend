export function welcomeEmailHtml(name: string): string {
  return `<h1>Welcome${name ? `, ${name}` : ''}!</h1><p>Thanks for joining Emma Commerce. Start shopping today.</p>`;
}

export function orderConfirmationEmailHtml(orderId: string, totalAmount: number): string {
  return `<h1>Order Confirmed</h1><p>Your order <strong>#${orderId}</strong> has been placed successfully. Total: <strong>${totalAmount}</strong>.</p>`;
}

export function orderStatusEmailHtml(orderId: string, status: string, trackingNumber?: string): string {
  const tracking = trackingNumber ? `<p>Tracking number: <strong>${trackingNumber}</strong></p>` : '';
  return `<h1>Order Update</h1><p>Your order <strong>#${orderId}</strong> is now <strong>${status}</strong>.</p>${tracking}`;
}

export function paymentConfirmationEmailHtml(orderId: string, amount: number): string {
  return `<h1>Payment Confirmed</h1><p>We received your payment of <strong>${amount}</strong> for order <strong>#${orderId}</strong>.</p>`;
}

export function passwordResetEmailHtml(resetToken: string): string {
  return `<h1>Password Reset</h1><p>Use the token below to reset your password. It expires in 15 minutes.</p><p><strong>${resetToken}</strong></p>`;
}
