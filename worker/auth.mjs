const encoder = new TextEncoder();
const encode = value => encoder.encode(value);
export const SESSION_COOKIE = 'brclio_session';
export const OAUTH_COOKIE = 'brclio_oauth';
export const SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
export const OTP_AGE = 10 * 60 * 1000;
export class HttpError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
export const token = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value) { return base64url(await crypto.subtle.digest('SHA-256', encode(value))); }
export function randomCode() {
  const bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= 4_294_000_000);
  return String(bytes[0] % 1_000_000).padStart(6, '0');
}
function authSecret(env) {
  if (typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length < 32) throw new HttpError(503, '账号服务暂未完成安全配置，请稍后重试。');
  return env.AUTH_SECRET;
}
async function hmacKey(env) { return crypto.subtle.importKey('raw', encode(authSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function codeHash(env, email, code, salt = token()) {
  const hash = await crypto.subtle.sign('HMAC', await hmacKey(env), encode(`email-code:${email}:${salt}:${code}`));
  return `${salt}:${base64url(hash)}`;
}
export async function checkCode(env, email, code, saved) {
  const [salt, signature] = saved.split(':');
  try { return await crypto.subtle.verify('HMAC', await hmacKey(env), decode(signature), encode(`email-code:${email}:${salt}:${code}`)); }
  catch { return false; }
}
async function passwordBits(env, password, salt, iterations) {
  // A server-only pepper prevents offline password cracking from a database-only leak.
  const peppered = await crypto.subtle.sign('HMAC', await hmacKey(env), encode(`password:${password}`));
  const key = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encode(salt), iterations, hash: 'SHA-256' }, key, 256));
}
export async function hashPassword(env, password) {
  const salt = token(), iterations = 100_000;
  return `pbkdf2-v1:${iterations}:${salt}:${base64url(await passwordBits(env, password, salt, iterations))}`;
}
export async function checkPassword(env, password, saved) {
  const candidate = typeof saved === 'string' ? saved : `pbkdf2-v1:100000:0000000000000000000000000000000000000000000:${'A'.repeat(43)}`;
  const [version, count, salt, hash] = candidate.split(':');
  if (version !== 'pbkdf2-v1' || count !== '100000' || !salt || !hash) return false;
  const bits = await passwordBits(env, password, salt, Number(count));
  let expected;
  try { expected = decode(hash); } catch { return false; }
  if (bits.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < bits.length; i++) difference |= bits[i] ^ expected[i];
  return Boolean(saved) && difference === 0;
}
export function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254) throw new HttpError(400, '请输入有效的邮箱地址。');
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) throw new HttpError(400, '请输入有效的邮箱地址。');
  return email;
}
export function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new HttpError(400, '密码需要 8–128 个字符。');
  return value;
}
export const publicUser = user => ({ id: user.id, email: user.email, provider: user.google_sub ? 'google' : 'email' });
export function cookies(request) {
  return Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(item => {
    const index = item.indexOf('=');
    return index < 0 ? ['', ''] : [item.slice(0, index).trim(), item.slice(index + 1).trim()];
  }));
}
export function setCookie(headers, name, value, maxAge, secure) {
  headers.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
export async function jsonBody(request) {
  const maxBody = 1_000_000;
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, '请使用 JSON 请求。');
  if (Number(request.headers.get('Content-Length')) > maxBody) throw new HttpError(413, '记录太大，请分批保存。');
  const reader = request.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBody) { await reader.cancel(); throw new HttpError(413, '记录太大，请分批保存。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new HttpError(400, '请求内容无法读取。'); }
}

export async function digestHex(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function signedSession(env, accountId, secret, expiresAt) {
  const payload = base64url(encode(JSON.stringify({ v: 1, a: accountId, s: secret, e: expiresAt })));
  const signature = base64url(await crypto.subtle.sign('HMAC', await hmacKey(env), encode(`session:${payload}`)));
  return `${payload}.${signature}`;
}
export async function verifySession(env, value, time = Date.now()) {
  if (typeof value !== 'string' || value.length > 600) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  try {
    const signatureBytes = decode(signature);
    if (base64url(signatureBytes) !== signature || !await crypto.subtle.verify('HMAC', await hmacKey(env), signatureBytes, encode(`session:${payload}`))) return null;
    const parsed = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (parsed?.v !== 1 || !/^[a-f0-9]{64}$/.test(parsed.a) || !/^[A-Za-z0-9_-]{43}$/.test(parsed.s)
      || !Number.isSafeInteger(parsed.e) || parsed.e <= time || parsed.e > time + SESSION_AGE) return null;
    return { accountId: parsed.a, secret: parsed.s, expiresAt: parsed.e };
  } catch { return null; }
}
