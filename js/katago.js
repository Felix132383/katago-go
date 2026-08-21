/**
 * KataGo 客户端（主线程）—— TensorFlow.js 引擎版
 *
 * 对接 web-katrain（Sir-Teo）的引擎：
 * - Web Worker（js/katago-engine/worker.js，由 web-katrain TS 转译，module worker）
 * - 消息协议：katago:init / katago:analyze / katago:init_result / katago:analyze_result
 * - 依赖通过 CDN（jsdelivr +esm）加载：@tensorflow/tfjs 4.22.0、tfjs-backend-wasm/webgpu、pako
 * - 模型：katago/model.bin.gz（KataGo 模型 v8~16，b6c96 v7 不支持）
 *
 * 降级：模型缺失 / Worker 失败 / 分析超时 → {ok:false}，由 app 降级到内置 AI。
 */
(function (root) {
  'use strict';

  /** 引擎目录解析：URL 参数 ?engine= > localStorage katago.engineUrl > 本地 katago/ */
  const BASE = (function () {
    try {
      const q = new URLSearchParams(location.search).get('engine');
      if (q) return q;
      const saved = localStorage.getItem('katago.engineUrl');
      if (saved) return saved;
    } catch (e) { /* ignore */ }
    const s = document.currentScript && document.currentScript.src;
    return s ? new URL('../katago/', s).href : 'katago/';
  })();

  const MODEL_URL = BASE + 'model.bin.gz';
  const WORKER_URL = (function () {
    const s = document.currentScript && document.currentScript.src;
    return s ? new URL('katago-engine/worker.js', s).href : 'js/katago-engine/worker.js';
  })();

  /** 颜色转换：0/1 -> 'black'/'white' */
  const toPlayer = (c) => (c === 0 ? 'black' : 'white');

  /** 由着法序列重放出一个局面棋盘（[x][y] 0/1/null -> [y][x] 'black'/'white'/null） */
  function rebuildBoard(size, moves) {
    const board = Array.from({ length: size }, () => Array(size).fill(null));
    const core = root.GoCore;
    if (core && core.GoGame) {
      const g = new core.GoGame(size);
      for (const m of moves) {
        if (!m.pass && g.winner === null) {
          const r = g.play(m.x, m.y);
          if (!r.ok) break;
        } else if (m.pass && g.winner === null) {
          g.pass();
        }
      }
      return toWKBoard(g.board, size);
    }
    // 兜底：无规则引擎时仅放子（不处理提子/劫）
    for (const m of moves) {
      if (!m.pass && board[m.y] && board[m.y][m.x] === null) board[m.y][m.x] = toPlayer(m.color);
    }
    return board;
  }

  function toWKBoard(goBoard, size) {
    const out = Array.from({ length: size }, () => Array(size).fill(null));
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        const v = goBoard[x] && goBoard[x][y];
        if (v === 0 || v === 1) out[y][x] = toPlayer(v);
      }
    }
    return out;
  }

  class KataGoClient {
    constructor() {
      this.worker = null;
      this.ready = false; // 引擎初始化完成
      this.available = false;
      this.status = 'unknown'; // 'ready' | 'no-assets' | 'worker-fail' | 'loading'
      this.backend = null;
      this.modelName = null;
      this._seq = 0;
      this._pending = new Map();
      this._initPromise = null;
    }

    /**
     * 初始化：探测模型 → 创建 module worker → 加载引擎与模型
     * @returns {Promise<{ok:boolean, status:string}>}
     */
    async init() {
      if (this._initPromise) return this._initPromise;
      this._initPromise = (async () => {
        // 1. 探测模型文件（Range 取头部，SPA/404 都会失败）
        try {
          const r = await fetch(MODEL_URL, { headers: { Range: 'bytes=0-511' }, cache: 'no-store' });
          if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
          const head = await r.text();
          if (/^\s*<!doctype|<html/i.test(head)) throw new Error('not a model asset');
        } catch (e) {
          this.status = 'no-assets';
          return { ok: false, status: this.status };
        }
        // 2. 创建 module worker（web-katrain 引擎）
        try {
          this.worker = new Worker(WORKER_URL, { type: 'module' });
          this.worker.onmessage = (e) => this._onMsg(e.data);
          this.worker.onerror = (e) => this._onWorkerError(e);
          this.status = 'loading';
          await this._call('katago:init', { modelUrl: MODEL_URL, backend: 'cpu' }, 120000);
          this.available = true;
          this.status = 'ready';
          return { ok: true, status: this.status };
        } catch (e) {
          this.status = 'worker-fail';
          if (this.worker) { try { this.worker.terminate(); } catch (x) { /* ignore */ } }
          this.worker = null;
          return { ok: false, status: this.status };
        }
      })();
      return this._initPromise;
    }

    /**
     * 分析当前局面，返回最佳落子
     * @param {object} args
     *   size: 路数; board: go-core 棋盘 [x][y](0/1/null); current: 0|1;
     *   history: [{x,y,color}|{pass:true,color}]; komi: 贴目; visits: 访问量
     * @returns {Promise<{ok:boolean, x:number, y:number, winrate:number|null, visits:number}>}
     *   x=-1/y=-1 表示建议停一手
     */
    async analyze(args) {
      if (!this.worker) return { ok: false, error: 'KataGo 未初始化' };
      const size = args.size;
      const moves = args.history.map((m) => (m.pass ? { x: -1, y: -1, player: toPlayer(m.color) } : { x: m.x, y: m.y, player: toPlayer(m.color) }));
      // 前一手/前两手局面（供引擎劫与历史特征；去掉最后一手重放）
      const prev = moves.slice(0, -1);
      const prevPrev = moves.slice(0, -2);
      const req = {
        type: 'katago:analyze',
        id: ++this._seq,
        modelUrl: MODEL_URL,
        backend: 'cpu',
        board: toWKBoard(args.board, size),
        previousBoard: prev.length ? rebuildBoard(size, args.history.slice(0, -1)) : undefined,
        previousPreviousBoard: prevPrev.length ? rebuildBoard(size, args.history.slice(0, -2)) : undefined,
        currentPlayer: toPlayer(args.current),
        moveHistory: moves,
        komi: args.komi !== undefined ? args.komi : size >= 15 ? 7.5 : 5.5,
        visits: args.visits || 300,
        maxTimeMs: 60000,
        topK: 5,
        analysisPvLen: 5,
        wideRootNoise: 0.04,
        reuseTree: false,
      };
      const res = await this._callByPayload(req, 60000);
      const analysis = res.analysis;
      if (!analysis || !Array.isArray(analysis.moves) || !analysis.moves.length) {
        return { ok: true, x: -1, y: -1, winrate: analysis ? analysis.rootWinRate : null, visits: 0 };
      }
      const best = analysis.moves[0];
      return {
        ok: true,
        x: best.x,
        y: best.y,
        winrate: best.winRate !== undefined ? best.winRate : analysis.rootWinRate,
        visits: best.visits || 0,
      };
    }

    /** 引擎信息 */
    getEngineInfo() {
      return { backend: this.backend, modelName: this.modelName, status: this.status };
    }

    destroy() {
      if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
      this.worker = null;
      this.ready = false;
      this.available = false;
      this._pending.clear();
    }

    /** 按消息类型发起请求并等待结果 */
    _call(type, payload, timeoutMs) {
      const id = ++this._seq;
      return this._callByPayload({ type: type, id: id, ...payload }, timeoutMs);
    }

    _callByPayload(payload, timeoutMs) {
      return new Promise((resolve, reject) => {
        const id = payload.id;
        this._pending.set(id, { resolve, reject });
        try {
          this.worker.postMessage(payload);
        } catch (e) {
          this._pending.delete(id);
          reject(e);
          return;
        }
        setTimeout(() => {
          if (this._pending.has(id)) {
            this._pending.delete(id);
            reject(new Error('KataGo 请求超时'));
          }
        }, timeoutMs || 60000);
      });
    }

    _onMsg(d) {
      if (!d) return;
      if (d.type === 'katago:init_result') {
        const p = this._pending.get(d.id);
        if (!p) return;
        this._pending.delete(d.id);
        if (d.ok) {
          this.ready = true;
          this.backend = d.backend || null;
          this.modelName = d.modelName || null;
          p.resolve(d);
        } else {
          this.ready = false;
          p.reject(new Error(d.error || '引擎初始化失败'));
        }
        return;
      }
      if (d.type === 'katago:analyze_result') {
        const p = this._pending.get(d.id);
        if (!p) return;
        this._pending.delete(d.id);
        if (d.ok) p.resolve(d);
        else p.reject(new Error(d.error || '分析失败'));
        return;
      }
      if (d.type === 'katago:analyze_update') return; // 进度事件，忽略
      if (d.type === 'katago:error' || d.type === 'error') {
        this._failAll('KataGo 引擎错误: ' + (d.error || ''));
      }
    }

    _onWorkerError(e) {
      this.ready = false;
      this._failAll('KataGo Worker 错误: ' + (e && e.message ? e.message : ''));
    }

    _failAll(msg) {
      for (const p of this._pending.values()) p.reject(new Error(msg));
      this._pending.clear();
    }
  }

  root.KataGoClient = KataGoClient;
  root.KATAGO_BASE = BASE;
})(typeof window !== 'undefined' ? window : this);
