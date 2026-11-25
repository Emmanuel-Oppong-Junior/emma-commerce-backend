import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateStoreSettingsInput } from './update-store-settings.input';

const invalidFields = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(UpdateStoreSettingsInput, body))).map((error) => error.property);

describe('UpdateStoreSettingsInput', () => {
  it('accepts an empty update', async () => {
    await expect(invalidFields({})).resolves.toEqual([]);
  });

  it('accepts a full, valid update', async () => {
    await expect(
      invalidFields({
        legalName: 'Emma Commerce Ltd',
        tradingName: 'Emma Mart',
        tin: 'GHA-123456789-0',
        vatRegistered: true,
        pricesIncludeTax: false,
        supportEmail: 'help@example.com',
        supportPhone: '+233244000000',
        abandonedCartReminderDelayHours: 6,
      }),
    ).resolves.toEqual([]);
  });

  it('lets the optional contact and TIN fields be cleared with null', async () => {
    await expect(invalidFields({ tin: null, supportEmail: null, supportPhone: null })).resolves.toEqual([]);
  });

  it.each(['legalName', 'tradingName', 'vatRegistered', 'pricesIncludeTax'])(
    'rejects null for %s, which cannot be cleared',
    async (field) => {
      await expect(invalidFields({ [field]: null })).resolves.toEqual([field]);
    },
  );

  it.each(['', '   '])('rejects a blank legal name (%j)', async (legalName) => {
    await expect(invalidFields({ legalName })).resolves.toEqual(['legalName']);
  });

  it.each(['P001 234', 'P0012345678901234567890', 'P001/2345', ''])('rejects the TIN %j', async (tin) => {
    await expect(invalidFields({ tin })).resolves.toEqual(['tin']);
  });

  it.each([0, 73, 2.5, null])(
    'rejects the abandoned-cart reminder delay %p',
    async (abandonedCartReminderDelayHours) => {
      await expect(invalidFields({ abandonedCartReminderDelayHours })).resolves.toEqual([
        'abandonedCartReminderDelayHours',
      ]);
    },
  );

  it('rejects an invalid support email and phone', async () => {
    await expect(invalidFields({ supportEmail: 'not-an-email', supportPhone: '12' })).resolves.toEqual([
      'supportEmail',
      'supportPhone',
    ]);
  });
});
