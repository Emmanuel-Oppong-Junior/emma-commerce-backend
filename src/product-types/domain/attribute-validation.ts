// Validates product attributes and variant option values against a product type's attribute definitions (ADR-0002).
// Pure: no I/O and no Nest, so admin create/update and a future bulk import share exactly the same rules.

export type AttributeDataType = 'TEXT' | 'NUMBER' | 'BOOLEAN';

export interface AttributeRule {
  key: string;
  dataType: AttributeDataType | `${AttributeDataType}`;
  unit: string | null;
  isRequired: boolean;
  allowedValues: readonly string[];
  isVariantAxis: boolean;
}

export type AttributeValue = string | number | boolean;
export type AttributeMap = Record<string, AttributeValue>;

export interface AttributeProblem {
  key: string;
  message: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: AttributeProblem[] };

export interface CheckedOptions {
  values: AttributeMap;
  /** Canonical form of the combination: equal for "XL"/"xl", so the database can keep combinations unique. */
  optionsKey: string;
}

export const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,49}$/;
export const MAX_TEXT_LENGTH = 200;
const DECIMAL = /^-?\d+(\.\d+)?$/;
// optionsKey joins key=value pairs with "|", so an option value must not contain it.
const OPTIONS_SEPARATOR = '|';

type Parsed = { ok: true; value: AttributeValue } | { ok: false; message: string };

const fail = (message: string): Parsed => ({ ok: false, message });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseText(rule: AttributeRule, raw: unknown): Parsed {
  if (typeof raw !== 'string') return fail('must be text');
  const text = raw.trim();
  if (text === '') return fail('must not be blank');
  if (text.length > MAX_TEXT_LENGTH) return fail(`must be at most ${MAX_TEXT_LENGTH} characters`);
  if (rule.isVariantAxis && text.includes(OPTIONS_SEPARATOR)) return fail(`must not contain "${OPTIONS_SEPARATOR}"`);
  if (rule.allowedValues.length === 0) return { ok: true, value: text };
  const allowed = rule.allowedValues.find((value) => value.toLowerCase() === text.toLowerCase());
  return allowed === undefined ? fail(`must be one of ${rule.allowedValues.join(', ')}`) : { ok: true, value: allowed };
}

function parseNumberText(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string' && DECIMAL.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

function parseNumber(rule: AttributeRule, raw: unknown): Parsed {
  let amount: unknown = raw;
  if (isPlainObject(raw)) {
    const extra = Object.keys(raw).filter((key) => key !== 'value' && key !== 'unit');
    if (extra.length) return fail(`takes only "value" and "unit", not ${extra.join(', ')}`);
    if (rule.unit === null) return fail('has no unit; send a plain number');
    if (typeof raw.unit !== 'string' || raw.unit.trim().toLowerCase() !== rule.unit.toLowerCase()) {
      return fail(`must be in ${rule.unit}`);
    }
    amount = raw.value;
  }
  const value = parseNumberText(amount);
  if (value === undefined) return fail(rule.unit ? `must be a number of ${rule.unit}` : 'must be a number');
  if (rule.allowedValues.length > 0 && !rule.allowedValues.some((allowed) => Number(allowed) === value)) {
    return fail(`must be one of ${rule.allowedValues.join(', ')}${rule.unit ? ` ${rule.unit}` : ''}`);
  }
  return { ok: true, value };
}

function parseBoolean(raw: unknown): Parsed {
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
  return fail('must be true or false');
}

function parseValue(rule: AttributeRule, raw: unknown): Parsed {
  if (rule.dataType === 'TEXT') return parseText(rule, raw);
  if (rule.dataType === 'NUMBER') return parseNumber(rule, raw);
  return parseBoolean(raw);
}

/** Checks `input` against the rules on one side (product attributes or variant axes); null means "not set". */
function checkAgainst(
  rules: readonly AttributeRule[],
  input: unknown,
  side: 'attributes' | 'options',
): Checked<AttributeMap> {
  if (input === null || input === undefined) input = {};
  if (!isPlainObject(input)) return { ok: false, problems: [{ key: '', message: 'must be an object of key: value' }] };

  const wanted = rules.filter((rule) => rule.isVariantAxis === (side === 'options'));
  const byKey = new Map(wanted.map((rule) => [rule.key, rule]));
  const otherSide = new Set(rules.filter((rule) => !byKey.has(rule.key)).map((rule) => rule.key));
  const problems: AttributeProblem[] = [];
  const values: AttributeMap = {};

  for (const [key, raw] of Object.entries(input)) {
    const rule = byKey.get(key);
    if (!rule) {
      problems.push({
        key,
        message: otherSide.has(key)
          ? side === 'attributes'
            ? 'is a variant option; set it on each variant'
            : 'is a product attribute, not a variant option'
          : 'is not an attribute of this product type',
      });
      continue;
    }
    if (raw === null || raw === undefined) continue;
    const parsed = parseValue(rule, raw);
    if (parsed.ok) values[key] = parsed.value;
    else problems.push({ key, message: parsed.message });
  }

  for (const rule of wanted) {
    if (rule.isRequired && !(rule.key in values) && !problems.some((problem) => problem.key === rule.key)) {
      problems.push({ key: rule.key, message: 'is required' });
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, value: values };
}

/** Validates a product's attribute map against its type's non-axis definitions and returns the normalised map. */
export function checkProductAttributes(rules: readonly AttributeRule[], input: unknown): Checked<AttributeMap> {
  return checkAgainst(rules, input, 'attributes');
}

/** Validates a variant's option values against its type's variant axes and returns them with their canonical key. */
export function checkOptionValues(rules: readonly AttributeRule[], input: unknown): Checked<CheckedOptions> {
  const checked = checkAgainst(rules, input, 'options');
  if (!checked.ok) return checked;
  return { ok: true, value: { values: checked.value, optionsKey: optionsKey(checked.value) } };
}

/**
 * The canonical form of an option combination: keys sorted, text lower-cased, joined as key=value|key=value; ""
 * for none. The migration that converted Variant.size/color (20261121010000_default_variants) builds the same form.
 */
export function optionsKey(values: AttributeMap): string {
  return Object.keys(values)
    .sort()
    .map((key) => {
      const value = values[key];
      return `${key}=${typeof value === 'string' ? value.toLowerCase() : String(value)}`;
    })
    .join(OPTIONS_SEPARATOR);
}

/** Problems with a definition itself: a unit only on NUMBER, allowed values that are valid for the data type. */
export function checkAttributeRule(rule: AttributeRule): AttributeProblem[] {
  const problems: string[] = [];
  if (!ATTRIBUTE_KEY.test(rule.key)) {
    problems.push('key must start with a lower-case letter and contain only a-z, 0-9 and _ (at most 50 characters)');
  }
  if (rule.unit !== null && rule.dataType !== 'NUMBER') problems.push('only NUMBER attributes have a unit');
  if (rule.dataType === 'BOOLEAN' && rule.allowedValues.length > 0) {
    problems.push('BOOLEAN attributes take no allowed values');
  }
  if (rule.dataType === 'NUMBER') {
    const notNumbers = rule.allowedValues.filter((value) => parseNumberText(value) === undefined);
    if (notNumbers.length) problems.push(`allowed values must be numbers, not ${notNumbers.join(', ')}`);
  }
  if (rule.dataType === 'TEXT') {
    const trimmed = rule.allowedValues.map((value) => value.trim());
    if (trimmed.some((value) => value === '')) problems.push('allowed values must not be blank');
    const lower = trimmed.map((value) => value.toLowerCase());
    if (new Set(lower).size !== lower.length) problems.push('allowed values must differ by more than letter case');
    if (rule.isVariantAxis && trimmed.some((value) => value.includes(OPTIONS_SEPARATOR))) {
      problems.push(`variant option values must not contain "${OPTIONS_SEPARATOR}"`);
    }
  }
  return problems.map((message) => ({ key: rule.key, message }));
}

/** One line for an error message, e.g. `size must be one of S, M; colour is required`. */
export function describeProblems(problems: readonly AttributeProblem[]): string {
  return problems.map((problem) => (problem.key ? `${problem.key} ${problem.message}` : problem.message)).join('; ');
}
