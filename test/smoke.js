/**
 * 围棋 KataGo 版 —— 浏览器冒烟测试（Puppeteer）
 * 运行：npm test（需本机 Chrome）
 * 覆盖：设置页渲染 → KataGo 降级提示 → 人机对局（简单 AI）→ 悔棋 → 停一手
 *     → 双人对局 → 数子结束 → 存档 → 历史 → 复盘 → 无 JS 报错
 */
'use strict';

const puppeteer = require('puppeteer-core');
const { server } = require('../server.js');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.error('  ✘ ' + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, r));
  const URL = 'http://127.0.0.1:' + server.address().port + '/';
  console.log('围棋应用 URL:', URL);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATHS.find((p) => require('fs').existsSync(p)),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--mute-audio'],
  });

  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // 忽略网络类错误：KataGo 引擎探测请求预期返回 404（未配置引擎 → 自动降级）
      if (t.includes('Failed to load resource')) return;
      pageErrors.push('console: ' + t);
    });

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(URL, { waitUntil: 'load' }); // 不用 networkidle：worker 拉 CDN 可能持续挂起，load 即算完成

    // 设置页渲染
    await page.waitForSelector('#view-menu:not(.hidden)');
    assert(true, '设置页渲染');
    // KataGo 引擎状态（就绪 / 模型缺失 / 加载失败降级；等状态圆点出现结论）
    await page.waitForFunction(() => {
      const d = document.getElementById('ks-dot');
      return d && (d.className.includes('ok') || d.className.includes('warn'));
    }, { timeout: 60000 });
    const ksText = await page.$eval('#ks-text', (el) => el.textContent);
    const ksDot = await page.$eval('#ks-dot', (el) => el.className);
    assert((ksDot.includes('ok') || ksDot.includes('warn')) && ksText.includes('KataGo'), 'KataGo 状态提示显示（' + ksText + '）');

    // ---------- 人机对局（简单 AI，玩家执黑） ----------
    await page.click('#seg-engine .seg-btn[data-engine="easy"]');
    await page.click('#seg-color .seg-btn[data-color="black"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => !document.getElementById('view-game').classList.contains('hidden'));
    assert(true, '进入对局视图');

    const clickCell = async (x, y) => {
      const box = await (await page.$('#board-canvas')).boundingBox();
      const cell = box.width / 18; // 19 路 = 18 格
      await page.touchscreen.tap(box.x + (x + 0.5) * cell, box.y + (y + 0.5) * cell);
    };
    // 玩家黑棋落子（单击直接落子模式）
    await clickCell(9, 9);
    await page.waitForFunction(() => document.getElementById('turn-bar').textContent.includes('思考'), { timeout: 5000 });
    assert(true, '玩家落子后 AI 开始思考');
    // AI 简单档快速回应
    await page.waitForFunction(() => document.getElementById('turn-bar').textContent.includes('黑棋落子'), { timeout: 12000 });
    assert(true, 'AI 回应落子');
    // 玩家再落一手，然后悔棋
    await clickCell(8, 9);
    await page.waitForFunction(() => document.getElementById('turn-bar').textContent.includes('黑棋落子'), { timeout: 12000 });
    await page.click('#btn-undo');
    await sleep(400);
    const turnAfterUndo = await page.$eval('#turn-bar', (el) => el.textContent);
    assert(turnAfterUndo.includes('黑棋落子'), '悔棋后回到玩家回合（' + turnAfterUndo + '）');
    // 停一手
    await page.click('#btn-pass');
    await page.waitForFunction(() => {
      const t = document.getElementById('turn-bar').textContent;
      return t.includes('白') || t.includes('结束') || !document.getElementById('overlay').classList.contains('hidden');
    }, { timeout: 6000 });
    assert(true, '停一手后流转正常');
    // 保存退出 → 历史列表出现本局
    await page.click('#btn-save');
    await page.waitForFunction(() => !document.getElementById('view-menu').classList.contains('hidden'));
    await page.click('#btn-history');
    await page.waitForFunction(() => document.querySelectorAll('#history-list .history-item').length >= 1);
    assert(true, '对局已存档，历史列表可见');

    // ---------- 复盘 ----------
    await page.click('#history-list .history-item');
    await page.waitForFunction(() => !document.getElementById('view-replay').classList.contains('hidden'));
    const step0 = await page.$eval('#rp-step', (el) => el.textContent);
    await page.click('#rp-next');
    const step1 = await page.$eval('#rp-step', (el) => el.textContent);
    assert(step0 !== step1, '复盘步进正常（' + step0 + ' → ' + step1 + '）');
    await page.click('#btn-replay-back');

    // ---------- 本地双人 + 数子 ----------
    await page.click('#btn-history-back'); // 回设置
    await page.waitForFunction(() => !document.getElementById('view-menu').classList.contains('hidden'));
    await page.click('#seg-mode .seg-btn[data-mode="local"]');
    await page.click('#seg-size .seg-btn[data-size="9"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => !document.getElementById('view-game').classList.contains('hidden'));
    // 9 路快速对局数子：黑 (2,2)(2,3)，白 (6,6)(6,7)，黑 (3,2) —— 然后数子结束
    const cell9 = (await (await page.$('#board-canvas')).boundingBox()).width / 8;
    const tap = async (x, y) => {
      const box = await (await page.$('#board-canvas')).boundingBox();
      await page.touchscreen.tap(box.x + (x + 0.5) * cell9, box.y + (y + 0.5) * cell9);
    };
    await tap(2, 2); // 黑
    await tap(6, 6); // 白
    await tap(2, 3); // 黑
    await tap(6, 7); // 白
    await tap(3, 2); // 黑
    await sleep(500);
    const turnLocal = await page.$eval('#turn-bar', (el) => el.textContent);
    assert(turnLocal.includes('白棋'), '双人对局轮流落子（' + turnLocal + '）');
    // 数子结束
    await page.click('#btn-count');
    await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('hidden'), { timeout: 5000 });
    const ovTitle = await page.$eval('#overlay-title', (el) => el.textContent);
    assert(ovTitle.includes('胜') || ovTitle.includes('和棋'), '数子判出胜负（' + ovTitle + '）');
    await page.click('#btn-close');

    // JS 报错检查
    assert(pageErrors.length === 0, '无 JS 报错' + (pageErrors.length ? '：' + pageErrors[0] : ''));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
