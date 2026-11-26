import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ImportKind, ImportRowStatus } from '../generated/prisma/client';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { ImportJobEntity, ImportJobPageEntity, ImportRowPageEntity } from './entities/import-job.entity';
import { CATALOG_IMPORT_KINDS, ImportsService, STOCK_IMPORT_KINDS } from './imports.service';
import { ImportJobRecord } from './import-queue';

const PRODUCTS = [ImportKind.PRODUCTS];
const PRICES = [ImportKind.PRICES];
const PAGE = { type: () => Int, nullable: true, defaultValue: 20 } as const;

// Catalogue imports (products, prices) need catalog.import; stock imports inventory.import. Applying a price import is
// a price change, so it also needs step-up. Uploads and reports are REST (ImportsController).
@Resolver(() => ImportJobEntity)
export class ImportsResolver {
  constructor(private readonly importsService: ImportsService) {}

  @RequirePermission('catalog.import')
  @Query(() => ImportJobPageEntity, { description: 'Staff (catalog.import): product and price imports, newest first' })
  catalogImportJobs(@Args('first', PAGE) first: number, @Args('after', { nullable: true }) after?: string) {
    return this.importsService.list(CATALOG_IMPORT_KINDS, first, after);
  }

  @RequirePermission('catalog.import')
  @Query(() => ImportJobEntity, { description: 'Staff (catalog.import): one product or price import' })
  catalogImportJob(@Args('id', { type: () => ID }) id: string) {
    return this.importsService.get(id, CATALOG_IMPORT_KINDS);
  }

  @RequirePermission('inventory.import')
  @Query(() => ImportJobPageEntity, { description: 'Staff (inventory.import): stock imports, newest first' })
  stockImportJobs(@Args('first', PAGE) first: number, @Args('after', { nullable: true }) after?: string) {
    return this.importsService.list(STOCK_IMPORT_KINDS, first, after);
  }

  @RequirePermission('inventory.import')
  @Query(() => ImportJobEntity, { description: 'Staff (inventory.import): one stock import' })
  stockImportJob(@Args('id', { type: () => ID }) id: string) {
    return this.importsService.get(id, STOCK_IMPORT_KINDS);
  }

  @RequirePermission('catalog.import')
  @Mutation(() => ImportJobEntity, {
    description:
      'Staff (catalog.import): applies the valid rows of a validated products import (or re-runs a failed apply)',
  })
  applyProductImport(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.importsService.apply(id, PRODUCTS, actorId);
  }

  @RequirePermission('catalog.import')
  @RequireStepUp()
  @Mutation(() => ImportJobEntity, {
    description: 'Staff (catalog.import, step-up): applies the valid rows of a validated prices import',
  })
  applyPriceImport(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.importsService.apply(id, PRICES, actorId);
  }

  @RequirePermission('inventory.import')
  @Mutation(() => ImportJobEntity, {
    description: 'Staff (inventory.import): applies the valid rows of a validated stock import',
  })
  applyStockImport(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.importsService.apply(id, STOCK_IMPORT_KINDS, actorId);
  }

  @RequirePermission('catalog.import')
  @Mutation(() => ImportJobEntity, {
    description: 'Staff (catalog.import): cancels a queued or validated catalogue import',
  })
  cancelCatalogImport(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.importsService.cancel(id, CATALOG_IMPORT_KINDS, actorId);
  }

  @RequirePermission('inventory.import')
  @Mutation(() => ImportJobEntity, {
    description: 'Staff (inventory.import): cancels a queued or validated stock import',
  })
  cancelStockImport(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.importsService.cancel(id, STOCK_IMPORT_KINDS, actorId);
  }

  // Reached only through the permission-guarded import queries and mutations above.
  @ResolveField(() => ImportRowPageEntity, { description: 'The per-row report, by row number' })
  rows(
    @Parent() job: ImportJobRecord,
    @Args('status', { type: () => ImportRowStatus, nullable: true }) status: ImportRowStatus | undefined,
    @Args('first', { ...PAGE, defaultValue: 50 }) first: number,
    @Args('after', { nullable: true }) after?: string,
  ) {
    return this.importsService.rows(job.id, status, first, after);
  }
}
