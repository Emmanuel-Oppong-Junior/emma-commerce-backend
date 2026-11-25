import { NotificationCategory, NotificationChannel } from '../../generated/prisma/client';
import { withDeliveryCode } from '../../delivery/code/delivery-code';
import { clip, formatMoney, markup, SafeHtml, SMS_MAX_LENGTH } from './render';

export type Locale = 'en';
export const DEFAULT_LOCALE: Locale = 'en';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface InAppContent {
  title: string;
  body: string;
}

export interface ReadyForPickupNotice {
  orderNumber: number;
  pickupName: string;
  address: string;
  hours: string;
  contactPhone: string | null;
  instructions: string | null;
}

export interface LowStockDigestSection {
  locationName: string;
  items: { productName: string; sku: string; available: number }[];
}

export interface OrderReceiptLine {
  productName: string;
  quantity: number;
  /** What the line cost, as a decimal string. */
  lineTotal: string;
}

/** The data each template renders. Amounts are decimal strings in `currency`; orders go by their order number. */
export interface TemplateData {
  'account.welcome': { name: string | null };
  'account.email_verification': { verificationToken: string; expiresInHours: number };
  'account.email_change_requested': { maskedNewEmail: string };
  'account.password_reset': { resetUrl: string; expiresInMinutes: number };
  'account.phone_otp': { code: string; expiresInMinutes: number };
  'order.placed': {
    orderNumber: number;
    currency: string;
    lines: OrderReceiptLine[];
    shippingTotal: string | null;
    discountTotal: string | null;
    grandTotal: string;
    cashOnDelivery: boolean;
  };
  /** A guest order (P6-G.1): the receipt plus the link to view, pay and track it without an account. */
  'order.guest_placed': TemplateData['order.placed'] & { orderUrl: string };
  /** Events recorded before P1-O.2 (order.status_changed.v1), with the old status names. */
  'order.updated': { orderNumber: number; status: string; trackingNumber: string | null };
  'order.completed': { orderNumber: number };
  'shipment.dispatched': { orderNumber: number; trackingNumber: string };
  'shipment.out_for_delivery': {
    orderNumber: number;
    carrier: string | null;
    trackingNumber: string | null;
    /** A rider's shipment: the code the customer gives the rider (P5-C.2); SMS only. */
    deliveryCode: string | null;
  };
  'shipment.delivered': { orderNumber: number };
  'shipment.ready_for_pickup': ReadyForPickupNotice;
  'payment.received': { orderNumber: number; amount: string; currency: string };
  'refund.processed': {
    orderNumber: number;
    amount: string;
    currency: string;
    reasonLabel: string;
    lines: { productName: string; quantity: number }[];
    includesShipping: boolean;
  };
  'inventory.low_stock_digest': { sections: LowStockDigestSection[] };
  /** Marketing (P6-G.2): only with the customer's consent for the channel. */
  'cart.abandoned': {
    items: { productName: string; variantLabel: string; quantity: number }[];
    cartUrl: string;
    /** One-click withdrawal of email marketing consent (email only). */
    unsubscribeUrl: string;
  };
}

export type TemplateKey = keyof TemplateData;

interface ChannelVariants<D> {
  email?: (data: D) => EmailContent;
  sms?: (data: D) => string;
  inApp?: (data: D) => InAppContent;
}

export interface TemplateDefinition<D> {
  /** Bumped whenever the wording changes meaningfully; each Notification row records the version it was sent with. */
  version: number;
  category: NotificationCategory;
  locales: Record<Locale, ChannelVariants<D>>;
}

const BRAND = 'Emma Commerce';

function email(subject: string, title: string, body: SafeHtml, text: string[]): EmailContent {
  return {
    subject,
    html: markup`<h1>${title}</h1>${body}<p style="color:#666;font-size:12px">${BRAND}</p>`.value,
    text: [title, '', ...text, '', BRAND].join('\n'),
  };
}

const order = (orderNumber: number) => `#${orderNumber}`;

function outForDeliveryText({ orderNumber, carrier, trackingNumber }: TemplateData['shipment.out_for_delivery']) {
  const via = carrier ? ` with ${clip(carrier, 40)}` : '';
  const tracking = trackingNumber ? ` Tracking number: ${clip(trackingNumber, 60)}.` : '';
  return `Your order ${order(orderNumber)} is out for delivery${via}.${tracking}`;
}

function placedEmail(data: TemplateData['order.placed'], orderUrl: string | null = null): EmailContent {
  const money = (amount: string) => formatMoney(amount, data.currency);
  const discount = data.discountTotal && data.discountTotal !== '0.00' ? money(data.discountTotal) : null;
  const shipping = data.shippingTotal !== null ? money(data.shippingTotal) : null;
  const total = money(data.grandTotal);
  const payment = data.cashOnDelivery
    ? 'You pay in cash when your order is delivered or collected.'
    : 'We will email you once your payment is confirmed.';
  const rows = data.lines.map(
    (line) => markup`<tr><td>${line.quantity} × ${line.productName}</td><td>${money(line.lineTotal)}</td></tr>`,
  );
  const discountRow = discount && markup`<tr><td>Discount</td><td>-${discount}</td></tr>`;
  const shippingRow = shipping && markup`<tr><td>Delivery</td><td>${shipping}</td></tr>`;
  const totalRow = markup`<tr><td><strong>Total</strong></td><td><strong>${total}</strong></td></tr>`;
  const link = orderUrl && markup`<p><a href="${orderUrl}">View, pay and track your order</a></p>`;
  return email(
    `Order ${order(data.orderNumber)} received`,
    'Thank you for your order',
    markup`<p>Your order <strong>${order(data.orderNumber)}</strong> has been placed.</p><table>${rows}${discountRow}${shippingRow}${totalRow}</table><p>${payment}</p>${link}`,
    [
      `Your order ${order(data.orderNumber)} has been placed.`,
      ...data.lines.map((line) => `${line.quantity} x ${line.productName}: ${money(line.lineTotal)}`),
      ...(discount ? [`Discount: -${discount}`] : []),
      ...(shipping ? [`Delivery: ${shipping}`] : []),
      `Total: ${total}`,
      payment,
      ...(orderUrl ? [`View, pay and track your order: ${orderUrl}`] : []),
    ],
  );
}

function readyForPickupEmail(notice: ReadyForPickupNotice): EmailContent {
  const number = order(notice.orderNumber);
  const instructions = notice.instructions && markup`<p>${notice.instructions}</p>`;
  const contact = notice.contactPhone && markup`<p>Questions? Call ${notice.contactPhone}.</p>`;
  return email(
    `Your order ${number} is ready for pickup`,
    'Ready for pickup',
    markup`<p>Your order <strong>${number}</strong> is ready to collect at <strong>${notice.pickupName}</strong>, ${notice.address}.</p><p>Opening hours: ${notice.hours}</p>${instructions}${contact}<p>Bring your order number ${number}.</p>`,
    [
      `Your order ${number} is ready to collect at ${notice.pickupName}, ${notice.address}.`,
      `Opening hours: ${notice.hours}`,
      ...(notice.instructions ? [notice.instructions] : []),
      ...(notice.contactPhone ? [`Questions? Call ${notice.contactPhone}.`] : []),
      `Bring your order number ${number}.`,
    ],
  );
}

function refundEmail(refund: TemplateData['refund.processed']): EmailContent {
  const number = order(refund.orderNumber);
  const items = [
    ...refund.lines.map((line) => `${line.quantity} × ${line.productName}`),
    ...(refund.includesShipping ? ['Delivery fee'] : []),
  ];
  const amount = formatMoney(refund.amount, refund.currency);
  const list = items.length > 0 && markup`<ul>${items.map((item) => markup`<li>${item}</li>`)}</ul>`;
  return email(
    `Refund for order ${number}`,
    'Refund sent',
    markup`<p>We refunded <strong>${amount}</strong> for order <strong>${number}</strong>.</p><p>Reason: ${refund.reasonLabel}</p>${list}`,
    [
      `We refunded ${amount} for order ${number}.`,
      `Reason: ${refund.reasonLabel}`,
      ...items.map((item) => `- ${item}`),
    ],
  );
}

function abandonedCartEmail({ items, cartUrl, unsubscribeUrl }: TemplateData['cart.abandoned']): EmailContent {
  const lines = items.map(
    (item) => `${item.quantity} × ${item.productName}${item.variantLabel ? ` (${item.variantLabel})` : ''}`,
  );
  const intro = 'You left these in your cart. They are waiting for you:';
  const why = 'You get this email because you agreed to marketing emails from us.';
  return email(
    'You left something in your cart',
    'Still thinking it over?',
    markup`<p>${intro}</p><ul>${lines.map((line) => markup`<li>${line}</li>`)}</ul><p><a href="${cartUrl}">Go to your cart</a></p><p style="color:#666;font-size:12px">${why} <a href="${unsubscribeUrl}">Unsubscribe</a></p>`,
    [
      intro,
      ...lines.map((line) => `- ${line}`),
      '',
      `Go to your cart: ${cartUrl}`,
      '',
      `${why} Unsubscribe: ${unsubscribeUrl}`,
    ],
  );
}

function lowStockDigestEmail({ sections }: TemplateData['inventory.low_stock_digest']): EmailContent {
  const count = sections.reduce((total, section) => total + section.items.length, 0);
  const intro = 'These variants went low since the last digest and are still at or below their low-stock level.';
  const tables = sections.map((section) => {
    const rows = section.items.map(
      (item) => markup`<tr><td>${item.productName}</td><td>${item.sku}</td><td>${item.available}</td></tr>`,
    );
    return markup`<h2>${section.locationName}</h2><table><tr><th>Product</th><th>SKU</th><th>Available</th></tr>${rows}</table>`;
  });
  return email(`Low stock: ${count} variant${count === 1 ? '' : 's'}`, 'Low stock', markup`<p>${intro}</p>${tables}`, [
    intro,
    ...sections.flatMap((section) => [
      '',
      section.locationName,
      ...section.items.map((item) => `- ${item.productName} (${item.sku}): ${item.available} available`),
    ]),
  ]);
}

const NOTIFICATION_TEMPLATES: { [K in TemplateKey]: TemplateDefinition<TemplateData[K]> } = {
  'account.welcome': {
    version: 2,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ name }) => {
          const intro = `Thanks for joining ${BRAND}. Start shopping today.`;
          return email(`Welcome to ${BRAND}!`, name ? `Welcome, ${name}!` : 'Welcome!', markup`<p>${intro}</p>`, [
            intro,
          ]);
        },
      },
    },
  },
  'account.email_verification': {
    version: 2,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ verificationToken, expiresInHours }) => {
          const intro = `Use the token below to confirm this email address for your ${BRAND} account. It expires in ${expiresInHours} hours.`;
          const ignore = 'If you did not request this, you can ignore this email.';
          return email(
            `Confirm your ${BRAND} email address`,
            'Confirm your email address',
            markup`<p>${intro}</p><p><strong>${verificationToken}</strong></p><p>${ignore}</p>`,
            [intro, '', verificationToken, '', ignore],
          );
        },
      },
    },
  },
  'account.email_change_requested': {
    version: 2,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ maskedNewEmail }) => {
          const notice = `Someone asked to change the email address of your ${BRAND} account to`;
          const effect = 'The change takes effect only once the new address is confirmed.';
          const warning = 'If this was not you, reset your password now and contact support.';
          return email(
            `Your ${BRAND} email address is changing`,
            'Email change requested',
            markup`<p>${notice} <strong>${maskedNewEmail}</strong>. ${effect}</p><p>${warning}</p>`,
            [`${notice} ${maskedNewEmail}. ${effect}`, warning],
          );
        },
      },
    },
  },
  'account.password_reset': {
    version: 2,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ resetUrl, expiresInMinutes }) => {
          const intro = `We received a request to reset your password. The link expires in ${expiresInMinutes} minutes.`;
          const ignore = 'If you did not ask for this, ignore this email: your password stays the same.';
          return email(
            `Reset your ${BRAND} password`,
            'Reset your password',
            markup`<p>${intro}</p><p><a href="${resetUrl}">Reset your password</a></p><p>${ignore}</p>`,
            [intro, '', resetUrl, '', ignore],
          );
        },
      },
    },
  },
  'account.phone_otp': {
    version: 1,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        sms: ({ code, expiresInMinutes }) =>
          `${code} is your verification code. It expires in ${expiresInMinutes} minutes. Never share it with anyone.`,
      },
    },
  },
  'order.placed': {
    version: 2,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: placedEmail,
        inApp: ({ orderNumber, grandTotal, currency }) => ({
          title: 'Order placed',
          body: `Your order ${order(orderNumber)} (${formatMoney(grandTotal, currency)}) has been placed.`,
        }),
      },
    },
  },
  'order.guest_placed': {
    version: 1,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: (data) => placedEmail(data, data.orderUrl),
        sms: ({ orderNumber, grandTotal, currency, orderUrl }) =>
          `Order ${order(orderNumber)} placed: ${formatMoney(grandTotal, currency)}. Pay and track it at ${orderUrl}`,
      },
    },
  },
  'order.updated': {
    version: 1,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ orderNumber, status, trackingNumber }) => {
          const tracking = trackingNumber && markup`<p>Tracking number: <strong>${trackingNumber}</strong></p>`;
          return email(
            `Your order ${order(orderNumber)} is ${status}`,
            'Order update',
            markup`<p>Your order <strong>${order(orderNumber)}</strong> is now <strong>${status}</strong>.</p>${tracking}`,
            [
              `Your order ${order(orderNumber)} is now ${status}.`,
              ...(trackingNumber ? [`Tracking number: ${trackingNumber}`] : []),
            ],
          );
        },
      },
    },
  },
  'order.completed': {
    version: 1,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ orderNumber }) => {
          const text = 'is complete. Thank you for shopping with us.';
          return email(
            `Your order ${order(orderNumber)} is complete`,
            'Order complete',
            markup`<p>Your order <strong>${order(orderNumber)}</strong> ${text}</p>`,
            [`Your order ${order(orderNumber)} ${text}`],
          );
        },
      },
    },
  },
  'shipment.dispatched': {
    version: 1,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ orderNumber, trackingNumber }) =>
          email(
            `Your order ${order(orderNumber)} has shipped`,
            'Your order has shipped',
            markup`<p>Your order <strong>${order(orderNumber)}</strong> is on its way.</p><p>Tracking number: <strong>${trackingNumber}</strong></p>`,
            [`Your order ${order(orderNumber)} is on its way.`, `Tracking number: ${trackingNumber}`],
          ),
      },
    },
  },
  'shipment.out_for_delivery': {
    version: 1,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ orderNumber, carrier, trackingNumber }) => {
          const via = carrier ? ` with ${carrier}` : '';
          const tracking = trackingNumber && markup`<p>Tracking number: <strong>${trackingNumber}</strong></p>`;
          return email(
            `Your order ${order(orderNumber)} is out for delivery`,
            'Out for delivery',
            markup`<p>Your order <strong>${order(orderNumber)}</strong> is out for delivery${via}.</p>${tracking}`,
            [outForDeliveryText({ orderNumber, carrier, trackingNumber, deliveryCode: null })],
          );
        },
        sms: (data) => {
          const text = outForDeliveryText(data);
          return data.deliveryCode ? withDeliveryCode(text, data.deliveryCode) : text;
        },
        inApp: ({ orderNumber }) => ({
          title: 'Out for delivery',
          body: `Your order ${order(orderNumber)} is out for delivery.`,
        }),
      },
    },
  },
  'shipment.delivered': {
    version: 1,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        sms: ({ orderNumber }) =>
          `Your order ${order(orderNumber)} has been delivered. Thank you for shopping with us.`,
        inApp: ({ orderNumber }) => ({
          title: 'Delivered',
          body: `Your order ${order(orderNumber)} has been delivered.`,
        }),
      },
    },
  },
  'shipment.ready_for_pickup': {
    version: 1,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: readyForPickupEmail,
        sms: (notice) => {
          const where = `${clip(notice.pickupName, 40)}, ${clip(notice.address, 70)}`;
          return `Order ${order(notice.orderNumber)} is ready for pickup at ${where}. Open: ${clip(notice.hours, 120)}.`;
        },
        inApp: ({ orderNumber, pickupName }) => ({
          title: 'Ready for pickup',
          body: `Your order ${order(orderNumber)} is ready to collect at ${pickupName}.`,
        }),
      },
    },
  },
  'payment.received': {
    version: 3,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: ({ orderNumber, amount, currency }) => {
          const paid = formatMoney(amount, currency);
          return email(
            `Payment received for order ${order(orderNumber)}`,
            'Payment confirmed',
            markup`<p>We received your payment of <strong>${paid}</strong> for order <strong>${order(orderNumber)}</strong>.</p>`,
            [`We received your payment of ${paid} for order ${order(orderNumber)}.`],
          );
        },
        sms: ({ orderNumber, amount, currency }) =>
          `We received your payment of ${formatMoney(amount, currency)} for order ${order(orderNumber)}. Thank you.`,
        inApp: ({ orderNumber, amount, currency }) => ({
          title: 'Payment received',
          body: `We received your payment of ${formatMoney(amount, currency)} for order ${order(orderNumber)}.`,
        }),
      },
    },
  },
  'refund.processed': {
    version: 2,
    category: NotificationCategory.TRANSACTIONAL,
    locales: {
      en: {
        email: refundEmail,
        inApp: ({ orderNumber, amount, currency }) => ({
          title: 'Refund sent',
          body: `We refunded ${formatMoney(amount, currency)} for order ${order(orderNumber)}.`,
        }),
      },
    },
  },
  'inventory.low_stock_digest': {
    version: 2,
    category: NotificationCategory.TRANSACTIONAL,
    locales: { en: { email: lowStockDigestEmail } },
  },
  'cart.abandoned': {
    version: 1,
    category: NotificationCategory.MARKETING,
    locales: {
      en: {
        email: abandonedCartEmail,
        sms: ({ items, cartUrl }) => {
          const units = items.reduce((total, item) => total + item.quantity, 0);
          return `${BRAND}: you left ${units} item${units === 1 ? '' : 's'} in your cart. Complete your order: ${cartUrl} (stop these in your account settings)`;
        },
      },
    },
  },
};

export function templateDefinition<K extends TemplateKey>(key: K): TemplateDefinition<TemplateData[K]> {
  return NOTIFICATION_TEMPLATES[key] as TemplateDefinition<TemplateData[K]>;
}

export function templateKeys(): TemplateKey[] {
  return Object.keys(NOTIFICATION_TEMPLATES) as TemplateKey[];
}

/** The channels a template has a variant for (in the default locale). */
export function templateChannels(key: TemplateKey): NotificationChannel[] {
  const variants = NOTIFICATION_TEMPLATES[key].locales[DEFAULT_LOCALE];
  return [
    ...(variants.email ? [NotificationChannel.EMAIL] : []),
    ...(variants.sms ? [NotificationChannel.SMS] : []),
    ...(variants.inApp ? [NotificationChannel.IN_APP] : []),
  ];
}

function variantsOf<K extends TemplateKey>(key: K, locale: Locale): ChannelVariants<TemplateData[K]> {
  return templateDefinition(key).locales[locale];
}

function missing(key: TemplateKey, channel: NotificationChannel): Error {
  return new Error(`Template "${key}" has no ${channel} variant`);
}

export function renderEmail<K extends TemplateKey>(
  key: K,
  data: TemplateData[K],
  locale = DEFAULT_LOCALE,
): EmailContent {
  const render = variantsOf(key, locale).email;
  if (!render) throw missing(key, NotificationChannel.EMAIL);
  return render(data);
}

/** The SMS text, refused above two segments: a template must keep its free-text fields clipped. */
export function renderSms<K extends TemplateKey>(key: K, data: TemplateData[K], locale = DEFAULT_LOCALE): string {
  const render = variantsOf(key, locale).sms;
  if (!render) throw missing(key, NotificationChannel.SMS);
  const text = render(data);
  if (text.length > SMS_MAX_LENGTH) {
    throw new Error(`SMS from template "${key}" is ${text.length} characters, over ${SMS_MAX_LENGTH}`);
  }
  return text;
}

export function renderInApp<K extends TemplateKey>(
  key: K,
  data: TemplateData[K],
  locale = DEFAULT_LOCALE,
): InAppContent {
  const render = variantsOf(key, locale).inApp;
  if (!render) throw missing(key, NotificationChannel.IN_APP);
  return render(data);
}
