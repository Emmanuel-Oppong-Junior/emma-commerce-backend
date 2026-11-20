import { createValidationPipe, InputValidationException } from '../../commons/validation-pipe';
import { CreateAddressInput } from './create-address.input';
import { UpdateAddressInput } from './update-address.input';

const pipe = createValidationPipe();
const validate = <T>(metatype: new () => T, value: Record<string, unknown>) =>
  pipe.transform(value, { type: 'body', metatype }) as Promise<T>;

const complete = {
  recipientName: '  Ama Mensah ',
  phone: '024 412 3456',
  region: 'GREATER_ACCRA',
  street: '12 Oxford St',
  city: 'Accra',
};

describe('CreateAddressInput', () => {
  it('accepts a complete address and normalises recipient, phone, GhanaPostGPS and country', async () => {
    const input = await validate(CreateAddressInput, {
      ...complete,
      area: 'Osu',
      landmark: 'Opposite the Total filling station',
      ghanaPostGps: 'ga 123 4567',
      latitude: 5.556,
      longitude: -0.1969,
      country: ' gh ',
    });

    expect(input).toEqual({
      ...complete,
      recipientName: 'Ama Mensah',
      phone: '+233244123456',
      area: 'Osu',
      landmark: 'Opposite the Total filling station',
      ghanaPostGps: 'GA-123-4567',
      latitude: 5.556,
      longitude: -0.1969,
      country: 'GH',
    });
  });

  it('accepts an address without zip code, area, landmark, GhanaPostGPS, coordinates or country', async () => {
    await expect(validate(CreateAddressInput, complete)).resolves.toEqual({
      ...complete,
      recipientName: 'Ama Mensah',
      phone: '+233244123456',
    });
  });

  it.each([
    ['recipientName', undefined],
    ['recipientName', '   '],
    ['recipientName', 'x'.repeat(101)],
    ['phone', undefined],
    ['phone', ''],
    ['phone', '+1 202 555 0100'],
    ['region', undefined],
    ['region', 'BRONG_AHAFO'],
    ['street', undefined],
    ['city', undefined],
    ['area', 'x'.repeat(101)],
    ['landmark', 'x'.repeat(201)],
    ['ghanaPostGps', 'Accra'],
    ['country', 'NG'],
    ['country', 'Ghana'],
    ['country', null],
  ])('rejects %s = %p', async (field, value) => {
    await expect(validate(CreateAddressInput, { ...complete, [field]: value })).rejects.toThrow(
      InputValidationException,
    );
  });

  it.each([
    [{ latitude: 5.556 }, 'latitude without longitude'],
    [{ longitude: -0.1969 }, 'longitude without latitude'],
    [{ latitude: 90.5, longitude: 0 }, 'latitude out of range'],
    [{ latitude: 0, longitude: -180.5 }, 'longitude out of range'],
    [{ latitude: null, longitude: 1 }, 'one coordinate null'],
  ] as [Record<string, unknown>, string][])('rejects %p (%s)', async (coordinates: Record<string, unknown>) => {
    await expect(validate(CreateAddressInput, { ...complete, ...coordinates })).rejects.toThrow(
      InputValidationException,
    );
  });

  it('accepts the coordinate limits', async () => {
    await expect(validate(CreateAddressInput, { ...complete, latitude: -90, longitude: 180 })).resolves.toMatchObject({
      latitude: -90,
      longitude: 180,
    });
  });
});

describe('UpdateAddressInput', () => {
  it('accepts a partial update', async () => {
    await expect(validate(UpdateAddressInput, { street: '1 New St' })).resolves.toEqual({ street: '1 New St' });
  });

  it('normalises a changed phone', async () => {
    await expect(validate(UpdateAddressInput, { phone: '00233244123456' })).resolves.toEqual({
      phone: '+233244123456',
    });
  });

  it.each(['street', 'city', 'region', 'recipientName', 'phone', 'country'])(
    'rejects an explicit null on the required field %s',
    async (field) => {
      await expect(validate(UpdateAddressInput, { [field]: null })).rejects.toThrow(InputValidationException);
    },
  );

  it('clears optional fields set to null', async () => {
    const cleared = { zipCode: null, area: null, landmark: null, ghanaPostGps: null, latitude: null, longitude: null };
    await expect(validate(UpdateAddressInput, cleared)).resolves.toEqual(cleared);
  });

  it.each([
    [{ latitude: null }, 'clearing one coordinate'],
    [{ latitude: 5.5 }, 'changing one coordinate'],
  ] as [Record<string, unknown>, string][])('rejects %p (%s)', async (coordinates: Record<string, unknown>) => {
    await expect(validate(UpdateAddressInput, coordinates)).rejects.toThrow(InputValidationException);
  });
});
