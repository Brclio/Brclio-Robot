import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailClient, MailError } from './mail.mjs';
const env = { SMTP_USER: 'sender@gmail.com', SMTP_PASS: 'test app password' };
const encode = text => new TextEncoder().encode(text);
function socketScript(steps, { greeting = '220-smtp.example\r\n220 ready\r\n', upgrade } = {}) {
  let controller;
  const calls = { writes: [], closes: 0 };
  const enqueue = text => { for (let i = 0; i < text.length; i += 3) controller.enqueue(encode(text.slice(i, i + 3))); };
  const socket = { opened: Promise.resolve(), closed: Promise.resolve(),
    readable: new ReadableStream({ start(value) { controller = value; if (greeting) enqueue(greeting); } }),
    writable: new WritableStream({ write(bytes) {
      const text = new TextDecoder().decode(bytes); calls.writes.push(text);
      const step = steps.shift(); assert.ok(step, 'unexpected SMTP command');
      if (typeof step[0] === 'function') step[0](text); else assert.match(text, step[0]);
      if (step[1]) enqueue(step[1]);
    } }),
    close: async () => { calls.closes++; try { controller.close(); } catch {} },
    startTls: () => { assert.ok(upgrade); return upgrade; },
  };
  return { socket, calls, steps };
}
const ehlo = [/^EHLO brclio-robot.local\r\n$/, '250-smtp.example\r\n250-SIZE 1000000\r\n250 AUTH LOGIN PLAIN\r\n'];
const plain = [text => { assert.match(text, /^AUTH PLAIN /); assert.equal(atob(text.slice(11).trim()), '\0sender@gmail.com\0testapppassword'); }, '235 2.7.0 accepted\r\n'];
const quit = [/^QUIT\r\n$/, '221 bye\r\n'];
function fixture(steps, options = {}, overrides = {}) {
  const fake = socketScript(steps, options), calls = [];
  const client = createMailClient({ ...env, ...overrides }, { deadlineMs: options.deadlineMs,
    connect: async (...args) => { calls.push(args); return fake.socket; },
  });
  return { client, ...fake, connections: calls };
}

test('native Worker SMTP verifies TLS and authenticates with fragmented multiline replies, without sending mail', async () => {
  const f = fixture([ehlo, plain, quit]);
  assert.deepEqual(await f.client.verify(), { verified: true, sent: false });
  assert.deepEqual(f.connections, [[{ hostname: 'smtp.gmail.com', port: 465 }, { secureTransport: 'on' }]]);
  assert.equal(f.steps.length, 0); assert.equal(f.calls.closes, 1);
  assert.ok(!f.calls.writes.some(line => /^(MAIL FROM|RCPT TO|DATA)/.test(line)));
});

test('email succeeds only after recipient and DATA accepted; MIME is UTF8/base64 with leading-zero OTP', async () => {
  const f = fixture([ehlo, plain,
    [/^MAIL FROM:<sender@gmail.com>\r\n$/, '250 sender accepted\r\n'],
    [/^RCPT TO:<child@example.com>\r\n$/, '250 recipient accepted\r\n'], [/^DATA\r\n$/, '354 begin\r\n'],
    [raw => {
      assert.match(raw, /From: Brclio Robot <sender@gmail.com>/); assert.match(raw, /Subject: =\?UTF-8\?B\?/);
      assert.match(raw, /Content-Transfer-Encoding: base64/); assert.ok(raw.endsWith('\r\n.\r\n'));
      const body = raw.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, '');
      assert.match(Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8'), /验证码是：012345/);
    }, '250 message accepted\r\n'], quit]);
  assert.deepEqual(await f.client.send('child@example.com', '012345'), { accepted: true });
  assert.equal(f.steps.length, 0);
});

test('STARTTLS587 upgrades socket and authenticates only after a fresh encrypted EHLO', async () => {
  const secure = socketScript([ehlo, plain, quit], { greeting: '' });
  const f = fixture([[/^EHLO /, '250-smtp.example\r\n250 STARTTLS\r\n'], [/^STARTTLS\r\n$/, '220 ready for TLS\r\n']], { upgrade: secure.socket }, { SMTP_PORT: '587' });
  assert.deepEqual(await f.client.verify(), { verified: true, sent: false });
  assert.equal(f.connections[0][1].secureTransport, 'starttls'); assert.equal(secure.steps.length, 0);
  assert.ok(!f.calls.writes.some(line => line.startsWith('AUTH')));
  const unsafe = fixture([[/^EHLO /, '250 AUTH PLAIN\r\n']], {}, { SMTP_PORT: '587' });
  await assert.rejects(unsafe.client.verify(), error => error.code === 'SMTP_TLS');
});

test('LOGIN challenge authentication works when PLAIN is not advertised', async () => {
  const f = fixture([[/^EHLO /, '250 AUTH LOGIN\r\n'], [/^AUTH LOGIN\r\n$/, '334 VXNlcg==\r\n'],
    [/^c2VuZGVyQGdtYWlsLmNvbQ==\r\n$/, '334 UGFzcw==\r\n'], [/^dGVzdGFwcHBhc3N3b3Jk\r\n$/, '235 accepted\r\n'], quit]);
  await f.client.verify(); assert.equal(f.steps.length, 0);
});

test('SMTP errors expose no raw authentication response, username, credentials, or cause', async () => {
  const f = fixture([ehlo, [/^AUTH PLAIN /, '535 private-secret sender@gmail.com raw-response\r\n']]);
  await assert.rejects(f.client.verify(), error => {
    assert.ok(error instanceof MailError); assert.equal(error.code, 'SMTP_AUTH');
    assert.ok(!String(error).includes('private-secret')); assert.ok(!JSON.stringify(error).includes('@'));
    assert.equal(error.cause, undefined); assert.equal(error.response, undefined); return true;
  });
});

test('recipient rejection never submits DATA or reports a delivered email', async () => {
  const f = fixture([ehlo, plain, [/^MAIL FROM:/, '250 okay\r\n'], [/^RCPT TO:/, '550 mailbox rejected\r\n']]);
  await assert.rejects(f.client.send('child@example.com', '123456'), error => error.code === 'SMTP_DELIVERY');
  assert.ok(!f.calls.writes.some(line => line === 'DATA\r\n'));
});

test('bounded timeout closes stalled real socket; failed QUIT cannot invalidate an accepted message', async () => {
  const stalled = fixture([], { greeting: '', deadlineMs: 10 });
  await assert.rejects(stalled.client.verify(), error => error.code === 'SMTP_TIMEOUT');
  assert.ok(stalled.calls.closes >= 1);
  const accepted = fixture([ehlo, plain, [/^MAIL FROM:/, '250 okay\r\n'], [/^RCPT TO:/, '250 okay\r\n'], [/^DATA/, '354 okay\r\n'], [/^From:/, '250 accepted\r\n'], [/^QUIT/, '']], { deadlineMs: 20 });
  assert.deepEqual(await accepted.client.send('child@example.com', '123456'), { accepted: true });
});

test('malformed multiline responses and excessively long greetings are rejected', async () => {
  for (const greeting of ['220-first\r\n250 inconsistent\r\n', 'hello\r\n', `220 ${'x'.repeat(5000)}\r\n`]) {
    const f = fixture([], { greeting });
    await assert.rejects(f.client.verify(), error => error.code === 'SMTP_PROTOCOL');
  }
});

test('a connector resolving after the deadline closes its late socket without authenticating', async () => {
  const fake = socketScript([]); let release;
  const client = createMailClient(env, { deadlineMs: 5, connect: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(client.verify(), error => error.code === 'SMTP_TIMEOUT');
  release(fake.socket);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fake.calls.closes, 1); assert.equal(fake.calls.writes.length, 0);
});

test('mailbox/header injection, unsafe transport config and malformed codes fail before connection', async () => {
  const f = fixture([]);
  for (const email of ['child@example.com\r\nBcc: outsider@example.com', 'child@example.com,other@example.com', '<child@example.com>']) await assert.rejects(f.client.send(email, '123456'), error => error.code === 'SMTP_INPUT');
  for (const code of ['12345', '1234567', '123\r\n4', 123456]) await assert.rejects(f.client.send('child@example.com', code), error => error.code === 'SMTP_INPUT');
  assert.equal(f.connections.length, 0);
  for (const overrides of [{ SMTP_FROM: 'sender@gmail.com\nBcc: other@example.com' }, { SMTP_FROM: 'sender@gmail.com, other@example.com' }, { SMTP_FROM: 'team: sender@gmail.com;' }, { SMTP_PORT: '25' }, { SMTP_PASS: '' }]) assert.throws(() => createMailClient({ ...env, ...overrides }), error => error.code === 'SMTP_CONFIG');
  const display = fixture([ehlo, plain, quit], {}, { SMTP_FROM: 'Brclio Robot <sender@gmail.com>' });
  await display.client.verify();
});
