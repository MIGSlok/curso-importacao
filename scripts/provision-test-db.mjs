import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const identityFile = new URL('../.env.neon-identity', import.meta.url);
const envFile = new URL('../.env.hosting', import.meta.url);
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Neon API respondeu HTTP ${response.status}`);
  return response.json();
}
let identity;
try { identity = JSON.parse(await readFile(identityFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  identity = await request('https://claimable.neon.tech/v1/agent/identity', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anonymous', capabilities: ['postgres'], source: 'agent-skills' })
  });
  await writeFile(identityFile, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
}
const token = await request('https://claimable.neon.tech/v1/oauth2/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: identity.identity_assertion, resource: 'https://claimable.neon.tech/' })
});
const headers = { Authorization: `Bearer ${token.access_token}` };
if (process.argv.includes('--claim')) {
  const claim = await request(`https://claimable.neon.tech/v1/projects/${identity.project.id}/claim`, { method: 'POST', headers });
  console.log(JSON.stringify({ projectId: identity.project.id, claimUrl: claim.verification_uri_complete, claimExpiresIn: claim.expires_in, projectExpiresAt: identity.project.expires_at }));
} else {
  try { await access(envFile); console.log('Ambiente de hospedagem já existe; credenciais preservadas.'); }
  catch {
    const creds = await request(`https://claimable.neon.tech/v1/projects/${identity.project.id}/credentials`, { headers });
    if (!creds.database_url) throw new Error('Neon não retornou DATABASE_URL');
    await writeFile(envFile, [
      `DATABASE_URL=${creds.database_url}`,
      `TOTP_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`,
      'COURSE_PRICE_BRL=1.00', 'MERCADOPAGO_MODE=test', 'TRUST_PROXY=1',
      'APP_URL=https://cssbuy-curso-teste.vercel.app', 'NODE_ENV=production', ''
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ projectId: identity.project.id, expiresAt: identity.project.expires_at, credentialsFile: '.env.hosting' }));
  }
}
