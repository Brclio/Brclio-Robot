import { emptyProgress, mergeProgress, validateProgress } from '../src/shared/progress.mjs';
import { createGitHubStore, ConflictError } from './github-store.mjs';
import { HttpError, SESSION_COOKIE, OAUTH_COOKIE, SESSION_AGE, OTP_AGE, token, digest, digestHex, randomCode, codeHash, checkCode,
  hashPassword, checkPassword, signedSession, verifySession, emailAddress, passwordValue, publicUser, cookies, setCookie, jsonBody } from './auth.mjs';

const defaultSendEmail = async (...args) => (await import('./mail.mjs')).sendVerificationEmail(...args);
const freshAccount = () => ({ version: 1, user: null, otp: null, progress: emptyProgress(), sessions: {}, rates: {} });
const accountPath = id => `accounts/${id}.json`;
const conflict = error => error instanceof ConflictError || error?.name === 'ConflictError';
function validAccount(value, id) {
  return value?.version === 1 && (value.user === null || (value.user?.id === id && typeof value.user.email === 'string'))
    && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
    && value.rates && typeof value.rates === 'object' && !Array.isArray(value.rates)
    && validateProgress(value.progress);
}
function pruneSessions(account, time) {
  account.sessions = Object.fromEntries(Object.entries(account.sessions).filter(([, expiry]) => Number.isSafeInteger(expiry) && expiry > time)
    .sort((a, b) => b[1] - a[1]).slice(0, 99));
}

/** Tests inject a CAS store and delivery function; production has no testing route or bypass. */
export function createWorker({ sendEmail = defaultSendEmail, fetchImpl = fetch, now = Date.now,
  storeFactory = env => createGitHubStore(env, { fetchImpl, now }) } = {}) {
  return { async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    const send = (status, value) => { headers.set('Content-Type', 'application/json; charset=utf-8'); return new Response(JSON.stringify(value), { status, headers }); };
    const redirect = target => { headers.set('Location', target); return new Response(null, { status: 302, headers }); };
    try {
      const appUrl = new URL(env.APP_ORIGIN || 'https://bubu.brclio.com');
      if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password) throw new HttpError(503, '站点地址暂未配置正确。');
      const secure = appUrl.protocol === 'https:', store = storeFactory(env);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const storageEnabled = Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID && env.GITHUB_DATA_REPO);
      const capabilities = { email: Boolean(storageEnabled && env.AUTH_SECRET && env.SMTP_USER && env.SMTP_PASS),
        google: Boolean(storageEnabled && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.AUTH_SECRET) };
      async function mutate(path, initial, update) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const current = await store.read(path), value = structuredClone(current?.value ?? initial());
          const result = await update(value, current);
          try {
            const written = await store.write(path, value, current?.revision ?? null);
            return { ...written, result };
          } catch (error) { if (!conflict(error)) throw error; }
        }
        throw new HttpError(503, '正在合并其他设备的记录，请稍后重试。');
      }
      function quota(entries, action, max, period) {
        const time = now(), previous = entries[action];
        if (previous?.resetsAt > time && previous.count >= max) throw new HttpError(429, '操作有些频繁，请稍后再试。', Math.max(1, Math.ceil((previous.resetsAt - time) / 1000)));
        for (const [key, entry] of Object.entries(entries)) if (!entry || entry.resetsAt <= time) delete entries[key];
        entries[action] = previous?.resetsAt > time ? { count: previous.count + 1, resetsAt: previous.resetsAt } : { count: 1, resetsAt: time + period };
      }
      async function ipLimit(action, max, period = 900_000) {
        const id = await digestHex(`ip:${ip}`);
        await mutate(`limits/${id}.json`, () => ({ version: 1, entries: {} }), value => quota(value.entries, action, max, period));
      }
      async function session() {
        const parsed = await verifySession(env, cookies(request)[SESSION_COOKIE], now());
        if (!parsed) return null;
        const record = await store.read(accountPath(parsed.accountId));
        if (!record || !validAccount(record.value, parsed.accountId) || !record.value.user) return null;
        const secretDigest = await digest(parsed.secret);
        if (record.value.sessions[secretDigest] !== parsed.expiresAt || parsed.expiresAt <= now()) return null;
        return { ...parsed, secretDigest, record, user: record.value.user };
      }
      async function requireSession() {
        const active = await session();
        if (!active) throw new HttpError(401, '登录后才能同步历史记录。');
        if (request.headers.get('X-Brclio-User-Id') !== active.user.id) throw new HttpError(409, '账号已在其他页面切换，请刷新后重试。');
        return active;
      }
      async function newSession(accountId) {
        const secret = token(), expiresAt = now() + SESSION_AGE;
        const previous = await verifySession(env, cookies(request)[SESSION_COOKIE], now());
        return { accountId, secret, expiresAt, secretDigest: await digest(secret), previousDigest: previous?.accountId === accountId ? await digest(previous.secret) : null };
      }
      function addSession(account, issued) {
        pruneSessions(account, now());
        if (issued.previousDigest) delete account.sessions[issued.previousDigest];
        account.sessions[issued.secretDigest] = issued.expiresAt;
      }
      async function sessionCookie(issued) {
        setCookie(headers, SESSION_COOKIE, await signedSession(env, issued.accountId, issued.secret, issued.expiresAt), SESSION_AGE / 1000, secure);
      }
      const safeReturnTo = raw => {
        try {
          if (typeof raw !== 'string' || raw.length > 1000 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return appUrl.pathname;
          const target = new URL(raw, appUrl.origin);
          if (target.origin !== appUrl.origin || target.pathname.startsWith('/api/')) return appUrl.pathname;
          target.searchParams.delete('auth_error'); return target.pathname + target.search + target.hash;
        } catch { return appUrl.pathname; }
      };
      const oauthFailure = (returnTo, code) => {
        const target = new URL(returnTo, appUrl.origin); target.searchParams.set('auth_error', code); return redirect(target.toString());
      };
      const method = request.method, path = url.pathname;
      if (!['GET', 'POST', 'PUT'].includes(method)) throw new HttpError(405, '不支持此操作。');
      if ((method === 'POST' || method === 'PUT') && (request.headers.get('Origin') !== appUrl.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) throw new HttpError(403, '请从本站页面重试。');
      if (method === 'GET' && path === '/api/auth/session') {
        const active = await session(); return send(200, { user: active ? publicUser(active.user) : null, capabilities });
      }
      if (method === 'POST' && path === '/api/auth/code') {
        if (!capabilities.email) throw new HttpError(503, '邮箱验证暂未配置，请联系站点管理员。');
        await ipLimit('code', 10);
        const email = emailAddress((await jsonBody(request)).email), accountId = await digestHex(email);
        const time = now(), code = randomCode(), hashed = await codeHash(env, email, code);
        await mutate(accountPath(accountId), freshAccount, account => {
          if (!validAccount(account, accountId)) throw new HttpError(503, '账号记录暂时无法读取，请稍后重试。');
          if (account.otp?.sentAt + 60_000 > time) throw new HttpError(429, '验证码已发送，请稍后再试。', Math.ceil((account.otp.sentAt + 60_000 - time) / 1000));
          quota(account.rates, 'code', 5, 3_600_000);
          account.otp = { hash: hashed, expiresAt: time + OTP_AGE, sentAt: time, guesses: 0 };
        });
        try { await sendEmail(env, email, code); }
        catch {
          await mutate(accountPath(accountId), freshAccount, account => { if (account.otp?.hash === hashed) account.otp = null; });
          throw new HttpError(503, '验证码暂时没有发送成功，请稍后重试。');
        }
        return send(200, { retryAfter: 60 });
      }
      if (method === 'POST' && path === '/api/auth/register') {
        await ipLimit('register', 20);
        const body = await jsonBody(request), email = emailAddress(body.email), password = passwordValue(body.password), accountId = await digestHex(email);
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new HttpError(400, '请输入邮件中的 6 位验证码。');
        const claimed = await mutate(accountPath(accountId), freshAccount, account => {
          if (!validAccount(account, accountId)) throw new HttpError(503, '账号记录暂时无法读取，请稍后重试。');
          quota(account.rates, 'register', 10, 900_000);
          if (!account.otp || account.otp.expiresAt <= now() || account.otp.guesses >= 5) throw new HttpError(400, '验证码已失效，请重新获取。');
          account.otp.guesses++; return structuredClone(account.otp);
        });
        if (!await checkCode(env, email, body.code, claimed.result.hash)) throw new HttpError(400, '验证码不正确，请检查后重试。');
        const passwordHash = await hashPassword(env, password), issued = await newSession(accountId);
        const saved = await mutate(accountPath(accountId), freshAccount, account => {
          if (account.user) throw new HttpError(409, '这个邮箱已经注册，请直接登录。');
          if (account.otp?.hash !== claimed.result.hash || account.otp.expiresAt <= now() || account.otp.guesses > 5) throw new HttpError(400, '验证码已失效，请重新获取。');
          account.user = { id: accountId, email, password_hash: passwordHash, google_sub: null, created_at: now() };
          account.otp = null; addSession(account, issued);
        });
        await sessionCookie(issued); return send(201, { user: publicUser(saved.value.user) });
      }
      if (method === 'POST' && path === '/api/auth/login') {
        await ipLimit('login', 30);
        const body = await jsonBody(request), email = emailAddress(body.email), accountId = await digestHex(email);
        if (typeof body.password !== 'string' || body.password.length > 128) throw new HttpError(401, '邮箱或密码不正确。');
        const attempt = await mutate(accountPath(accountId), freshAccount, account => {
          if (!validAccount(account, accountId)) throw new HttpError(503, '账号记录暂时无法读取，请稍后重试。');
          quota(account.rates, 'login', 10, 900_000); return account.user?.password_hash;
        });
        if (!await checkPassword(env, body.password, attempt.result)) throw new HttpError(401, '邮箱或密码不正确。');
        const issued = await newSession(accountId);
        const saved = await mutate(accountPath(accountId), freshAccount, account => {
          if (!account.user || account.user.password_hash !== attempt.result) throw new HttpError(401, '邮箱或密码不正确。');
          addSession(account, issued);
        });
        await sessionCookie(issued); return send(200, { user: publicUser(saved.value.user) });
      }
      if (method === 'POST' && path === '/api/auth/logout') {
        const active = await session();
        if (active) {
          if (request.headers.get('X-Brclio-User-Id') !== active.user.id) throw new HttpError(409, '账号已在其他页面切换，请刷新后重试。');
          await mutate(accountPath(active.accountId), freshAccount, account => { delete account.sessions[active.secretDigest]; });
        }
        setCookie(headers, SESSION_COOKIE, '', 0, secure); return send(200, { ok: true });
      }
      if (method === 'GET' && path === '/api/auth/google') {
        if (!capabilities.google) throw new HttpError(503, 'Google 登录暂未配置，请使用邮箱登录。');
        await ipLimit('google', 20);
        const state = token(), verifier = token();
        await store.write(`oauth/${await digestHex(state)}.json`, { version: 1, verifier, returnTo: safeReturnTo(url.searchParams.get('returnTo')), expiresAt: now() + OTP_AGE, consumed: false }, null);
        setCookie(headers, OAUTH_COOKIE, state, OTP_AGE / 1000, secure);
        const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        target.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${appUrl.origin}/api/auth/google/callback`, response_type: 'code', scope: 'openid email', state,
          code_challenge: await digest(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
        return redirect(target.toString());
      }
      if (method === 'GET' && path === '/api/auth/google/callback') {
        setCookie(headers, OAUTH_COOKIE, '', 0, secure);
        const state = url.searchParams.get('state'), stateCookie = cookies(request)[OAUTH_COOKIE];
        if (!state || state !== stateCookie || !/^[A-Za-z0-9_-]{43}$/.test(state)) return oauthFailure(appUrl.pathname, 'google_state');
        let claimed;
        try {
          claimed = await mutate(`oauth/${await digestHex(state)}.json`, () => null, value => {
            if (!value || value.consumed || value.expiresAt <= now()) throw new HttpError(400, 'OAuth state expired');
            value.consumed = true; return structuredClone(value);
          });
        } catch { return oauthFailure(appUrl.pathname, 'google_state'); }
        const saved = claimed.result;
        if (url.searchParams.has('error') || !url.searchParams.get('code')) return oauthFailure(saved.returnTo, 'google_cancelled');
        try {
          const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
              redirect_uri: `${appUrl.origin}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: saved.verifier }), signal: AbortSignal.timeout(15_000) });
          if (!tokenResponse.ok) throw new Error('token');
          const tokens = await tokenResponse.json();
          if (typeof tokens.access_token !== 'string' || tokens.token_type?.toLowerCase() !== 'bearer') throw new Error('token');
          const profileResponse = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15_000) });
          if (!profileResponse.ok) throw new Error('profile');
          const profile = await profileResponse.json();
          if (typeof profile.sub !== 'string' || !profile.sub || profile.sub.length > 255 || profile.email_verified !== true) throw new Error('profile');
          const email = emailAddress(profile.email), identityPath = `identities/google/${await digestHex(profile.sub)}.json`;
          let identity = await store.read(identityPath), accountId = identity?.value?.accountId || await digestHex(email);
          if (!/^[a-f0-9]{64}$/.test(accountId)) throw new Error('identity');
          if (!identity) {
            const existing = await store.read(accountPath(accountId));
            if (existing?.value?.user && (existing.value.user.google_sub && existing.value.user.google_sub !== profile.sub
              || !existing.value.user.google_sub && !email.endsWith('@gmail.com') && !(typeof profile.hd === 'string' && profile.hd.length > 0))) return oauthFailure(saved.returnTo, 'google_link_required');
            try { identity = await store.write(identityPath, { version: 1, accountId }, null); }
            catch (error) {
              if (!conflict(error)) throw error;
              identity = await store.read(identityPath); accountId = identity?.value?.accountId;
              if (!/^[a-f0-9]{64}$/.test(accountId)) throw new Error('identity');
            }
          }
          const issued = await newSession(accountId);
          const result = await mutate(accountPath(accountId), freshAccount, account => {
            if (!validAccount(account, accountId)) throw new HttpError(503, '账号记录暂时无法读取，请稍后重试。');
            if (account.user) {
              if (account.user.google_sub && account.user.google_sub !== profile.sub) throw new Error('identity');
              // An identity index can survive a failed earlier account write. It
              // cannot authorize linking a different email-only account after the
              // Google identity changes its email. Already-bound subjects remain stable.
              if (!account.user.google_sub && (account.user.email !== email
                || !email.endsWith('@gmail.com') && !(typeof profile.hd === 'string' && profile.hd.length > 0))) throw new Error('external-link');
              account.user.google_sub = profile.sub;
            } else account.user = { id: accountId, email, password_hash: null, google_sub: profile.sub, created_at: now() };
            addSession(account, issued);
          });
          if (!result.value.user) throw new Error('identity');
          await sessionCookie(issued); return redirect(new URL(saved.returnTo, appUrl.origin).toString());
        } catch { return oauthFailure(saved.returnTo, 'google_failed'); }
      }
      if (path === '/api/progress' && (method === 'GET' || method === 'PUT')) {
        const active = await requireSession();
        if (method === 'GET') return send(200, { progress: active.record.value.progress });
        const body = await jsonBody(request);
        if (Object.keys(body).length !== 1 || !validateProgress(body.progress, now())) throw new HttpError(400, '历史记录格式不正确，当前浏览器的记录会保留。');
        const updated = await mutate(accountPath(active.accountId), freshAccount, account => {
          if (!validAccount(account, active.accountId) || account.sessions[active.secretDigest] !== active.expiresAt || active.expiresAt <= now()) throw new HttpError(401, '登录后才能同步历史记录。');
          quota(account.rates, 'progress', 120, 60_000);
          account.progress = mergeProgress(account.progress, body.progress);
        });
        return send(200, { progress: updated.value.progress });
      }
      throw new HttpError(404, '找不到这个接口。');
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.retryAfter) headers.set('Retry-After', String(error.retryAfter));
        return send(error.status, { error: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
      }
      return send(503, { error: '账号存储暂时不可用，请稍后重试。浏览器中的记录会保留。' });
    }
  } };
}
export default createWorker();
