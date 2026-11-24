import { NotificationCategory, NotificationChannel } from '../../generated/prisma/client';
import { clip, escapeHtml, formatMoney, markup, SMS_MAX_LENGTH, SMS_SEGMENT_LENGTH } from './render';
import {
  renderEmail,
  renderInApp,
  renderSms,
  templateChannels,
  templateDefinition,
  TemplateData,
  templateKeys,
} from './templates';

const SCRIPT = '<script>alert("x")</script>';
const ESCAPED_SCRIPT = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';
const PHISHING_LINK = `<a href='https://evil.example'>Verify</a>`;

const PLACED: TemplateData['order.placed'] = {
  orderNumber: 10042,
  currency: 'GHS',
  lines: [{ productName: 'Kente scarf', quantity: 2, lineTotal: '240' }],
  shippingTotal: '15.00',
  discountTotal: '0.00',
  grandTotal: '1255.5',
  cashOnDelivery: false,
};

const REFUND: TemplateData['refund.processed'] = {
  orderNumber: 10042,
  amount: '108.33',
  currency: 'GHS',
  reasonLabel: 'Item arrived damaged',
  lines: [{ productName: 'Kente scarf', quantity: 2 }],
  includesShipping: true,
};

const PICKUP: TemplateData['shipment.ready_for_pickup'] = {
  orderNumber: 10042,
  pickupName: 'Osu Store',
  address: '12 Oxford St, Accra',
  hours: 'Mon-Fri 08:00-17:00',
  contactPhone: '+233302000000',
  instructions: 'Ask at the front desk',
};

describe('render helpers', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml(120.5)).toBe('120.5');
  });

  it('escapes every interpolated value of `markup` but keeps nested `markup` markup', () => {
    const inner = markup`<b>${SCRIPT}</b>`;
    expect(markup`<p>${SCRIPT}${inner}${null}${false}${[1, markup`<i>2</i>`]}</p>`.value).toBe(
      `<p>${ESCAPED_SCRIPT}<b>${ESCAPED_SCRIPT}</b>1<i>2</i></p>`,
    );
  });

  it('formats money as GHS with two decimals and thousands separators', () => {
    expect(formatMoney('1255.5')).toBe('GHS 1,255.50');
    expect(formatMoney(0)).toBe('GHS 0.00');
    expect(formatMoney('1234567.899', 'GHS')).toBe('GHS 1,234,567.90');
  });

  it('clips free text with an ellipsis and flattens whitespace', () => {
    expect(clip('Osu  Store\n', 20)).toBe('Osu Store');
    expect(clip('a'.repeat(30), 10)).toBe('aaaaaaa...');
  });
});

describe('email templates', () => {
  it('escapes a <script> in the welcome name and renders a link-shaped name as text', () => {
    const script = renderEmail('account.welcome', { name: SCRIPT });
    expect(script.html).toContain(ESCAPED_SCRIPT);
    expect(script.html).not.toContain('<script>');

    const link = renderEmail('account.welcome', { name: PHISHING_LINK }).html;
    expect(link).not.toContain('<a ');
    expect(link).toContain('&lt;a href=&#39;https://evil.example&#39;&gt;Verify&lt;/a&gt;');
  });

  it.each([
    [
      'order placed (product)',
      () => renderEmail('order.placed', { ...PLACED, lines: [{ ...PLACED.lines[0], productName: SCRIPT }] }),
    ],
    [
      'order update (status)',
      () => renderEmail('order.updated', { orderNumber: 1, status: SCRIPT, trackingNumber: null }),
    ],
    [
      'order update (tracking)',
      () => renderEmail('order.updated', { orderNumber: 1, status: 'SHIPPED', trackingNumber: SCRIPT }),
    ],
    ['shipment dispatched', () => renderEmail('shipment.dispatched', { orderNumber: 1, trackingNumber: SCRIPT })],
    [
      'out for delivery',
      () =>
        renderEmail('shipment.out_for_delivery', {
          orderNumber: 1,
          carrier: SCRIPT,
          trackingNumber: SCRIPT,
          deliveryCode: null,
        }),
    ],
    ['ready for pickup', () => renderEmail('shipment.ready_for_pickup', { ...PICKUP, instructions: SCRIPT })],
    [
      'refund (line)',
      () => renderEmail('refund.processed', { ...REFUND, lines: [{ productName: SCRIPT, quantity: 1 }] }),
    ],
    ['refund (reason)', () => renderEmail('refund.processed', { ...REFUND, reasonLabel: SCRIPT })],
    ['password reset', () => renderEmail('account.password_reset', { resetUrl: SCRIPT, expiresInMinutes: 15 })],
    [
      'email verification',
      () => renderEmail('account.email_verification', { verificationToken: SCRIPT, expiresInHours: 24 }),
    ],
    ['email change notice', () => renderEmail('account.email_change_requested', { maskedNewEmail: SCRIPT })],
    [
      'low-stock digest',
      () =>
        renderEmail('inventory.low_stock_digest', {
          sections: [{ locationName: SCRIPT, items: [{ productName: PHISHING_LINK, sku: SCRIPT, available: 1 }] }],
        }),
    ],
  ])('escapes interpolated values in the %s template', (_name, render) => {
    const { html: body } = render();
    expect(body).toContain(ESCAPED_SCRIPT);
    expect(body).not.toContain('<script>');
    expect(body).not.toContain("<a href='https://evil");
  });

  it('shows orders by order number and money in GHS with two decimals, never the order id or a raw number', () => {
    const placed = renderEmail('order.placed', PLACED);
    expect(placed.subject).toBe('Order #10042 received');
    expect(placed.html).toContain('GHS 1,255.50');
    expect(placed.html).toContain('2 × Kente scarf');
    expect(placed.html).toContain('GHS 240.00');
    expect(placed.html).toContain('Delivery');
    expect(placed.html).not.toContain('Discount');
    expect(placed.text).toContain('Total: GHS 1,255.50');

    const paid = renderEmail('payment.received', { orderNumber: 10042, amount: '99.9', currency: 'GHS' });
    expect(paid.subject).toBe('Payment received for order #10042');
    expect(paid.text).toContain('GHS 99.90');
  });

  it('lists the refunded amount, reason, units and delivery fee', () => {
    const { html: body, text } = renderEmail('refund.processed', REFUND);
    expect(body).toContain('GHS 108.33');
    expect(body).toContain('Reason: Item arrived damaged');
    expect(body).toContain('<li>2 × Kente scarf</li><li>Delivery fee</li>');
    expect(text).toContain('- Delivery fee');
  });

  it('lists the low-stock digest by location, one row per variant with its available stock', () => {
    const { subject, html: body } = renderEmail('inventory.low_stock_digest', {
      sections: [
        { locationName: 'Kumasi', items: [{ productName: 'Kente scarf', sku: 'KS-1', available: 0 }] },
        { locationName: 'Main store', items: [{ productName: 'Shea butter', sku: 'SB-2', available: 3 }] },
      ],
    });
    expect(subject).toBe('Low stock: 2 variants');
    expect(body).toContain('<h2>Kumasi</h2>');
    expect(body).toContain('<tr><td>Kente scarf</td><td>KS-1</td><td>0</td></tr>');
    expect(body.indexOf('Kumasi')).toBeLessThan(body.indexOf('Main store'));
    expect(body).toContain('<tr><td>Shea butter</td><td>SB-2</td><td>3</td></tr>');
  });

  it('sends a reset link (not a bare token) with a do-nothing-if-not-you line', () => {
    const { html: body, text } = renderEmail('account.password_reset', {
      resetUrl: 'https://shop.example.com/reset-password#token=abc',
      expiresInMinutes: 15,
    });
    expect(body).toContain('<a href="https://shop.example.com/reset-password#token=abc">');
    expect(text).toContain('https://shop.example.com/reset-password#token=abc');
    expect(text).toContain('If you did not ask for this');
  });

  it('gives every email a plain-text part', () => {
    expect(renderEmail('order.completed', { orderNumber: 7 }).text).toContain('Your order #7 is complete');
  });
});

describe('SMS templates', () => {
  it('keep the existing texts', () => {
    expect(renderSms('account.phone_otp', { code: '123456', expiresInMinutes: 10 })).toBe(
      '123456 is your verification code. It expires in 10 minutes. Never share it with anyone.',
    );
    expect(
      renderSms('shipment.out_for_delivery', {
        orderNumber: 1042,
        carrier: 'DHL',
        trackingNumber: 'T1',
        deliveryCode: null,
      }),
    ).toBe('Your order #1042 is out for delivery with DHL. Tracking number: T1.');
    expect(
      renderSms('shipment.out_for_delivery', {
        orderNumber: 1042,
        carrier: null,
        trackingNumber: null,
        deliveryCode: null,
      }),
    ).toBe('Your order #1042 is out for delivery.');
    expect(
      renderSms('shipment.out_for_delivery', {
        orderNumber: 5,
        carrier: null,
        trackingNumber: null,
        deliveryCode: '004211',
      }),
    ).toBe('Your order #5 is out for delivery. Give the rider this code when you receive it: 004211.');
    expect(renderSms('shipment.delivered', { orderNumber: 1042 })).toBe(
      'Your order #1042 has been delivered. Thank you for shopping with us.',
    );
    expect(renderSms('shipment.ready_for_pickup', PICKUP)).toBe(
      'Order #10042 is ready for pickup at Osu Store, 12 Oxford St, Accra. Open: Mon-Fri 08:00-17:00.',
    );
  });

  it('fit one segment for typical values and never exceed two, even with the longest free text', () => {
    const long = 'x'.repeat(500);
    const typical = [
      renderSms('account.phone_otp', { code: '123456', expiresInMinutes: 10 }),
      renderSms('shipment.delivered', { orderNumber: 1234567 }),
      renderSms('shipment.out_for_delivery', {
        orderNumber: 1234567,
        carrier: 'DHL',
        trackingNumber: 'TRK123',
        deliveryCode: '123456',
      }),
    ];
    for (const text of typical) expect(text.length).toBeLessThanOrEqual(SMS_SEGMENT_LENGTH);

    const worst = [
      renderSms('shipment.ready_for_pickup', {
        ...PICKUP,
        orderNumber: 99999999,
        pickupName: long,
        address: long,
        hours: long,
      }),
      renderSms('shipment.out_for_delivery', {
        orderNumber: 99999999,
        carrier: long,
        trackingNumber: long,
        deliveryCode: '123456',
      }),
    ];
    for (const text of worst) expect(text.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it('render plain text: no HTML escaping', () => {
    expect(renderSms('shipment.delivered', { orderNumber: 1 })).not.toContain('&');
    expect(renderSms('shipment.ready_for_pickup', { ...PICKUP, pickupName: 'Tom & Jerry' })).toContain('Tom & Jerry');
  });

  it('refuse a channel the template has no variant for', () => {
    expect(() => renderSms('order.completed', { orderNumber: 1 })).toThrow('has no SMS variant');
    expect(() => renderEmail('account.phone_otp', { code: '1', expiresInMinutes: 1 })).toThrow('has no EMAIL variant');
  });
});

describe('in-app templates', () => {
  it('give a short plain title and body', () => {
    expect(renderInApp('refund.processed', REFUND)).toEqual({
      title: 'Refund sent',
      body: 'We refunded GHS 108.33 for order #10042.',
    });
    expect(renderInApp('shipment.ready_for_pickup', { ...PICKUP, pickupName: '<b>Osu</b>' }).body).toContain(
      '<b>Osu</b>',
    );
  });
});

describe('registry', () => {
  it('versions every template, gives it a category and at least one channel in English', () => {
    for (const key of templateKeys()) {
      const definition = templateDefinition(key);
      expect(definition.version).toBeGreaterThanOrEqual(1);
      expect(Object.values(NotificationCategory)).toContain(definition.category);
      expect(templateChannels(key).length).toBeGreaterThan(0);
    }
  });

  it('keeps account codes and order updates transactional', () => {
    for (const key of ['account.phone_otp', 'account.password_reset', 'order.placed', 'refund.processed'] as const) {
      expect(templateDefinition(key).category).toBe(NotificationCategory.TRANSACTIONAL);
    }
    expect(templateChannels('order.placed')).toEqual([NotificationChannel.EMAIL, NotificationChannel.IN_APP]);
  });
});
