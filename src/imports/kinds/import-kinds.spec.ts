import { ImportRowAction, ImportRowStatus, Prisma, StockAdjustmentReason } from '../../generated/prisma/client';
import { TableRow } from '../spreadsheet/table-reader';
import { applyBatches } from '../import-batches';
import { canMoveImportJob, importStatusesBefore } from '../import-job-status';
import { headerProblems } from './import-rows';
import {
  IMPORT_COLUMNS,
  importTemplate,
  validatePriceRows,
  validateProductRows,
  validateStockRows,
} from './import-kinds';
import { CatalogueFacts, ExistingVariant, planProductGroup } from './products-import';
import { planStockRow } from './stock-import';

const D = (value: string) => new Prisma.Decimal(value);
const row = (rowNumber: number, values: Record<string, string>, extraCells = 0): TableRow => ({
  rowNumber,
  values,
  extraCells,
});

describe('headerProblems', () => {
  it('names missing required and unknown columns, accepting attr./option. columns for products', () => {
    expect(headerProblems(['base_price', 'colour'], IMPORT_COLUMNS.PRICES)).toEqual([
      'Missing required column(s): sku',
      'Unknown column(s): colour',
    ]);
    expect(headerProblems(['sku', 'attr.material', 'option.size', 'attr.'], IMPORT_COLUMNS.PRODUCTS)).toEqual([
      'Unknown column(s): attr.',
    ]);
  });

  it('every template has the required columns first and passes its own header check', () => {
    for (const kind of ['PRODUCTS', 'PRICES', 'STOCK'] as const) {
      const { header, example } = importTemplate(kind);
      expect(headerProblems(header, IMPORT_COLUMNS[kind])).toEqual([]);
      expect(example).toHaveLength(header.length);
    }
  });
});

describe('PRICES rows', () => {
  const variants = new Map([
    ['shirt-m', { id: 'v1', basePrice: D('100.00'), price: D('115.00'), isTaxable: true }],
    ['mug', { id: 'v2', basePrice: D('20.00'), price: D('20.00'), isTaxable: false }],
  ]);
  const rate = D('0.15');

  it('plans an update with the tax-inclusive price, NONE when unchanged, and errors per row', () => {
    const outcomes = validatePriceRows(
      [
        row(2, { sku: 'SHIRT-M', base_price: '120.00' }),
        row(3, { sku: 'mug', base_price: '20' }),
        row(4, { sku: 'nope', base_price: '1.00' }),
        row(5, { sku: 'mug', base_price: '5' }),
        row(6, { sku: 'shirt-m', base_price: '12,50' }),
        row(7, { base_price: '1.999' }),
      ],
      variants,
      rate,
    );

    expect(outcomes.get(2)).toEqual({ errors: [], warnings: [], action: ImportRowAction.UPDATE });
    expect(outcomes.get(3)).toEqual({ errors: [], warnings: [], action: ImportRowAction.NONE });
    expect(outcomes.get(4)!.errors).toEqual(['No variant has SKU "nope"']);
    expect(outcomes.get(5)!.errors).toEqual(['SKU "mug" is already in row 3']);
    expect(outcomes.get(6)!.errors).toEqual(['SKU "shirt-m" is already in row 2']);
    expect(outcomes.get(7)!.errors).toEqual([
      'sku is required',
      'base_price must be an amount such as 12.50 (dot for decimals), got "1.999"',
    ]);
  });
});

describe('STOCK rows', () => {
  const locations = [
    { id: 'loc_main', name: 'Main warehouse', isActive: true, isDefault: true },
    { id: 'loc_shop', name: 'Osu shop', isActive: true, isDefault: false },
    { id: 'loc_old', name: 'Old store', isActive: false, isDefault: false },
  ];
  const variants = new Map([
    ['tee', { id: 'v1', trackLots: false, trackSerials: false }],
    ['milk', { id: 'v2', trackLots: true, trackSerials: false }],
    ['phone', { id: 'v3', trackLots: false, trackSerials: true }],
    ['cap', { id: 'v4', trackLots: false, trackSerials: false }],
    ['sock', { id: 'v5', trackLots: false, trackSerials: false }],
    ['hat', { id: 'v6', trackLots: false, trackSerials: false }],
  ]);
  const levels = new Map([
    ['v1@loc_main', { onHand: 10, reserved: 2 }],
    ['v1@loc_shop', { onHand: 4, reserved: 0 }],
    ['v4@loc_main', { onHand: 10, reserved: 2 }],
  ]);

  it('turns a count into a delta from on-hand, defaulting to CORRECTION at the default location', () => {
    const outcome = planStockRow(
      { sku: 'tee', count: '7' },
      variants.get('tee'),
      locations,
      levels.get('v1@loc_main')!,
    );

    expect(outcome).toMatchObject({
      errors: [],
      action: ImportRowAction.UPDATE,
      plan: { variantId: 'v1', locationId: 'loc_main', delta: -3, count: 7, reason: StockAdjustmentReason.CORRECTION },
    });
    expect(
      planStockRow({ sku: 'tee', count: '10' }, variants.get('tee'), locations, levels.get('v1@loc_main')!),
    ).toMatchObject({ errors: [], action: ImportRowAction.NONE, plan: { delta: 0 } });
  });

  it('validates deltas, reasons, locations, tracking and duplicates per row', () => {
    const outcomes = validateStockRows(
      [
        row(2, { sku: 'tee', location: 'osu SHOP', delta: '5', reason: 'found' }),
        row(3, { sku: 'tee', location: 'loc_shop', delta: '1', reason: 'FOUND' }),
        row(4, { sku: 'tee', delta: '-3' }),
        row(5, { sku: 'tee', location: 'Old store', delta: '2', reason: 'FOUND', note: 'x' }),
        row(6, { sku: 'milk', delta: '2', reason: 'FOUND' }),
        row(7, { sku: 'phone', count: '1' }),
        row(8, { sku: 'tee', location: 'Nowhere', delta: '1', count: '2', reason: 'LOST' }),
        row(9, { sku: 'cap', location: 'Main warehouse', delta: '-9', reason: 'DAMAGED' }),
        row(10, { sku: 'sock', location: 'Osu shop', delta: '-1', reason: 'FOUND' }, 2),
        row(11, { sku: 'hat', location: 'Osu shop', delta: '-1', reason: 'STOCK_TAKE' }),
      ],
      variants,
      locations,
      levels,
    );

    expect(outcomes.get(2)).toEqual({ errors: [], warnings: [], action: ImportRowAction.UPDATE });
    expect(outcomes.get(3)!.errors).toEqual(['SKU "tee" at this location is already in row 2']);
    expect(outcomes.get(4)!.errors).toEqual(['reason is required with a delta']);
    expect(outcomes.get(5)!.errors).toEqual(['Stock location "Old store" is inactive']);
    expect(outcomes.get(6)!.errors[0]).toMatch(/tracks lots/);
    expect(outcomes.get(7)!.errors[0]).toMatch(/tracks serial numbers/);
    expect(outcomes.get(8)!.errors).toEqual([
      'No stock location is called "Nowhere"',
      'Give either delta or count, not both and not neither',
    ]);
    expect(outcomes.get(9)!.errors).toEqual(['Stock cannot go below the 2 unit(s) reserved for orders (on hand 10)']);
    expect(outcomes.get(10)!.errors[0]).toMatch(/beyond the last named column/);
    expect(outcomes.get(11)!.errors[0]).toMatch(/reason must be one of/);
  });
});

describe('PRODUCTS rows', () => {
  const sizeRule = {
    key: 'size',
    dataType: 'TEXT' as const,
    unit: null,
    isRequired: true,
    allowedValues: ['S', 'M', 'L'],
    isVariantAxis: true,
  };
  const materialRule = {
    key: 'material',
    dataType: 'TEXT' as const,
    unit: null,
    isRequired: true,
    allowedValues: [],
    isVariantAxis: false,
  };
  const existingVariant: ExistingVariant = {
    id: 'v_tee_s',
    sku: 'TEE-S',
    barcode: '111',
    productId: 'p_tee',
    optionsKey: 'size=s',
    optionValues: { size: 'S' },
    isActive: true,
    basePrice: D('50.00'),
    weightGrams: 200,
    lowStockThreshold: 5,
  };
  const facts = (): CatalogueFacts => ({
    productTypes: [
      { id: 'pt_general', key: 'general', attributes: [] },
      { id: 'pt_apparel', key: 'apparel', attributes: [sizeRule, materialRule] },
    ],
    defaultProductTypeId: 'pt_general',
    categories: [{ id: 'cat_clothes', name: 'Clothes' }],
    subcategories: [{ id: 'sub_tops', name: 'Tops', categoryId: 'cat_clothes' }],
    brands: [{ id: 'brand_kente', name: 'Kente Co' }],
    tags: [{ id: 'tag_new', name: 'New' }],
    variantsBySku: new Map([['tee-s', existingVariant]]),
    products: new Map([
      [
        'p_tee',
        {
          id: 'p_tee',
          name: 'Tee',
          description: null,
          shortDescription: null,
          productTypeId: 'pt_apparel',
          isTaxable: true,
          status: 'DRAFT',
          attributes: { material: 'Cotton' },
          categoryId: 'cat_clothes',
          subcategoryId: null,
          brandId: null,
          tagIds: [],
          variants: [existingVariant],
        },
      ],
    ]),
    barcodeOwners: new Map([['111', 'v_tee_s']]),
    taxRate: D('0.15'),
  });

  it('creates a product with its variants from rows sharing a product_key, validating type rules', () => {
    const { rows, plan } = planProductGroup(
      [
        {
          rowNumber: 2,
          values: {
            sku: 'DRESS-S',
            product_key: 'dress',
            name: 'Dress',
            product_type: 'Apparel',
            category: 'clothes',
            subcategory: 'tops',
            brand: 'kente co',
            tags: 'new',
            is_taxable: 'yes',
            'attr.material': 'Silk',
            'option.size': 's',
            base_price: '100.00',
          },
        },
        { rowNumber: 3, values: { sku: 'DRESS-M', product_key: 'dress', 'option.size': 'M', base_price: '110' } },
      ],
      facts(),
    );

    expect([...rows.values()].map((outcome) => outcome.errors)).toEqual([[], []]);
    expect(plan!.product).toEqual({
      kind: 'create',
      data: {
        name: 'Dress',
        productTypeId: 'pt_apparel',
        isTaxable: true,
        categoryId: 'cat_clothes',
        subcategoryId: 'sub_tops',
        brandId: 'brand_kente',
        attributes: { material: 'Silk' },
      },
    });
    expect(plan!.tagIds).toEqual(['tag_new']);
    expect(plan!.variants).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        kind: 'create',
        data: expect.objectContaining({ sku: 'DRESS-S', optionsKey: 'size=s', basePrice: D('100'), price: D('115') }),
      }),
      expect.objectContaining({
        rowNumber: 3,
        kind: 'create',
        data: expect.objectContaining({ optionsKey: 'size=m' }),
      }),
    ]);
  });

  it('fails the whole product when one row is invalid, naming the reasons', () => {
    const { rows, plan } = planProductGroup(
      [
        {
          rowNumber: 2,
          values: {
            sku: 'A',
            product_key: 'k',
            name: 'A',
            product_type: 'apparel',
            'option.size': 'XL',
            base_price: '1',
          },
        },
        {
          rowNumber: 3,
          values: { sku: 'B', product_key: 'k', name: 'Other name', 'option.size': 'S', base_price: '1' },
        },
      ],
      facts(),
    );

    expect(plan).toBeUndefined();
    expect(rows.get(2)!.errors).toEqual([
      'Invalid attributes: material is required',
      'Invalid options: size must be one of S, M, L',
    ]);
    expect(rows.get(3)!.errors).toEqual(['name "Other name" differs from row 2 ("A")']);
  });

  it('updates an existing SKU without touching its price, refusing type and tax changes', () => {
    const update = planProductGroup(
      [
        {
          rowNumber: 2,
          values: { sku: 'tee-s', name: 'Tee classic', weight_grams: '250', base_price: '60.00', tags: 'New' },
        },
      ],
      facts(),
    );
    expect(update.rows.get(2)).toEqual({
      errors: [],
      warnings: ['base_price is ignored for an existing SKU: change prices with a PRICES import'],
      action: ImportRowAction.UPDATE,
    });
    expect(update.plan).toEqual({
      product: { kind: 'update', id: 'p_tee', data: { name: 'Tee classic' } },
      tagIds: ['tag_new'],
      variants: [{ rowNumber: 2, kind: 'update', id: 'v_tee_s', data: { weightGrams: 250 } }],
    });

    const refused = planProductGroup(
      [{ rowNumber: 2, values: { sku: 'TEE-S', product_type: 'general', is_taxable: 'false' } }],
      facts(),
    );
    expect(refused.rows.get(2)!.errors).toEqual([
      'The product type of an existing product cannot change by import: change it in the admin',
      'Changing is_taxable reprices every variant: change it in the admin',
    ]);
  });

  it('adds a variant to an existing product by product_id, refusing a clashing option or taken barcode', () => {
    const outcomes = validateProductRows(
      [
        row(2, { sku: 'TEE-M', product_id: 'p_tee', 'option.size': 'M', base_price: '50', barcode: '222' }),
        row(3, { sku: 'TEE-S2', product_id: 'p_tee', 'option.size': 's', base_price: '50' }),
        row(4, { sku: 'TEE-L', product_id: 'p_tee', 'option.size': 'L', base_price: '50', barcode: '111' }),
      ],
      facts(),
    );

    expect(outcomes.get(3)!.errors).toEqual([
      'Another active variant of the product (v_tee_s) has the same options (size=s)',
    ]);
    expect(outcomes.get(4)!.errors).toEqual(['Barcode "111" is already used by variant "v_tee_s"']);
    expect(outcomes.get(2)!.errors[0]).toMatch(/Row\(s\) 3, 4 of the same product are invalid/);
  });

  it('refuses duplicate SKUs in the file and a new product without a name or price', () => {
    const outcomes = validateProductRows(
      [
        row(2, { sku: 'NEW-1', base_price: '5', name: 'One' }),
        row(3, { sku: 'new-1', base_price: '5' }),
        row(4, { sku: 'NEW-2' }),
      ],
      facts(),
    );

    expect(outcomes.get(2)).toEqual({ errors: [], warnings: [], action: ImportRowAction.CREATE });
    expect(outcomes.get(3)!.errors).toEqual(['SKU "new-1" is already in row 2']);
    expect(outcomes.get(4)!.errors).toEqual([
      'name is required for a new product',
      'base_price is required for a new SKU',
    ]);
  });
});

describe('apply batches and job status', () => {
  it('takes only VALID rows, keeps a unit together and caps batch size', () => {
    const rows = [
      { rowNumber: 5, status: ImportRowStatus.VALID, unit: 'b' },
      { rowNumber: 2, status: ImportRowStatus.APPLIED, unit: 'a' },
      { rowNumber: 3, status: ImportRowStatus.VALID, unit: 'a' },
      { rowNumber: 4, status: ImportRowStatus.FAILED, unit: 'a' },
      { rowNumber: 6, status: ImportRowStatus.VALID, unit: 'b' },
      { rowNumber: 7, status: ImportRowStatus.VALID, unit: 'c' },
      { rowNumber: 8, status: ImportRowStatus.SKIPPED, unit: 'c' },
    ];

    const batches = applyBatches(rows, (r) => r.unit, 2);

    expect(batches.map((batch) => batch.map((unit) => unit.map((r) => r.rowNumber)))).toEqual([[[3]], [[5, 6]], [[7]]]);
    expect(
      applyBatches(
        rows.filter((r) => r.status !== ImportRowStatus.VALID),
        (r) => r.unit,
      ),
    ).toEqual([]);
  });

  it('allows the documented moves only', () => {
    expect(canMoveImportJob('VALIDATED', 'APPLYING')).toBe(true);
    expect(canMoveImportJob('FAILED', 'APPLYING')).toBe(true);
    expect(canMoveImportJob('COMPLETED', 'APPLYING')).toBe(false);
    expect(canMoveImportJob('APPLYING', 'CANCELLED')).toBe(false);
    expect(importStatusesBefore('CANCELLED').sort()).toEqual(['QUEUED', 'VALIDATED']);
  });
});
