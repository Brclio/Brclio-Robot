import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createTestHarness } from 'wrangler';
import { createWorker } from './index.mjs';
import { digest, digestHex } from './auth.mjs';
import { levels } from '../src/data/levels.ts';
const ORIGIN = 'https://bubu.brclio.com';
function memoryStore() {
  const records = new Map(); let serial = 0;
  return { records, async read(path) { await Promise.resolve(); return structuredClone(records.get(path) || null); },
    async write(path, value, expectedRevision = null) {
      await Promise.resolve(); const current = records.get(path);
      if ((current?.revision ?? null) !== expectedRevision) { const error = new Error('CAS conflict'); error.name = 'ConflictError'; throw error; }
      const record = { value: structuredClone(value), revision: (++serial).toString(16).padStart(40, '0') };
      records.set(path, record); return structuredClone(record);
    } };
}
async function fixture(overrides = {}) {
  const store = memoryStore(); let clock = Date.now(); const sent = [];
  const env = { APP_ORIGIN: ORIGIN, AUTH_SECRET: 'test-only-auth-pepper-01234567890123456789', SMTP_USER: 'sender@example.com', SMTP_PASS: 'test-password',
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'fake', GITHUB_INSTALLATION_ID: '456',
    GITHUB_DATA_OWNER: 'BrclioData', GITHUB_DATA_REPO: 'Brclio-Robot-Data', ASSETS: { fetch: async () => new Response('static asset') }, ...overrides.env };
  const worker = createWorker({ now: () => clock, storeFactory: () => store, sendEmail: async (_env, email, code) => sent.push({ email, code }), ...overrides.worker });
  const userIds = new Map();
  async function request(path, { method = 'GET', body, cookie, expectedUser = userIds.get(cookie), origin = ORIGIN, ip = '198.51.100.1' } = {}) {
    const response = await worker.fetch(new Request(ORIGIN + path, { method, headers: { ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip,
      ...(cookie ? { Cookie: cookie } : {}), ...(expectedUser ? { 'X-Brclio-User-Id': expectedUser } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    const responseBody = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : await response.text();
    const responseCookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    if (responseBody?.user?.id) userIds.set(responseCookie || cookie, responseBody.user.id);
    return { response, body: responseBody, cookie: responseCookie };
  }
  async function register(email = 'robot@example.com') {
    const issued = await request('/api/auth/code', { method: 'POST', body: { email } });
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body));
    const result = await request('/api/auth/register', { method: 'POST', body: { email, password: 'safe-password-123', code: sent.at(-1).code } });
    assert.equal(result.response.status, 201, JSON.stringify(result.body)); return result;
  }
  const account = async email => (await store.read(`accounts/${await digestHex(email.toLowerCase())}.json`))?.value;
  return { store, account, worker, env, sent, request, register, time: () => clock, advance: ms => { clock += ms; } };
}

test('private account CAS registration, password login and signed secure sessions', async () => {
  const f = await fixture(), account = await f.register('ROBOT@example.com');
  assert.equal(account.body.user.email, 'robot@example.com'); assert.equal(account.body.user.id, await digestHex('robot@example.com'));
  assert.match(account.response.headers.get('Set-Cookie'), /HttpOnly/); assert.match(account.response.headers.get('Set-Cookie'), /Secure/);
  const data = await f.account('robot@example.com'); assert.match(data.user.password_hash, /^pbkdf2-v1:100000:/); assert.equal(data.otp, null);
  assert.deepEqual((await f.request('/api/auth/session', { cookie: account.cookie })).body.user, account.body.user);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: 'robot@example.com', password: 'wrong' } })).response.status, 401);
  const login = await f.request('/api/auth/login', { method: 'POST', cookie: account.cookie, body: { email: 'robot@example.com', password: 'safe-password-123' } });
  assert.equal(login.response.status, 200); assert.equal((await f.request('/api/auth/session', { cookie: account.cookie })).body.user, null);
  await f.request('/api/auth/logout', { method: 'POST', cookie: login.cookie }); assert.equal((await f.request('/api/auth/session', { cookie: login.cookie })).body.user, null);
});

test('concurrent OTP issue and registration consume one challenge exactly once', async () => {
  const f = await fixture(), email = 'parallel@example.com';
  const issued = await Promise.all(Array.from({ length: 3 }, () => f.request('/api/auth/code', { method: 'POST', body: { email } })));
  assert.deepEqual(issued.map(result => result.response.status).sort(), [200, 429, 429]); assert.equal(f.sent.length, 1);
  const registered = await Promise.all(Array.from({ length: 2 }, () => f.request('/api/auth/register', { method: 'POST', body: { email, password: 'safe-password', code: f.sent[0].code } })));
  assert.equal(registered.filter(result => result.response.status === 201).length, 1);
  const account = await f.account(email); assert.equal(account.otp, null); assert.equal(Object.keys(account.sessions).length, 1);
});

test('OTP guess limit, expiry and delivery failures preserve account safety', async () => {
  const f = await fixture(), email = 'guess@example.com'; await f.request('/api/auth/code', { method: 'POST', body: { email } });
  const correct = f.sent[0].code, wrong = correct === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/auth/register', { method: 'POST', body: { email, password: 'safe-password', code: wrong } })).response.status, 400);
  assert.equal((await f.request('/api/auth/register', { method: 'POST', body: { email, password: 'safe-password', code: correct } })).response.status, 400);
  f.advance(61_000); await f.request('/api/auth/code', { method: 'POST', body: { email: 'expired@example.com' } }); const expired = f.sent.at(-1).code;
  f.advance(600_001); assert.equal((await f.request('/api/auth/register', { method: 'POST', body: { email: 'expired@example.com', password: 'safe-password', code: expired } })).response.status, 400);
  const failure = createWorker({ storeFactory: () => f.store, sendEmail: async () => { throw new Error('smtp-secret'); } });
  const response = await failure.fetch(new Request(ORIGIN + '/api/auth/code', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'failed@example.com' }) }), f.env);
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('smtp-secret')); assert.equal((await f.account('failed@example.com')).otp, null);
});

test('account CAS merges concurrent progress without losing sessions or other records', async () => {
  const f = await fixture(), account = await f.register();
  const a = { version: 1, drafts: { '001': { program: levels[0].solution, updatedAt: f.time() } }, completed: {} };
  const b = { version: 1, drafts: { '002': { program: levels[1].solution, updatedAt: f.time() } }, completed: {} };
  const results = await Promise.all([a, b].map(progress => f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress } })));
  assert.ok(results.every(result => result.response.status === 200));
  assert.deepEqual((await f.request('/api/progress', { cookie: account.cookie })).body.progress.drafts, { ...a.drafts, ...b.drafts });
  const data = await f.account('robot@example.com'); assert.equal(Object.keys(data.sessions).length, 1); assert.equal(data.user.id, account.body.user.id);
  const second = await f.register('other@example.com');
  assert.equal((await f.request('/api/progress', { cookie: second.cookie, expectedUser: account.body.user.id })).response.status, 409);
  assert.equal((await f.request('/api/progress', { method: 'PUT', cookie: second.cookie, expectedUser: account.body.user.id, body: { progress: a } })).response.status, 409);
  assert.deepEqual((await f.request('/api/progress', { cookie: second.cookie })).body.progress.drafts, {});
});

test('CSRF, forged cookies, future progress and 1MB stream are rejected', async () => {
  const f = await fixture(), account = await f.register();
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie: account.cookie, origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await f.request('/api/progress')).response.status, 401);
  assert.equal((await f.request('/api/progress', { cookie: account.cookie, expectedUser: null })).response.status, 409);
  const forged = account.cookie.slice(0, -1) + (account.cookie.endsWith('A') ? 'B' : 'A');
  assert.equal((await f.request('/api/auth/session', { cookie: forged })).body.user, null);
  const future = { version: 1, drafts: { '001': { program: levels[0].solution, updatedAt: f.time() + 301_000 } }, completed: {} };
  assert.equal((await f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress: future } })).response.status, 400);
  const bytes = new TextEncoder().encode(JSON.stringify({ payload: 'x'.repeat(1_000_001) }));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 500_000)); controller.enqueue(bytes.subarray(500_000)); controller.close(); } });
  const response = await f.worker.fetch(new Request(ORIGIN + '/api/progress', { method: 'PUT', duplex: 'half', headers: { Origin: ORIGIN, Cookie: account.cookie, 'X-Brclio-User-Id': account.body.user.id, 'Content-Type': 'application/json' }, body: stream }), f.env);
  assert.equal(response.status, 413);
});

test('CAS IP quotas cannot be bypassed with concurrent requests', async () => {
  const f = await fixture();
  for (let i = 0; i < 20; i++) assert.equal((await f.request('/api/auth/register', { method: 'POST', body: { email: `quota${i}@example.com`, password: 'safe-password', code: '111111' } })).response.status, 400);
  const results = await Promise.all(Array.from({ length: 3 }, () => f.request('/api/auth/register', { method: 'POST', body: { email: 'new@example.com', password: 'safe-password', code: '111111' } })));
  assert.ok(results.every(result => result.response.status === 429));
  f.advance(900_001); assert.equal((await f.request('/api/auth/register', { method: 'POST', body: { email: 'new@example.com', password: 'safe-password', code: '111111' } })).response.status, 400);
});

async function google(f) {
  const start = await f.request('/api/auth/google?returnTo=//evil.example'), target = new URL(start.response.headers.get('Location'));
  return { start, target, state: target.searchParams.get('state') };
}
test('Google PKCE and CAS state permit exactly one callback', async () => {
  const requests = [], f = await fixture({ worker: { fetchImpl: async (url, options) => { requests.push([url, options]); return new Response(JSON.stringify(url.includes('/token') ? { access_token: 'token', token_type: 'Bearer' } : { sub: 'google-user-id', email: 'google@example.com', email_verified: true })); } } });
  const { start, target, state } = await google(f); assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  const callbacks = await Promise.all(Array.from({ length: 2 }, () => f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie })));
  const success = callbacks.find(result => result.response.headers.get('Location') === ORIGIN + '/'); assert.ok(success);
  assert.equal(callbacks.filter(result => result.response.headers.get('Location')?.includes('google_state')).length, 1); assert.equal(requests.length, 2);
  assert.equal(await digest(requests[0][1].body.get('code_verifier')), target.searchParams.get('code_challenge'));
  assert.equal((await f.request('/api/auth/session', { cookie: success.cookie })).body.user.provider, 'google');
});

test('Google rejects unverified identity and external existing-mailbox linking', async () => {
  let verified = false;
  const f = await fixture({ worker: { fetchImpl: async url => new Response(JSON.stringify(url.includes('/token') ? { access_token: 'token', token_type: 'Bearer' } : { sub: 'external-id', email: 'robot@example.com', email_verified: verified })) } });
  await f.register();
  const attempt = async () => { const { start, state } = await google(f); return f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie }); };
  assert.match((await attempt()).response.headers.get('Location'), /google_failed/); verified = true;
  assert.match((await attempt()).response.headers.get('Location'), /google_link_required/); assert.equal((await f.account('robot@example.com')).user.google_sub, null);
});

test('Google identity index preserves account ID when Google email changes', async () => {
  let email = 'first@gmail.com';
  const f = await fixture({ worker: { fetchImpl: async url => new Response(JSON.stringify(url.includes('/token') ? { access_token: 'token', token_type: 'Bearer' } : { sub: 'stable-google-id', email, email_verified: true })) } });
  const signin = async () => { const { start, state } = await google(f); const result = await f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie }); return (await f.request('/api/auth/session', { cookie: result.cookie })).body.user; };
  const first = await signin(); email = 'second@gmail.com'; const second = await signin(); assert.equal(first.id, second.id); assert.equal(second.email, first.email);
});

test('logout rejects stale tabs and clears expired sessions safely', async () => {
  const f = await fixture(), first = await f.register('logout-first@example.com'), second = await f.register('logout-second@example.com');
  for (const expectedUser of [null, first.body.user.id]) {
    const stale = await f.request('/api/auth/logout', { method: 'POST', cookie: second.cookie, expectedUser }); assert.equal(stale.response.status, 409);
    assert.equal(stale.response.headers.get('Set-Cookie'), null); assert.deepEqual((await f.request('/api/auth/session', { cookie: second.cookie })).body.user, second.body.user);
  }
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie: second.cookie })).response.status, 200);
  f.advance(31 * 24 * 60 * 60 * 1000);
  const expired = await f.request('/api/auth/logout', { method: 'POST', cookie: first.cookie, expectedUser: null }); assert.equal(expired.response.status, 200); assert.match(expired.response.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('CAS exhaustion returns recoverable failure without overwriting account data', async () => {
  const f = await fixture(), account = await f.register(), before = structuredClone(await f.account('robot@example.com'));
  const original = f.store.write; f.store.write = async () => { const error = new Error('conflict'); error.name = 'ConflictError'; throw error; };
  const result = await f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress: { version: 1, drafts: { '001': { program: levels[0].solution, updatedAt: f.time() } }, completed: {} } } });
  assert.equal(result.response.status, 503); f.store.write = original; assert.deepEqual(await f.account('robot@example.com'), before);
});

test('static assets need no account storage', async () => { assert.equal(await (await createWorker().fetch(new Request(ORIGIN + '/'), { ASSETS: { fetch: async () => new Response('static') } })).text(), 'static'); });

test('actual workerd runtime uses signed cookies, native password crypto and CAS storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'brclio-github-runtime-')), entry = join(directory, 'worker.mjs'), config = join(directory, 'wrangler.json');
  const runtimeOrigin = 'http://bubu.brclio.com';
  await writeFile(entry, `import{createWorker}from ${JSON.stringify(resolve('worker/index.mjs'))}; const store=(${memoryStore.toString()})(); const app=createWorker({storeFactory:()=>store,sendEmail:async()=>{}}); export default{async fetch(request,env,ctx){if(new URL(request.url).pathname==='/test-seed'){const {codeHash,digestHex}=await import(${JSON.stringify(resolve('worker/auth.mjs'))});const email='runtime@example.com';await store.write('accounts/'+await digestHex(email)+'.json',{version:1,user:null,otp:{hash:await codeHash(env,email,'123456'),expiresAt:Date.now()+600000,sentAt:Date.now(),guesses:0},progress:{version:1,drafts:{},completed:{}},sessions:{},rates:{}},null);return new Response('seeded')}return app.fetch(request,env,ctx)}}`);
  const vars = { APP_ORIGIN: runtimeOrigin, AUTH_SECRET: 'test-only-runtime-pepper-01234567890123456789', SMTP_USER: 'fake@example.com', SMTP_PASS: 'fake', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'fake', GITHUB_INSTALLATION_ID: '456', GITHUB_DATA_OWNER: 'BrclioData', GITHUB_DATA_REPO: 'Brclio-Robot-Data' };
  await writeFile(config, JSON.stringify({ name: 'brclio-runtime-test', main: entry, compatibility_date: '2026-10-25', compatibility_flags: ['nodejs_compat'], vars }));
  const harness = createTestHarness({ root: directory, workers: [{ configPath: config, secrets: vars }] });
  t.after(async () => { await harness.close(); await rm(directory, { recursive: true, force: true }); }); await harness.listen();
  await harness.fetch(runtimeOrigin + '/test-seed');
  const post = (path, body) => harness.fetch(runtimeOrigin + path, { method: 'POST', headers: { Origin: runtimeOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const register = await post('/api/auth/register', { email: 'runtime@example.com', password: 'runtime-password', code: '123456' }); assert.equal(register.status, 201);
  const user = (await register.json()).user, cookie = register.headers.getSetCookie()[0].split(';')[0];
  const progress = { version: 1, drafts: { '001': { program: levels[0].solution, updatedAt: Date.now() } }, completed: {} };
  const saved = await harness.fetch(runtimeOrigin + '/api/progress', { method: 'PUT', headers: { Origin: runtimeOrigin, 'Content-Type': 'application/json', Cookie: cookie, 'X-Brclio-User-Id': user.id }, body: JSON.stringify({ progress }) }); assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).progress, progress); const login = await post('/api/auth/login', { email: 'runtime@example.com', password: 'runtime-password' }); assert.equal(login.status, 200);
});

test('a stale Google identity index cannot link a different email-only account after email changes', async () => {
  const subject = 'previously-indexed-google-subject';
  const f = await fixture({ worker: { fetchImpl: async url => new Response(JSON.stringify(url.includes('/token')
    ? { access_token: 'token', token_type: 'Bearer' }
    : { sub: subject, email: 'current@gmail.com', email_verified: true })) } });
  const existing = await f.register('reassigned@example.com');
  const before = structuredClone(await f.account('reassigned@example.com'));
  await f.store.write(`identities/google/${await digestHex(subject)}.json`, { version: 1, accountId: existing.body.user.id }, null);
  const { start, state } = await google(f);
  const callback = await f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie });
  assert.match(callback.response.headers.get('Location'), /google_failed/);
  assert.ok(!callback.cookie.includes('brclio_session='));
  assert.deepEqual(await f.account('reassigned@example.com'), before);
  assert.deepEqual((await f.request('/api/auth/session', { cookie: existing.cookie })).body.user, existing.body.user);
});
