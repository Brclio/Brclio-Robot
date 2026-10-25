import { createServer as httpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, statSync, realpathSync, createReadStream } from 'node:fs';
import { isIP } from 'node:net';
import { resolve, dirname, extname, sep } from 'node:path';
import nodemailer from 'nodemailer';
import { emptyProgress, mergeProgress, validateProgress } from '../src/shared/progress.mjs';

const scrypt = promisify(scryptCallback);
const digest = text => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const COOKIE = 'brclio_session';
const OAUTH_COOKIE = 'brclio_oauth';
const SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
const OTP_AGE = 10 * 60 * 1000;
const MAX_BODY = 1_000_000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
class HttpError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export function readConfig(env = process.env) {
  const appUrl = new URL(env.APP_ORIGIN || 'http://127.0.0.1:5174');
  if (!['https:', 'http:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.search || appUrl.hash) throw new Error('APP_ORIGIN must be a valid http(s) site URL');
  if (env.NODE_ENV === 'production' && appUrl.protocol !== 'https:') throw new Error('Production APP_ORIGIN must use HTTPS');
  return {
    appOrigin: appUrl.origin, appPath: appUrl.pathname,
    databasePath: env.DATABASE_PATH || './data/brclio.sqlite',
    secureCookies: appUrl.protocol === 'https:',
    smtp: { host: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 465),
      secure: Number(env.SMTP_PORT || 465) === 465,
      user: env.SMTP_USER || '', pass: (env.SMTP_PASS || '').replace(/\s/g, ''),
      from: env.SMTP_FROM || env.SMTP_USER || '' },
    googleClientId: env.GOOGLE_CLIENT_ID || '', googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    trustProxy: env.TRUST_PROXY === 'true', staticDir: resolve(env.STATIC_DIR || 'dist'),
  };
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(item => {
    const index = item.indexOf('=');
    return index < 0 ? ['', ''] : [item.slice(0, index).trim(), item.slice(index + 1).trim()];
  }));
}
function publicUser(row) { return { id: row.id, email: row.email, provider: row.google_sub ? 'google' : 'email' }; }
function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254) throw new HttpError(400, '请输入有效的邮箱地址。');
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) throw new HttpError(400, '请输入有效的邮箱地址。');
  return email;
}
function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new HttpError(400, '密码需要 8–128 个字符。');
  return value;
}
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function checkPassword(password, hash) {
  const [, salt, saved] = (hash || `scrypt:00000000000000000000000000000000:${'0'.repeat(128)}`).split(':');
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(saved, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key) && Boolean(hash);
}
async function jsonBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求。');
  if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); throw new HttpError(413, '记录太大，请分批保存。'); }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) { req.resume(); throw new HttpError(413, '记录太大，请分批保存。'); }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, '请求内容无法读取。'); }
}

/** No real messages are sent when a test supplies mailer.sendMail. */
export function createApp(options = {}) {
  const config = { ...readConfig({}), ...options.config };
  const now = options.now || Date.now;
  const fetchImpl = options.fetchImpl || fetch;
  const databasePath = options.dbPath || config.databasePath;
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, google_sub TEXT UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS email_codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL, guesses INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS progress (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
  `);
  const mailer = options.mailer || (config.smtp.user && config.smtp.pass ? nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  }) : null);
  const capabilities = { email: Boolean(mailer), google: Boolean(config.googleClientId && config.googleClientSecret) };
  let lastCleanup = 0;
  function cleanup() {
    if (now() - lastCleanup < 3_600_000) return;
    lastCleanup = now();
    for (const table of ['sessions', 'email_codes', 'oauth_states']) db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(now());
    db.prepare('DELETE FROM rate_limits WHERE resets_at < ?').run(now());
  }
  function limit(key, max, period = 15 * 60 * 1000) {
    const hashed = digest(key);
    const row = db.prepare('SELECT count,resets_at FROM rate_limits WHERE key=?').get(hashed);
    if (row && row.resets_at > now()) {
      if (row.count >= max) throw new HttpError(429, '操作有些频繁，请稍后再试。', Math.ceil((row.resets_at - now()) / 1000));
      db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(hashed);
    } else db.prepare('INSERT OR REPLACE INTO rate_limits VALUES (?,?,?)').run(hashed, 1, now() + period);
  }
  function ipAddress(req) {
    const remote = req.socket.remoteAddress || 'unknown';
    // TRUST_PROXY supports one local ingress only. nginx proxy_add_x_forwarded_for
    // appends the actual client on the right; every earlier entry is user input.
    const localIngress = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (config.trustProxy && localIngress && typeof req.headers['x-forwarded-for'] === 'string') {
      const rightmost = req.headers['x-forwarded-for'].split(',').at(-1).trim();
      if (isIP(rightmost)) return rightmost;
    }
    return remote;
  }
  function setCookie(res, name, value, maxAge) {
    const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
    const existing = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : existing ? [existing] : []), cookie]);
  }
  function sessionUser(req) {
    const secret = cookies(req)[COOKIE];
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    return db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?').get(digest(secret), now()) || null;
  }
  function startSession(req, res, user) {
    const previous = cookies(req)[COOKIE];
    if (previous) db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(previous));
    const secret = token();
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(secret), user.id, now() + SESSION_AGE);
    setCookie(res, COOKIE, secret, SESSION_AGE / 1000);
  }
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function redirect(res, target) { res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' }); res.end(); }
  function safeReturnTo(raw) {
    try {
      if (typeof raw !== 'string' || raw.length > 1000 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return config.appPath;
      const url = new URL(raw, config.appOrigin);
      if (url.origin !== config.appOrigin || url.pathname.startsWith('/api/')) return config.appPath;
      url.searchParams.delete('auth_error');
      return `${url.pathname}${url.search}${url.hash}`;
    } catch { return config.appPath; }
  }
  function oauthFailure(res, returnTo, error) {
    const url = new URL(returnTo, config.appOrigin);
    url.searchParams.set('auth_error', error);
    redirect(res, url.toString());
  }
  const server = httpServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      cleanup();
      const url = new URL(req.url, config.appOrigin);
      const path = url.pathname;
      const method = req.method;
      if (!path.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持此操作。');
        let relative;
        try { relative = decodeURIComponent(path).replace(/^\/+/, ''); } catch { throw new HttpError(400, '地址格式有误。'); }
        if (config.appPath !== '/' && path.startsWith(config.appPath)) relative = path.slice(config.appPath.length).replace(/^\/+/, '');
        const file = resolve(config.staticDir, relative || 'index.html');
        if (!file.startsWith(config.staticDir + sep)) throw new HttpError(404, '找不到这个页面。');
        let actualFile, actualRoot, fileStat;
        try {
          actualRoot = realpathSync(config.staticDir);
          actualFile = realpathSync(file);
          fileStat = statSync(actualFile);
        } catch { throw new HttpError(404, '找不到这个页面。请先运行 npm run build。'); }
        if (!actualFile.startsWith(actualRoot + sep) || !fileStat.isFile()) throw new HttpError(404, '找不到这个页面。');
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME[extname(actualFile)] || 'application/octet-stream');
        res.setHeader('Cache-Control', extname(actualFile) === '.html' ? 'no-cache' : 'public, max-age=3600');
        if (method === 'HEAD') res.end();
        else {
          const stream = createReadStream(actualFile);
          stream.on('error', () => {
            // Files can disappear during deployment after stat. Handle the stream's
            // asynchronous error without crashing the entire account service.
            if (!res.headersSent) send(res, 404, { error: '这个页面暂时无法读取，请刷新后重试。' });
            else res.destroy();
          });
          res.once('close', () => stream.destroy());
          stream.pipe(res);
        }
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'POST', 'PUT'].includes(method)) throw new HttpError(405, '不支持此操作。');
      if (method === 'POST' || method === 'PUT') {
        if (req.headers.origin !== config.appOrigin) throw new HttpError(403, '请从本站页面重试。');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请从本站页面重试。');
      }
      if (method === 'GET' && path === '/api/auth/session') {
        const user = sessionUser(req);
        send(res, 200, { user: user ? publicUser(user) : null, capabilities }); return;
      }
      if (method === 'POST' && path === '/api/auth/code') {
        if (!mailer) throw new HttpError(503, '邮箱验证暂未配置，请联系站点管理员。');
        limit(`code-ip:${ipAddress(req)}`, 10);
        const { email: rawEmail } = await jsonBody(req);
        const email = emailAddress(rawEmail);
        limit(`code-email:${email}`, 5, 60 * 60 * 1000);
        const existing = db.prepare('SELECT sent_at FROM email_codes WHERE email=?').get(email);
        if (existing && existing.sent_at + 60_000 > now()) throw new HttpError(429, '验证码已发送，请稍后再试。', Math.ceil((existing.sent_at + 60_000 - now()) / 1000));
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        // Store a per-code salt together with the digest, so a stolen database cannot brute-force six digits cheaply.
        const salt = randomBytes(16).toString('hex');
        const codeHash = await scrypt(code, `${email}:${salt}`, 32);
        // Reserve cooldown before awaiting SMTP; parallel requests cannot send the same address twice.
        const current = db.prepare('SELECT sent_at FROM email_codes WHERE email=?').get(email);
        if (current && current.sent_at + 60_000 > now()) throw new HttpError(429, '验证码已发送，请稍后再试。', 60);
        db.prepare('INSERT OR REPLACE INTO email_codes VALUES (?,?,?,?,0)').run(email, `${salt}:${codeHash.toString('hex')}`, now() + OTP_AGE, now());
        try {
          await mailer.sendMail({ from: config.smtp.from || config.smtp.user, to: email,
            subject: 'Brclio Robot 注册验证码', text: `你的 Brclio Robot 注册验证码是：${code}\n\n验证码 10 分钟内有效，请勿转发给他人。\n如果你没有申请注册，请忽略此邮件。` });
        } catch {
          db.prepare('DELETE FROM email_codes WHERE email=? AND hash=?').run(email, `${salt}:${codeHash.toString('hex')}`);
          throw new HttpError(503, '验证码暂时没有发送成功，请稍后重试。');
        }
        send(res, 200, { retryAfter: 60 }); return;
      }
      if (method === 'POST' && path === '/api/auth/register') {
        limit(`register-ip:${ipAddress(req)}`, 20);
        const body = await jsonBody(req);
        const email = emailAddress(body.email), password = passwordValue(body.password);
        limit(`register-email:${email}`, 10);
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new HttpError(400, '请输入邮件中的 6 位验证码。');
        const savedCode = db.prepare('SELECT * FROM email_codes WHERE email=?').get(email);
        if (!savedCode || savedCode.expires_at <= now() || savedCode.guesses >= 5) throw new HttpError(400, '验证码已失效，请重新获取。');
        db.prepare('UPDATE email_codes SET guesses=guesses+1 WHERE email=?').run(email);
        const [salt, hash] = savedCode.hash.split(':');
        const givenHash = await scrypt(body.code, `${email}:${salt}`, 32);
        if (!timingSafeEqual(givenHash, Buffer.from(hash, 'hex'))) throw new HttpError(400, '验证码不正确，请检查后重试。');
        const passwordHash = await hashPassword(password);
        // Recheck after asynchronous hashing to prevent reusing a consumed/replaced OTP in concurrent registrations.
        const activeCode = db.prepare('SELECT * FROM email_codes WHERE email=?').get(email);
        if (!activeCode || activeCode.hash !== savedCode.hash || activeCode.expires_at <= now() || activeCode.guesses > 5) throw new HttpError(400, '验证码已失效，请重新获取。');
        if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw new HttpError(409, '这个邮箱已经注册，请直接登录。');
        const user = { id: randomUUID(), email, google_sub: null };
        db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id, email, passwordHash, null, now());
        db.prepare('DELETE FROM email_codes WHERE email=?').run(email);
        startSession(req, res, user);
        send(res, 201, { user: publicUser(user) }); return;
      }
      if (method === 'POST' && path === '/api/auth/login') {
        limit(`login-ip:${ipAddress(req)}`, 30);
        const body = await jsonBody(req);
        const email = emailAddress(body.email);
        limit(`login-email:${email}`, 10);
        if (typeof body.password !== 'string' || body.password.length > 128) throw new HttpError(401, '邮箱或密码不正确。');
        const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        if (!await checkPassword(body.password, user?.password_hash)) throw new HttpError(401, '邮箱或密码不正确。');
        startSession(req, res, user);
        send(res, 200, { user: publicUser(user) }); return;
      }
      if (method === 'POST' && path === '/api/auth/logout') {
        const user = sessionUser(req);
        if (user && req.headers['x-brclio-user-id'] !== user.id) throw new HttpError(409, '账号已在其他页面切换，请刷新后重试。');
        const secret = cookies(req)[COOKIE];
        if (secret) db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(secret));
        setCookie(res, COOKIE, '', 0);
        send(res, 200, { ok: true }); return;
      }
      if (method === 'GET' && path === '/api/auth/google') {
        if (!capabilities.google) throw new HttpError(503, 'Google 登录暂未配置，请使用邮箱登录。');
        limit(`google-ip:${ipAddress(req)}`, 20);
        const state = token(), verifier = token();
        db.prepare('INSERT INTO oauth_states VALUES (?,?,?,?)').run(digest(state), verifier, safeReturnTo(url.searchParams.get('returnTo')), now() + OTP_AGE);
        setCookie(res, OAUTH_COOKIE, state, OTP_AGE / 1000);
        const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        target.search = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: `${config.appOrigin}/api/auth/google/callback`, response_type: 'code',
          scope: 'openid email', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
        redirect(res, target.toString()); return;
      }
      if (method === 'GET' && path === '/api/auth/google/callback') {
        setCookie(res, OAUTH_COOKIE, '', 0);
        const state = url.searchParams.get('state'), stateCookie = cookies(req)[OAUTH_COOKIE];
        if (!state || !stateCookie || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(stateCookie) || !timingSafeEqual(Buffer.from(state), Buffer.from(stateCookie))) {
          oauthFailure(res, config.appPath, 'google_state'); return;
        }
        const saved = db.prepare('SELECT * FROM oauth_states WHERE hash=? AND expires_at>?').get(digest(state), now());
        db.prepare('DELETE FROM oauth_states WHERE hash=?').run(digest(state));
        if (!saved) { oauthFailure(res, config.appPath, 'google_state'); return; }
        if (url.searchParams.has('error') || !url.searchParams.get('code')) { oauthFailure(res, saved.return_to, 'google_cancelled'); return; }
        try {
          const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: config.googleClientId, client_secret: config.googleClientSecret,
              redirect_uri: `${config.appOrigin}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: saved.verifier }), signal: AbortSignal.timeout(15_000) });
          if (!tokenResponse.ok) throw new Error('token');
          const tokens = await tokenResponse.json();
          if (typeof tokens.access_token !== 'string' || tokens.token_type?.toLowerCase() !== 'bearer') throw new Error('token');
          const profileResponse = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15_000) });
          if (!profileResponse.ok) throw new Error('profile');
          const profile = await profileResponse.json();
          if (typeof profile.sub !== 'string' || profile.sub.length < 1 || profile.sub.length > 255 || profile.email_verified !== true) throw new Error('profile');
          const email = emailAddress(profile.email);
          let user = db.prepare('SELECT * FROM users WHERE google_sub=?').get(profile.sub);
          if (!user) {
            user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
            if (user) {
              // Google is authoritative for Gmail/Workspace, not arbitrary third-party mailboxes.
              if (user.google_sub || (!email.endsWith('@gmail.com') && typeof profile.hd !== 'string')) { oauthFailure(res, saved.return_to, 'google_link_required'); return; }
              db.prepare('UPDATE users SET google_sub=? WHERE id=?').run(profile.sub, user.id);
              user.google_sub = profile.sub;
            } else {
              user = { id: randomUUID(), email, google_sub: profile.sub };
              db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id, email, null, profile.sub, now());
            }
          }
          startSession(req, res, user);
          redirect(res, new URL(saved.return_to, config.appOrigin).toString());
        } catch { oauthFailure(res, saved.return_to, 'google_failed'); }
        return;
      }
      if (path === '/api/progress' && (method === 'GET' || method === 'PUT')) {
        const user = sessionUser(req);
        if (!user) throw new HttpError(401, '登录后才能同步历史记录。');
        // A cookie is shared by every tab. Require the initiating tab's expected account
        // so an old tab cannot read/write another account after a login elsewhere.
        if (req.headers['x-brclio-user-id'] !== user.id) throw new HttpError(409, '账号已在其他页面切换，请刷新后重试。');
        limit(`progress:${user.id}`, 120, 60_000);
        if (method === 'GET') {
          const saved = db.prepare('SELECT data FROM progress WHERE user_id=?').get(user.id);
          send(res, 200, { progress: saved ? JSON.parse(saved.data) : null }); return;
        }
        const body = await jsonBody(req);
        if (Object.keys(body).length !== 1 || !validateProgress(body.progress, now())) throw new HttpError(400, '历史记录格式不正确，当前浏览器的记录会保留。');
        const saved = db.prepare('SELECT data FROM progress WHERE user_id=?').get(user.id);
        const progress = mergeProgress(saved ? JSON.parse(saved.data) : emptyProgress(), body.progress);
        db.prepare('INSERT OR REPLACE INTO progress VALUES (?,?)').run(user.id, JSON.stringify(progress));
        send(res, 200, { progress }); return;
      }
      throw new HttpError(404, '找不到这个接口。');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof HttpError) {
        if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
        send(res, error.status, { error: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
      } else {
        // Never serialize SMTP/OAuth responses, secrets, passwords, codes or database internals.
        send(res, 500, { error: '服务暂时不可用，请稍后重试。浏览器中的记录会保留。' });
      }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, db, capabilities, config, async close() {
    await new Promise((resolveClose, reject) => server.listening ? server.close(error => error ? reject(error) : resolveClose()) : resolveClose());
    mailer?.close?.(); db.close();
  } };
}
