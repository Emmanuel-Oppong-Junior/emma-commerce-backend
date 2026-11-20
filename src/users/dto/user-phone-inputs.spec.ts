import { createValidationPipe, InputValidationException } from '../../commons/validation-pipe';
import { CreateUserInput } from './create-user.input';
import { UpdateUserInput } from './update-user.input';

const pipe = createValidationPipe();
const validate = <T>(metatype: new () => T, value: Record<string, unknown>) =>
  pipe.transform(value, { type: 'body', metatype }) as Promise<T>;

const newUser = { name: 'Ama Mensah', email: 'ama@example.com', isActive: true, role: 'USER' };

describe('phoneNumber on user inputs', () => {
  it.each([
    ['CreateUserInput', CreateUserInput, newUser],
    ['UpdateUserInput', UpdateUserInput, {}],
  ] as const)('%s stores a Ghana number in E.164 form', async (_name, metatype, base) => {
    const input = await validate<{ phoneNumber?: string | null }>(metatype, { ...base, phoneNumber: '024-412-3456' });

    expect(input.phoneNumber).toBe('+233244123456');
  });

  it.each([
    ['CreateUserInput', CreateUserInput, newUser],
    ['UpdateUserInput', UpdateUserInput, {}],
  ] as const)('%s rejects an empty or non-Ghana number', async (_name, metatype, base) => {
    for (const phoneNumber of ['', '   ', '+44 20 7946 0958', '24412345']) {
      await expect(validate(metatype, { ...base, phoneNumber })).rejects.toThrow(InputValidationException);
    }
  });

  it('lets UpdateUserInput clear the number with null', async () => {
    await expect(validate(UpdateUserInput, { phoneNumber: null })).resolves.toEqual({ phoneNumber: null });
  });

  it('leaves the number out when it is not sent', async () => {
    await expect(validate(UpdateUserInput, { profilePicture: 'https://example.com/a.png' })).resolves.toEqual({
      profilePicture: 'https://example.com/a.png',
    });
  });
});
