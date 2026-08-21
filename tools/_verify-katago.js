// 验证：完整 KataGo 初始化 + 一次分析（本机无网也应成功：bundle/wasm 全本地）
'use strict';
const puppeteer = require('puppeteer-core');
const { server } = require('../server.js');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  await new Promise((r) => server.listen(0, r));
  const URL = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log('[c]', m.type(), m.text().slice(0, 160)); });
  await page.goto(URL, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 800));

  const result = await page.evaluate(async () => {
    const t0 = performance.now();
    const steps = [];
    // 1) 下载模型
    const r = await fetch('katago/model.bin.gz');
    const buf = new Uint8Array(await r.arrayBuffer());
    steps.push('model ' + buf.length + 'B ' + Math.round(performance.now() - t0) + 'ms');
    // 2) 创建 worker
    const worker = new Worker(new URL('js/katago-engine/worker.js', location.href), { type: 'module' });
    let resolveInit, resolveAnalyze;
    const initP = new Promise((res) => { resolveInit = res; });
    const anaP = new Promise((res) => { resolveAnalyze = res; });
    worker.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'debug') steps.push(d.step + (d.backend ? '(' + d.backend + ')' : '') + ' ' + Math.round(performance.now() - t0) + 'ms');
      if (d.type === 'katago:init_result') resolveInit(d);
      if (d.type === 'katago:analyze_result') resolveAnalyze(d);
    };
    worker.onerror = (e) => { steps.push('WORKER-ERR ' + e.message); resolveInit({ ok: false, error: e.message }); resolveAnalyze({ ok: false, error: e.message }); };
    worker.postMessage({ type: 'katago:init', modelUrl: 'model', modelData: buf.buffer, backend: 'webgpu' });
    const init = await Promise.race([initP, new Promise((res) => setTimeout(() => res({ ok: false, error: 'init-timeout-60s' }), 60000))]);
    if (!init.ok) return { ok: false, steps, initError: init.error };
    steps.push('INIT-OK backend=' + init.backend + ' model=' + init.modelName + ' ' + Math.round(performance.now() - t0) + 'ms');
    // 3) 分析一个空 9 路局面（黑先）
    const size = 9;
    const empty = Array.from({ length: size }, () => Array(size).fill(null));
    worker.postMessage({
      type: 'katago:analyze', id: 1, modelUrl: 'model',
      board: empty, currentPlayer: 'black', moveHistory: [], komi: 5.5,
      visits: 100, maxTimeMs: 30000, topK: 3, analysisPvLen: 2,
    });
    const ana = await Promise.race([anaP, new Promise((res) => setTimeout(() => res({ ok: false, error: 'analyze-timeout-60s' }), 60000))]);
    if (!ana.ok || !ana.analysis) return { ok: false, steps, anaError: ana.error };
    const mv = ana.analysis.moves[0];
    return {
      ok: true, steps, backend: ana.backend,
      bestMove: mv ? { x: mv.x, y: mv.y, winRate: +(mv.winRate * 100).toFixed(1), visits: mv.visits } : null,
      rootWinRate: +(ana.analysis.rootWinRate * 100).toFixed(1),
      totalMs: Math.round(performance.now() - t0),
    };
  });
  console.log('=== 结果 ===');
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  process.exit(result && result.ok ? 0 : 1);
})().catch((e) => { console.error('验证异常:', e); process.exit(1); });
