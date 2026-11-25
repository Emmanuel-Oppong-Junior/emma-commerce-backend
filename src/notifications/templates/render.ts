import { Prisma } from '../../generated/prisma/client';

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

/** Markup built by `markup`, which `markup` inserts as is; every other value is escaped. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

type HtmlValue = SafeHtml | string | number | null | undefined | false | readonly HtmlValue[];

function htmlPart(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return (value as readonly HtmlValue[]).map(htmlPart).join('');
  return escapeHtml(value as string | number);
}

/**
 * Tagged template for email HTML: every interpolated value is HTML-escaped unless it is itself `markup` output, so a
 * template cannot forget to escape a customer's name or a product name. null, undefined and false render nothing;
 * arrays render their parts in order.
 */
export function markup(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  return new SafeHtml(
    strings.reduce((out, part, index) => out + part + (index < values.length ? htmlPart(values[index]) : ''), ''),
  );
}

/** "GHS 1,250.50": the currency code and the amount with 2 decimals (money is never shown as a raw number). */
export function formatMoney(amount: Prisma.Decimal | string | number, currency = 'GHS'): string {
  const fixed = new Prisma.Decimal(amount).toFixed(2);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}.${fraction}`;
}

/** At most `max` characters of a free-text value (names, addresses) in an SMS, ending in "..." when cut. */
export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

/** One GSM-7 segment. */
export const SMS_SEGMENT_LENGTH = 160;
/** Two concatenated segments (153 characters each): the longest SMS a template may produce (ADR-0015). */
export const SMS_MAX_LENGTH = 306;
