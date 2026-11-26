// Stands in for Paystack (HTTPS, reached as api.paystack.co through the compose network) and Resend (plain HTTP via
// the SDK's RESEND_BASE_URL) so a load test never calls a real provider. State is in memory; restart clears it.
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const LATENCY_MS = Number(process.env.STUB_PAYSTACK_LATENCY_MS ?? 300);
const CERT_DIR = process.env.STUB_CERT_DIR ?? '/certs';

const transactions = new Map();
const stats = { initialized: 0, verified: 0, verifyUnknown: 0, refunds: 0, emails: 0 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function paystack(req, res) {
  const url = new URL(req.url, 'https://api.paystack.co');
  await delay(LATENCY_MS);

  if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
    const body = JSON.parse(await readBody(req));
    transactions.set(body.reference, { amount: body.amount, currency: body.currency });
    stats.initialized++;
    return send(res, 200, {
      status: true,
      message: 'Authorization URL created',
      data: {
        authorization_url: `https://checkout.paystack.test/${encodeURIComponent(body.reference)}`,
        access_code: randomUUID(),
        reference: body.reference,
      },
    });
  }

  const verify = url.pathname.match(/^\/transaction\/verify\/(.+)$/);
  if (req.method === 'GET' && verify) {
    const reference = decodeURIComponent(verify[1]);
    const transaction = transactions.get(reference);
    if (!transaction) {
      stats.verifyUnknown++;
      return send(res, 400, { status: false, message: 'Transaction reference not found' });
    }
    stats.verified++;
    return send(res, 200, {
      status: true,
      message: 'Verification successful',
      data: {
        reference,
        status: 'success',
        amount: transaction.amount,
        currency: transaction.currency,
        channel: 'card',
        paid_at: new Date().toISOString(),
        gateway_response: 'Successful',
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/transaction') {
    return send(res, 200, { status: true, data: [], meta: { pageCount: 0 } });
  }

  if (req.method === 'POST' && url.pathname === '/refund') {
    stats.refunds++;
    return send(res, 200, { status: true, data: { id: randomUUID(), status: 'pending' } });
  }

  return send(res, 404, { status: false, message: `Stub has no route ${req.method} ${url.pathname}` });
}

async function plain(req, res) {
  if (req.method === 'POST' && req.url === '/emails') {
    await readBody(req);
    stats.emails++;
    return send(res, 200, { id: randomUUID() });
  }
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && req.url === '/stats') return send(res, 200, stats);
  return send(res, 404, { message: `Stub has no route ${req.method} ${req.url}` });
}

const handle = (handler) => (req, res) =>
  handler(req, res).catch((error) => {
    console.error(`stub error on ${req.method} ${req.url}: ${error.message}`);
    send(res, 500, { status: false, message: 'Stub failed' });
  });

createHttpsServer(
  { key: readFileSync(`${CERT_DIR}/server.key`), cert: readFileSync(`${CERT_DIR}/server.crt`) },
  handle(paystack),
).listen(443, () => console.log(`Paystack stub on :443 (latency ${LATENCY_MS} ms)`));

createHttpServer(handle(plain)).listen(8080, () => console.log('Resend stub and /stats on :8080'));
