// Reproducible production smoke: serve dist at root and at a nested static path.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium, expect } from '@playwright/test';
const directory = resolve('dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  let pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname.startsWith('/robot/')) pathname = pathname.slice('/robot'.length);
  const file = resolve(directory, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
  if (!file.startsWith(`${directory}${sep}`)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch();
  for (const path of ['/', '/robot/']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = [], failed = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    // Pure static hosting deliberately has no account API; guests can still play and save.
    page.on('response', response => { if (response.status() >= 400 && !(response.status() === 404 && response.url() === `${origin}/api/auth/session`)) failed.push(response.url()); });
    page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
    await page.goto(`${origin}${path}`);
    await page.getByTestId('library-forward').click();
    await page.getByLabel('第 1 块移动步数').selectOption('2');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('execution-message')).toContainText('你学会了');
    await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '3');
    expect(errors).toEqual([]); expect(failed).toEqual([]); expect(external).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    console.log(`PASS production ${path}: all resources local, no browser errors, first lesson completed`);
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
