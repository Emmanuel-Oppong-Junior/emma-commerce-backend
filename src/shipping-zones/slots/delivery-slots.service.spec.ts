import { BadRequestException, ConflictException } from '@nestjs/common';
import { DeliverySlotsService } from './delivery-slots.service';
import { DeliverySlotsRepository } from './delivery-slots.repository';
import { AUDIT_TX, createAuditServiceMock, withoutUndefined } from '../../../test/helpers/audit.helper';

const fixedDate = new Date('2026-11-01T00:00:00.000Z');
const slot = {
  id: 'slot1',
  zoneId: 'zone1',
  weekday: 'MONDAY' as const,
  startMinute: 540,
  endMinute: 720,
  capacity: 5,
  cutoffHours: 2,
  isActive: true,
  createdAt: fixedDate,
  updatedAt: fixedDate,
};
const closure = { id: 'c1', zoneId: 'zone1', date: new Date('2026-12-25T00:00:00Z'), reason: 'Christmas' };

describe('DeliverySlotsService', () => {
  let repository: jest.Mocked<
    Pick<
      DeliverySlotsRepository,
      | 'calendar'
      | 'book'
      | 'findSlot'
      | 'createSlot'
      | 'updateSlot'
      | 'deleteSlot'
      | 'countBookings'
      | 'findClosure'
      | 'createClosure'
      | 'deleteClosure'
    >
  >;
  let audit: ReturnType<typeof createAuditServiceMock>;
  let service: DeliverySlotsService;

  beforeEach(() => {
    repository = {
      calendar: jest.fn(),
      book: jest.fn(),
      findSlot: jest.fn().mockResolvedValue(slot),
      createSlot: jest.fn().mockImplementation(async (zoneId, data) => ({ ...slot, ...data, zoneId })),
      updateSlot: jest.fn().mockImplementation(async (id, data) => ({ ...slot, ...withoutUndefined(data), id })),
      deleteSlot: jest.fn().mockResolvedValue(slot),
      countBookings: jest.fn().mockResolvedValue(0),
      findClosure: jest.fn().mockResolvedValue(closure),
      createClosure: jest.fn().mockResolvedValue(closure),
      deleteClosure: jest.fn().mockResolvedValue(closure),
    };
    audit = createAuditServiceMock();
    service = new DeliverySlotsService(repository as never, audit as never);
  });

  it('stores a window as minutes from midnight and shows it as HH:MM', async () => {
    const created = await service.createSlot(
      'zone1',
      { weekday: 'MONDAY', startTime: '09:00', endTime: '12:00', capacity: 5 },
      'admin1',
    );

    expect(repository.createSlot).toHaveBeenCalledWith(
      'zone1',
      { weekday: 'MONDAY', startMinute: 540, endMinute: 720, capacity: 5, cutoffHours: 0, isActive: true },
      AUDIT_TX,
    );
    expect(created).toMatchObject({ startTime: '09:00', endTime: '12:00' });
  });

  it.each([
    ['a window ending before it starts', { startTime: '12:00', endTime: '09:00' }],
    ['a time that is not HH:MM in the day', { startTime: '25:00', endTime: '26:00' }],
  ])('refuses %s', async (_name, times) => {
    await expect(service.createSlot('zone1', { weekday: 'MONDAY', capacity: 5, ...times }, 'admin1')).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.createSlot).not.toHaveBeenCalled();
  });

  it('checks a changed end against the stored start', async () => {
    await expect(service.updateSlot('slot1', { endTime: '08:00' }, 'admin1')).rejects.toThrow(BadRequestException);
  });

  it('refuses to delete a slot that has bookings', async () => {
    repository.countBookings.mockResolvedValue(1);

    await expect(service.deleteSlot('slot1', 'admin1')).rejects.toThrow(ConflictException);
    expect(repository.deleteSlot).not.toHaveBeenCalled();
  });

  it('turns a failed booking into CONFLICT with reason SLOT_FULL', async () => {
    repository.book.mockResolvedValue(false);

    const error = await service
      .book(AUDIT_TX, { slotId: 'slot1', date: '2026-11-30', capacity: 5 })
      .catch((e: ConflictException) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ extensions: { reason: 'SLOT_FULL' } });
  });

  it('builds the checkout calendar from templates, closures and bookings', async () => {
    repository.calendar.mockResolvedValue({
      templates: [slot],
      closures: [closure],
      bookings: [{ id: 'b1', slotId: 'slot1', date: new Date('2026-11-30T00:00:00Z'), booked: 3 }],
    });

    const calendar = await service.calendar('zone1', new Date('2026-11-23T10:00:00Z'));

    expect(repository.calendar).toHaveBeenCalledWith('zone1', '2026-11-23', '2026-11-30', undefined);
    expect([...calendar.closedDates]).toEqual(['2026-12-25']);
    expect([...calendar.booked]).toEqual([['slot1|2026-11-30', 3]]);
  });

  describe('audit trail', () => {
    it.each<[string, () => Promise<unknown>, object]>([
      [
        'createDeliverySlot',
        () =>
          service.createSlot(
            'zone1',
            { weekday: 'MONDAY', startTime: '09:00', endTime: '12:00', capacity: 5 },
            'admin1',
          ),
        { entity: 'DeliverySlot', entityId: 'slot1', action: 'CREATE' },
      ],
      [
        'updateDeliverySlot',
        () => service.updateSlot('slot1', { capacity: 8 }, 'admin1'),
        { entity: 'DeliverySlot', action: 'UPDATE', details: { changes: { capacity: { from: 5, to: 8 } } } },
      ],
      ['deleteDeliverySlot', () => service.deleteSlot('slot1', 'admin1'), { entity: 'DeliverySlot', action: 'DELETE' }],
      [
        'addDeliveryClosure',
        () => service.addClosure('zone1', { date: '2026-12-25', reason: 'Christmas' }, 'admin1'),
        {
          entity: 'DeliveryClosure',
          action: 'CREATE',
          details: { after: { zoneId: 'zone1', date: '2026-12-25', reason: 'Christmas' } },
        },
      ],
      [
        'removeDeliveryClosure',
        () => service.removeClosure('c1', 'admin1'),
        { entity: 'DeliveryClosure', action: 'DELETE' },
      ],
    ])('%s writes an audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      await act();

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin1', ...expected }), AUDIT_TX);
    });
  });
});
