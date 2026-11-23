import { ReadyForPickupNotifier } from './ready-for-pickup.notifier';

const ORDER = {
  id: 'order1',
  orderNumber: 10023,
  contactPhone: '024 412 3456',
  user: { email: 'kwame@gmail.com' },
  pickupLocation: {
    name: 'Osu Store',
    address: '12 Oxford St',
    city: 'Accra',
    contactPhone: '+233302000000',
    instructions: 'Ask at the front desk',
    openingHours: [{ weekday: 'SATURDAY', opensMinute: 540, closesMinute: 780 }],
  },
};

function build(order: object | null = ORDER) {
  const prisma = { order: { findUnique: jest.fn().mockResolvedValue(order) } };
  const email = { sendReadyForPickupEmail: jest.fn().mockResolvedValue(undefined) };
  const notifications = { queueReadyForPickupSms: jest.fn().mockResolvedValue(undefined) };
  const logger = { warn: jest.fn() };
  const notifier = new ReadyForPickupNotifier(prisma as never, email as never, notifications as never, logger as never);
  return { notifier, email, notifications, logger };
}

const notice = {
  orderNumber: 10023,
  pickupName: 'Osu Store',
  address: '12 Oxford St, Accra',
  hours: 'Mon-Fri closed, Sat 09:00-13:00, Sun closed',
  contactPhone: '+233302000000',
  instructions: 'Ask at the front desk',
};

describe('ReadyForPickupNotifier', () => {
  it('emails the account and queues one SMS to the contact phone, keyed by the event job id', async () => {
    const { notifier, email, notifications } = build();

    await notifier.notify('order1', 'evt1');

    expect(email.sendReadyForPickupEmail).toHaveBeenCalledWith('kwame@gmail.com', 'order1', notice, 'evt1');
    expect(notifications.queueReadyForPickupSms).toHaveBeenCalledWith('evt1-sms', { to: '+233244123456', notice });
  });

  it('skips the SMS, logging no number, when the contact phone is not a Ghana number', async () => {
    const { notifier, email, notifications, logger } = build({ ...ORDER, contactPhone: '+447700900123' });

    await notifier.notify('order1', 'evt1');

    expect(email.sendReadyForPickupEmail).toHaveBeenCalled();
    expect(notifications.queueReadyForPickupSms).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).not.toContain('447700');
  });

  it('sends nothing for an order that is gone', async () => {
    const { notifier, email, notifications } = build(null);

    await notifier.notify('order1', 'evt1');

    expect(email.sendReadyForPickupEmail).not.toHaveBeenCalled();
    expect(notifications.queueReadyForPickupSms).not.toHaveBeenCalled();
  });
});
