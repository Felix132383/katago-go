/**
 * 棋盘 Canvas 渲染器
 * - 自适应容器尺寸（含设备像素比缩放，Retina 清晰）
 * - 支持鼠标 / 触摸（Pointer Events）落子，带悬停预览
 * - 棋子落子有轻微弹入动画
 * - 跟随系统深浅色主题切换棋盘配色（避免手机深色模式下棋盘过亮）
 */
(function (root) {
  'use strict';

  // 浅色主题配色
  // 浅色主题配色（浅木色棋盘 + 黑色网格线，木质渐变增强质感）
  const LIGHT = {
    bgHi: '#efdbb0', // 棋盘底色高光（浅木色）
    bgLo: '#e2c78f', // 底色阴影（木纹层次）
    line: '#3a352e', // 网格线（黑色系）
    star: '#3a352e', // 星位（黑色，加粗便于观察）
    blackHi: '#56524b',
    blackLo: '#14120f',
    blackEdge: 'rgba(255,255,255,0)',
    whiteHi: '#ffffff',
    whiteLo: '#cfc9bd',
    whiteEdge: 'rgba(60,50,30,0.35)',
    marker: '#d9381e', // 最后一手标记
    ghost: 'rgba(40,36,28,0.28)', // 悬停预览
  };

  // 深色主题配色（界面深色，但棋盘仍为浅木色 + 黑线，保证落子/星位清晰）
  const DARK = {
    bgHi: '#ddc291',
    bgLo: '#c9a96f',
    line: '#2b2721',
    star: '#2b2721',
    blackHi: '#4d4943',
    blackLo: '#151310',
    blackEdge: 'rgba(0,0,0,0)',
    whiteHi: '#fffdf6',
    whiteLo: '#cfc6b2',
    whiteEdge: 'rgba(20,16,10,0.45)',
    marker: '#d9381e',
    ghost: 'rgba(30,26,20,0.28)',
  };

  /** 计算当前是否深色：优先看手动设置（html[data-theme]），否则跟随系统 */
  function computeDark() {
    const html = root.document && root.document.documentElement;
    const t = html && html.dataset ? html.dataset.theme : null;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /** 根据棋盘路数返回星位坐标列表 */
  function starPoints(size) {
    const mid = (size - 1) / 2;
    const pts = [];
    if (size === 19) {
      for (const a of [3, 9, 15]) for (const b of [3, 9, 15]) pts.push([a, b]);
    } else {
      const a = size === 9 ? 2 : 3;
      const b = size - 1 - a;
      pts.push([a, a], [a, b], [b, a], [b, b], [mid, mid]);
    }
    return pts;
  }

  class BoardRenderer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts { size, onMove(x, y) }
     */
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onMove = opts.onMove || function () {};
      this.onForbiddenHint = opts.onForbiddenHint || function () {};
      this.size = opts.size || 15;

      // 当前展示状态
      this.board = null;
      this.lastMove = null;
      this.current = 0;
      this.interactive = false;
      this.myColor = null;
      this.confirm = false; // 双击确认模式（单机）：第一次点击预览，第二次确认
      this.pending = null; // 待确认的落子 {x, y}

      this.hover = null; // 悬停格 {x, y}
      this.anims = []; // 落子动画 {x, y, color, t0}

      this.css = 0; // 画布 CSS 尺寸（正方形）
      this.dpr = 1;

      // 主题跟随系统/手动设置（html[data-theme]），并监听系统切换实时重绘
      this.dark = computeDark();
      this._themeListener = () => this.refreshTheme();
      if (root.matchMedia) {
        root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', this._themeListener);
      }

      this._bindEvents();
      this._resize();
      this._loop();
    }

    /** 手动切换主题后刷新（app 调用）或系统主题变化时自动调用 */
    refreshTheme() {
      this.dark = computeDark();
      this.draw();
    }

    /** 当前主题配色 */
    get colors() {
      return this.dark ? DARK : LIGHT;
    }

    /** 更新棋盘状态并重绘 */
    setState(s) {
      if (s.size && s.size !== this.size) {
        this.size = s.size;
        this.hover = null;
        this.pending = null;
        this._resize();
      }
      this.board = s.board;
      this.lastMove = s.lastMove || null;
      this.current = s.current;
      this.interactive = !!s.interactive;
      this.myColor = s.myColor !== undefined ? s.myColor : null;
      this.confirm = !!s.confirm; // 强制双击确认（单机模式）
      this.confirmTouch = !!s.confirmTouch; // 触摸设备双击确认（在线对局防误触）
      this.forbiddenCheck = !!s.forbiddenCheck; // 黑棋禁手模式（提示禁手点并禁止落子）
      // 待确认的预览格若已被占用（如 AI 落子占据），自动清除
      if (this.pending && (!this.board || this.board[this.pending.x] === undefined || this.board[this.pending.x][this.pending.y] !== null)) {
        this.pending = null;
      }
      this.draw();
    }

    /** 触发一枚棋子的弹入动画（收到 game:move 时调用） */
    animateStone(x, y, color) {
      this.anims.push({ x: x, y: y, color: color, t0: performance.now() });
    }

    /** 黑棋在 (x, y) 是否为禁手（依赖共享规则模块 GomokuCore.isForbidden） */
    _forbiddenAt(x, y) {
      const core = root.GomokuCore;
      return core && core.isForbidden ? core.isForbidden(this.board, this.size, x, y) : false;
    }

    /** 禁手提示（触发 app 的 toast 提示） */
    _showForbiddenHint(type) {
      const label = type === 'overline' ? '长连禁手' : type === 'double-four' ? '四四禁手' : '三三禁手';
      this.onForbiddenHint(label);
    }

    // ---------- 几何 ----------

    _resize() {
      const parent = this.canvas.parentElement;
      const w = parent ? parent.clientWidth : this.canvas.clientWidth || 400;
      this.css = Math.max(120, w);
      this.dpr = (root.devicePixelRatio || 1) > 1.5 ? 2 : 1;
      this.canvas.width = Math.round(this.css * this.dpr);
      this.canvas.height = Math.round(this.css * this.dpr);
      this.pad = this.css * 0.05;
      this.cell = (this.css - 2 * this.pad) / (this.size - 1);
      this.draw();
    }

    /** 交点坐标 -> 格点 */
    _toCell(px, py) {
      const x = Math.round((px - this.pad) / this.cell);
      const y = Math.round((py - this.pad) / this.cell);
      if (x < 0 || x >= this.size || y < 0 || y >= this.size) return null;
      return { x: x, y: y };
    }

    /** 格点 -> 像素坐标 */
    _toPx(x, y) {
      return { cx: this.pad + x * this.cell, cy: this.pad + y * this.cell };
    }

    // ---------- 事件 ----------

    _bindEvents() {
      const c = this.canvas;
      c.style.touchAction = 'none';
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const cell = this._toCell(e.clientX - rect.left, e.clientY - rect.top);
        if (!cell) return;
        if (!this.interactive || !this.board) return;
        if (this.board[cell.x][cell.y] !== null) return;
        // 黑棋禁手提示：禁手点禁止落子
        if (this.forbiddenCheck && this.myColor === 0) {
          const f = this._forbiddenAt(cell.x, cell.y);
          if (f) {
            this._showForbiddenHint(f);
            return;
          }
        }
        // 需要二次确认的情形：单机强制双击，或触摸设备在线对局（防误触）
        const needConfirm = this.confirm || (this.confirmTouch && e.pointerType === 'touch');
        if (needConfirm) {
          // 双击确认模式：第一次点击预览，第二次点击同一格确认落子
          if (this.pending && this.pending.x === cell.x && this.pending.y === cell.y) {
            this.pending = null;
            this.draw();
            this.onMove(cell.x, cell.y);
          } else {
            this.pending = { x: cell.x, y: cell.y };
            this.draw();
          }
          return;
        }
        // 普通模式：单击落子
        this.onMove(cell.x, cell.y);
      });
      c.addEventListener('pointermove', (e) => {
        const rect = c.getBoundingClientRect();
        const cell = this._toCell(e.clientX - rect.left, e.clientY - rect.top);
        const key = cell ? cell.x + ',' + cell.y : '';
        const prev = this.hover ? this.hover.x + ',' + this.hover.y : '';
        if (key === prev) return;
        this.hover = cell;
        this.draw();
      });
      c.addEventListener('pointerleave', () => {
        if (this.hover) {
          this.hover = null;
          this.draw();
        }
      });
      if (root.ResizeObserver) {
        new ResizeObserver(() => this._resize()).observe(c.parentElement);
      } else {
        root.addEventListener('resize', () => this._resize());
      }
    }

    // ---------- 绘制 ----------

    /** 绘制一颗棋子（scale 用于动画） */
    _drawStone(x, y, color, scale) {
      const { ctx } = this;
      const C = this.colors;
      const { cx, cy } = this._toPx(x, y);
      const r = this.cell * 0.43 * scale;
      if (r <= 0) return;
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r);
      if (color === 0) {
        g.addColorStop(0, C.blackHi);
        g.addColorStop(1, C.blackLo);
      } else {
        g.addColorStop(0, C.whiteHi);
        g.addColorStop(1, C.whiteLo);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      if (color === 0) {
        // 深色模式下给黑棋加浅描边，保证在深色棋盘上轮廓清晰
        ctx.strokeStyle = C.blackEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.strokeStyle = C.whiteEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    draw() {
      const { ctx, css, size, cell, pad } = this;
      const C = this.colors;
      if (!css) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // 底色：浅木色径向渐变（中心亮、边缘稍深，保留木质质感）
      const bgGrad = ctx.createRadialGradient(css / 2, css / 2, css * 0.08, css / 2, css / 2, css * 0.78);
      bgGrad.addColorStop(0, C.bgHi);
      bgGrad.addColorStop(1, C.bgLo);
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, css, css);

      // 网格线（黑色，1px 细线）
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < size; i++) {
        const p = pad + i * cell;
        ctx.moveTo(pad, p);
        ctx.lineTo(css - pad, p);
        ctx.moveTo(p, pad);
        ctx.lineTo(p, css - pad);
      }
      ctx.stroke();

      // 星位（黑色，加粗便于定位天元/星位）
      ctx.fillStyle = C.star;
      for (const [sx, sy] of starPoints(size)) {
        const { cx, cy } = this._toPx(sx, sy);
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.12, 0, Math.PI * 2);
        ctx.fill();
      }

      // 已落棋子
      if (this.board) {
        for (let x = 0; x < size; x++) {
          for (let y = 0; y < size; y++) {
            const v = this.board[x][y];
            if (v !== null) this._drawStone(x, y, v, 1);
          }
        }
      }

      // 落子动画（覆盖绘制）
      for (const a of this.anims) {
        const k = Math.min(1, (performance.now() - a.t0) / 150);
        const ease = 1 - Math.pow(1 - k, 3);
        this._drawStone(a.x, a.y, a.color, Math.max(0.05, ease));
      }

      // 最后一手标记
      if (this.lastMove && this.board && this.board[this.lastMove.x] && this.board[this.lastMove.x][this.lastMove.y] !== null) {
        const { cx, cy } = this._toPx(this.lastMove.x, this.lastMove.y);
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.14, 0, Math.PI * 2);
        ctx.fillStyle = C.marker;
        ctx.fill();
      }

      // 悬停预览（仅当可落子且格内为空；黑棋禁手点显示红色 ✕）
      if (this.hover && this.interactive && this.board) {
        const { x, y } = this.hover;
        if (this.board[x][y] === null) {
          const forbidden = this.forbiddenCheck && this.myColor === 0 && this._forbiddenAt(x, y);
          const { cx, cy } = this._toPx(x, y);
          if (forbidden) {
            // 禁手标记：红色 ✕
            const r = cell * 0.42;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(217, 56, 30, 0.18)';
            ctx.fill();
            ctx.strokeStyle = '#d9381e';
            ctx.lineWidth = Math.max(2, cell * 0.09);
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.55, cy - r * 0.55);
            ctx.lineTo(cx + r * 0.55, cy + r * 0.55);
            ctx.moveTo(cx + r * 0.55, cy - r * 0.55);
            ctx.lineTo(cx - r * 0.55, cy + r * 0.55);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.arc(cx, cy, cell * 0.43, 0, Math.PI * 2);
            ctx.fillStyle = C.ghost;
            ctx.fill();
          }
        }
      }

      // 待确认落子预览（双击确认模式：圆环 + 中心点，示意"再点一次确认"）
      if (this.pending && this.interactive && this.board &&
          this.board[this.pending.x] && this.board[this.pending.x][this.pending.y] === null) {
        const { cx, cy } = this._toPx(this.pending.x, this.pending.y);
        const ringColor = this.dark ? '#7fc7be' : '#2e6f6a';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.43, 0, Math.PI * 2);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = Math.max(2, cell * 0.08);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.1, 0, Math.PI * 2);
        ctx.fillStyle = ringColor;
        ctx.fill();
      }
    }

    /** 动画帧循环（驱动落子动画） */
    _loop() {
      if (this.anims.length) {
        this.anims = this.anims.filter((a) => performance.now() - a.t0 < 200);
        this.draw();
      }
      requestAnimationFrame(() => this._loop());
    }
  }

  root.BoardRenderer = BoardRenderer;
})(typeof window !== 'undefined' ? window : this);
