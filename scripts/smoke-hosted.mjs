import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const origin = 'https://cssbuy-curso-teste.vercel.app';
const email = `qa-${Date.now()}@example.com`;
const password = randomBytes(24).toString('base64url');
let cookie;
async function call(route, data) {
  const response = await fetch(origin + route, { method: data ? 'POST' : 'GET', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(30000) });
  const nextCookie = response.headers.get('set-cookie');
  if (nextCookie) cookie = nextCookie.split(';')[0];
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${result.error}`);
  return result;
}
const health = await call('/api/health');
if (!health.checkoutReady || health.checkoutMode !== 'test' || health.priceCents !== 100 || health.database !== 'postgresql') throw new Error('Configuração do teste inválida');
await call('/api/register', { email, password });
const first = await call('/api/me');
if (!first.authenticated || first.ownsBasic) throw new Error('Cadastro ou permissão inválida');
await call('/api/logout', {});
await call('/api/login', { email, password });
const checkout = await call('/api/checkout', {});
if (!checkout.checkoutUrl?.startsWith('https://www.mercadopago.com.br/checkout/')) throw new Error('Endereço do Checkout Pro inválido');
await writeFile(new URL('../.env.test-checkout', import.meta.url), JSON.stringify({ email, password, cookie, checkoutUrl: checkout.checkoutUrl }), { mode: 0o600 });
console.log(JSON.stringify({ register: 'ok', login: 'ok', database: health.database, checkoutMode: health.checkoutMode, priceCents: health.priceCents, sandboxPreference: 'created' }));
