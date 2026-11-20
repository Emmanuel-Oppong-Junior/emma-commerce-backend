import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AttributeDefinition } from '../generated/prisma/client';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { ProductTypesRepository, ProductTypeWithAttributes } from './product-types.repository';
import { CreateProductTypeInput, UpdateProductTypeInput } from './dto/product-type.input';
import { AttributeDefinitionInput, UpdateAttributeDefinitionInput } from './dto/attribute-definition.input';

const AUDITED_TYPE_FIELDS = [
  'key',
  'name',
  'description',
] as const satisfies readonly (keyof ProductTypeWithAttributes)[];
const AUDITED_ATTRIBUTE_FIELDS = [
  'productTypeId',
  'key',
  'label',
  'dataType',
  'unit',
  'isRequired',
  'allowedValues',
  'isVariantAxis',
  'isFilterable',
  'position',
] as const satisfies readonly (keyof AttributeDefinition)[];

function attributeData(input: AttributeDefinitionInput) {
  return {
    key: input.key,
    label: input.label,
    dataType: input.dataType,
    unit: input.unit ?? null,
    isRequired: input.isRequired,
    allowedValues: input.allowedValues ?? [],
    isVariantAxis: input.isVariantAxis,
    isFilterable: input.isFilterable,
    position: input.position,
  };
}

@Injectable()
export class ProductTypesService {
  constructor(
    private readonly repository: ProductTypesRepository,
    private readonly auditService: AuditService,
  ) {}

  async findAll(): Promise<ProductTypeWithAttributes[]> {
    return this.repository.findAll();
  }

  async findOne(id: string): Promise<ProductTypeWithAttributes> {
    const productType = await this.repository.findById(id);
    if (!productType) throw new NotFoundException(`Product type "${id}" not found`);
    return productType;
  }

  async create(input: CreateProductTypeInput, actorId: string): Promise<ProductTypeWithAttributes> {
    const attributes = input.attributes ?? [];
    const keys = attributes.map((attribute) => attribute.key);
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    if (duplicates.length) {
      throw new BadRequestException(`Attribute keys must be unique; repeated: ${[...new Set(duplicates)].join(', ')}`);
    }
    return this.auditService.record(
      (tx) =>
        this.repository.create(
          {
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            attributes: { create: attributes.map(attributeData) },
          },
          tx,
        ),
      (created) => ({
        entity: 'ProductType',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: {
          after: fieldValues(created, AUDITED_TYPE_FIELDS),
          attributes: created.attributes.map((attribute) => fieldValues(attribute, AUDITED_ATTRIBUTE_FIELDS)),
        },
      }),
    );
  }

  async update(id: string, input: UpdateProductTypeInput, actorId: string): Promise<ProductTypeWithAttributes> {
    const existing = await this.findEditable(id);
    return this.auditService.record(
      (tx) => this.repository.update(id, { name: input.name, description: input.description }, tx),
      (updated) => ({
        entity: 'ProductType',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_TYPE_FIELDS) },
      }),
    );
  }

  async delete(id: string, actorId: string): Promise<ProductTypeWithAttributes> {
    await this.findEditable(id);
    await this.ensureUnused(id, 'deleted');
    return this.auditService.record(
      (tx) => this.repository.delete(id, tx),
      (deleted) => ({
        entity: 'ProductType',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_TYPE_FIELDS) },
      }),
    );
  }

  /** An attribute added to a type in use must be optional: its products have no value for it yet. */
  async addAttribute(
    productTypeId: string,
    input: AttributeDefinitionInput,
    actorId: string,
  ): Promise<ProductTypeWithAttributes> {
    await this.findEditable(productTypeId);
    if (input.isRequired) await this.ensureUnused(productTypeId, 'given a required attribute');
    return this.auditService
      .record(
        async (tx) => {
          const created = await this.repository.createAttribute({ ...attributeData(input), productTypeId }, tx);
          return { created, productType: (await this.repository.findById(productTypeId, tx))! };
        },
        ({ created }) => ({
          entity: 'AttributeDefinition',
          entityId: created.id,
          action: 'CREATE',
          userId: actorId,
          details: { after: fieldValues(created, AUDITED_ATTRIBUTE_FIELDS) },
        }),
      )
      .then(({ productType }) => productType);
  }

  /**
   * Relabelling, reordering, filterability and new allowed values are always safe. Making an attribute required,
   * changing its unit or narrowing its allowed values could invalidate stored values, so needs the type unused.
   */
  async updateAttribute(
    attributeId: string,
    input: UpdateAttributeDefinitionInput,
    actorId: string,
  ): Promise<ProductTypeWithAttributes> {
    const existing = await this.findAttribute(attributeId);
    await this.findEditable(existing.productTypeId);
    const narrowing = this.narrowingChanges(existing, input);
    if (narrowing.length) await this.ensureUnused(existing.productTypeId, `changed this way (${narrowing.join(', ')})`);
    return this.auditService
      .record(
        async (tx) => {
          const updated = await this.repository.updateAttribute(
            attributeId,
            {
              label: input.label,
              unit: input.unit,
              isRequired: input.isRequired,
              allowedValues: input.allowedValues,
              isFilterable: input.isFilterable,
              position: input.position,
            },
            tx,
          );
          return { updated, productType: (await this.repository.findById(existing.productTypeId, tx))! };
        },
        ({ updated }) => ({
          entity: 'AttributeDefinition',
          entityId: attributeId,
          action: 'UPDATE',
          userId: actorId,
          details: { changes: fieldChanges(existing, updated, AUDITED_ATTRIBUTE_FIELDS) },
        }),
      )
      .then(({ productType }) => productType);
  }

  async removeAttribute(attributeId: string, actorId: string): Promise<ProductTypeWithAttributes> {
    const existing = await this.findAttribute(attributeId);
    await this.findEditable(existing.productTypeId);
    await this.ensureUnused(existing.productTypeId, 'stripped of an attribute');
    return this.auditService
      .record(
        async (tx) => {
          const deleted = await this.repository.deleteAttribute(attributeId, tx);
          return { deleted, productType: (await this.repository.findById(existing.productTypeId, tx))! };
        },
        ({ deleted }) => ({
          entity: 'AttributeDefinition',
          entityId: attributeId,
          action: 'DELETE',
          userId: actorId,
          details: { before: fieldValues(deleted, AUDITED_ATTRIBUTE_FIELDS) },
        }),
      )
      .then(({ productType }) => productType);
  }

  private narrowingChanges(existing: AttributeDefinition, input: UpdateAttributeDefinitionInput): string[] {
    const changes: string[] = [];
    if (input.isRequired === true && !existing.isRequired) changes.push('made required');
    if (input.unit !== undefined && input.unit !== existing.unit) changes.push('unit changed');
    if (input.allowedValues !== undefined) {
      const removed =
        existing.allowedValues.length === 0
          ? input.allowedValues.length > 0
          : existing.allowedValues.some((value) => !input.allowedValues!.includes(value));
      if (removed) changes.push('allowed values narrowed');
    }
    return changes;
  }

  private async findEditable(id: string): Promise<ProductTypeWithAttributes> {
    const productType = await this.findOne(id);
    if (productType.isSystem) {
      throw new ConflictException(`Product type "${productType.key}" is a system type and cannot be changed`);
    }
    return productType;
  }

  private async findAttribute(id: string): Promise<AttributeDefinition> {
    const attribute = await this.repository.findAttributeById(id);
    if (!attribute) throw new NotFoundException(`Attribute definition "${id}" not found`);
    return attribute;
  }

  private async ensureUnused(productTypeId: string, change: string): Promise<void> {
    const products = await this.repository.countProducts(productTypeId);
    if (products > 0) {
      throw new ConflictException(
        `Product type "${productTypeId}" is used by ${products} product(s) and cannot be ${change}`,
      );
    }
  }
}
