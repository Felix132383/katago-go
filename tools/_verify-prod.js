// 生产路径验证：KataGoClient.init() 全流程
'use strict';
const puppeteer = require('puppeteer-core');
const { server } = require('../server.js');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  await new Promise((r) => server.listen(0, r));
  const URL = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text().slice(0, 150)));
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message.slice(0, 150)));
  await page.goto(URL, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 800));
  const result = await page.evaluate(async () => {
    const c = new window.KataGoClient();
    const t0 = performance.now();
    try {
      const r = await c.init();
      return { ok: r.ok, status: r.status, backend: c.getEngineInfo().backend, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: e.message, status: c.status, ms: Math.round(performance.now() - t0) };
    }
  });
  console.log('=== KataGoClient.init ===');
  console.log(JSON.stringify(result, null, 2));
  console.log('--- 日志（关键） ---');
  logs.slice(0, 40).forEach((l) => console.log(l));
  await browser.close();
  await new Promise((r) => server.close(r));
  process.exit(result.ok ? 0 : 1);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
