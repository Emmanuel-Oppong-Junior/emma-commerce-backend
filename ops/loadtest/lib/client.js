import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3100';

// The API sits behind one trusted proxy (main.ts: trust proxy 1), so it rate-limits by the last X-Forwarded-For
// address, as it would behind the production load balancer. Each virtual user is its own shopper on its own address;
// the global limit (120 requests/min per address) still applies to each of them unchanged.
export function shopperIp(offset = 0) {
  const n = exec.vu.idInTest + offset;
  return `10.${100 + (Math.floor(n / 65536) % 100)}.${Math.floor(n / 256) % 256}.${n % 256}`;
}

function headers(token, ip) {
  const result = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || shopperIp() };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

/** One GraphQL operation; checks the HTTP status and the absence of errors. Returns `data` or null. */
export function gql(flow, op, query, variables, { token, ip } = {}) {
  const res = http.post(`${BASE_URL}/graphql`, JSON.stringify({ query, variables }), {
    headers: headers(token, ip),
    tags: { flow, op, name: op },
  });
  let body = null;
  try {
    body = res.json();
  } catch (_) {
    body = null;
  }
  const errors = body && body.errors;
  const ok = check(
    res,
    {
      [`${op}: HTTP 200`]: (r) => r.status === 200,
      [`${op}: no GraphQL errors`]: () => !errors,
    },
    { flow, op },
  );
  if (!ok && __ENV.LOG_ERRORS !== 'false') {
    const detail = errors
      ? JSON.stringify(errors).slice(0, 300)
      : `HTTP ${res.status} ${String(res.body).slice(0, 200)}`;
    console.warn(`${op} failed: ${detail}`);
  }
  return ok && body ? body.data : null;
}

export function postJson(flow, op, path, payload, { token, ip, extraHeaders } = {}) {
  return http.post(`${BASE_URL}${path}`, typeof payload === 'string' ? payload : JSON.stringify(payload), {
    headers: Object.assign(headers(token, ip), extraHeaders || {}),
    tags: { flow, op, name: op },
  });
}

export function signIn(flow, email, password, ip) {
  const data = gql(
    flow,
    'signIn',
    'mutation SignIn($input: SignInInput!) { signIn(input: $input) { accessToken } }',
    { input: { email, password } },
    { ip },
  );
  return data ? data.signIn.accessToken : null;
}
