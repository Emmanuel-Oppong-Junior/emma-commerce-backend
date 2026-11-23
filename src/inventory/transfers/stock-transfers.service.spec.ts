import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { StockTransfersService } from './stock-transfers.service';
import { createAuditServiceMock } from '../../../test/helpers/audit.helper';

const tx = { tx: true };

function transfer(status: string, lines = [{ variantId: 'v1', quantity: 5 }]) {
  return {
    id: 't1',
    fromLocationId: 'main',
    toLocationId: 'branch',
    status,
    lines: lines.map((line, i) => ({ id: `l${i}`, receivedQuantity: null, varianceNote: null, ...line })),
  };
}

describe('StockTransfersService', () => {
  let repository: Record<string, jest.Mock>;
  let ledger: Record<string, jest.Mock>;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let lots: Record<string, jest.Mock>;
  let service: StockTransfersService;

  beforeEach(() => {
    repository = {
      findById: jest.fn(),
      findByIdOrThrow: jest.fn(),
      findLocation: jest.fn().mockResolvedValue({ name: 'x', isActive: true }),
      existingVariantIds: jest.fn().mockResolvedValue(['v1']),
      create: jest.fn().mockResolvedValue(transfer('DRAFT')),
      transition: jest.fn().mockResolvedValue(true),
      recordReceipt: jest.fn(),
    };
    ledger = {
      transferOut: jest.fn().mockResolvedValue({ id: 'mv' }),
      transferIn: jest.fn().mockResolvedValue({ id: 'mv' }),
      available: jest.fn(),
    };
    audit = createAuditServiceMock();
    const prisma = { $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)) };
    lots = { transferReceiptLots: jest.fn().mockResolvedValue(undefined) };
    service = new StockTransfersService(
      repository as never,
      ledger as never,
      prisma as never,
      audit as never,
      lots as never,
      {
        dispatchTransfer: jest.fn(),
        receiveTransfer: jest.fn(),
      } as never,
    );
  });

  describe('create', () => {
    const input = { fromLocationId: 'main', toLocationId: 'branch', lines: [{ variantId: 'v1', quantity: 5 }] };

    it('creates a draft between two active locations and audits it', async () => {
      await service.create(input, 'clerk');

      expect(repository.create).toHaveBeenCalledWith(tx, { ...input, createdById: 'clerk' });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'StockTransfer', entityId: 't1', action: 'CREATE', userId: 'clerk' }),
        tx,
      );
    });

    it('refuses an invalid draft before touching the database', async () => {
      await expect(service.create({ ...input, toLocationId: 'main' }, 'clerk')).rejects.toThrow(BadRequestException);
      expect(repository.findLocation).not.toHaveBeenCalled();
    });

    it('refuses an inactive or unknown location and an unknown variant', async () => {
      repository.findLocation.mockResolvedValueOnce({ name: 'Closed', isActive: false });
      await expect(service.create(input, 'clerk')).rejects.toThrow(BadRequestException);
      repository.findLocation.mockResolvedValueOnce(null);
      await expect(service.create(input, 'clerk')).rejects.toThrow(NotFoundException);
      repository.existingVariantIds.mockResolvedValue([]);
      await expect(service.create(input, 'clerk')).rejects.toThrow(new NotFoundException('Variant "v1" not found'));
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('dispatch', () => {
    beforeEach(() => {
      repository.findByIdOrThrow.mockResolvedValue(transfer('DISPATCHED'));
    });

    it('claims the draft, then takes each line off the source as a TRANSFER referencing the transfer', async () => {
      await service.dispatch('t1', 'clerk');

      expect(repository.transition).toHaveBeenCalledWith(
        tx,
        't1',
        'DRAFT',
        'DISPATCHED',
        expect.objectContaining({ dispatchedById: 'clerk' }),
      );
      expect(ledger.transferOut).toHaveBeenCalledWith(tx, 'v1', 'main', 5, {
        refType: 'StockTransfer',
        refId: 't1',
        actorId: 'clerk',
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'STATUS_CHANGE', details: { from: 'DRAFT', to: 'DISPATCHED' } }),
        tx,
      );
    });

    it('fails the whole dispatch when the source lacks units of a line', async () => {
      ledger.transferOut.mockResolvedValue(null);
      ledger.available.mockResolvedValue(2);

      await expect(service.dispatch('t1', 'clerk')).rejects.toThrow(
        new BadRequestException('Cannot dispatch 5 of variant "v1": only 2 available at the source'),
      );
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('is a CONFLICT when the transfer is no longer a draft', async () => {
      repository.transition.mockResolvedValue(false);
      repository.findById.mockResolvedValue(transfer('DISPATCHED'));

      await expect(service.dispatch('t1', 'clerk')).rejects.toThrow(ConflictException);
      expect(ledger.transferOut).not.toHaveBeenCalled();
    });

    it('is NOT_FOUND for an unknown transfer', async () => {
      repository.transition.mockResolvedValue(false);
      repository.findById.mockResolvedValue(null);

      await expect(service.dispatch('nope', 'clerk')).rejects.toThrow(NotFoundException);
    });
  });

  describe('receive', () => {
    const lines = [
      { variantId: 'v1', quantity: 5 },
      { variantId: 'v2', quantity: 2 },
    ];

    beforeEach(() => {
      repository.findById.mockResolvedValue(transfer('DISPATCHED', lines));
      repository.findByIdOrThrow.mockResolvedValue(transfer('DISPATCHED', lines));
    });

    it('adds what arrived at the destination and records the shortfall on its line', async () => {
      await service.receive('t1', [{ variantId: 'v1', receivedQuantity: 3, note: 'Crushed' }], 'clerk');

      expect(repository.transition).toHaveBeenCalledWith(
        tx,
        't1',
        'DISPATCHED',
        'PARTIALLY_RECEIVED',
        expect.objectContaining({ receivedById: 'clerk' }),
      );
      expect(repository.recordReceipt).toHaveBeenCalledWith(
        tx,
        't1',
        expect.objectContaining({ variantId: 'v1', receivedQuantity: 3, variance: 2, varianceNote: 'Crushed' }),
      );
      expect(ledger.transferIn).toHaveBeenCalledWith(tx, 'v1', 'branch', 3, {
        refType: 'StockTransfer',
        refId: 't1',
        actorId: 'clerk',
        note: 'Short by 2: Crushed',
      });
      expect(ledger.transferIn).toHaveBeenCalledWith(tx, 'v2', 'branch', 2, expect.anything());
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          details: {
            from: 'DISPATCHED',
            to: 'PARTIALLY_RECEIVED',
            variances: [{ variantId: 'v1', variance: 2, note: 'Crushed' }],
          },
        }),
        tx,
      );
    });

    it('writes no movement for a line where nothing arrived', async () => {
      await service.receive('t1', [{ variantId: 'v2', receivedQuantity: 0, note: 'Lost' }], 'clerk');

      expect(ledger.transferIn).toHaveBeenCalledTimes(1);
      expect(ledger.transferIn).toHaveBeenCalledWith(tx, 'v1', 'branch', 5, expect.anything());
    });

    it('refuses an invalid receipt without claiming the transfer', async () => {
      await expect(service.receive('t1', [{ variantId: 'v1', receivedQuantity: 9 }], 'clerk')).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.transition).not.toHaveBeenCalled();
    });

    it('is a CONFLICT when another request received it first', async () => {
      repository.transition.mockResolvedValue(false);

      await expect(service.receive('t1', [], 'clerk')).rejects.toThrow(ConflictException);
      expect(ledger.transferIn).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('cancels a draft with the reason audited', async () => {
      repository.findByIdOrThrow.mockResolvedValue(transfer('CANCELLED'));

      await service.cancel('t1', 'clerk', 'Wrong branch');

      expect(repository.transition).toHaveBeenCalledWith(
        tx,
        't1',
        'DRAFT',
        'CANCELLED',
        expect.objectContaining({ cancelledById: 'clerk' }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ details: { from: 'DRAFT', to: 'CANCELLED', reason: 'Wrong branch' } }),
        tx,
      );
    });

    it('is a CONFLICT once dispatched', async () => {
      repository.transition.mockResolvedValue(false);
      repository.findById.mockResolvedValue(transfer('DISPATCHED'));

      await expect(service.cancel('t1', 'clerk')).rejects.toThrow(/is DISPATCHED; it cannot become CANCELLED/);
    });
  });
});
