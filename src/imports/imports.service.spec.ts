import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ImportJobStatus, ImportKind } from '../generated/prisma/client';
import { AuditEntry } from '../commons/audit.service';
import { CATALOG_IMPORT_KINDS, ImportsService } from './imports.service';

function build(job: Partial<{ status: ImportJobStatus; kind: ImportKind; applyRuns: number }> = {}) {
  const current = {
    id: 'imp1',
    kind: ImportKind.PRICES,
    status: ImportJobStatus.VALIDATED,
    applyRuns: 0,
    validRows: 3,
    ...job,
  };
  const tx = {
    importJob: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'imp1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(async () => ({ ...current, status: ImportJobStatus.APPLYING, applyRuns: 1 })),
    },
  };
  const prisma = {
    importJob: { findFirst: jest.fn().mockResolvedValue(current), update: jest.fn() },
  };
  const logged: AuditEntry[] = [];
  const audit = {
    record: jest.fn(async (change: (client: typeof tx) => Promise<unknown>, entry: (result: unknown) => AuditEntry) => {
      const result = await change(tx);
      logged.push(entry(result));
      return result;
    }),
  };
  const logger = { error: jest.fn() };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const service = new ImportsService(prisma as never, audit as never, logger as never, queue as never);
  return { service, tx, prisma, logged, queue };
}

const csv = (text: string) => ({ buffer: Buffer.from(text), originalname: 'prices.csv' });

describe('ImportsService', () => {
  it('stores a sniffed upload as a QUEUED job, audits it and queues its validation', async () => {
    const { service, tx, logged, queue } = build();

    await service.upload(ImportKind.PRICES, csv('sku,base_price\nA,1.00\n'), { apply: false }, 'staff1');

    expect(tx.importJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'PRICES', format: 'CSV', fileName: 'prices.csv', createdById: 'staff1' }),
      }),
    );
    expect(logged).toEqual([
      expect.objectContaining({ entity: 'ImportJob', entityId: 'imp1', action: 'CREATE', userId: 'staff1' }),
    ]);
    expect(queue.add).toHaveBeenCalledWith('import.validate', { importJobId: 'imp1' }, { jobId: 'imp1-validate' });
  });

  it('refuses a missing file, a binary file and a sheet name on a CSV before storing anything', async () => {
    const { service, tx } = build();

    await expect(service.upload(ImportKind.PRICES, undefined, { apply: false }, 's')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.upload(
        ImportKind.PRICES,
        { buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), originalname: 'a.csv' },
        { apply: false },
        's',
      ),
    ).rejects.toThrow('Legacy Excel');
    await expect(service.upload(ImportKind.PRICES, csv('sku\n'), { sheet: 'Data', apply: false }, 's')).rejects.toThrow(
      'A CSV file has no sheets',
    );
    expect(tx.importJob.create).not.toHaveBeenCalled();
  });

  it('applies a validated job with a conditional move, a STATUS_CHANGE audit row and a run-specific queue job', async () => {
    const { service, tx, logged, queue } = build();

    await service.apply('imp1', CATALOG_IMPORT_KINDS, 'staff2');

    expect(tx.importJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'imp1', status: { in: ['VALIDATED', 'FAILED'] }, validatedAt: { not: null } },
      data: { status: 'APPLYING', applyRuns: { increment: 1 }, appliedById: 'staff2', error: null },
    });
    expect(logged).toEqual([
      expect.objectContaining({
        entity: 'ImportJob',
        action: 'STATUS_CHANGE',
        userId: 'staff2',
        details: { from: 'VALIDATED', to: 'APPLYING', run: 1, validRows: 3 },
      }),
    ]);
    expect(queue.add).toHaveBeenCalledWith('import.apply', { importJobId: 'imp1' }, { jobId: 'imp1-apply-1' });
  });

  it('refuses to apply a job that is not validated, or of a kind the caller may not handle', async () => {
    const { service, tx, prisma, queue } = build({ status: ImportJobStatus.COMPLETED });
    tx.importJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.apply('imp1', CATALOG_IMPORT_KINDS, 's')).rejects.toThrow(ConflictException);
    prisma.importJob.findFirst.mockResolvedValue(null);
    await expect(service.apply('imp1', [ImportKind.STOCK], 's')).rejects.toThrow(NotFoundException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('cancels a queued or validated job, dropping its file, with an audit row', async () => {
    const { service, tx, logged } = build();

    await service.cancel('imp1', CATALOG_IMPORT_KINDS, 'staff3');

    expect(tx.importJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'imp1', status: { in: ['QUEUED', 'VALIDATED'] } },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date), file: null },
    });
    expect(logged).toEqual([
      expect.objectContaining({
        action: 'STATUS_CHANGE',
        userId: 'staff3',
        details: { from: 'VALIDATED', to: 'CANCELLED' },
      }),
    ]);
  });

  it('fails the job when its validation cannot be queued', async () => {
    const { service, prisma, queue } = build();
    queue.add.mockRejectedValue(new Error('redis down'));

    await expect(service.upload(ImportKind.PRICES, csv('sku\n'), { apply: false }, 's')).rejects.toThrow('redis down');
    expect(prisma.importJob.update).toHaveBeenCalledWith({
      where: { id: 'imp1' },
      data: { status: 'FAILED', error: 'The job could not be queued; upload the file again' },
    });
  });
});
