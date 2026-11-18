import { BadRequestException } from '@nestjs/common';
import { isSettlingEvent, isValidPaystackSignature, parsePaystackWebhook, webhookEventKey } from './paystack-webhook';

// Vectors computed independently with `openssl dgst -sha512 -hmac <secret>` over the exact bytes below.
const SECRET = 'sk_test_signature_vector';
const COMPACT =
  '{"event":"charge.success","data":{"id":302961,"reference":"qTPrJoy9Bx","amount":10000,"currency":"GHS","status":"success"}}';
const COMPACT_SIGNATURE =
  '383503d3e9b137a9602358f30041f293102a12cc4fe6b8179ea0fd3159eaa53c3d18a8c504c7288889c9c7930f9a02b5d9c6e7e2f3feafc87cbf56c3cc265b30';
const SPACED =
  '{"event": "charge.success", "data": {"id": 302961, "reference": "qTPrJoy9Bx", "amount": 10000, "currency": "GHS", "status": "success"}}';
const SPACED_SIGNATURE =
  '17fdac6622d885a7826c2cff42c9538e09feaec7518893ff802d6025637f09a65179102acf302ffc3b448a023319fba7a6c669664a2514b25e9d4658ec6f62cd';
const ESCAPED_SLASH =
  '{"event":"charge.success","data":{"reference":"ref-1","gateway_response":"Approved \\/ Successful","amount":10000}}';
const ESCAPED_SLASH_SIGNATURE =
  '1df0ee687fbee664703dae1ee38113c3b25a7b6b4706eef911bda70a413750b2520a18f06c3682ba641cfc1d83683df227f281b9b0ad0e26469db0a250892863';

const bytes = (body: string) => Buffer.from(body, 'utf8');

describe('isValidPaystackSignature', () => {
  it.each([
    ['compact JSON', COMPACT, COMPACT_SIGNATURE],
    ['JSON with spaces', SPACED, SPACED_SIGNATURE],
    ['JSON with an escaped slash', ESCAPED_SLASH, ESCAPED_SLASH_SIGNATURE],
  ])('accepts the HMAC-SHA512 of the raw bytes for %s', (_label, body, signature) => {
    expect(isValidPaystackSignature(bytes(body), signature, SECRET)).toBe(true);
  });

  it('accepts an upper-case hex signature', () => {
    expect(isValidPaystackSignature(bytes(COMPACT), COMPACT_SIGNATURE.toUpperCase(), SECRET)).toBe(true);
  });

  it('rejects a valid signature presented with a body re-serialised differently', () => {
    expect(isValidPaystackSignature(bytes(SPACED), COMPACT_SIGNATURE, SECRET)).toBe(false);
    expect(
      isValidPaystackSignature(bytes(JSON.stringify(JSON.parse(ESCAPED_SLASH))), ESCAPED_SLASH_SIGNATURE, SECRET),
    ).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(isValidPaystackSignature(bytes(COMPACT), COMPACT_SIGNATURE, 'sk_test_other')).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not hex', 'not-a-valid-signature'],
    ['truncated', COMPACT_SIGNATURE.slice(0, 64)],
    ['one character short', COMPACT_SIGNATURE.slice(0, -1)],
    ['too long', `${COMPACT_SIGNATURE}00`],
  ])('rejects a %s signature without throwing', (_label, signature) => {
    expect(isValidPaystackSignature(bytes(COMPACT), signature, SECRET)).toBe(false);
  });
});

describe('parsePaystackWebhook', () => {
  it('keys a delivery by event and Paystack transaction id, and keeps the reference', () => {
    const parsed = parsePaystackWebhook(bytes(COMPACT));

    expect(parsed).toMatchObject({
      event: 'charge.success',
      eventKey: 'charge.success:id:302961',
      reference: 'qTPrJoy9Bx',
    });
  });

  it('gives the same key to the same event however it is serialised', () => {
    expect(parsePaystackWebhook(bytes(SPACED)).eventKey).toBe(parsePaystackWebhook(bytes(COMPACT)).eventKey);
  });

  it('does not store customer PII, card authorization or metadata', () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 1,
        reference: 'ref-1',
        amount: 100,
        customer: { email: 'buyer@example.com' },
        authorization: { authorization_code: 'AUTH_x' },
        ip_address: '1.2.3.4',
        log: { history: [] },
        metadata: { phone: '+233' },
      },
    });

    expect(parsePaystackWebhook(bytes(body)).payload).toEqual({
      event: 'charge.success',
      data: { id: 1, reference: 'ref-1', amount: 100 },
    });
  });

  it.each([
    ['not JSON', 'event=charge.success'],
    ['a JSON array', '[]'],
    ['missing the event', '{"data":{}}'],
    ['an empty event', '{"event":"","data":{}}'],
    ['missing data', '{"event":"charge.success"}'],
    ['data that is not an object', '{"event":"charge.success","data":"x"}'],
  ])('rejects a body that is %s', (_label, body) => {
    expect(() => parsePaystackWebhook(bytes(body))).toThrow(BadRequestException);
  });
});

describe('webhookEventKey', () => {
  const raw = bytes('{}');

  it('falls back to the reference when the event has no id', () => {
    expect(webhookEventKey('charge.failed', { reference: 'ref-9' }, raw)).toBe('charge.failed:ref:ref-9');
  });

  it('separates different events for the same transaction', () => {
    expect(webhookEventKey('charge.failed', { id: 5 }, raw)).not.toBe(
      webhookEventKey('charge.success', { id: 5 }, raw),
    );
  });

  it('keys a body with neither id nor reference by its digest', () => {
    expect(webhookEventKey('transfer.success', {}, raw)).toBe(
      'transfer.success:sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });
});

describe('isSettlingEvent', () => {
  it.each([
    ['charge.success', true],
    ['charge.failed', true],
    ['refund.processed', false],
    ['transfer.success', false],
  ])('%s -> %s', (event, expected) => {
    expect(isSettlingEvent(event)).toBe(expected);
  });
});
