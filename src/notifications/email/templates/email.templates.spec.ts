import {
  emailChangeRequestedEmailHtml,
  emailVerificationEmailHtml,
  escapeHtml,
  orderConfirmationEmailHtml,
  orderStatusEmailHtml,
  passwordResetEmailHtml,
  paymentConfirmationEmailHtml,
  refundEmailHtml,
  welcomeEmailHtml,
} from './email.templates';

const SCRIPT = '<script>alert("x")</script>';
const ESCAPED_SCRIPT = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';
const PHISHING_LINK = `<a href='https://evil.example'>Verify</a>`;

describe('email templates', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml(120.5)).toBe('120.5');
  });

  it('escapes a <script> in the welcome name', () => {
    const html = welcomeEmailHtml(SCRIPT);

    expect(html).toContain(ESCAPED_SCRIPT);
    expect(html).not.toContain('<script>');
  });

  it('renders a link-shaped name as text, not a link', () => {
    const html = welcomeEmailHtml(PHISHING_LINK);

    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;a href=&#39;https://evil.example&#39;&gt;Verify&lt;/a&gt;');
  });

  it.each([
    ['order confirmation', orderConfirmationEmailHtml(SCRIPT, '10.00')],
    ['order status (id)', orderStatusEmailHtml(SCRIPT, 'SHIPPED')],
    ['order status (status)', orderStatusEmailHtml('order-1', SCRIPT)],
    ['order status (tracking number)', orderStatusEmailHtml('order-1', 'SHIPPED', SCRIPT)],
    ['payment confirmation', paymentConfirmationEmailHtml(SCRIPT, '10.00')],
    [
      'refund (id)',
      refundEmailHtml(SCRIPT, {
        amount: '1.00',
        currency: 'GHS',
        reasonLabel: 'Other',
        lines: [],
        includesShipping: false,
      }),
    ],
    [
      'refund (line)',
      refundEmailHtml('order-1', {
        amount: '1.00',
        currency: 'GHS',
        reasonLabel: 'Other',
        lines: [{ productName: SCRIPT, quantity: 1 }],
        includesShipping: false,
      }),
    ],
    ['password reset', passwordResetEmailHtml(SCRIPT)],
    ['email verification', emailVerificationEmailHtml(SCRIPT, 24)],
    ['email change notice', emailChangeRequestedEmailHtml(SCRIPT)],
  ])('escapes interpolated values in the %s template', (_name, html) => {
    expect(html).toContain(ESCAPED_SCRIPT);
    expect(html).not.toContain('<script>');
  });

  it('lists the refunded amount, reason, units and delivery fee', () => {
    const html = refundEmailHtml('order-1', {
      amount: '108.33',
      currency: 'GHS',
      reasonLabel: 'Item arrived damaged',
      lines: [{ productName: 'Kente scarf', quantity: 2 }],
      includesShipping: true,
    });

    expect(html).toContain('GHS 108.33');
    expect(html).toContain('Reason: Item arrived damaged');
    expect(html).toContain('<li>2 × Kente scarf</li><li>Delivery fee</li>');
  });
});
