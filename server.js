import express from 'express';
import 'dotenv/config';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { openDatabase } from './database.js';
import { createHash, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCb);
const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const production = process.env.NODE_ENV === 'production';
const appUrl = new URL(process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000'));
const port = Number(process.env.PORT || 3000);
const price = Number(process.env.COURSE_PRICE_BRL);
const proxyHops = Number(process.env.TRUST_PROXY || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0) app.set('trust proxy', proxyHops);
const db = await openDatabase(root);
await db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
await db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').run(Date.now());

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
  frameAncestors: ["'none'"], formAction: ["'self'", 'https://www.mercadopago.com.br', 'https://www.mercadopago.com'], upgradeInsecureRequests: production ? [] : null
} } }));
app.use(express.json({ limit: '20kb' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/', (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/portal.html', (_req, res) => res.sendFile(path.join(root, 'portal.html')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(root, 'app.js')));

let limiterSequence = 0;
const limit = (max, windowMs = 15 * 60 * 1000) => {
  const namespace = String(++limiterSequence);
  const store = {
    localKeys: false,
    prefix: `${namespace}:`,
    async increment(clientKey) {
      const key = tokenDigest(`${namespace}:${clientKey}`);
      const now = Date.now();
      const row = await db.prepare(`INSERT INTO rate_limits(key,hits,expires_at) VALUES(?,1,?)
        ON CONFLICT(key) DO UPDATE SET
          hits = CASE WHEN rate_limits.expires_at <= ? THEN 1 ELSE rate_limits.hits + 1 END,
          expires_at = CASE WHEN rate_limits.expires_at <= ? THEN ? ELSE rate_limits.expires_at END
        RETURNING hits,expires_at`).get(key, now + windowMs, now, now, now + windowMs);
      return { totalHits: row.hits, resetTime: new Date(Number(row.expires_at)) };
    },
    async decrement(clientKey) { await db.prepare('UPDATE rate_limits SET hits = CASE WHEN hits > 0 THEN hits - 1 ELSE 0 END WHERE key = ?').run(tokenDigest(`${namespace}:${clientKey}`)); },
    async resetKey(clientKey) { await db.prepare('DELETE FROM rate_limits WHERE key = ?').run(tokenDigest(`${namespace}:${clientKey}`)); }
  };
  return rateLimit({ windowMs, limit: max, store, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' } });
};
const authLimiter = limit(8);
const checkoutLimiter = limit(5, 60 * 60 * 1000);
const apiLimiter = limit(120);
app.use('/api', apiLimiter);
app.use('/api/register', authLimiter);
app.use('/api/login', authLimiter);
app.use('/api/2fa/verify-login', authLimiter);
app.use('/api/2fa/setup', authLimiter);
app.use('/api/2fa/enable', authLimiter);
app.use('/api/2fa/disable', authLimiter);
app.use('/api/checkout', checkoutLimiter);

function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  const allowedOrigins = [appUrl.origin, ...(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)];
  if (!origin || !allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Origem inválida. Atualize a página e tente de novo.' });
  next();
}
app.use('/api', (req, res, next) => req.method === 'GET' || req.path === '/payments/webhook' ? next() : sameOrigin(req, res, next));

const tokenDigest = (token) => createHash('sha256').update(token).digest('hex');
const sessionCookie = (res, token) => res.cookie('cssbuy_session', token, {
  httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000
});
async function session(req, res, next) {
  const token = req.get('cookie')?.split(';').map((x) => x.trim()).find((x) => x.startsWith('cssbuy_session='))?.slice('cssbuy_session='.length);
  if (!token || token.length > 200) return next();
  let rawToken;
  try { rawToken = decodeURIComponent(token); } catch { return next(); }
  const row = await db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenDigest(rawToken), Date.now());
  if (!row) return next();
  req.sessionRow = row;
  if (row.user_id) req.user = await db.prepare('SELECT id, email, totp_secret FROM users WHERE id = ?').get(row.user_id);
  next();
}
app.use(session);
async function createSession(res, userId, pendingUserId = null) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.prepare('INSERT INTO sessions(token_hash,user_id,pending_user_id,expires_at,created_at) VALUES(?,?,?,?,?)')
    .run(tokenDigest(token), userId, pendingUserId, now + (pendingUserId ? 5 * 60000 : 7 * 86400000), now);
  sessionCookie(res, token);
}
async function rotateSession(req, res, userId, pendingUserId = null) {
  if (req.sessionRow) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionRow.token_hash);
  await createSession(res, userId, pendingUserId);
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  next();
}
function validEmail(value) { return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function safeCompare(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
async function passwordHash(password, salt = randomBytes(16)) {
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$3$${salt.toString('hex')}$${Buffer.from(hash).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [kind, n, r, p, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt' || n !== '32768' || r !== '8' || p !== '3') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function encryptionKey() {
  const key = Buffer.from(process.env.TOTP_ENCRYPTION_KEY || '', 'base64url');
  return key.length === 32 ? key : null;
}
function encryptSecret(secret) {
  const key = encryptionKey(); if (!key) throw new Error('TOTP_ENCRYPTION_KEY precisa conter 32 bytes em base64url.');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}
function decryptSecret(value) {
  const key = encryptionKey(); if (!key) throw new Error('TOTP_ENCRYPTION_KEY inválida.');
  const [iv, tag, data] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
function totp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 30000);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Bytes(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1000000).padStart(6, '0');
}
function verifyTotp(secret, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  return [-1, 0, 1].some((step) => safeCompare(totp(secret, Date.now() + step * 30000), code));
}
function makeSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let out = '';
  for (const byte of randomBytes(20)) out += alphabet[byte & 31];
  return out;
}
function base32Bytes(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const char of value) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

app.get('/api/me', async (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  const owned = Boolean(await db.prepare("SELECT 1 FROM orders WHERE user_id = ? AND course_id = 'basic' AND status = 'approved' LIMIT 1").get(req.user.id));
  const recent = await db.prepare("SELECT status FROM orders WHERE user_id = ? AND course_id = 'basic' ORDER BY created_at DESC LIMIT 1").get(req.user.id);
  res.json({ authenticated: true, email: req.user.email, ownsBasic: owned, latestPaymentStatus: recent?.status || null, twoFactorEnabled: Boolean(req.user.totp_secret), checkoutReady: isCheckoutReady(), checkoutMode, priceCents: Math.round(price * 100) });
});
app.post('/api/register', async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;
  if (!validEmail(email) || typeof password !== 'string' || password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Informe um e-mail válido e senha de 12 a 128 caracteres.' });
  try {
    const id = randomBytes(16).toString('hex');
    await db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(id, email, await passwordHash(password), new Date().toISOString());
    await rotateSession(req, res, id); res.status(201).json({ ok: true, email });
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT') || error.code === '23505') return res.status(409).json({ error: 'Este e-mail já tem uma conta. Entre nela.' });
    console.error('register failed', error.message); res.status(500).json({ error: 'Não foi possível criar a conta agora.' });
  }
});
app.post('/api/login', async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!validEmail(email) || password.length > 128) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const valid = user && await verifyPassword(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  if (user.totp_secret) {
    await rotateSession(req, res, null, user.id);
    return res.json({ requiresTwoFactor: true });
  }
  await rotateSession(req, res, user.id); res.json({ ok: true });
});
app.post('/api/2fa/verify-login', async (req, res) => {
  const pendingId = req.sessionRow?.pending_user_id;
  const user = pendingId && Date.now() - Number(req.sessionRow.created_at) <= 5 * 60000 && await db.prepare('SELECT id,totp_secret FROM users WHERE id = ?').get(pendingId);
  if (!user || !user.totp_secret || !verifyTotp(decryptSecret(user.totp_secret), req.body.code)) return res.status(401).json({ error: 'Código inválido ou expirado.' });
  await rotateSession(req, res, user.id); res.json({ ok: true });
});
app.post('/api/logout', async (req, res) => {
  if (req.sessionRow) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionRow.token_hash);
  res.clearCookie('cssbuy_session', { httpOnly: true, secure: production, sameSite: 'lax', path: '/' }); res.json({ ok: true });
});
app.post('/api/2fa/setup', requireUser, async (req, res) => {
  if (req.user.totp_secret) return res.status(409).json({ error: 'Desative a autenticação atual usando seu código antes de configurar outro aplicativo.' });
  if (!encryptionKey()) return res.status(503).json({ error: 'Configure TOTP_ENCRYPTION_KEY no servidor antes de ativar a autenticação em duas etapas.' });
  const secret = makeSecret();
  await db.prepare('UPDATE users SET totp_pending = ? WHERE id = ? AND totp_secret IS NULL').run(encryptSecret(secret), req.user.id);
  const label = encodeURIComponent(`Importação Curso:${req.user.email}`);
  res.json({ secret, issuer: 'Importação Curso', uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Importação Curso')}&algorithm=SHA1&digits=6&period=30` });
});
app.post('/api/2fa/enable', requireUser, async (req, res) => {
  if (req.user.totp_secret) return res.status(409).json({ error: 'A autenticação em duas etapas já está ativa.' });
  const row = await db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(req.user.id);
  if (!row?.totp_pending || !verifyTotp(decryptSecret(row.totp_pending), req.body.code)) return res.status(400).json({ error: 'Código inválido. Confira o horário do celular e tente novamente.' });
  const updated = await db.prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL WHERE id = ? AND totp_secret IS NULL AND totp_pending = ?').run(row.totp_pending, req.user.id, row.totp_pending);
  if (!updated.changes) return res.status(409).json({ error: 'A configuração mudou. Comece a ativação novamente.' });
  await db.prepare('DELETE FROM sessions WHERE user_id = ? OR pending_user_id = ?').run(req.user.id, req.user.id);
  await createSession(res, req.user.id);
  res.json({ ok: true });
});
app.post('/api/2fa/disable', requireUser, async (req, res) => {
  if (!req.user.totp_secret || !verifyTotp(decryptSecret(req.user.totp_secret), req.body.code)) return res.status(400).json({ error: 'Código inválido.' });
  await db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

function isCheckoutReady() {
  return Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN && Number.isFinite(price) && Math.round(price * 100) > 0 && appUrl.protocol === 'https:' && (checkoutMode === 'test' || process.env.MERCADOPAGO_WEBHOOK_SECRET));
}
const checkoutMode = process.env.MERCADOPAGO_MODE || 'test';
if (!['test', 'production'].includes(checkoutMode)) throw new Error('MERCADOPAGO_MODE inválido.');
async function mpRequest(endpoint, options = {}) {
  const response = await fetch(`https://api.mercadopago.com${endpoint}`, {
    ...options, signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...options.headers }
  });
  if (!response.ok) throw new Error(`Mercado Pago respondeu ${response.status}`);
  return response.json();
}
let sellerCache;
async function paymentSeller() {
  if (sellerCache && sellerCache.expires > Date.now()) return sellerCache.user;
  const user = await mpRequest('/users/me');
  const isTestUser = Array.isArray(user.tags) && user.tags.includes('test_user');
  if (!user.id || (checkoutMode === 'test' ? !isTestUser : isTestUser)) {
    throw new Error('As credenciais não correspondem ao modo de pagamento configurado.');
  }
  sellerCache = { user, expires: Date.now() + 5 * 60000 };
  return user;
}
function checkoutLink(preference) {
  // Mercado Pago's current test seller accounts use the normal checkout URL.
  // paymentSeller() verifies test_user before either a new or reused preference.
  const link = preference.init_point;
  if (!link) throw new Error('O Mercado Pago não retornou o endereço para este modo de pagamento.');
  const url = new URL(link);
  if (url.protocol !== 'https:' || !['www.mercadopago.com.br', 'sandbox.mercadopago.com.br', 'www.mercadopago.com', 'sandbox.mercadopago.com'].includes(url.hostname)) throw new Error('Endereço do checkout inválido.');
  return link;
}
app.post('/api/checkout', requireUser, async (req, res) => {
  if (!isCheckoutReady()) return res.status(503).json({ error: 'O pagamento de teste está aguardando a configuração da conta Mercado Pago.' });
  try { await paymentSeller(); } catch (error) {
    console.error('payment seller validation failed', error.message);
    return res.status(503).json({ error: 'As credenciais de pagamento precisam ser configuradas para o ambiente de teste.' });
  }
  const owned = await db.prepare("SELECT 1 FROM orders WHERE user_id = ? AND course_id = 'basic' AND status = 'approved' LIMIT 1").get(req.user.id);
  if (owned) return res.status(409).json({ error: 'Esta conta já tem acesso ao curso básico.' });
  const pending = await db.prepare("SELECT id,preference_id FROM orders WHERE user_id = ? AND course_id = 'basic' AND status = 'pending' AND amount_cents = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1").get(req.user.id, Math.round(price * 100), new Date(Date.now() - 60 * 60 * 1000).toISOString());
  if (pending?.preference_id) {
    try {
      const detail = await mpRequest(`/checkout/preferences/${encodeURIComponent(pending.preference_id)}`);
      return res.json({ checkoutUrl: checkoutLink(detail) });
    } catch { /* Se a preferência expirou, cria-se uma nova abaixo. */ }
  }
  const orderId = randomBytes(18).toString('hex'); const amountCents = Math.round(price * 100); const now = new Date().toISOString();
  await db.prepare('INSERT INTO orders(id,user_id,course_id,amount_cents,currency,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(orderId, req.user.id, 'basic', amountCents, 'BRL', 'pending', now, now);
  try {
    const data = await mpRequest('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: 'cssbuy-course-basic', title: 'Curso Básico de Importação', description: 'Curso digital em PDF sobre compras internacionais, organização de pedidos e envio.', quantity: 1, currency_id: 'BRL', unit_price: price }],
        ...(checkoutMode === 'production' ? { payer: { email: req.user.email }, notification_url: `${appUrl.origin}/api/payments/webhook` } : {}), external_reference: orderId,
        back_urls: { success: `${appUrl.origin}/portal.html?payment=return`, pending: `${appUrl.origin}/portal.html?payment=pending`, failure: `${appUrl.origin}/portal.html?payment=failure` },
        auto_return: 'approved' })
    });
    const checkoutUrl = checkoutLink(data);
    await db.prepare('UPDATE orders SET preference_id = ?, updated_at = ? WHERE id = ?').run(data.id, new Date().toISOString(), orderId);
    res.json({ checkoutUrl });
  } catch (error) {
    await db.prepare("UPDATE orders SET status = 'error', updated_at = ? WHERE id = ?").run(new Date().toISOString(), orderId);
    console.error('checkout creation failed', error.message); res.status(502).json({ error: 'O checkout não abriu. Tente novamente em alguns minutos.' });
  }
});
app.get('/api/course/download', requireUser, async (req, res) => {
  const owned = await db.prepare("SELECT 1 FROM orders WHERE user_id = ? AND course_id = 'basic' AND status = 'approved' LIMIT 1").get(req.user.id);
  if (!owned) return res.status(403).json({ error: 'O curso fica disponível após a confirmação do pagamento.' });
  const pdf = path.join(root, 'private', 'course-basic.pdf');
  try { if ((await stat(pdf)).isFile()) return res.download(pdf, 'Curso_Basico_Importacao.pdf'); }
  catch { /* O arquivo pago deve ser enviado pelo proprietário. */ }
  res.status(503).json({ error: 'O arquivo do curso ainda não foi instalado no servidor.' });
});

function verifyMpSignature(req) {
  const signature = req.get('x-signature') || ''; const requestId = req.get('x-request-id') || '';
  const params = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=')));
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
  if (!params.ts || !params.v1 || !requestId || !dataId) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${params.ts};`;
  const expected = createHmac('sha256', process.env.MERCADOPAGO_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeCompare(expected, params.v1);
}
async function applyVerifiedPayment(payment, requiredUserId = null) {
  const seller = await paymentSeller();
  // APP_USR test sellers use production infrastructure; their test_user tag,
  // validated above, identifies fictitious payments independently of live_mode.
  if (String(payment.collector_id) !== String(seller.id) || (checkoutMode === 'production' && payment.live_mode !== true)) return null;
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.external_reference);
  if (!order || (requiredUserId && order.user_id !== requiredUserId) || (payment.preference_id && order.preference_id !== payment.preference_id)) return null;
  if (payment.currency_id !== order.currency || Math.round(Number(payment.transaction_amount) * 100) !== order.amount_cents) return null;
  const statuses = ['approved', 'pending', 'in_process', 'authorized', 'rejected', 'cancelled', 'refunded', 'charged_back', 'in_mediation'];
  if (!statuses.includes(payment.status)) return null;
  await db.prepare('UPDATE orders SET status = ?, payment_id = ?, updated_at = ? WHERE id = ?').run(payment.status, String(payment.id), new Date().toISOString(), order.id);
  return payment.status;
}
app.post('/api/payments/reconcile', limit(12, 60000), requireUser, async (req, res) => {
  if (!isCheckoutReady()) return res.status(503).json({ error: 'A configuração do pagamento de teste ainda está pendente.' });
  try {
    await paymentSeller();
    const orders = await db.prepare("SELECT id FROM orders WHERE user_id = ? AND course_id = 'basic' AND preference_id IS NOT NULL ORDER BY created_at DESC LIMIT 5").all(req.user.id);
    for (const order of orders) {
      const search = await mpRequest(`/v1/payments/search?external_reference=${encodeURIComponent(order.id)}&sort=date_created&criteria=desc&limit=10`);
      const results = Array.isArray(search.results) ? search.results : [];
      const candidate = results.find((payment) => payment.status === 'approved') || results[0];
      if (candidate && /^\d{1,30}$/.test(String(candidate.id))) {
        const payment = await mpRequest(`/v1/payments/${encodeURIComponent(candidate.id)}`);
        const status = await applyVerifiedPayment(payment, req.user.id);
        if (status === 'approved') break;
      }
    }
    const owned = Boolean(await db.prepare("SELECT 1 FROM orders WHERE user_id = ? AND course_id = 'basic' AND status = 'approved' LIMIT 1").get(req.user.id));
    const latest = await db.prepare("SELECT status FROM orders WHERE user_id = ? AND course_id = 'basic' ORDER BY created_at DESC LIMIT 1").get(req.user.id);
    res.json({ ok: true, ownsBasic: owned, status: owned ? 'approved' : latest?.status || null });
  } catch (error) {
    console.error('payment reconciliation failed', error.message);
    res.status(502).json({ error: 'Não foi possível consultar o pagamento agora. Tente novamente em alguns minutos.' });
  }
});
app.post('/api/payments/webhook', limit(120), async (req, res) => {
  if (!process.env.MERCADOPAGO_WEBHOOK_SECRET || !verifyMpSignature(req)) return res.sendStatus(401);
  if (req.body?.type !== 'payment') return res.sendStatus(200);
  const paymentId = String(req.query['data.id'] || req.body?.data?.id || '');
  if (!/^\d{1,30}$/.test(paymentId)) return res.sendStatus(400);
  try {
    const payment = await mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`);
    await applyVerifiedPayment(payment);
    res.sendStatus(200);
  } catch (error) {
    console.error('payment webhook processing failed', error.message); res.sendStatus(500);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, checkoutReady: isCheckoutReady(), checkoutMode, database: process.env.DATABASE_URL ? 'postgresql' : 'sqlite', priceCents: Math.round(price * 100) }));
app.use((error, _req, res, _next) => { console.error('request failed', error.message); res.status(500).json({ error: 'Erro interno.' }); });
if (!process.env.VERCEL) app.listen(port, () => console.log(`CSSBuy course portal listening on ${appUrl.origin}`));
export default app;
