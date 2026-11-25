import { INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../../src/prisma/prisma.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { SMS_PROVIDER } from '../../src/notifications/sms/sms-provider.port';
import { AppMetrics } from '../../src/observability/metrics';
import { clearQueues, createTestWorker } from '../helpers/worker.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

// SMS go out from the worker through the template registry, each recorded as a Notification row (P6-N.2). The SMS
// gateway is the fake here.
describe('SMS through templates and Notification rows (e2e)', () => {
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  const provider = { send: jest.fn<Promise<{ messageId: string; status?: string }>, [string, string]>() };

  const otpRows = () =>
    prisma.notification.findMany({ where: { templateKey: 'account.phone_otp' }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    worker = await createTestWorker((builder) => builder.overrideProvider(SMS_PROVIDER).useValue(provider));
    prisma = worker.get(PrismaService);
    await clearQueues(worker);
    await resetDb(prisma);
    await seedMinimal(prisma);
  });

  beforeEach(async () => {
    provider.send.mockReset();
    await prisma.notification.deleteMany();
  });

  afterAll(async () => {
    await clearQueues(worker);
    await resetDb(prisma);
    await worker.close();
  });

  it('renders the code SMS from its template and stores the provider message id and status', async () => {
    provider.send.mockResolvedValue({ messageId: 'hub-1', status: '0' });
    const sms = jest.spyOn(worker.get(AppMetrics), 'recordSms');

    await worker.get(NotificationsService).queuePhoneOtpSms('seed_user', '+233244123456', '482913', 10);

    await waitUntil(async () => (await otpRows()).some((row) => row.status === 'SENT'));
    expect(provider.send).toHaveBeenCalledWith(
      '+233244123456',
      '482913 is your verification code. It expires in 10 minutes. Never share it with anyone.',
    );
    expect(await otpRows()).toEqual([
      expect.objectContaining({
        userId: 'seed_user',
        category: 'TRANSACTIONAL',
        channel: 'SMS',
        templateVersion: 1,
        status: 'SENT',
        providerMessageId: 'hub-1',
        providerStatus: '0',
        attempts: 1,
      }),
    ]);
    expect(sms).toHaveBeenCalledWith('account.phone_otp', 'sent');
  });

  it('records a refused send as FAILED and the retry as SENT, on one row', async () => {
    provider.send
      .mockRejectedValueOnce(new Error('Hubtel SMS refused: HTTP 503'))
      .mockResolvedValue({ messageId: 'hub-2', status: '0' });

    await worker.get(NotificationsService).queuePhoneOtpSms('seed_user', '+233244123456', '111222', 10);

    await waitUntil(async () => (await otpRows()).some((row) => row.status === 'FAILED'));
    await waitUntil(async () => (await otpRows()).some((row) => row.status === 'SENT'), 30_000);
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(await otpRows()).toEqual([
      expect.objectContaining({ status: 'SENT', providerMessageId: 'hub-2', attempts: 2, errorCode: null }),
    ]);
  });
});
