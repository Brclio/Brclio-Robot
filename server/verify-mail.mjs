import nodemailer from 'nodemailer';
import { readConfig } from './app.mjs';
const { smtp } = readConfig();
if (!smtp.user || !smtp.pass) {
  console.error('SMTP 尚未配置，请在服务端环境中设置 SMTP_USER 与 SMTP_PASS。');
  process.exit(1);
}
const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure,
  auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
try {
  await transport.verify();
  console.log('SMTP 连接和身份验证通过。此检查没有发送邮件。');
} catch (error) {
  // Transport errors can contain account identifiers and server replies. Print only a known error category.
  const known = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS']);
  const category = known.has(error?.code) ? error.code : 'SMTP_ERROR';
  console.error(`SMTP 连接或身份验证未通过（${category}）。请检查服务端凭据与网络。此检查没有发送邮件。`);
  process.exitCode = 1;
} finally { transport.close(); }
