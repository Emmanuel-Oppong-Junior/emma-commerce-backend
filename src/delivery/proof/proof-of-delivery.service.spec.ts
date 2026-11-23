import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ProofOfDeliveryService } from './proof-of-delivery.service';

const tx = { tx: true };
const dispatchedAt = new Date('2026-11-23T09:00:00Z');
const repository = { findShipmentForProof: jest.fn(), runTransaction: jest.fn(), create: jest.fn() };
const shipments = { lockShipment: jest.fn(), deliverWithProof: jest.fn() };
const payments = { recordDeliveredCash: jest.fn() };
const codes = { check: jest.fn() };
const cloudinary = { urlFor: jest.fn((id: string) => `https://res.cloudinary.test/${id}`) };
const auditService = { log: jest.fn() };
const metrics = { recordDeliveryCodeFailure: jest.fn(), recordDeliveryOverride: jest.fn() };
const logger = { log: jest.fn(), warn: jest.fn() };

const service = new ProofOfDeliveryService(
  repository as never,
  shipments as never,
  payments as never,
  codes as never,
  cloudinary as never,
  auditService as never,
  metrics as never,
  logger as never,
);

const shipment = (overrides: object = {}) => ({
  id: 'ship1',
  status: 'OUT_FOR_DELIVERY',
  riderId: 'rider1',
  dispatchedAt,
  ...overrides,
});
const rider = { id: 'rider1', asRider: true, mayOverride: false };
const manager = { id: 'mgr1', asRider: false, mayOverride: true };

function given(paymentMethod = 'ONLINE', current: object = {}) {
  repository.findShipmentForProof.mockResolvedValue({ ...shipment(), order: { id: 'order1', paymentMethod } });
  shipments.lockShipment.mockResolvedValue({
    order: { id: 'order1', paymentMethod, fulfillmentType: 'DELIVERY' },
    shipment: shipment(current),
  });
}

describe('ProofOfDeliveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repository.runTransaction.mockImplementation(async (work: (t: unknown) => unknown) => work(tx));
    repository.create.mockImplementation(async (_tx, proof) => ({ id: 'pod1', ...proof }));
    codes.check.mockResolvedValue({ result: 'MATCH' });
    payments.recordDeliveredCash.mockResolvedValue('cc1');
  });

  it('delivers a rider’s online shipment with the right code: proof, DELIVERED and an audit row in one transaction', async () => {
    given();

    await service.complete(
      {
        shipmentId: 'ship1',
        code: '123456',
        photoPublicId: 'proof-of-delivery/ship1/p1',
        latitude: 5.5560001,
        longitude: -0.19,
      },
      rider,
    );

    expect(codes.check).toHaveBeenCalledWith('ship1', dispatchedAt, '123456');
    expect(repository.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        shipmentId: 'ship1',
        method: 'CODE',
        overrideReason: null,
        deliveredById: 'rider1',
        photoPublicId: 'proof-of-delivery/ship1/p1',
        photoUrl: 'https://res.cloudinary.test/proof-of-delivery/ship1/p1',
        latitude: new Prisma.Decimal('5.556000'),
        longitude: new Prisma.Decimal('-0.190000'),
      }),
    );
    expect(shipments.deliverWithProof).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: 'order1' }),
      shipment(),
      'rider1',
    );
    expect(payments.recordDeliveredCash).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'Shipment',
        entityId: 'ship1',
        action: 'PROOF_OF_DELIVERY',
        userId: 'rider1',
        details: expect.objectContaining({ method: 'CODE', riderId: 'rider1', photo: true }),
      }),
      tx,
    );
    expect(metrics.recordDeliveryOverride).not.toHaveBeenCalled();
  });

  it('records cash on delivery in the same transaction, as taken by the shipment’s rider', async () => {
    given('CASH_ON_DELIVERY');
    const cash = new Prisma.Decimal('40.00');

    await service.complete(
      { shipmentId: 'ship1', overrideReason: 'Customer has no phone', cashCollected: cash },
      manager,
    );

    expect(payments.recordDeliveredCash).toHaveBeenCalledWith(
      tx,
      { orderId: 'order1', riderId: 'rider1', amount: cash, collectedAt: expect.any(Date) },
      'mgr1',
    );
    expect(shipments.deliverWithProof).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ method: 'OVERRIDE', overrideReason: 'Customer has no phone', deliveredById: 'mgr1' }),
    );
    expect(auditService.log.mock.calls[0][0].details).toMatchObject({ cashCollectionId: 'cc1', method: 'OVERRIDE' });
    expect(codes.check).not.toHaveBeenCalled();
    expect(metrics.recordDeliveryOverride).toHaveBeenCalledTimes(1);
  });

  it('refuses a wrong code, counts it and writes nothing', async () => {
    given();
    codes.check.mockResolvedValue({ result: 'MISMATCH', attemptsLeft: 2 });

    await expect(service.complete({ shipmentId: 'ship1', code: '000000' }, rider)).rejects.toThrow(BadRequestException);
    expect(metrics.recordDeliveryCodeFailure).toHaveBeenCalledWith('WRONG_CODE');
    expect(repository.runTransaction).not.toHaveBeenCalled();
  });

  it('says NOT_FOUND to a rider for another rider’s shipment, before touching the code', async () => {
    given();

    await expect(service.complete({ shipmentId: 'ship1', code: '123456' }, { ...rider, id: 'rider2' })).rejects.toThrow(
      NotFoundException,
    );
    expect(codes.check).not.toHaveBeenCalled();
  });

  it('never lets a rider override, and needs the cash for cash on delivery before checking the code', async () => {
    given();
    await expect(
      service.complete({ shipmentId: 'ship1', overrideReason: 'x' }, { ...rider, mayOverride: true }),
    ).rejects.toThrow('delivery.override');

    given('CASH_ON_DELIVERY');
    await expect(service.complete({ shipmentId: 'ship1', code: '123456' }, rider)).rejects.toThrow(BadRequestException);
    expect(codes.check).not.toHaveBeenCalled();
  });

  it('refuses when the shipment changed between the code check and the lock', async () => {
    given('ONLINE', { dispatchedAt: new Date(dispatchedAt.getTime() + 1000) });

    await expect(service.complete({ shipmentId: 'ship1', code: '123456' }, rider)).rejects.toThrow(ConflictException);
    expect(repository.create).not.toHaveBeenCalled();
  });
});
