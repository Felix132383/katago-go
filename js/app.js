/**
 * 围棋（KataGo 版）——纯前端对局应用
 * - 复用共享规则引擎 GoCore.GoGame 与基础 AI GoAI（简单/中等）
 * - KataGo 强 AI：通过 Web Worker 加载 WASM 引擎（资产缺失时自动降级）
 * - 对局记录存 localStorage，可复盘
 */
(function () {
  'use strict';

  // ==================== 工具 ====================
  const $ = (id) => document.getElementById(id);
  function toast(msg, type) {
    const box = document.createElement('div');
    box.className = 'toast' + (type === 'error' ? ' error' : '');
    box.textContent = msg;
    $('toasts').appendChild(box);
    setTimeout(() => box.remove(), 2600);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTouch = ('ontouchstart' in window) || ((navigator.maxTouchPoints || 0) > 0);
  const HISTORY_KEY = 'katago-go.history';
  const KOMI = (size) => (size >= 15 ? 7.5 : 5.5); // 贴目（目数，规则内换算成子）

  // ==================== 分段选择器 ====================
  function segValue(id) {
    const el = $(id).querySelector('.seg-btn.active');
    const keys = Object.keys(el.dataset);
    return keys.length ? el.dataset[keys[0]] : '';
  }
  function bindSeg(id, onChange) {
    const box = $(id);
    box.querySelectorAll('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        box.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        if (onChange) {
          const keys = Object.keys(b.dataset);
          onChange(keys.length ? b.dataset[keys[0]] : '');
        }
      });
    });
  }

  // ==================== 状态 ====================
  const state = {
    view: 'menu', // menu | game | replay | history
    mode: 'ai', // ai | local
    size: 19,
    engine: 'easy', // easy | medium | katago
    myColor: 0, // 人机：我的执子
    confirm: false, // 双击确认落子
    game: null,
    board: null, // BoardRenderer
    thinking: false,
    aiColor: 1,
    katago: null, // KataGoClient
    katagoOk: false,
    history: loadHistory(),
    replayData: null,
    replayGame: null,
  };

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch (e) { /* 存储满等忽略 */ }
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ==================== KataGo 初始化（探测/降级） ====================
  async function initKataGo() {
    const dot = $('ks-dot');
    const text = $('ks-text');
    text.textContent = '正在加载 KataGo 引擎（首次需从 CDN 下载 TensorFlow.js，约 10~30 秒）…';
    state.katago = new KataGoClient();
    const r = await state.katago.init();
    if (r.ok) {
      dot.className = 'ks-dot ok';
      text.textContent = '⚡ KataGo 引擎就绪（TensorFlow.js · ' + (state.katago.backend || '自动') + '）';
      state.katagoOk = true;
    } else if (r.status === 'no-assets') {
      dot.className = 'ks-dot warn';
      text.textContent = '⚠ KataGo 模型未配置（需 katago/model.bin.gz，v8+ 格式），已自动使用内置中等 AI';
    } else {
      dot.className = 'ks-dot warn';
      text.textContent = '⚠ KataGo 引擎加载失败（网络无法访问 CDN 或浏览器不支持），已自动使用内置中等 AI';
    }
  }

  // ==================== 视图切换 ====================
  function showView(v) {
    state.view = v;
    for (const id of ['view-menu', 'view-game', 'view-replay', 'view-history']) $(id).classList.toggle('hidden', id !== 'view-' + v);
  }

  // ==================== 对局 ====================
  function startGame() {
    state.mode = segValue('seg-mode');
    state.size = Number(segValue('seg-size'));
    state.confirm = segValue('seg-confirm') === '1';
    if (state.mode === 'ai') {
      state.engine = segValue('seg-engine');
      const colorPref = segValue('seg-color');
      state.myColor = colorPref === 'black' ? 0 : colorPref === 'white' ? 1 : Math.random() < 0.5 ? 0 : 1;
      state.aiColor = 1 - state.myColor;
    } else {
      state.engine = 'local';
      state.myColor = null;
      state.aiColor = null;
    }
    // KataGo 不可用时自动降级
    if (state.engine === 'katago' && !state.katagoOk) {
      state.engine = 'medium';
      $('btn-engine-katago').classList.remove('active');
      document.querySelector('#seg-engine .seg-btn[data-engine="medium"]').classList.add('active');
      toast('KataGo 未就绪，已切换为内置中等 AI', 'error');
    }

    state.game = new GoCore.GoGame(state.size);
    const names = state.mode === 'ai'
      ? { 0: state.myColor === 0 ? '我' : 'AI', 1: state.myColor === 1 ? '我' : 'AI' }
      : { 0: '黑方', 1: '白方' };
    state.names = names;
    $('name-black').textContent = names[0] + (state.mode === 'ai' && state.myColor === 0 ? '（我）' : '');
    $('name-white').textContent = names[1] + (state.mode === 'ai' && state.myColor === 1 ? '（我）' : '');
    $('game-mode-label').textContent =
      (state.mode === 'ai' ? '人机 · ' + (state.engine === 'katago' ? 'KataGo' : state.engine === 'medium' ? '中等' : '简单') + (state.myColor === 0 ? ' · 执黑' : ' · 执白') : '本地双人') +
      ' · ' + state.size + ' 路';
    $('katago-badge').classList.toggle('hidden', !(state.mode === 'ai' && state.engine === 'katago'));
    $('btn-resign').classList.toggle('hidden', state.mode !== 'ai'); // 双人无认输（避免歧义）？保留也可以，先隐藏

    showView('game');
    refreshTurn();
    renderGame();
    if (state.mode === 'ai' && state.myColor !== 0) {
      // AI 执黑先行
      scheduleAI();
    }
  }

  function renderGame() {
    state.board.setState({
      board: state.game.board,
      size: state.game.size,
      lastMove: state.game.lastMove,
      current: state.game.current,
      interactive: !state.thinking && state.game.winner === null,
      myColor: state.myColor,
      confirm: state.mode === 'ai' && state.confirm,
      confirmTouch: state.mode === 'ai' && state.confirm && isTouch,
    });
    updateCards();
  }

  function updateCards() {
    $('capture-black').textContent = state.game.captures[0] ? '提 ' + state.game.captures[0] + ' 子' : '';
    $('capture-white').textContent = state.game.captures[1] ? '提 ' + state.game.captures[1] + ' 子' : '';
    $('winrate-black').textContent = '';
    $('winrate-white').textContent = '';
    const g = state.game;
    $('card-black').classList.toggle('active', g.winner === null && g.current === 0);
    $('card-white').classList.toggle('active', g.winner === null && g.current === 1);
  }

  function refreshTurn() {
    const g = state.game;
    let t = '';
    if (g.winner !== null) t = '对局结束';
    else if (state.thinking) t = (g.current === 0 ? '黑' : '白') + ' 思考中…';
    else if (state.mode === 'ai' && g.current === state.aiColor) t = (g.current === 0 ? 'AI 执黑' : 'AI 执白') + ' 思考中…';
    else t = (g.current === 0 ? '黑棋落子' : '白棋落子') + (state.mode === 'ai' ? '（你' + (g.current === state.myColor ? '' : ' 的对手') + '）' : '');
    $('turn-bar').textContent = t;
    $('btn-undo').disabled = state.thinking || g.history.length === 0;
    $('btn-pass').disabled = state.thinking || g.winner !== null;
    $('btn-resign').disabled = state.thinking || g.winner !== null;
    $('btn-count').disabled = state.thinking || g.winner !== null;
  }

  /** 落子入口（玩家点击棋盘回调） */
  function onMove(x, y) {
    if (state.thinking || !state.game || state.game.winner !== null) return;
    if (state.mode === 'ai' && state.game.current === state.aiColor) return;
    const r = state.game.play(x, y);
    if (!r.ok) { toast(r.error, 'error'); return; }
    afterPlayerMove(x, y);
  }

  function afterPlayerMove(x, y) {
    state.board.animateStone(x, y, state.game.history[state.game.history.length - 1].color);
    renderGame();
    if (state.game.winner !== null) { finishGame(); return; }
    if (state.mode === 'ai' && state.game.current === state.aiColor) scheduleAI();
    else refreshTurn();
  }

  /** 调度 AI 落子（基础 AI / KataGo） */
  async function scheduleAI() {
    if (state.thinking) return;
    state.thinking = true;
    refreshTurn();
    const g = state.game;
    try {
      let mv = null;
      let winrate = null;
      if (state.engine === 'katago') {
        mv = await askKataGo();
      } else {
        // 内置基础 AI：模拟思考延迟
        await sleep(state.engine === 'medium' ? 800 + Math.random() * 900 : 500 + Math.random() * 600);
        if (state.game !== g || state.game.winner !== null) return;
        mv = GoAI.chooseMove(g, state.engine);
      }
      if (state.game !== g || g.winner !== null) return; // 对局已变（悔棋/退出）
      if (!mv) {
        // AI 无处可下或 KataGo 建议停一手
        const pr = g.pass();
        if (pr.ok && pr.over) { finishGame(); return; }
      } else {
        const r = g.play(mv.x, mv.y);
        if (r.ok) {
          state.board.animateStone(mv.x, mv.y, g.history[g.history.length - 1].color);
          if (winrate !== null) setWinrate(g.current === 0 ? 1 : 0, winrate);
        } else if (!g.pass()) {
          // 非法落子（异常兜底）：停一手
          const pr = g.pass();
          if (pr.ok && pr.over) { finishGame(); return; }
        }
      }
      renderGame();
      if (g.winner !== null) { finishGame(); return; }
    } finally {
      state.thinking = false;
      refreshTurn();
    }
    renderGame();
  }

  /** KataGo 分析（TF.js 引擎 Worker），失败降级到内置中等 AI */
  async function askKataGo() {
    const g = state.game;
    const history = g.history.map((h) => (h.pass ? { pass: true, color: h.color } : { x: h.x, y: h.y, color: h.color }));
    try {
      const res = await state.katago.analyze({
        size: g.size,
        board: g.board, // go-core 棋盘 [x][y]（0/1/null）
        current: g.current,
        history: history,
        komi: KOMI(g.size),
        visits: 300,
      });
      if (!res.ok) throw new Error(res.error || '分析失败');
      state.katagoOk = true;
      // 胜率显示：KataGo 返回当前行棋方（AI）的胜率
      if (res.winrate !== null && res.winrate !== undefined) setWinrate(g.current, res.winrate);
      if (res.x === -1 || res.y === -1) return null; // 建议停一手
      return { x: res.x, y: res.y };
    } catch (e) {
      state.katagoOk = false;
      toast('KataGo 分析失败，改用内置中等 AI（' + (e.message || '') + '）', 'error');
      return GoAI.chooseMove(g, 'medium');
    }
  }

  function setWinrate(seat, wr) {
    if (wr === null || wr === undefined) return;
    const pct = Math.round(wr * 100);
    const el = seat === 0 ? $('winrate-black') : $('winrate-white');
    el.textContent = pct + '%';
  }

  // ==================== 结束 / 数子 ====================
  function finishGame() {
    const g = state.game;
    const s = g.score;
    $('overlay-title').textContent = g.winner === -1 ? '🤝 和棋' : g.winner === 0 ? '⚫ 黑方胜' : '⚪ 白方胜';
    $('overlay-title').className = 'overlay-title' + (g.winner === 0 ? ' win' : '');
    $('overlay-sub').textContent = g.reason;
    const scoreEl = $('overlay-score');
    if (s) {
      const diff = s.diff > 0 ? '黑胜 ' + s.diff + ' 子' : s.diff < 0 ? '白胜 ' + (-s.diff) + ' 子' : '半目胜负';
      scoreEl.innerHTML =
        '黑：' + s.blackStones + ' 子 + ' + s.blackTerr + ' 目 = ' + s.blackTotal + '<br>' +
        '白：' + s.whiteStones + ' 子 + ' + s.whiteTerr + ' 目 + 贴 ' + s.komiMu + ' 目 = ' + s.whiteTotal + '<br>' +
        '<b>' + diff + '</b>';
      scoreEl.classList.remove('hidden');
    } else {
      scoreEl.classList.add('hidden');
    }
    $('overlay').classList.remove('hidden');
    saveToHistory();
  }

  /** 数子（提前结束并判定）：基于当前局面计算目数与胜负 */
  function countNow() {
    const g = state.game;
    const c = g.computeScore();
    const komi = KOMI(g.size);
    const blackTotal = c.blackStones + c.blackTerr;
    const whiteTotal = c.whiteStones + c.whiteTerr + komi;
    const diff = blackTotal - whiteTotal;
    g.score = {
      ...c, komi,
      blackTotal: Math.round(blackTotal * 100) / 100,
      whiteTotal: Math.round(whiteTotal * 100) / 100,
      diff: Math.round(diff * 100) / 100,
      komiMu: Math.round(komi * 2 * 10) / 10,
    };
    g.winner = Math.abs(diff) < 1e-9 ? -1 : diff > 0 ? 0 : 1;
    g.reason = '提前数子定胜负';
    finishGame();
  }

  function resignNow() {
    const g = state.game;
    g.winner = 1 - g.current;
    g.reason = (g.current === 0 ? '黑方' : '白方') + ' 认输';
    finishGame();
  }

  function undoNow() {
    const g = state.game;
    if (state.thinking || !g.history.length) return;
    if (state.mode === 'ai') {
      // 人机悔棋：撤回双方各一手，回到玩家回合
      if (g.current === state.aiColor) {
        g.undo(); // 轮到 AI：撤玩家上一手
      } else {
        g.undo(); // 轮到玩家：撤 AI 一手
        if (g.history.length && g.current !== state.myColor) g.undo(); // 再撤玩家一手
      }
      // 兜底：确保回到玩家回合
      let guard = 0;
      while (g.history.length && g.current !== state.myColor && guard < 8) { g.undo(); guard++; }
    } else {
      g.undo();
    }
    // 若悔棋解除了结束状态（双停数子后），清理浮层
    $('overlay').classList.add('hidden');
    renderGame();
    refreshTurn();
  }

  function passNow() {
    const g = state.game;
    if (state.thinking || g.winner !== null) return;
    const r = g.pass();
    if (r.ok) {
      if (r.over) finishGame();
      else { renderGame(); refreshTurn(); }
    }
  }

  function saveToHistory() {
    const g = state.game;
    const rec = {
      id: Date.now(),
      date: fmtDate(Date.now()),
      size: g.size,
      mode: state.mode,
      engine: state.engine,
      myColor: state.myColor,
      names: state.names,
      moves: g.state().replay,
      captures: g.captures,
      result: g.winner === null ? null : { winner: g.winner, reason: g.reason, score: g.score },
    };
    state.history.unshift(rec);
    if (state.history.length > 50) state.history.length = 50;
    saveHistory();
  }

  // ==================== 复盘 ====================
  function openReplay(rec) {
    state.replayData = rec;
    showView('replay');
    $('replay-title').textContent = rec.date + ' · ' + rec.size + ' 路 · ' +
      (rec.mode === 'ai' ? (rec.engine === 'katago' ? 'KataGo' : rec.engine === 'medium' ? '中等' : '简单') : '双人') +
      (rec.result ? ' · ' + (rec.result.winner === 0 ? '黑胜' : rec.result.winner === 1 ? '白胜' : '和棋') : ' · 未结束');
    $('replay-info').textContent = (rec.names ? rec.names[0] + ' 对 ' + rec.names[1] : '') + ' · 共 ' + rec.moves.length + ' 手';
    renderReplayStep(0);
  }

  function renderReplayStep(step) {
    const rec = state.replayData;
    const g = new GoCore.GoGame(rec.size);
    for (let i = 0; i < step && i < rec.moves.length; i++) {
      const mv = rec.moves[i];
      if (mv.pass) g.pass();
      else g.play(mv.x, mv.y);
    }
    state.replayGame = g;
    $('rp-step').textContent = step + ' / ' + rec.moves.length;
    state.replayBoard.setState({
      board: g.board,
      size: rec.size,
      lastMove: g.lastMove,
      current: g.current,
      interactive: false,
    });
  }

  // ==================== 历史列表 ====================
  function renderHistory() {
    const list = $('history-list');
    list.innerHTML = '';
    if (!state.history.length) {
      list.innerHTML = '<div class="empty">暂无历史对局</div>';
      return;
    }
    for (const rec of state.history) {
      const li = document.createElement('li');
      li.className = 'history-item';
      const res = rec.result
        ? (rec.result.winner === 0 ? '⚫ 黑胜' : rec.result.winner === 1 ? '⚪ 白胜' : '🤝 和棋')
        : '未结束';
      li.innerHTML =
        '<div class="h-main">' + esc(rec.date) + ' · ' + rec.size + ' 路 · ' +
        (rec.mode === 'ai' ? '人机(' + (rec.engine === 'katago' ? 'KataGo' : rec.engine === 'medium' ? '中等' : '简单') + ')' : '双人') +
        '</div>' +
        '<div class="h-sub">' + esc(rec.moves.length + ' 手') + ' · ' + esc(res) + '</div>';
      li.addEventListener('click', () => openReplay(rec));
      list.appendChild(li);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ==================== 初始化 ====================
  function init() {
    bindSeg('seg-mode', (v) => {
      $('row-ai').classList.toggle('hidden', v !== 'ai');
      $('row-color').classList.toggle('hidden', v !== 'ai');
    });
    bindSeg('seg-size');
    bindSeg('seg-engine', (v) => {
      $('engine-hint').textContent =
        v === 'easy' ? '内置 AI：基础启发式，适合入门'
        : v === 'medium' ? '内置 AI：启发式 + 蒙特卡洛，约业余级'
        : 'KataGo 强 AI：本地 WASM 引擎，需要预先配置引擎文件（见 katago/README.md）';
    });
    bindSeg('seg-color');
    bindSeg('seg-confirm');
    $('engine-hint').textContent = '内置 AI：基础启发式，适合入门';

    state.board = new BoardRenderer($('board-canvas'), { onMove: onMove });
    state.replayBoard = new BoardRenderer($('replay-canvas'), { size: 19 });

    // 底部按钮（移动端避免原生 confirm 弹窗，直接执行 + 提示）
    $('btn-undo').addEventListener('click', undoNow);
    $('btn-pass').addEventListener('click', passNow);
    $('btn-resign').addEventListener('click', () => { resignNow(); toast('已认输'); });
    $('btn-count').addEventListener('click', () => { countNow(); toast('已按当前局面数子'); });
    $('btn-restart').addEventListener('click', () => { toast('重新开始一局'); startGame(); });

    // 顶部按钮
    $('btn-back').addEventListener('click', () => { saveToHistory(); toast('对局已保存'); showView('menu'); renderHistory(); });
    $('btn-save').addEventListener('click', () => { saveToHistory(); toast('已保存对局'); showView('menu'); renderHistory(); });
    $('btn-start').addEventListener('click', startGame);
    $('btn-history').addEventListener('click', () => { renderHistory(); showView('history'); });
    $('btn-history-back').addEventListener('click', () => showView('menu'));

    // 结果浮层
    $('btn-replay').addEventListener('click', () => {
      $('overlay').classList.add('hidden');
      openReplay(state.history[0]); // 最近保存的即为本局
    });
    $('btn-new').addEventListener('click', () => { $('overlay').classList.add('hidden'); startGame(); });
    $('btn-close').addEventListener('click', () => { $('overlay').classList.add('hidden'); showView('menu'); renderHistory(); });

    // 复盘控制
    $('btn-replay-back').addEventListener('click', () => { showView('history'); renderHistory(); });
    $('rp-first').addEventListener('click', () => renderReplayStep(0));
    $('rp-prev').addEventListener('click', () => { const s = state.replayData; const step = Number($('rp-step').textContent.split(' / ')[0]); renderReplayStep(Math.max(0, step - 1)); });
    $('rp-next').addEventListener('click', () => { const s = state.replayData; const step = Number($('rp-step').textContent.split(' / ')[0]); renderReplayStep(Math.min(s.moves.length, step + 1)); });
    $('rp-last').addEventListener('click', () => renderReplayStep(state.replayData.moves.length));

    initKataGo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
