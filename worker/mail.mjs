import addressParser from 'nodemailer/lib/addressparser';

const DEADLINE_MS = 18_000;
const encoder = new TextEncoder();
const MAILBOX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const defaultConnect = async (...args) => (await import('cloudflare:sockets')).connect(...args);

export class MailError extends Error {
  constructor(code) {
    super(code === 'SMTP_CONFIG' ? '邮箱验证服务暂未配置正确，请联系站点管理员。' : '验证码暂时没有发送成功，请稍后重试。');
    this.name = 'MailError'; this.code = code;
  }
}
function mailbox(value, code) {
  if (typeof value !== 'string' || value.length > 254 || /[\r\n\0]/.test(value)) throw new MailError(code);
  const address = value.trim().toLowerCase();
  if (!MAILBOX.test(address)) throw new MailError(code);
  return address;
}
function settings(env) {
  const user = mailbox(env.SMTP_USER, 'SMTP_CONFIG'), rawFrom = env.SMTP_FROM || user;
  if (typeof rawFrom !== 'string' || rawFrom.length > 400 || /[\r\n\0]/.test(rawFrom)) throw new MailError('SMTP_CONFIG');
  const parsedFrom = addressParser(rawFrom);
  if (parsedFrom.length !== 1 || parsedFrom[0].group || (parsedFrom[0].name || '').length > 100) throw new MailError('SMTP_CONFIG');
  const from = mailbox(parsedFrom[0].address, 'SMTP_CONFIG');
  const host = env.SMTP_HOST || 'smtp.gmail.com', port = Number(env.SMTP_PORT || 465);
  if (typeof host !== 'string' || host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)
    || ![465, 587].includes(port) || typeof env.SMTP_PASS !== 'string') throw new MailError('SMTP_CONFIG');
  const pass = env.SMTP_PASS.replace(/\s/g, '');
  if (!pass || pass.length > 1024 || /[\x00-\x1f\x7f]/.test(pass)) throw new MailError('SMTP_CONFIG');
  return { user, from, host, port, pass };
}
function base64(text) { return btoa(String.fromCharCode(...encoder.encode(text))); }
function message(from, to, code) {
  const body = base64(`你的 Brclio Robot 注册验证码是：${code}\n\n验证码 10 分钟内有效，请勿转发给他人。\n如果你没有申请注册，请忽略此邮件。`).match(/.{1,76}/g).join('\r\n');
  return [
    `From: Brclio Robot <${from}>`, `To: <${to}>`,
    `Subject: =?UTF-8?B?${base64('Brclio Robot 注册验证码')}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n');
}

/** Injectable sockets exercise the protocol offline; request input cannot select the connector. */
export function createMailClient(env, { connect = defaultConnect, deadlineMs = DEADLINE_MS } = {}) {
  const config = settings(env);
  async function perform(email, code, verifyOnly) {
    let socket, reader, writer, buffer = '', timeout, complete = false, timedOut = false;
    const result = verifyOnly ? { verified: true, sent: false } : { accepted: true };
    const attach = async next => {
      socket = next;
      socket.closed?.catch(() => undefined);
      if (timedOut) { await socket.close().catch(() => undefined); throw new MailError('SMTP_TIMEOUT'); }
      await socket.opened;
      reader = socket.readable.getReader(); writer = socket.writable.getWriter(); buffer = '';
    };
    const write = text => writer.write(encoder.encode(text));
    const response = async () => {
      const decoder = new TextDecoder();
      const lines = []; let expected, size = 0;
      for (;;) {
        const newline = buffer.indexOf('\r\n');
        if (newline < 0) {
          if (buffer.length > 4096) throw new MailError('SMTP_PROTOCOL');
          const chunk = await reader.read();
          if (chunk.done) throw new MailError('SMTP_CONNECTION');
          buffer += decoder.decode(chunk.value, { stream: true });
          size += chunk.value.byteLength;
          if (size > 65_536) throw new MailError('SMTP_PROTOCOL');
          continue;
        }
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 2);
        const match = /^(\d{3})([- ])(.*)$/.exec(line);
        if (!match || (expected && expected !== match[1]) || line.length > 4096 || lines.length >= 100) throw new MailError('SMTP_PROTOCOL');
        expected = match[1]; lines.push(match[3]);
        if (match[2] === ' ') return { code: Number(expected), lines };
      }
    };
    const expect = async (codes, category = 'SMTP_DELIVERY') => {
      const reply = await response();
      if (!codes.includes(reply.code)) throw new MailError(category);
      return reply;
    };
    const command = async (text, codes, category) => { await write(text + '\r\n'); return expect(codes, category); };
    const close = async () => { try { await socket?.close(); } catch { /* SMTP payloads and credentials never escape. */ } };
    const run = async () => {
      await attach(await connect({ hostname: config.host, port: config.port }, { secureTransport: config.port === 465 ? 'on' : 'starttls' }));
      await expect([220], 'SMTP_CONNECTION');
      let capabilities = await command('EHLO brclio-robot.local', [250], 'SMTP_CONNECTION');
      if (config.port === 587) {
        if (!capabilities.lines.some(line => /^STARTTLS\b/i.test(line))) throw new MailError('SMTP_TLS');
        await command('STARTTLS', [220], 'SMTP_TLS');
        reader.releaseLock(); writer.releaseLock();
        await attach(socket.startTls());
        capabilities = await command('EHLO brclio-robot.local', [250], 'SMTP_CONNECTION');
      }
      const auth = capabilities.lines.find(line => /^AUTH(?:=|\s)/i.test(line)) || '';
      const methods = auth.toUpperCase().split(/[=\s]+/).slice(1);
      if (methods.includes('PLAIN')) {
        const credentials = base64(`\0${config.user}\0${config.pass}`);
        await write(`AUTH PLAIN ${credentials}\r\n`);
        const challenge = await expect([235, 334], 'SMTP_AUTH');
        if (challenge.code === 334) await command(credentials, [235], 'SMTP_AUTH');
      } else if (methods.includes('LOGIN')) {
        await command('AUTH LOGIN', [334], 'SMTP_AUTH');
        await command(base64(config.user), [334], 'SMTP_AUTH');
        await command(base64(config.pass), [235], 'SMTP_AUTH');
      } else throw new MailError('SMTP_AUTH');
      if (!verifyOnly) {
        await command(`MAIL FROM:<${config.from}>`, [250]);
        await command(`RCPT TO:<${email}>`, [250, 251]);
        await command('DATA', [354]);
        // MIME is base64 today; dot-stuff as well so future text changes stay safe.
        const data = message(config.from, email, code).replace(/(^|\r\n)\./g, '$1..');
        await write(data + '\r\n.\r\n');
        await expect([250]);
      }
      // SMTP 250 after DATA is the acceptance boundary. A failed QUIT must not
      // turn an accepted email into a retry and invalidate the code already sent.
      complete = true;
      await command('QUIT', [221]).catch(() => undefined);
      return result;
    };
    try {
      return await Promise.race([run(), new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          void close();
          if (complete) resolve(result); else reject(new MailError('SMTP_TIMEOUT'));
        }, deadlineMs);
      })]);
    } catch (error) { throw error instanceof MailError ? error : new MailError('SMTP_CONNECTION'); }
    finally { clearTimeout(timeout); await close(); }
  }
  return {
    async send(email, code) {
      const recipient = mailbox(email, 'SMTP_INPUT');
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new MailError('SMTP_INPUT');
      return perform(recipient, code, false);
    },
    verify: () => perform(null, null, true),
  };
}
export const sendVerificationEmail = (env, email, code) => createMailClient(env).send(email, code);
/** TLS + EHLO + AUTH + QUIT only; no envelope or message is submitted. */
export const verifySmtp = env => createMailClient(env).verify();
