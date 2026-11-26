import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  ImportFileFormat,
  ImportJobStatus,
  ImportKind,
  ImportRowAction,
  ImportRowStatus,
} from '../../generated/prisma/client';

registerEnumType(ImportKind, {
  name: 'ImportKind',
  description: 'What a bulk import changes',
  valuesMap: {
    PRODUCTS: { description: 'Create or update products and variants, keyed by SKU' },
    PRICES: { description: "Set variants' base prices, keyed by SKU" },
    STOCK: { description: 'Adjust stock by a delta or to a counted quantity, per SKU and location' },
  },
});
registerEnumType(ImportJobStatus, {
  name: 'ImportJobStatus',
  description: 'QUEUED → VALIDATING → VALIDATED (dry run) → APPLYING → COMPLETED; FAILED; CANCELLED',
});
registerEnumType(ImportFileFormat, { name: 'ImportFileFormat' });
registerEnumType(ImportRowStatus, {
  name: 'ImportRowStatus',
  description:
    'VALID/INVALID after validation; APPLIED, SKIPPED (nothing to change) or FAILED (refused) after applying',
});
registerEnumType(ImportRowAction, { name: 'ImportRowAction', description: 'What applying the row does' });

@ObjectType('ImportRow', { description: 'One data row of an import file and its outcome' })
export class ImportRowEntity {
  @Field(() => ID)
  id: string;

  @Field(() => Int, { description: 'Line in the sheet; the header is line 1' })
  rowNumber: number;

  @Field(() => String, { nullable: true })
  sku: string | null;

  @Field(() => ImportRowStatus)
  status: ImportRowStatus;

  @Field(() => ImportRowAction)
  action: ImportRowAction;

  @Field(() => [String])
  errors: string[];

  @Field(() => [String])
  warnings: string[];

  @Field(() => ID, { nullable: true, description: 'The variant, product or stock movement the row changed' })
  entityId: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  appliedAt: Date | null;
}

@ObjectType('ImportRowPage')
export class ImportRowPageEntity {
  @Field(() => [ImportRowEntity])
  nodes: ImportRowEntity[];

  @Field(() => Int)
  totalCount: number;

  @Field()
  hasNextPage: boolean;
}

@ObjectType('ImportJob', { description: 'A bulk CSV/Excel import (P8-I). The uploaded file itself is never exposed.' })
export class ImportJobEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ImportKind)
  kind: ImportKind;

  @Field(() => ImportJobStatus)
  status: ImportJobStatus;

  @Field(() => ImportFileFormat)
  format: ImportFileFormat;

  @Field()
  fileName: string;

  @Field(() => String, { nullable: true })
  sheetName: string | null;

  @Field(() => Int)
  fileSize: number;

  @Field({ description: 'True when the valid rows are applied as soon as validation ends (no dry run)' })
  applyAfterValidation: boolean;

  @Field(() => Int)
  totalRows: number;

  @Field(() => Int)
  validRows: number;

  @Field(() => Int)
  invalidRows: number;

  @Field(() => Int)
  appliedRows: number;

  @Field(() => Int)
  skippedRows: number;

  @Field(() => Int)
  failedRows: number;

  @Field(() => String, { nullable: true, description: 'Why the whole job failed' })
  error: string | null;

  @Field(() => ID)
  createdById: string;

  @Field(() => ID, { nullable: true })
  appliedById: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  validatedAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  completedAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  cancelledAt: Date | null;
}

@ObjectType('ImportJobPage')
export class ImportJobPageEntity {
  @Field(() => [ImportJobEntity])
  nodes: ImportJobEntity[];

  @Field(() => Int)
  totalCount: number;

  @Field()
  hasNextPage: boolean;
}
