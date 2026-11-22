import {
  emailChangeRequestedEmailHtml,
  emailVerificationEmailHtml,
  escapeHtml,
  lowStockDigestEmailHtml,
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

  it('lists the low-stock digest by location, one row per variant with its available stock', () => {
    const html = lowStockDigestEmailHtml([
      { locationName: 'Kumasi', items: [{ productName: 'Kente scarf', sku: 'KS-1', available: 0 }] },
      { locationName: 'Main store', items: [{ productName: 'Shea butter', sku: 'SB-2', available: 3 }] },
    ]);

    expect(html).toContain('<h2>Kumasi</h2>');
    expect(html).toContain('<tr><td>Kente scarf</td><td>KS-1</td><td>0</td></tr>');
    expect(html.indexOf('Kumasi')).toBeLessThan(html.indexOf('Main store'));
    expect(html).toContain('<tr><td>Shea butter</td><td>SB-2</td><td>3</td></tr>');
  });

  it('escapes product, SKU and location names in the low-stock digest', () => {
    const html = lowStockDigestEmailHtml([
      { locationName: SCRIPT, items: [{ productName: PHISHING_LINK, sku: SCRIPT, available: 1 }] },
    ]);

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a href=');
    expect(html).toContain(ESCAPED_SCRIPT);
  });
});
