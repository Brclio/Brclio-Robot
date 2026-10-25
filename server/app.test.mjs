import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp, readConfig } from './app.mjs';
import { emptyProgress, mergeProgress, validateProgress } from '../src/shared/progress.mjs';
import { levels } from '../src/data/levels.ts';

const ORIGIN = 'http://127.0.0.1:5174';
async function fixture(t, overrides = {}) {
  const sent = [];
  let clock = Date.now();
  const app = createApp({ dbPath: ':memory:', mailer: { sendMail: async mail => { sent.push(mail); } }, now: () => clock,
    config: { appOrigin: ORIGIN, appPath: '/', googleClientId: 'client-id', googleClientSecret: 'client-secret' }, ...overrides });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const userIds = new Map();
  const request = async (path, { body, cookie, origin = ORIGIN, expectedUser = userIds.get(cookie), ...options } = {}) => {
    const response = await fetch(base + path, { ...options, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(expectedUser ? { 'X-Brclio-User-Id': expectedUser } : {}), ...options.headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    const responseBody = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
    const responseCookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    if (responseBody?.user?.id) userIds.set(responseCookie || cookie, responseBody.user.id);
    return { response, body: responseBody, cookie: responseCookie };
  };
  const register = async (email = 'robot@example.com') => {
    const sentCode = await request('/api/auth/code', { method: 'POST', body: { email } });
    assert.equal(sentCode.response.status, 200);
    const code = sent.at(-1).text.match(/\d{6}/)[0];
    const result = await request('/api/auth/register', { method: 'POST', body: { email, password: 'safe-password-123', code } });
    assert.equal(result.response.status, 201);
    return result;
  };
  return { ...app, base, request, sent, register, advance: milliseconds => { clock += milliseconds; }, time: () => clock };
}

test('email registration verifies code, hashes credentials and creates private session', async t => {
  const f = await fixture(t);
  const account = await f.register('ROBOT@example.com');
  assert.equal(account.body.user.email, 'robot@example.com');
  assert.equal(account.body.user.provider, 'email');
  const cookie = account.response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  const dbUser = f.db.prepare('SELECT * FROM users').get();
  assert.match(dbUser.password_hash, /^scrypt:/); assert.ok(!dbUser.password_hash.includes('safe-password'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM email_codes').get().n, 0);
  assert.notEqual(f.db.prepare('SELECT hash FROM sessions').get().hash, account.cookie.split('=')[1]);
  const session = await f.request('/api/auth/session', { cookie: account.cookie });
  assert.deepEqual(session.body.user, account.body.user);
  assert.deepEqual(session.body.capabilities, { email: true, google: true });
});

test('OTP cooldown, expiry and five attempts prevent repeated sends and guessing', async t => {
  const f = await fixture(t);
  const email = 'guess@example.com';
  await f.request('/api/auth/code', { method: 'POST', body: { email } });
  const retry = await f.request('/api/auth/code', { method: 'POST', body: { email } });
  assert.equal(retry.response.status, 429); assert.equal(retry.body.retryAfter, 60); assert.equal(f.sent.length, 1);
  const realCode = f.sent[0].text.match(/\d{6}/)[0];
  const wrong = realCode === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) {
    const result = await f.request('/api/auth/register', { method: 'POST', body: { email, password: 'safe-password', code: wrong } });
    assert.equal(result.response.status, 400);
  }
  const locked = await f.request('/api/auth/register', { method: 'POST', body: { email, password: 'safe-password', code: realCode } });
  assert.equal(locked.response.status, 400);
  f.advance(61_000);
  await f.request('/api/auth/code', { method: 'POST', body: { email: 'expiry@example.com' } });
  const expiringCode = f.sent.at(-1).text.match(/\d{6}/)[0];
  f.advance(600_001);
  const expired = await f.request('/api/auth/register', { method: 'POST', body: { email: 'expiry@example.com', password: 'safe-password', code: expiringCode } });
  assert.equal(expired.response.status, 400);
});

test('SMTP failures never return success or expose transport credentials', async t => {
  const f = await fixture(t, { mailer: { sendMail: async () => { throw new Error('secret smtp password'); } } });
  const result = await f.request('/api/auth/code', { method: 'POST', body: { email: 'mail@example.com' } });
  assert.equal(result.response.status, 503);
  assert.ok(!JSON.stringify(result.body).includes('secret'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM email_codes').get().n, 0);
});

test('password login rejects wrong credentials, logout invalidates the cookie, and expiry is enforced', async t => {
  const f = await fixture(t);
  const registered = await f.register();
  const wrong = await f.request('/api/auth/login', { method: 'POST', body: { email: 'robot@example.com', password: 'wrong-password' } });
  assert.equal(wrong.response.status, 401);
  const login = await f.request('/api/auth/login', { method: 'POST', cookie: registered.cookie, body: { email: 'robot@example.com', password: 'safe-password-123' } });
  assert.equal(login.response.status, 200);
  assert.notEqual(login.cookie, registered.cookie);
  assert.equal((await f.request('/api/auth/session', { cookie: registered.cookie })).body.user, null);
  await f.request('/api/auth/logout', { method: 'POST', cookie: login.cookie });
  assert.equal((await f.request('/api/auth/session', { cookie: login.cookie })).body.user, null);
  const again = await f.request('/api/auth/login', { method: 'POST', body: { email: 'robot@example.com', password: 'safe-password-123' } });
  f.advance(31 * 24 * 60 * 60 * 1000);
  assert.equal((await f.request('/api/auth/session', { cookie: again.cookie })).body.user, null);
});

test('mutations require same-origin JSON and authenticated progress cannot be accessed cross-account', async t => {
  const f = await fixture(t);
  const first = await f.register();
  const second = await f.register('other@example.com');
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie: first.cookie, origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie: first.cookie, origin: null })).response.status, 403);
  const progress = { version: 1, drafts: { '001': { program: levels[0].solution, updatedAt: f.time() } },
    completed: { '001': { completedAt: new Date(f.time()).toISOString(), blocks: 2, actions: 2, program: levels[0].solution } } };
  assert.equal((await f.request('/api/progress', { method: 'PUT', cookie: first.cookie, body: { progress } })).response.status, 200);
  assert.equal((await f.request('/api/progress', { cookie: second.cookie })).body.progress, null);
  assert.equal((await f.request('/api/progress')).response.status, 401);
  assert.equal((await f.request('/api/progress', { method: 'PUT', cookie: first.cookie, body: { progress, userId: second.body.user.id } })).response.status, 400);
});

test('progress merges new records without stale draft loss and rejects invalid or future data', async t => {
  const f = await fixture(t);
  const account = await f.register();
  const current = { version: 1, drafts: { '001': { program: levels[0].solution, updatedAt: f.time() } }, completed: {} };
  await f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress: current } });
  const stale = { version: 1, drafts: { '001': { program: { main: [], functions: { A: [], B: [] } }, updatedAt: f.time() - 1000 } },
    completed: { '002': { completedAt: new Date(f.time()).toISOString(), blocks: 1, actions: 4, program: levels[1].solution } } };
  const result = await f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress: stale } });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.progress.drafts['001'], current.drafts['001']);
  assert.ok(result.body.progress.completed['002']);
  const invalid = structuredClone(current); invalid.drafts['001'].program.main[0].steps = 999;
  assert.equal((await f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress: invalid } })).response.status, 400);
  const future = structuredClone(current); future.drafts['001'].updatedAt = f.time() + 301_000;
  assert.equal((await f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress: future } })).response.status, 400);
  assert.deepEqual((await f.request('/api/progress', { cookie: account.cookie })).body.progress, result.body.progress);
});

test('Google flow uses PKCE, one-time browser state and safe redirects to create a verified account', async t => {
  const requests = [];
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    requests.push([url, options]);
    return new Response(JSON.stringify(url.includes('/token') ? { access_token: 'google-access-token', token_type: 'Bearer' }
      : { sub: 'google-user-123', email: 'google@example.com', email_verified: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const start = await f.request('/api/auth/google?returnTo=//evil.example');
  assert.equal(start.response.status, 302);
  const target = new URL(start.response.headers.get('location'));
  assert.equal(target.origin, 'https://accounts.google.com');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  const state = target.searchParams.get('state');
  const mismatch = await f.request(`/api/auth/google/callback?state=${state}&code=code`);
  assert.match(mismatch.response.headers.get('location'), /auth_error=google_state/);
  const callback = await f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie });
  assert.equal(callback.response.headers.get('location'), ORIGIN + '/');
  const verifier = requests[0][1].body.get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), target.searchParams.get('code_challenge'));
  const session = await f.request('/api/auth/session', { cookie: callback.cookie });
  assert.equal(session.body.user.provider, 'google');
  const repeated = await f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie });
  assert.match(repeated.response.headers.get('location'), /auth_error=google_state/);
  assert.equal(requests.length, 2);
});

test('Google never links a non-authoritative third-party address to an existing password account', async t => {
  const f = await fixture(t, { fetchImpl: async url => new Response(JSON.stringify(url.includes('/token')
    ? { access_token: 'token', token_type: 'Bearer' }
    : { sub: 'external-google-id', email: 'robot@example.com', email_verified: true }), { status: 200 }) });
  await f.register();
  const start = await f.request('/api/auth/google');
  const state = new URL(start.response.headers.get('location')).searchParams.get('state');
  const callback = await f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie });
  assert.match(callback.response.headers.get('location'), /google_link_required/);
  assert.equal(f.db.prepare('SELECT google_sub FROM users').get().google_sub, null);
});

test('unverified Google email is rejected and no session is issued', async t => {
  const f = await fixture(t, { fetchImpl: async url => new Response(JSON.stringify(url.includes('/token')
    ? { access_token: 'token', token_type: 'Bearer' }
    : { sub: 'unverified-user', email: 'robot@gmail.com', email_verified: false }), { status: 200 }) });
  const start = await f.request('/api/auth/google');
  const state = new URL(start.response.headers.get('location')).searchParams.get('state');
  const callback = await f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie });
  assert.match(callback.response.headers.get('location'), /google_failed/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  assert.ok(!callback.cookie.includes('brclio_session='));
});

test('capabilities reflect configuration and production requires secure cookies', async t => {
  const f = await fixture(t, { mailer: null, config: { appOrigin: ORIGIN, appPath: '/', googleClientId: '', googleClientSecret: '' } });
  assert.deepEqual((await f.request('/api/auth/session')).body.capabilities, { email: false, google: false });
  assert.equal((await f.request('/api/auth/code', { method: 'POST', body: { email: 'robot@example.com' } })).response.status, 503);
  assert.equal((await f.request('/api/auth/google')).response.status, 503);
  assert.throws(() => readConfig({ APP_ORIGIN: 'http://example.com', NODE_ENV: 'production' }), /HTTPS/);
  assert.equal(readConfig({ APP_ORIGIN: 'https://bubu.brclio.com', NODE_ENV: 'production' }).secureCookies, true);
});

test('shared merge is commutative and idempotent for equal timestamps', () => {
  const a = emptyProgress(), b = emptyProgress();
  a.drafts['001'] = { program: levels[0].solution, updatedAt: 1 };
  b.drafts['001'] = { program: { main: [], functions: { A: [], B: [] } }, updatedAt: 1 };
  assert.deepEqual(mergeProgress(a, b), mergeProgress(b, a));
  assert.deepEqual(mergeProgress(a, a), a);
  assert.ok(validateProgress(mergeProgress(a, b)));
  assert.equal(validateProgress({ version: 1, drafts: { '__proto__': {} }, completed: {} }), false);
});

test('shared merge retains captured solutions added to legacy completions at the same time', () => {
  const legacy = { version: 1, drafts: {}, completed: { '001': { completedAt: '2026-01-01T00:00:00.000Z', blocks: 2, actions: 2 } } };
  const captured = structuredClone(legacy);
  captured.completed['001'].program = levels[0].solution;
  assert.deepEqual(mergeProgress(legacy, captured), captured);
  assert.deepEqual(mergeProgress(captured, legacy), captured);
});

test('login attempts are rate-limited per mailbox and do not reveal account existence', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const result = await f.request('/api/auth/login', { method: 'POST', body: { email: 'absent@example.com', password: 'some-password' } });
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error, '邮箱或密码不正确。');
  }
  const limited = await f.request('/api/auth/login', { method: 'POST', body: { email: 'absent@example.com', password: 'some-password' } });
  assert.equal(limited.response.status, 429);
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
});

test('Google cancellation consumes state without creating an account', async t => {
  const f = await fixture(t);
  const start = await f.request('/api/auth/google?returnTo=%2F%3Flesson%3D2');
  const state = new URL(start.response.headers.get('location')).searchParams.get('state');
  const cancelled = await f.request(`/api/auth/google/callback?state=${state}&error=access_denied`, { cookie: start.cookie });
  const location = new URL(cancelled.response.headers.get('location'));
  assert.equal(location.origin, ORIGIN);
  assert.equal(location.searchParams.get('lesson'), '2');
  assert.equal(location.searchParams.get('auth_error'), 'google_cancelled');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM oauth_states').get().n, 0);
});

test('Google verified Gmail address links to the existing account without losing history', async t => {
  const f = await fixture(t, { fetchImpl: async url => new Response(JSON.stringify(url.includes('/token')
    ? { access_token: 'token', token_type: 'Bearer' }
    : { sub: 'gmail-google-id', email: 'robot@gmail.com', email_verified: true }), { status: 200 }) });
  const existing = await f.register('robot@gmail.com');
  const start = await f.request('/api/auth/google');
  const state = new URL(start.response.headers.get('location')).searchParams.get('state');
  const callback = await f.request(`/api/auth/google/callback?state=${state}&code=code`, { cookie: start.cookie });
  const account = (await f.request('/api/auth/session', { cookie: callback.cookie })).body.user;
  assert.equal(account.id, existing.body.user.id);
  assert.equal(account.provider, 'google');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  const passwordLogin = await f.request('/api/auth/login', { method: 'POST', body: { email: 'robot@gmail.com', password: 'safe-password-123' } });
  assert.equal(passwordLogin.response.status, 200);
});

test('parallel code requests issue one message and parallel registration consumes its code once', async t => {
  const f = await fixture(t);
  const email = 'parallel@example.com';
  const issued = await Promise.all(Array.from({ length: 3 }, () => f.request('/api/auth/code', { method: 'POST', body: { email } })));
  assert.deepEqual(issued.map(r => r.response.status).sort(), [200, 429, 429]);
  assert.equal(f.sent.length, 1);
  const code = f.sent[0].text.match(/\d{6}/)[0];
  const registered = await Promise.all(Array.from({ length: 2 }, () => f.request('/api/auth/register', { method: 'POST', body: { email, password: 'safe-password', code } })));
  assert.equal(registered.filter(r => r.response.status === 201).length, 1);
  assert.equal(registered.filter(r => r.response.status === 400).length, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});

test('sync rate limits reject request storms and reset without destroying saved progress', async t => {
  const f = await fixture(t);
  const account = await f.register();
  for (let i = 0; i < 120; i++) {
    const result = await f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress: emptyProgress() } });
    assert.equal(result.response.status, 200);
  }
  const limited = await f.request('/api/progress', { method: 'PUT', cookie: account.cookie, body: { progress: emptyProgress() } });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.retryAfter, 60);
  f.advance(60_001);
  const saved = await f.request('/api/progress', { cookie: account.cookie });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.body.progress, emptyProgress());
});

test('API rejects oversized bodies with both Content-Length and chunked transfer', async t => {
  const f = await fixture(t);
  const account = await f.register();
  const oversized = JSON.stringify({ progress: 'x'.repeat(1_000_001) });
  const direct = await fetch(f.base + '/api/progress', { method: 'PUT', headers: { Origin: ORIGIN, Cookie: account.cookie, 'X-Brclio-User-Id': account.body.user.id, 'Content-Type': 'application/json' }, body: oversized });
  assert.equal(direct.status, 413);
  assert.match((await direct.json()).error, /记录太大/);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(oversized.slice(0, 500_000))); controller.enqueue(encoder.encode(oversized.slice(500_000))); controller.close(); } });
  const chunked = await fetch(f.base + '/api/progress', { method: 'PUT', duplex: 'half', headers: { Origin: ORIGIN, Cookie: account.cookie, 'X-Brclio-User-Id': account.body.user.id, 'Content-Type': 'application/json' }, body: stream });
  assert.equal(chunked.status, 413);
  assert.match((await chunked.json()).error, /记录太大/);
  assert.equal((await f.request('/api/progress', { cookie: account.cookie })).body.progress, null);
});

test('an account switched in another tab cannot read or write the previous tab history', async t => {
  const f = await fixture(t);
  const first = await f.register('first@example.com');
  const second = await f.register('second@example.com');
  const firstId = first.body.user.id, secondId = second.body.user.id;
  const firstData = { version: 1, drafts: { '001': { program: levels[0].solution, updatedAt: f.time() } }, completed: {} };
  await f.request('/api/progress', { method: 'PUT', cookie: first.cookie, body: { progress: firstData } });
  for (const expectedUser of [null, firstId]) {
    const staleRead = await f.request('/api/progress', { cookie: second.cookie, expectedUser });
    assert.equal(staleRead.response.status, 409);
    assert.match(staleRead.body.error, /账号已在其他页面切换/);
    const staleWrite = await f.request('/api/progress', { method: 'PUT', cookie: second.cookie, expectedUser, body: { progress: firstData } });
    assert.equal(staleWrite.response.status, 409);
  }
  assert.equal((await f.request('/api/progress', { cookie: second.cookie, expectedUser: secondId })).body.progress, null);
  assert.deepEqual((await f.request('/api/progress', { cookie: first.cookie, expectedUser: firstId })).body.progress, firstData);
});

test('SQLite sessions and progress survive a backend restart', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'brclio-server-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'persist.sqlite');
  const config = { appOrigin: ORIGIN, appPath: '/' };
  const sent = [];
  const first = createApp({ dbPath, config, mailer: { sendMail: async mail => sent.push(mail) } });
  first.server.listen(0, '127.0.0.1'); await once(first.server, 'listening');
  const firstUrl = `http://127.0.0.1:${first.server.address().port}`;
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  await fetch(firstUrl + '/api/auth/code', { method: 'POST', headers, body: JSON.stringify({ email: 'persist@example.com' }) });
  const register = await fetch(firstUrl + '/api/auth/register', { method: 'POST', headers, body: JSON.stringify({ email: 'persist@example.com', password: 'safe-password', code: sent[0].text.match(/\d{6}/)[0] }) });
  const user = (await register.json()).user;
  const cookie = register.headers.getSetCookie()[0].split(';')[0];
  const progress = { version: 1, drafts: { '001': { program: levels[0].solution, updatedAt: Date.now() } }, completed: {} };
  const saved = await fetch(firstUrl + '/api/progress', { method: 'PUT', headers: { ...headers, Cookie: cookie, 'X-Brclio-User-Id': user.id }, body: JSON.stringify({ progress }) });
  assert.equal(saved.status, 200); await saved.json();
  await first.close();
  const second = createApp({ dbPath, config });
  second.server.listen(0, '127.0.0.1'); await once(second.server, 'listening');
  t.after(() => second.close());
  const secondUrl = `http://127.0.0.1:${second.server.address().port}`;
  const session = await fetch(secondUrl + '/api/auth/session', { headers: { Cookie: cookie } });
  assert.deepEqual((await session.json()).user, user);
  const restored = await fetch(secondUrl + '/api/progress', { headers: { Cookie: cookie, 'X-Brclio-User-Id': user.id } });
  assert.deepEqual((await restored.json()).progress, progress);
});

test('a single loopback proxy uses the rightmost client IP and ignores spoofed XFF prefixes', async t => {
  const f = await fixture(t, { config: { appOrigin: ORIGIN, appPath: '/', trustProxy: true } });
  for (let i = 0; i < 20; i++) {
    const result = await f.request('/api/auth/register', { method: 'POST', headers: { 'X-Forwarded-For': `198.51.100.${i + 1}, 203.0.113.77` },
      body: { email: `proxy${i}@example.com`, password: 'safe-password', code: '123456' } });
    assert.equal(result.response.status, 400);
  }
  const limited = await f.request('/api/auth/register', { method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.200, 203.0.113.77' },
    body: { email: 'other-proxy@example.com', password: 'safe-password', code: '123456' } });
  assert.equal(limited.response.status, 429);
  const differentClient = await f.request('/api/auth/register', { method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.200, 203.0.113.78' },
    body: { email: 'another-proxy@example.com', password: 'safe-password', code: '123456' } });
  assert.equal(differentClient.response.status, 400);
});

test('static serving rejects symlinks outside its real root while allowing bundled assets', async t => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'brclio-static-test-'));
  const staticDir = join(directory, 'dist');
  await mkdir(staticDir);
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Robot</title>');
  await writeFile(join(directory, 'secret.txt'), 'outside-secret');
  await symlink(join(directory, 'secret.txt'), join(staticDir, 'leak.txt'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, { config: { appOrigin: ORIGIN, appPath: '/', staticDir } });
  const index = await f.request('/');
  assert.equal(index.response.status, 200); assert.match(index.body, /Robot/);
  const escaped = await f.request('/leak.txt');
  assert.equal(escaped.response.status, 404);
  assert.ok(!JSON.stringify(escaped.body).includes('outside-secret'));
  const head = await f.request('/', { method: 'HEAD' });
  assert.equal(head.response.status, 200); assert.equal(head.body, '');
});

test('a static read-stream failure returns an error without crashing the account service', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('POSIX read permissions require an unprivileged user'); return; }
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'brclio-stream-test-'));
  const file = join(directory, 'blocked.html');
  await writeFile(file, '<title>unreadable</title>');
  await chmod(file, 0);
  t.after(async () => { await chmod(file, 0o600); await rm(directory, { recursive: true, force: true }); });
  const f = await fixture(t, { config: { appOrigin: ORIGIN, appPath: '/', staticDir: directory } });
  const result = await f.request('/blocked.html');
  assert.equal(result.response.status, 404);
  assert.match(result.body.error, /暂时无法读取/);
  assert.equal((await f.request('/api/auth/session')).response.status, 200);
});

test('logout cannot invalidate another tab account and still clears expired sessions', async t => {
  const f = await fixture(t);
  const first = await f.register('logout-first@example.com');
  const second = await f.register('logout-second@example.com');
  for (const expectedUser of [null, first.body.user.id]) {
    const stale = await f.request('/api/auth/logout', { method: 'POST', cookie: second.cookie, expectedUser });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.response.headers.get('Set-Cookie'), null);
    assert.deepEqual((await f.request('/api/auth/session', { cookie: second.cookie })).body.user, second.body.user);
  }
  const valid = await f.request('/api/auth/logout', { method: 'POST', cookie: second.cookie, expectedUser: second.body.user.id });
  assert.equal(valid.response.status, 200);
  assert.equal((await f.request('/api/auth/session', { cookie: second.cookie })).body.user, null);
  f.advance(31 * 24 * 60 * 60 * 1000);
  const expired = await f.request('/api/auth/logout', { method: 'POST', cookie: first.cookie, expectedUser: null });
  assert.equal(expired.response.status, 200);
  assert.match(expired.response.headers.get('Set-Cookie'), /Max-Age=0/);
});
