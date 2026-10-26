import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubStore, ConflictError, StorageError } from './github-store.mjs';
const encoder = new TextEncoder();
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']);
const privateDer = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
const privatePem = `-----BEGIN PRIVATE KEY-----\n${privateDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
const PATH = 'accounts/' + 'a'.repeat(64) + '.json';
const SHA = 'b'.repeat(40), NEXT_SHA = 'c'.repeat(40);
let fixtureId = 0;
function json(value, status = 200, headers) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
function fixture(options = {}) {
  let clock = Date.now(), privateRepo = true, issued = 0;
  const calls = [];
  const env = { GITHUB_APP_ID: '5467364', GITHUB_INSTALLATION_ID: String(900_000_000_000 + ++fixtureId), GITHUB_APP_PRIVATE_KEY: privatePem,
    GITHUB_DATA_OWNER: 'BrclioData', GITHUB_DATA_REPO: 'Brclio-Robot-Data', ...options.env };
  const value = options.value || { email: 'child@example.com', progress: { completed: { '001': true } }, label: '积木' };
  const contents = path => {
    const bytes = encoder.encode(JSON.stringify(value));
    return { type: 'file', path, sha: SHA, encoding: 'base64', size: bytes.byteLength, content: Buffer.from(bytes).toString('base64').match(/.{1,60}/g).join('\n') };
  };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url); calls.push({ url: parsed, ...init });
    assert.equal(parsed.origin, 'https://api.github.com'); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    if (parsed.pathname.endsWith('/access_tokens')) {
      issued++;
      return options.token ? options.token({ url: parsed, init, issued, now: clock }) : json({ token: `ghs_test_secret_installation_token_${fixtureId}_${issued}`, expires_at: new Date(clock + 3_600_000).toISOString(),
        permissions: { contents: 'write', metadata: 'read' }, repositories: [{ full_name: 'BrclioData/Brclio-Robot-Data' }] }, 201);
    }
    if (!parsed.pathname.includes('/contents/')) return options.metadata ? options.metadata() : json({ private: privateRepo, full_name: 'BrclioData/Brclio-Robot-Data' });
    const path = decodeURIComponent(parsed.pathname.split('/contents/')[1]);
    if (options.data) return options.data({ url: parsed, init, path, contents });
    return init.method === 'PUT' ? json({ content: { sha: NEXT_SHA, path } }, 201) : json(contents(path));
  };
  const now = () => clock;
  return { env, calls, value, fetchImpl, now, store: createGitHubStore(env, { fetchImpl, now }),
    advance: milliseconds => { clock += milliseconds; }, visibility: privateValue => { privateRepo = privateValue; },
    count: part => calls.filter(call => call.url.pathname.includes(part)).length };
}

test('App JWT has verifiable RS256 signature, short bounded claims, and token is repo/permission scoped', async () => {
  const f = fixture();
  const read = await f.store.read(PATH);
  assert.deepEqual(read, { value: f.value, revision: SHA });
  const tokenRequest = f.calls[0], jwt = tokenRequest.headers.Authorization.slice(7), [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, '5467364'); assert.equal(claims.iat, Math.floor(f.now() / 1000) - 60); assert.equal(claims.exp - claims.iat, 600);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, Buffer.from(signature, 'base64url'), encoder.encode(`${header}.${payload}`)), true);
  assert.deepEqual(JSON.parse(tokenRequest.body), { repositories: ['Brclio-Robot-Data'], permissions: { contents: 'write', metadata: 'read' } });
  assert.equal(tokenRequest.headers['User-Agent'], 'Brclio-Robot-Data-Store');
  assert.equal(f.calls.at(-1).url.searchParams.get('ref'), 'main');
  assert.ok(!f.calls.at(-1).headers.Authorization.includes(jwt));
});

test('token and private-repo checks cache across stores, expire independently, and concurrent calls share refresh', async () => {
  const f = fixture();
  const second = createGitHubStore(f.env, { fetchImpl: f.fetchImpl, now: f.now });
  await Promise.all([f.store.read(PATH), second.read(PATH), f.store.read(PATH)]);
  assert.equal(f.count('/access_tokens'), 1); assert.equal(f.calls.filter(call => !call.url.pathname.includes('/contents/') && !call.url.pathname.endsWith('/access_tokens')).length, 1);
  f.advance(59_000); await second.read(PATH); assert.equal(f.count('/access_tokens'), 1); assert.equal(f.calls.length, 6);
  f.advance(2_000); await f.store.read(PATH); assert.equal(f.calls.length, 8); assert.equal(f.count('/access_tokens'), 1);
  f.advance(3_540_000); await f.store.read(PATH); assert.equal(f.count('/access_tokens'), 2);
});

test('private visibility is checked before every data operation and rechecked within a minute', async () => {
  const blocked = fixture(); blocked.visibility(false);
  await assert.rejects(blocked.store.read(PATH), error => error.code === 'GITHUB_PRIVATE_REQUIRED');
  await assert.rejects(blocked.store.write(PATH, { secret: 'private' }, null), error => error.code === 'GITHUB_PRIVATE_REQUIRED');
  assert.equal(blocked.count('/contents/'), 0);
  const changed = fixture(); await changed.store.read(PATH); changed.visibility(false); changed.advance(60_001);
  await assert.rejects(changed.store.write(PATH, { secret: 'private' }, SHA), error => error.code === 'GITHUB_PRIVATE_REQUIRED');
  assert.equal(changed.calls.filter(call => call.method === 'PUT').length, 0);
  const internal = fixture({ metadata: () => json({ private: true, visibility: 'internal', full_name: 'BrclioData/Brclio-Robot-Data' }) });
  await assert.rejects(internal.store.read(PATH), error => error.code === 'GITHUB_PRIVATE_REQUIRED');
  assert.equal(internal.count('/contents/'), 0);
});

test('write uses expected blob SHA, explicit branch, encoded JSON and a constant nonpersonal commit subject', async () => {
  const f = fixture({ env: { GITHUB_DATA_BRANCH: 'data/live' } });
  const value = { email: 'child@example.com', label: '新积木' };
  assert.deepEqual(await f.store.write(PATH, value, SHA), { value, revision: NEXT_SHA });
  const body = JSON.parse(f.calls.at(-1).body);
  assert.equal(body.sha, SHA); assert.equal(body.branch, 'data/live'); assert.equal(body.message, 'Update account data');
  assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), value);
  assert.ok(!f.calls.at(-1).url.pathname.includes('child'));
  await f.store.write('oauth/' + 'd'.repeat(64) + '.json', { consumed: false }, null);
  assert.ok(!('sha' in JSON.parse(f.calls.at(-1).body)));
});

test('409 and specifically SHA-related 422 are CAS conflicts; unrelated validation errors are not retried as conflicts', async () => {
  for (const [status, body] of [[409, { message: 'conflict' }], [422, { message: 'sha was not supplied' }], [422, { errors: [{ field: 'sha', code: 'invalid' }] }]]) {
    const f = fixture({ data: () => json(body, status) });
    await assert.rejects(f.store.write(PATH, { ok: true }, SHA), ConflictError);
    assert.equal(f.count('/contents/'), 1);
  }
  const invalid = fixture({ data: () => json({ message: 'private raw validation secret' }, 422) });
  await assert.rejects(invalid.store.write(PATH, { ok: true }, null), error => error instanceof StorageError && !(error instanceof ConflictError) && !String(error).includes('secret'));
});

test('only allowlisted hashed record paths are accepted and source repo cannot become the data store', async () => {
  const f = fixture();
  for (const path of ['../.env', PATH + '?ref=other', 'accounts/' + 'a'.repeat(63) + '.json', '.github/workflows/run.yml', 'accounts/person@example.com.json', 'accounts/' + 'A'.repeat(64) + '.json']) {
    await assert.rejects(f.store.read(path), error => error.code === 'GITHUB_PATH');
    await assert.rejects(f.store.write(path, { ok: true }, null), error => error.code === 'GITHUB_PATH');
  }
  assert.equal(f.calls.length, 0);
  for (const path of ['limits/' + 'a'.repeat(64) + '.json', 'identities/google/' + 'a'.repeat(64) + '.json']) await f.store.read(path);
  assert.throws(() => createGitHubStore({ ...f.env, GITHUB_DATA_OWNER: 'Brclio', GITHUB_DATA_REPO: 'Brclio-Robot' }), error => error.code === 'GITHUB_CONFIG');
});

test('write bounds UTF8 byte size, rejects invalid JSON roots and SHA, and never starts network on malformed values', async () => {
  const f = fixture(), cyclic = {}; cyclic.self = cyclic;
  for (const value of ['string', [], null, cyclic]) await assert.rejects(f.store.write(PATH, value, null), error => error.code === 'GITHUB_DATA_INVALID');
  await assert.rejects(f.store.write(PATH, { text: '文'.repeat(333_334) }, null), error => error.code === 'GITHUB_DATA_TOO_LARGE');
  await assert.rejects(f.store.write(PATH, {}, 'not-a-sha'), error => error.code === 'GITHUB_REVISION');
  assert.equal(f.calls.length, 0);
});

test('read rejects malformed base64/JSON/UTF8, oversized or mismatched blobs and non-file targets', async () => {
  const candidates = [
    body => ({ ...body, content: '***' }), body => ({ ...body, size: 1_000_001 }), body => ({ ...body, size: body.size + 1 }),
    body => ({ ...body, type: 'symlink' }), body => ({ ...body, path: 'other.json' }), body => ({ ...body, sha: 'unsafe' }),
    body => ({ ...body, content: Buffer.from('broken JSON').toString('base64'), size: 11 }),
    body => ({ ...body, content: Buffer.from([0xff, 0xfe]).toString('base64'), size: 2 }),
  ];
  for (const alter of candidates) {
    const f = fixture({ data: ({ path, contents }) => json(alter(contents(path))) });
    await assert.rejects(f.store.read(PATH), error => error.code === 'GITHUB_DATA_INVALID');
  }
  const absent = fixture({ data: () => json({ message: 'Not found' }, 404) });
  assert.equal(await absent.store.read(PATH), null);
});

test('expired/revoked installation token refreshes once and revalidates privacy', async () => {
  let reads = 0;
  const f = fixture({ data: ({ path, contents }) => ++reads === 1 ? json({ message: 'bad credentials private-token' }, 401) : json(contents(path)) });
  assert.ok(await f.store.read(PATH)); assert.equal(f.count('/access_tokens'), 2); assert.equal(reads, 2);
});

test('unexpected installation permissions/repositories are refused before any data read', async () => {
  for (const changes of [{ permissions: { contents: 'write', metadata: 'read', issues: 'write' } }, { repositories: [{ full_name: 'Brclio/Brclio-Robot' }] }]) {
    const f = fixture({ token: ({ now }) => json({ token: 'ghs_secret_test_token_123456789', expires_at: new Date(now + 3_600_000).toISOString(),
      permissions: { contents: 'write', metadata: 'read' }, repositories: [{ full_name: 'BrclioData/Brclio-Robot-Data' }], ...changes }, 201) });
    await assert.rejects(f.store.read(PATH), error => error.code === 'GITHUB_AUTH');
    assert.equal(f.count('/contents/'), 0);
  }
});

test('transport and GitHub errors are sanitized without tokens, raw bodies, private keys or causes', async () => {
  const f = fixture({ data: () => { throw new Error('ghs_secret_token private-email@example.com raw secret body'); } });
  await assert.rejects(f.store.read(PATH), error => {
    assert.equal(error.code, 'GITHUB_UNAVAILABLE'); assert.equal(error.cause, undefined);
    assert.ok(!String(error).includes('ghs_')); assert.ok(!JSON.stringify(error).includes('secret')); return true;
  });
  const limited = fixture({ data: () => json({ message: 'raw private error' }, 403, { 'X-RateLimit-Remaining': '0' }) });
  await assert.rejects(limited.store.read(PATH), error => error.code === 'GITHUB_RATE_LIMIT');
  const malformed = fixture({ data: () => new Response('secret raw nonJSON', { status: 200 }) });
  await assert.rejects(malformed.store.read(PATH), error => error.code === 'GITHUB_RESPONSE_INVALID');
});

test('PKCS1 and malformed keys fail closed without external writes', async () => {
  const f = fixture();
  assert.throws(() => createGitHubStore({ ...f.env, GITHUB_APP_PRIVATE_KEY: privatePem.replaceAll('PRIVATE KEY', 'RSA PRIVATE KEY') }), error => error.code === 'GITHUB_CONFIG');
  const invalid = createGitHubStore({ ...f.env, GITHUB_INSTALLATION_ID: String(900_000_000_000 + ++fixtureId), GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }, { fetchImpl: f.fetchImpl });
  await assert.rejects(invalid.read(PATH), error => error.code === 'GITHUB_CONFIG');
  assert.equal(f.calls.length, 0);
});

test('GitHub requests abort after 15 seconds without exposing raw network details', async t => {
  const f = fixture(); let signal, started;
  const ready = new Promise(resolve => { started = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createGitHubStore(f.env, { now: f.now, fetchImpl: async (_url, init) => {
    signal = init.signal; started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private-network-secret')), { once: true }));
  } });
  const pending = store.read(PATH);
  await ready;
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, error => error.code === 'GITHUB_TIMEOUT' && !String(error).includes('private'));
  assert.equal(signal.aborted, true);
});

test('oversized GitHub responses are bounded before JSON or account data processing', async () => {
  const f = fixture({ metadata: () => json({ private: true, full_name: 'BrclioData/Brclio-Robot-Data' }, 200, { 'Content-Length': '2000000' }) });
  await assert.rejects(f.store.read(PATH), error => error.code === 'GITHUB_RESPONSE_INVALID');
  assert.equal(f.count('/contents/'), 0);
  const streamed = fixture({ data: () => new Response(' '.repeat(1_500_001)) });
  await assert.rejects(streamed.store.read(PATH), error => error.code === 'GITHUB_RESPONSE_INVALID');
});

test('Worker-compatible manual redirects reject every 3xx before reading bodies and never forward credentials', async () => {
  for (const status of [301, 302, 303, 304, 307, 308]) {
    let reads = 0;
    const f = fixture({ data: () => {
      const response = new Response(status === 304 ? null : 'private redirect body', { status, headers: { Location: 'https://untrusted.example/receive-token' } });
      if (response.body) {
        const getReader = response.body.getReader.bind(response.body);
        response.body.getReader = (...args) => { reads++; return getReader(...args); };
      }
      return response;
    } });
    await assert.rejects(f.store.read(PATH), error => error.code === 'GITHUB_REDIRECT');
    assert.equal(reads, 0); assert.equal(f.count('/contents/'), 1);
    assert.ok(f.calls.every(call => call.redirect === 'manual' && call.url.origin === 'https://api.github.com'));
    assert.equal(f.calls.at(-1).signal.aborted, true);
  }
  const tokenRedirect = fixture({ token: () => new Response(null, { status: 307, headers: { Location: 'https://untrusted.example/receive-jwt' } }) });
  await assert.rejects(tokenRedirect.store.read(PATH), error => error.code === 'GITHUB_REDIRECT');
  assert.equal(tokenRedirect.calls.length, 1);
});
