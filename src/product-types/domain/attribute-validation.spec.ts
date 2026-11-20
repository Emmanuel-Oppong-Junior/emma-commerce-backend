import {
  AttributeRule,
  checkAttributeRule,
  checkOptionValues,
  checkProductAttributes,
  describeProblems,
  MAX_TEXT_LENGTH,
  optionsKey,
} from './attribute-validation';

function rule(overrides: Partial<AttributeRule> & Pick<AttributeRule, 'key'>): AttributeRule {
  return { dataType: 'TEXT', unit: null, isRequired: false, allowedValues: [], isVariantAxis: false, ...overrides };
}

const phone: AttributeRule[] = [
  rule({ key: 'storage', dataType: 'NUMBER', unit: 'GB', allowedValues: ['64', '128', '256'], isVariantAxis: true }),
  rule({ key: 'colour', isVariantAxis: true, isRequired: true }),
  rule({ key: 'warranty_months', dataType: 'NUMBER', unit: 'months', isRequired: true }),
  rule({ key: 'dual_sim', dataType: 'BOOLEAN' }),
  rule({ key: 'condition', allowedValues: ['New', 'Refurbished'] }),
  rule({ key: 'screen_inches', dataType: 'NUMBER' }),
];

describe('checkProductAttributes', () => {
  it('accepts valid values and normalises them (trimmed text, allowed spelling, numbers, booleans)', () => {
    const result = checkProductAttributes(phone, {
      warranty_months: '12',
      dual_sim: 'true',
      condition: '  refurbished ',
      screen_inches: 6.1,
    });

    expect(result).toEqual({
      ok: true,
      value: { warranty_months: 12, dual_sim: true, condition: 'Refurbished', screen_inches: 6.1 },
    });
  });

  it('treats null, undefined and an omitted map as "not set"', () => {
    const rules = [rule({ key: 'material' })];

    expect(checkProductAttributes(rules, null)).toEqual({ ok: true, value: {} });
    expect(checkProductAttributes(rules, undefined)).toEqual({ ok: true, value: {} });
    expect(checkProductAttributes(rules, { material: null })).toEqual({ ok: true, value: {} });
  });

  it('rejects a missing required attribute, including one sent as null', () => {
    expect(checkProductAttributes(phone, {})).toEqual({
      ok: false,
      problems: [{ key: 'warranty_months', message: 'is required' }],
    });
    expect(checkProductAttributes(phone, { warranty_months: null })).toMatchObject({ ok: false });
  });

  it('rejects unknown keys and variant axes, saying where an axis belongs', () => {
    const result = checkProductAttributes(phone, { warranty_months: 12, colour: 'Red', weight: 3 });

    expect(result).toEqual({
      ok: false,
      problems: [
        { key: 'colour', message: 'is a variant option; set it on each variant' },
        { key: 'weight', message: 'is not an attribute of this product type' },
      ],
    });
  });

  it.each([
    ['an array', ['warranty_months']],
    ['a string', 'warranty_months=12'],
    ['a number', 12],
  ])('rejects %s instead of an object', (_label, input) => {
    expect(checkProductAttributes(phone, input)).toEqual({
      ok: false,
      problems: [{ key: '', message: 'must be an object of key: value' }],
    });
  });

  describe('TEXT', () => {
    const rules = [rule({ key: 'material' }), rule({ key: 'condition', allowedValues: ['New', 'Used'] })];

    it.each([
      [42, 'must be text'],
      [true, 'must be text'],
      ['   ', 'must not be blank'],
      ['x'.repeat(MAX_TEXT_LENGTH + 1), `must be at most ${MAX_TEXT_LENGTH} characters`],
    ])('rejects %p (%s)', (value, message) => {
      expect(checkProductAttributes(rules, { material: value })).toEqual({
        ok: false,
        problems: [{ key: 'material', message }],
      });
    });

    it('accepts text of exactly the maximum length', () => {
      expect(checkProductAttributes(rules, { material: 'x'.repeat(MAX_TEXT_LENGTH) }).ok).toBe(true);
    });

    it('matches allowed values case-insensitively and rejects the rest, listing them', () => {
      expect(checkProductAttributes(rules, { condition: 'USED' })).toEqual({ ok: true, value: { condition: 'Used' } });
      expect(checkProductAttributes(rules, { condition: 'Broken' })).toEqual({
        ok: false,
        problems: [{ key: 'condition', message: 'must be one of New, Used' }],
      });
    });

    it('allows "|" in product attributes (only option values are joined with it)', () => {
      expect(checkProductAttributes(rules, { material: 'cotton|linen' }).ok).toBe(true);
    });
  });

  describe('NUMBER', () => {
    const rules = [
      rule({ key: 'weight', dataType: 'NUMBER', unit: 'g' }),
      rule({ key: 'pieces', dataType: 'NUMBER' }),
      rule({ key: 'pack', dataType: 'NUMBER', allowedValues: ['6', '12.5'] }),
    ];

    it('accepts numbers, decimal strings and { value, unit } in the defined unit', () => {
      expect(checkProductAttributes(rules, { weight: '250.5', pieces: -3 })).toEqual({
        ok: true,
        value: { weight: 250.5, pieces: -3 },
      });
      expect(checkProductAttributes(rules, { weight: { value: 250, unit: ' G ' } })).toEqual({
        ok: true,
        value: { weight: 250 },
      });
    });

    it.each([
      [{ weight: '1e3' }, 'weight', 'must be a number of g'],
      [{ weight: Infinity }, 'weight', 'must be a number of g'],
      [{ weight: Number.NaN }, 'weight', 'must be a number of g'],
      [{ weight: '' }, 'weight', 'must be a number of g'],
      [{ pieces: 'three' }, 'pieces', 'must be a number'],
      [{ weight: { value: 2, unit: 'kg' } }, 'weight', 'must be in g'],
      [{ weight: { value: 2 } }, 'weight', 'must be in g'],
      [{ weight: { value: 2, unit: 'g', note: 'x' } }, 'weight', 'takes only "value" and "unit", not note'],
      [{ pieces: { value: 2, unit: 'g' } }, 'pieces', 'has no unit; send a plain number'],
      [{ pack: 7 }, 'pack', 'must be one of 6, 12.5'],
    ])('rejects %p', (input, key, message) => {
      expect(checkProductAttributes(rules, input)).toEqual({ ok: false, problems: [{ key, message }] });
    });

    it('compares allowed values numerically', () => {
      expect(checkProductAttributes(rules, { pack: '12.50' })).toEqual({ ok: true, value: { pack: 12.5 } });
    });
  });

  describe('BOOLEAN', () => {
    const rules = [rule({ key: 'organic', dataType: 'BOOLEAN' })];

    it.each([
      [true, true],
      [false, false],
      ['true', true],
      ['false', false],
    ])('accepts %p as %p', (input, value) => {
      expect(checkProductAttributes(rules, { organic: input })).toEqual({ ok: true, value: { organic: value } });
    });

    it.each(['yes', 1, 0, 'TRUE'])('rejects %p', (input) => {
      expect(checkProductAttributes(rules, { organic: input })).toEqual({
        ok: false,
        problems: [{ key: 'organic', message: 'must be true or false' }],
      });
    });
  });

  it('reports every problem at once', () => {
    const result = checkProductAttributes(phone, { dual_sim: 'maybe', condition: 'Broken', extra: 1 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.map((problem) => problem.key)).toEqual([
      'dual_sim',
      'condition',
      'extra',
      'warranty_months',
    ]);
  });

  it('accepts anything empty for a type without attributes (General) and rejects any key', () => {
    expect(checkProductAttributes([], {})).toEqual({ ok: true, value: {} });
    expect(checkProductAttributes([], { colour: 'red' })).toMatchObject({ ok: false });
  });
});

describe('checkOptionValues', () => {
  it('returns the normalised values and their canonical key', () => {
    expect(checkOptionValues(phone, { storage: { value: '128', unit: 'gb' }, colour: ' Midnight Blue ' })).toEqual({
      ok: true,
      value: { values: { storage: 128, colour: 'Midnight Blue' }, optionsKey: 'colour=midnight blue|storage=128' },
    });
  });

  it('rejects product attributes and unknown keys among option values', () => {
    expect(checkOptionValues(phone, { colour: 'Red', warranty_months: 12, size: 'M' })).toEqual({
      ok: false,
      problems: [
        { key: 'warranty_months', message: 'is a product attribute, not a variant option' },
        { key: 'size', message: 'is not an attribute of this product type' },
      ],
    });
  });

  it('enforces required axes and allowed values', () => {
    expect(checkOptionValues(phone, { storage: 512 })).toEqual({
      ok: false,
      problems: [
        { key: 'storage', message: 'must be one of 64, 128, 256 GB' },
        { key: 'colour', message: 'is required' },
      ],
    });
  });

  it('refuses "|" in an option value, which the canonical key uses as a separator', () => {
    expect(checkOptionValues(phone, { colour: 'black|white' })).toEqual({
      ok: false,
      problems: [{ key: 'colour', message: 'must not contain "|"' }],
    });
  });

  it('gives a variant without options (a General product) the empty key', () => {
    expect(checkOptionValues([], {})).toEqual({ ok: true, value: { values: {}, optionsKey: '' } });
    expect(checkOptionValues([], null)).toEqual({ ok: true, value: { values: {}, optionsKey: '' } });
  });

  it('makes "XL"/"xl" and differently ordered maps the same combination', () => {
    const apparel = [rule({ key: 'size', isVariantAxis: true }), rule({ key: 'colour', isVariantAxis: true })];
    const a = checkOptionValues(apparel, { size: 'XL', colour: 'Red' });
    const b = checkOptionValues(apparel, { colour: 'red', size: 'xl' });

    expect(a.ok && b.ok && a.value.optionsKey === b.value.optionsKey).toBe(true);
    expect(a.ok && a.value.values).toEqual({ size: 'XL', colour: 'Red' });
  });
});

describe('optionsKey', () => {
  it('sorts keys and formats each value type', () => {
    expect(optionsKey({ size: 'M', colour: 'Red', organic: false, weight: 2.5 })).toBe(
      'colour=red|organic=false|size=m|weight=2.5',
    );
  });

  it('is empty for no options', () => {
    expect(optionsKey({})).toBe('');
  });
});

describe('checkAttributeRule', () => {
  it('accepts coherent definitions', () => {
    expect(checkAttributeRule(rule({ key: 'storage', dataType: 'NUMBER', unit: 'GB', allowedValues: ['64'] }))).toEqual(
      [],
    );
    expect(checkAttributeRule(rule({ key: 'size', isVariantAxis: true, allowedValues: ['S', 'M'] }))).toEqual([]);
    expect(checkAttributeRule(rule({ key: 'organic', dataType: 'BOOLEAN' }))).toEqual([]);
  });

  it.each([
    [
      rule({ key: 'Size' }),
      'key must start with a lower-case letter and contain only a-z, 0-9 and _ (at most 50 characters)',
    ],
    [rule({ key: 'material', unit: 'cm' }), 'only NUMBER attributes have a unit'],
    [
      rule({ key: 'organic', dataType: 'BOOLEAN', allowedValues: ['true'] }),
      'BOOLEAN attributes take no allowed values',
    ],
    [
      rule({ key: 'pack', dataType: 'NUMBER', allowedValues: ['6', 'dozen'] }),
      'allowed values must be numbers, not dozen',
    ],
    [rule({ key: 'size', allowedValues: ['S', ' '] }), 'allowed values must not be blank'],
    [rule({ key: 'size', allowedValues: ['XL', 'xl'] }), 'allowed values must differ by more than letter case'],
    [
      rule({ key: 'colour', isVariantAxis: true, allowedValues: ['a|b'] }),
      'variant option values must not contain "|"',
    ],
  ])('reports %o', (definition, message) => {
    expect(checkAttributeRule(definition)).toEqual([{ key: definition.key, message }]);
  });
});

describe('describeProblems', () => {
  it('joins problems into one line, keyless ones as they are', () => {
    expect(
      describeProblems([
        { key: 'size', message: 'must be one of S, M' },
        { key: '', message: 'must be an object of key: value' },
      ]),
    ).toBe('size must be one of S, M; must be an object of key: value');
  });
});
