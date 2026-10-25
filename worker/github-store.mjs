const API = 'https://api.github.com';
const VERSION = '2026-03-10';
const MAX_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 1_500_000;
const PRIVATE_TTL = 60_000;
const TOKEN_SKEW = 60_000;
const TIMEOUT = 15_000;
const encoder = new TextEncoder();
const tokens = new Map();
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PATH = /^(?:(?:accounts|limits|oauth)\/[a-f0-9]{64}|identities\/google\/[a-f0-9]{64})\.json$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class StorageError extends Error {
  constructor(code = 'GITHUB_UNAVAILABLE') {
    super('账号存储暂时不可用，请稍后重试。浏览器中的记录会保留。');
    this.name = 'StorageError'; this.code = code;
  }
}
export class ConflictError extends StorageError {
  constructor() { super('GITHUB_CONFLICT'); this.name = 'ConflictError'; }
}
function fail(code) { throw new StorageError(code); }
function b64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
const b64url = bytes => b64(new Uint8Array(bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function unbase64(value, max) {
  if (typeof value !== 'string') fail('GITHUB_DATA_INVALID');
  const compact = value.replace(/[\r\n]/g, '');
  if (compact.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) fail('GITHUB_DATA_INVALID');
  try {
    const binary = atob(compact);
    if (binary.length > max) fail('GITHUB_DATA_INVALID');
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch { fail('GITHUB_DATA_INVALID'); }
}
function config(env) {
  const app = String(env.GITHUB_APP_ID || ''), installation = String(env.GITHUB_INSTALLATION_ID || '');
  const owner = env.GITHUB_DATA_OWNER || 'BrclioData', repo = env.GITHUB_DATA_REPO || 'Brclio-Robot-Data', branch = env.GITHUB_DATA_BRANCH || 'main';
  if (!/^[1-9]\d{0,19}$/.test(app) || !/^[1-9]\d{0,19}$/.test(installation)
    || typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)
    || typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)
    || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.split('/').some(part => part.endsWith('.lock'))
    || (owner.toLowerCase() === 'brclio' && repo.toLowerCase() === 'brclio-robot')
    || typeof env.GITHUB_APP_PRIVATE_KEY !== 'string') fail('GITHUB_CONFIG');
  const pem = env.GITHUB_APP_PRIVATE_KEY.replaceAll('\\n', '\n').trim();
  const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/.exec(pem);
  if (!match) fail('GITHUB_CONFIG');
  let keyBytes;
  try { keyBytes = unbase64(match[1].replace(/\s/g, ''), 8192); }
  catch { fail('GITHUB_CONFIG'); }
  return { app, installation, owner, repo, branch, keyBytes,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    cacheKey: `${app}:${installation}:${owner.toLowerCase()}/${repo.toLowerCase()}` };
}
async function jwt(settings, now) {
  try {
    const key = await crypto.subtle.importKey('pkcs8', settings.keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    if (key.algorithm.modulusLength < 2048) fail('GITHUB_CONFIG');
    const seconds = Math.floor(now() / 1000);
    const header = b64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = b64url(encoder.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: settings.app })));
    const input = `${header}.${claims}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input));
    return `${input}.${b64url(signature)}`;
  } catch { fail('GITHUB_CONFIG'); }
}
function checkedPath(path) {
  if (typeof path !== 'string' || !PATH.test(path)) fail('GITHUB_PATH');
  return path.split('/').map(encodeURIComponent).join('/');
}
function serialized(value) {
  if (!record(value)) fail('GITHUB_DATA_INVALID');
  try {
    const text = JSON.stringify(value);
    if (!record(JSON.parse(text))) fail('GITHUB_DATA_INVALID');
    const bytes = encoder.encode(text);
    if (bytes.byteLength > MAX_BYTES) fail('GITHUB_DATA_TOO_LARGE');
    return { bytes, value: JSON.parse(text) };
  } catch (error) { if (error instanceof StorageError) throw error; fail('GITHUB_DATA_INVALID'); }
}
function shaConflict(body) {
  return record(body) && ((typeof body.message === 'string' && /\bsha\b/i.test(body.message))
    || (Array.isArray(body.errors) && body.errors.some(error => record(error) && error.field === 'sha')));
}

/** All credentials stay inside this Worker. Paths and commit subjects contain no personal data. */
export function createGitHubStore(env, { fetchImpl = fetch, now = Date.now } = {}) {
  const settings = config(env);
  async function api(path, credential, { method = 'GET', body } = {}) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), TIMEOUT);
    try {
      const response = await fetchImpl(API + path, { method, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: abort.signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${credential}`, 'X-GitHub-Api-Version': VERSION,
          'User-Agent': 'Brclio-Robot-Data-Store', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let bytes = 0, raw = '', reader;
      const decoder = new TextDecoder();
      if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES) fail('GITHUB_RESPONSE_INVALID');
      try {
        reader = response.body?.getReader();
        if (reader) for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('GITHUB_RESPONSE_INVALID'); }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      } finally { reader?.releaseLock(); }
      let parsed;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { fail('GITHUB_RESPONSE_INVALID'); }
      return { status: response.status, headers: response.headers, body: parsed };
    } catch (error) { if (error instanceof StorageError) throw error; fail(abort.signal.aborted ? 'GITHUB_TIMEOUT' : 'GITHUB_UNAVAILABLE'); }
    finally { clearTimeout(timer); abort.abort(); }
  }
  function httpFailure(result) {
    if (result.status === 401) fail('GITHUB_AUTH');
    if (result.status === 429 || (result.status === 403 && result.headers.get('X-RateLimit-Remaining') === '0')) fail('GITHUB_RATE_LIMIT');
    fail(result.status >= 500 ? 'GITHUB_UNAVAILABLE' : 'GITHUB_REJECTED');
  }
  async function installationToken() {
    const cached = tokens.get(settings.cacheKey);
    if (cached?.pending) return cached.pending;
    if (cached?.expires > now() + TOKEN_SKEW) return cached;
    const pending = (async () => {
      const result = await api(`/app/installations/${settings.installation}/access_tokens`, await jwt(settings, now), {
        method: 'POST', body: { repositories: [settings.repo], permissions: { contents: 'write', metadata: 'read' } },
      });
      if (result.status !== 201) httpFailure(result);
      const body = result.body, expires = Date.parse(body?.expires_at);
      if (!record(body) || typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(body.token)
        || !Number.isFinite(expires) || expires <= now() + TOKEN_SKEW || body.permissions?.contents !== 'write'
        || Object.keys(body.permissions).some(key => !['contents', 'metadata'].includes(key))
        || (body.permissions.metadata !== undefined && body.permissions.metadata !== 'read')) fail('GITHUB_AUTH');
      if (body.repositories !== undefined && (!Array.isArray(body.repositories) || body.repositories.length !== 1
        || String(body.repositories[0]?.full_name || '').toLowerCase() !== `${settings.owner}/${settings.repo}`.toLowerCase())) fail('GITHUB_AUTH');
      return { token: body.token, expires, privateCheckedAt: undefined, privatePending: undefined };
    })();
    const entry = { pending };
    if (tokens.size >= 64) tokens.delete(tokens.keys().next().value);
    tokens.set(settings.cacheKey, entry);
    try { const created = await pending; if (tokens.get(settings.cacheKey) === entry) tokens.set(settings.cacheKey, created); return created; }
    catch (error) { if (tokens.get(settings.cacheKey) === entry) tokens.delete(settings.cacheKey); throw error; }
  }
  async function privateRepository(entry) {
    if (entry.privateCheckedAt !== undefined && now() >= entry.privateCheckedAt && now() - entry.privateCheckedAt < PRIVATE_TTL) return;
    if (!entry.privatePending) entry.privatePending = (async () => {
      const result = await api(settings.path, entry.token);
      if (result.status !== 200) httpFailure(result);
      if (result.body?.private !== true || (result.body.visibility !== undefined && result.body.visibility !== 'private')
        || String(result.body?.full_name || '').toLowerCase() !== `${settings.owner}/${settings.repo}`.toLowerCase()) fail('GITHUB_PRIVATE_REQUIRED');
      entry.privateCheckedAt = now();
    })();
    try { await entry.privatePending; } finally { entry.privatePending = undefined; }
  }
  async function authorized(path, options) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let entry;
      try {
        entry = await installationToken();
        await privateRepository(entry);
        const result = await api(path, entry.token, options);
        if (result.status === 401) fail('GITHUB_AUTH');
        return result;
      } catch (error) {
        if (error instanceof StorageError && error.code === 'GITHUB_AUTH') {
          if (entry && tokens.get(settings.cacheKey) === entry) tokens.delete(settings.cacheKey);
          if (attempt === 0) continue;
        }
        throw error;
      }
    }
    fail('GITHUB_AUTH');
  }
  return {
    async read(path) {
      const safe = checkedPath(path), query = new URLSearchParams({ ref: settings.branch });
      const result = await authorized(`${settings.path}/contents/${safe}?${query}`);
      if (result.status === 404) return null;
      if (result.status !== 200) httpFailure(result);
      const body = result.body;
      if (!record(body) || body.type !== 'file' || body.path !== path || body.encoding !== 'base64' || !SHA.test(body.sha || '')
        || !Number.isSafeInteger(body.size) || body.size < 0 || body.size > MAX_BYTES) fail('GITHUB_DATA_INVALID');
      const bytes = unbase64(body.content, MAX_BYTES);
      if (bytes.byteLength !== body.size) fail('GITHUB_DATA_INVALID');
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!record(value)) fail('GITHUB_DATA_INVALID');
        return { value, revision: body.sha };
      } catch { fail('GITHUB_DATA_INVALID'); }
    },
    async write(path, value, expectedRevision = null) {
      const safe = checkedPath(path), data = serialized(value);
      if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !SHA.test(expectedRevision))) fail('GITHUB_REVISION');
      const result = await authorized(`${settings.path}/contents/${safe}`, { method: 'PUT', body: {
        message: 'Update account data', content: b64(data.bytes), branch: settings.branch, ...(expectedRevision === null ? {} : { sha: expectedRevision }),
      } });
      if (result.status === 409 || (result.status === 422 && shaConflict(result.body))) throw new ConflictError();
      if (result.status !== 200 && result.status !== 201) httpFailure(result);
      if (!SHA.test(result.body?.content?.sha || '') || result.body.content.path !== path) fail('GITHUB_RESPONSE_INVALID');
      return { value: data.value, revision: result.body.content.sha };
    },
  };
}
