import { isStepUpFresh, STEP_UP_WINDOW_MS, StepUpStore } from './step-up.store';

describe('step-up window', () => {
  const now = 1_700_000_000_000;

  it('is fresh for 10 minutes after the verification', () => {
    expect(STEP_UP_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(isStepUpFresh(now, now)).toBe(true);
    expect(isStepUpFresh(now - STEP_UP_WINDOW_MS + 1, now)).toBe(true);
  });

  it('expires at 10 minutes', () => {
    expect(isStepUpFresh(now - STEP_UP_WINDOW_MS, now)).toBe(false);
  });

  it('is never fresh without a verification or with one in the future', () => {
    expect(isStepUpFresh(null, now)).toBe(false);
    expect(isStepUpFresh(now + 1000, now)).toBe(false);
  });
});

describe('StepUpStore', () => {
  const redis = { set: jest.fn(), get: jest.fn() };
  const store = new StepUpStore(redis as never);

  it('stores the verification per user and session, expiring with the window', async () => {
    await store.markVerified('u1', 's1', 123);

    expect(redis.set).toHaveBeenCalledWith('mfa:step-up:u1:s1', '123', 'PX', STEP_UP_WINDOW_MS);
  });

  it('reads it back, or null when there is none', async () => {
    redis.get.mockResolvedValueOnce('123').mockResolvedValueOnce(null);

    await expect(store.lastVerifiedAt('u1', 's1')).resolves.toBe(123);
    await expect(store.lastVerifiedAt('u1', 's2')).resolves.toBeNull();
    expect(redis.get).toHaveBeenCalledWith('mfa:step-up:u1:s2');
  });
});
