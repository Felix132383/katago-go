/**
 * 围棋核心逻辑（共享模块，简化规则）
 * - 浏览器端通过 <script> 引入，暴露全局 GoCore
 * - Node 端通过 require 引入（服务端权威校验 + 单元测试）
 *
 * 规则说明（MVP 简化版）：
 * 1. 提子：落子后，先移除四周无气的对方棋块，再检查自身（禁入点/自杀判定）
 * 2. 打劫：采用简化劫规则——禁止落子后棋盘与“对方上一手之前”的局面完全相同
 * 3. 结束：双方连续停一手（pass）后结束，按中国规则数子（面积法）判胜负
 * 4. 贴目：19 路贴 3.75 子（7.5 目），9/13 路简化贴 2.75 子（5.5 目）
 *
 * 棋盘坐标：x 为列（0 ~ size-1），y 为行（0 ~ size-1）
 * 棋盘数值：null=空，0=黑棋，1=白棋
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GoCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 深拷贝棋盘 */
  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  /** 两块棋盘是否完全相同（用于劫规则判定） */
  function boardsEqual(a, b, size) {
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        if (a[x][y] !== b[x][y]) return false;
      }
    }
    return true;
  }

  /** 围棋对局类 */
  class GoGame {
    constructor(size) {
      this.size = size || 19;
      this.board = Array.from({ length: this.size }, () => Array(this.size).fill(null));
      this.current = 0; // 0=黑 1=白
      this.history = []; // [{x,y,color,captured,snapshot,passCountBefore,pass}]
      this.lastMove = null; // {x,y} 或 null（上一手是停一手）
      this.lastWasPass = false;
      this.passCount = 0; // 连续停一手计数
      this.captures = [0, 0]; // 双方提子数
      this.winner = null;
      this.reason = '';
      this.score = null; // 数子结果
    }

    /** 返回 (x, y) 的四邻居坐标 */
    neighbors(x, y) {
      const list = [];
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < this.size && ny >= 0 && ny < this.size) list.push([nx, ny]);
      }
      return list;
    }

    /**
     * 获取包含 (x, y) 的棋块
     * @returns {{stones: Array, liberties: Set}} stones 为该棋块所有棋子，liberties 为气（去重坐标字符串）
     */
    getGroup(x, y) {
      const color = this.board[x][y];
      const stones = [];
      const liberties = new Set();
      const visited = new Set();
      const stack = [[x, y]];
      visited.add(x + ',' + y);
      while (stack.length) {
        const [cx, cy] = stack.pop();
        stones.push([cx, cy]);
        for (const [nx, ny] of this.neighbors(cx, cy)) {
          const v = this.board[nx][ny];
          if (v === null) {
            liberties.add(nx + ',' + ny);
          } else if (v === color && !visited.has(nx + ',' + ny)) {
            visited.add(nx + ',' + ny);
            stack.push([nx, ny]);
          }
        }
      }
      return { stones, liberties };
    }

    /**
     * 落子（当前执子方）
     * @returns {{ok:boolean, error?:string, captured?:Array}}
     */
    play(x, y) {
      if (this.winner !== null) return { ok: false, error: '对局已结束' };
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= this.size || y < 0 || y >= this.size) {
        return { ok: false, error: '落子坐标越界' };
      }
      if (this.board[x][y] !== null) return { ok: false, error: '此处已有棋子' };

      const color = this.current;
      const opp = 1 - color;
      const passCountBefore = this.passCount;
      // 记录落子前的局面快照（悔棋与劫规则都依赖它）
      const snapshot = cloneBoard(this.board);

      // 1. 暂时落子
      this.board[x][y] = color;

      // 2. 提掉四周无气的对方棋块
      const captured = [];
      for (const [nx, ny] of this.neighbors(x, y)) {
        if (this.board[nx][ny] === opp) {
          const g = this.getGroup(nx, ny);
          if (g.liberties.size === 0) {
            for (const [sx, sy] of g.stones) {
              this.board[sx][sy] = null;
              captured.push([sx, sy]);
            }
          }
        }
      }

      // 3. 自杀判定：自身棋块无气则非法，回滚
      const own = this.getGroup(x, y);
      if (own.liberties.size === 0) {
        this.board[x][y] = null;
        for (const [sx, sy] of captured) this.board[sx][sy] = opp;
        return { ok: false, error: '禁入点（自杀）' };
      }

      // 4. 简化劫判定：落子后局面不得与"对方最后一手（提劫手）之前"的局面相同。
      //    即比较 history[len-1].snapshot（最后一手落子前的完整局面）
      if (this.history.length >= 1) {
        const prevSnapshot = this.history[this.history.length - 1].snapshot;
        if (boardsEqual(this.board, prevSnapshot, this.size)) {
          this.board[x][y] = null;
          for (const [sx, sy] of captured) this.board[sx][sy] = opp;
          return { ok: false, error: '违反打劫规则' };
        }
      }

      // 5. 提交
      this.captures[color] += captured.length;
      this.passCount = 0;
      this.lastWasPass = false;
      this.lastMove = { x, y };
      this.history.push({
        x, y, color, captured,
        snapshot,
        passCountBefore,
        pass: false,
      });
      this.current = opp;
      return { ok: true, captured };
    }

    /** 停一手（pass） */
    pass() {
      if (this.winner !== null) return { ok: false, error: '对局已结束' };
      const color = this.current;
      const passCountBefore = this.passCount;
      this.passCount++;
      this.lastWasPass = true;
      this.lastMove = null;
      this.history.push({
        color,
        captured: [],
        snapshot: cloneBoard(this.board),
        passCountBefore,
        pass: true,
      });
      if (this.passCount >= 2) {
        // 双方连续停一手：按数子规则结束
        this.endByScore();
      } else {
        this.current = 1 - color;
      }
      return { ok: true, over: this.winner !== null, passCount: this.passCount };
    }

    /**
     * 数子（面积法）：
     * 对每个空白区域做洪泛填充，若区域只邻接黑棋则算黑地，只邻接白棋则算白地，否则为公共单官（不计）
     */
    computeScore() {
      const size = this.size;
      const visited = new Set();
      let blackStones = 0;
      let whiteStones = 0;
      let blackTerr = 0;
      let whiteTerr = 0;
      let neutral = 0;

      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          const v = this.board[x][y];
          if (v === 0) blackStones++;
          else if (v === 1) whiteStones++;
          else {
            const key = x + ',' + y;
            if (visited.has(key)) continue;
            // 洪泛填充空白区域
            const region = [];
            const borders = new Set();
            const stack = [[x, y]];
            visited.add(key);
            while (stack.length) {
              const [cx, cy] = stack.pop();
              region.push([cx, cy]);
              for (const [nx, ny] of this.neighbors(cx, cy)) {
                const nv = this.board[nx][ny];
                if (nv === null) {
                  const nk = nx + ',' + ny;
                  if (!visited.has(nk)) {
                    visited.add(nk);
                    stack.push([nx, ny]);
                  }
                } else {
                  borders.add(nv);
                }
              }
            }
            if (borders.size === 1) {
              if (borders.has(0)) blackTerr += region.length;
              else whiteTerr += region.length;
            } else {
              neutral += region.length;
            }
          }
        }
      }
      return { blackStones, whiteStones, blackTerr, whiteTerr, neutral };
    }

    /** 双方停一手后数子判胜负 */
    endByScore() {
      const size = this.size;
      const s = this.computeScore();
      // 贴目：19 路贴 3.75 子（7.5 目），小棋盘简化贴 2.75 子（5.5 目）
      const komi = size >= 15 ? 3.75 : 2.75;
      const blackTotal = s.blackStones + s.blackTerr;
      const whiteTotal = s.whiteStones + s.whiteTerr + komi;
      const diff = blackTotal - whiteTotal;

      this.score = {
        ...s,
        komi,
        blackTotal: Math.round(blackTotal * 100) / 100,
        whiteTotal: Math.round(whiteTotal * 100) / 100,
        diff: Math.round(diff * 100) / 100,
        komiMu: Math.round(komi * 2 * 10) / 10, // 换算成“目”便于展示
      };
      this.winner = Math.abs(diff) < 1e-9 ? -1 : diff > 0 ? 0 : 1;
      this.reason = '双方停一手，数子定胜负';
    }

    /** 悔棋：撤销最后一手（落子或停一手） */
    undo() {
      if (!this.history.length) return { ok: false, error: '没有可悔的棋' };
      const last = this.history.pop();
      // 恢复上一步的完整局面
      this.board = cloneBoard(last.snapshot);
      this.passCount = last.passCountBefore;
      this.current = last.color;
      if (!last.pass) {
        this.captures[last.color] = Math.max(0, this.captures[last.color] - last.captured.length);
      }
      const prev = this.history[this.history.length - 1];
      if (prev && !prev.pass) {
        this.lastMove = { x: prev.x, y: prev.y };
        this.lastWasPass = false;
      } else {
        this.lastMove = null;
        this.lastWasPass = true;
      }
      // 若此前因停一手已判胜负，悔棋后重新开放对局
      if (this.winner !== null && this.reason === '双方停一手，数子定胜负') {
        this.winner = null;
        this.reason = '';
        this.score = null;
      }
      return { ok: true };
    }

    /** 序列化给客户端的状态快照 */
    state() {
      return {
        board: this.board,
        current: this.current,
        lastMove: this.lastMove,
        winner: this.winner,
        reason: this.reason,
        score: this.score,
        moveNumber: this.history.length,
        historyLen: this.history.length,
        captures: this.captures,
        passCount: this.passCount,
        lastWasPass: this.lastWasPass,
        replay: this.history.map((h) => (h.pass ? { pass: true, color: h.color } : { x: h.x, y: h.y, color: h.color })),
      };
    }
  }

  return { GoGame, cloneBoard, boardsEqual };
});
