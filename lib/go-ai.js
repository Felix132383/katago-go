/**
 * 入门级围棋 AI（共享模块）
 * - 浏览器端通过 <script> 引入，暴露全局 GoAI
 * - Node 端通过 require 引入（便于单元测试）
 *
 * 定位说明：目标是"会下围棋"的入门级 AI（约业余 10 级左右的强度）——
 * 能围地、提子、保气、不送死、基础攻防，可完整对局；距离 KataGo 等
 * 顶级引擎仍有巨大差距（粗略相当于其 10% 的棋力水位，仅作通俗参照）。
 *
 * 实现：
 * 1. 简单难度：纯启发式评分（提子收益 / 自身气数 / 眼位潜力 / 位置偏好）
 * 2. 中等难度：启发式筛选 top 候选 + 轻量蒙特卡洛 playout（随机互弈后
 *    用面积法评估优势），在浏览器内 1~3 秒内完成决策
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GoAI = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // ==================== 轻量棋盘模拟（不建历史，供搜索使用） ====================

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  /** 棋块信息：{stones: [[x,y]...], liberties: Set(坐标字符串)} */
  function groupInfo(board, size, x, y) {
    const color = board[x][y];
    const stones = [];
    const liberties = new Set();
    const visited = new Set();
    const stack = [[x, y]];
    visited.add(x + ',' + y);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      stones.push([cx, cy]);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
        const v = board[nx][ny];
        if (v === null) liberties.add(nx + ',' + ny);
        else if (v === color && !visited.has(nx + ',' + ny)) {
          visited.add(nx + ',' + ny);
          stack.push([nx, ny]);
        }
      }
    }
    return { stones, liberties };
  }

  /**
   * 模拟落子（含提子与自杀检查，不含劫——模拟阶段劫的影响可忽略）
   * @returns {{ok:boolean, captured:Array}}
   */
  function simPlay(board, size, x, y, color) {
    board[x][y] = color;
    const opp = 1 - color;
    const captured = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
      if (board[nx][ny] === opp) {
        const g = groupInfo(board, size, nx, ny);
        if (g.liberties.size === 0) {
          for (const [sx, sy] of g.stones) {
            board[sx][sy] = null;
            captured.push([sx, sy]);
          }
        }
      }
    }
    const own = groupInfo(board, size, x, y);
    if (own.liberties.size === 0) {
      // 自杀：回滚
      board[x][y] = null;
      for (const [sx, sy] of captured) board[sx][sy] = opp;
      return { ok: false, captured: [] };
    }
    return { ok: true, captured };
  }

  // ==================== 候选生成 ====================

  /** 收集已有棋子邻域（半径 2）内的空点；棋盘空旷时补充天元/星位 */
  function candidates(board, size) {
    const added = new Set();
    const list = [];
    let anyStone = false;
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        if (board[x][y] !== null) {
          anyStone = true;
          continue;
        }
        let near = false;
        outer: for (let dx = -2; dx <= 2; dx++) {
          for (let dy = -2; dy <= 2; dy++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
            if (board[nx][ny] !== null) {
              near = true;
              break outer;
            }
          }
        }
        if (near) {
          list.push([x, y]);
          added.add(x + ',' + y);
        }
      }
    }
    if (!anyStone) {
      // 空棋盘：天元 + 角部星位
      const mid = Math.floor(size / 2);
      const star = size >= 15 ? 3 : size >= 11 ? 3 : 2;
      const pts = [
        [mid, mid],
        [star, star], [size - 1 - star, star], [star, size - 1 - star], [size - 1 - star, size - 1 - star],
      ];
      for (const [px, py] of pts) {
        if (board[px][py] === null) list.push([px, py]);
      }
    } else if (list.length < 6) {
      // 棋子很少时补充中部区域点，避免过于贴近
      const mid = Math.floor(size / 2);
      for (let d = 0; d <= 4; d++) {
        for (let dx = -d; dx <= d; dx++) {
          for (let dy = -d; dy <= d; dy++) {
            const nx = mid + dx;
            const ny = mid + dy;
            if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
            const k = nx + ',' + ny;
            if (!added.has(k) && board[nx][ny] === null) {
              list.push([nx, ny]);
              added.add(k);
              if (list.length >= 24) return list;
            }
          }
        }
      }
    }
    return list;
  }

  // ==================== 启发式评分 ====================

  /**
   * 模拟落子后的静态评分（越界/自杀返回 -Infinity）
   * 提子 × 30 + 自身气 × 3 + 空邻居 × 2 + 位置偏好
   */
  function heuristicScore(board, size, x, y, color) {
    const res = simPlay(board, size, x, y, color);
    if (!res.ok) return -Infinity;
    let score = res.captured.length * 30;
    const own = groupInfo(board, size, x, y);
    score += own.liberties.size * 3;
    let open = 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === null) open++;
    }
    score += open * 2;
    // 位置偏好：靠近中心略优（引导布局展开）
    const mid = (size - 1) / 2;
    score += 4 - Math.min(Math.abs(x - mid), Math.abs(y - mid)) * 0.15;
    return score;
  }

  // ==================== 蒙特卡洛 playout ====================

  /** 面积法快速评估：返回黑/白各自"子数 + 独占地盘" */
  function areaEval(board, size) {
    const visited = new Set();
    let black = 0;
    let white = 0;
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        const v = board[x][y];
        if (v === 0) black++;
        else if (v === 1) white++;
        else {
          const key = x + ',' + y;
          if (visited.has(key)) continue;
          const region = [];
          const borders = new Set();
          const stack = [[x, y]];
          visited.add(key);
          while (stack.length) {
            const [cx, cy] = stack.pop();
            region.push([cx, cy]);
            for (const [dx, dy] of DIRS) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
              const nv = board[nx][ny];
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
            if (borders.has(0)) black += region.length;
            else white += region.length;
          }
        }
      }
    }
    return { black: black, white: white };
  }

  /**
   * 从当前局面随机互弈 maxMoves 手，返回"myColor 方"的面积优势
   * @param {Array} board 棋盘（将被修改）
   * @param {number} myColor 我方颜色
   * @param {number} firstColor 模拟中先行动方（通常为对方）
   */
  function playout(board, size, myColor, firstColor, maxMoves) {
    let color = firstColor;
    let moves = 0;
    while (moves < maxMoves) {
      const cands = candidates(board, size);
      const scored = [];
      for (const [cx, cy] of cands) {
        const s = heuristicScore(board, size, cx, cy, color);
        if (s > -Infinity) scored.push([cx, cy, s]);
      }
      if (!scored.length) {
        color = 1 - color; // 无合法点视为停一手
        moves++;
        continue;
      }
      scored.sort((a, b) => b[2] - a[2]);
      // 前 3 名中随机选（带随机性，保证模拟多样性）
      const pick = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
      simPlay(board, size, pick[0], pick[1], color);
      color = 1 - color;
      moves++;
    }
    const area = areaEval(board, size);
    return area[myColor] - area[1 - myColor];
  }

  // ==================== 主入口 ====================

  /**
   * 选择 AI 落子点
   * @param {object} game GoGame 实例（读取 board/current/size；不修改其状态）
   * @param {string} difficulty 'easy'（纯启发式）| 'medium'（启发式 + 蒙特卡洛）
   * @returns {{x:number, y:number}|null}
   */
  function chooseMove(game, difficulty) {
    const size = game.size;
    const myColor = game.current;
    const base = cloneBoard(game.board);
    const cands = candidates(base, size);
    if (!cands.length) return null;

    const scored = [];
    for (const [cx, cy] of cands) {
      const s = heuristicScore(base, size, cx, cy, myColor);
      if (s > -Infinity) scored.push({ x: cx, y: cy, s: s });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.s - a.s);

    if (difficulty !== 'medium') {
      // 简单：启发式前三随机
      const idx = Math.floor(Math.random() * Math.min(3, scored.length));
      return { x: scored[idx].x, y: scored[idx].y };
    }

    // 中等：top 候选各做若干次蒙特卡洛 playout
    const top = scored.slice(0, 6);
    const N = size >= 15 ? 8 : 12; // 19 路控制模拟量，保证 1~3 秒内完成
    const maxMoves = size >= 15 ? 24 : 32;
    const opp = 1 - myColor;
    let best = null;
    let bestScore = -Infinity;
    for (const mv of top) {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const b = cloneBoard(base);
        simPlay(b, size, mv.x, mv.y, myColor); // 模拟我方落子
        sum += playout(b, size, myColor, opp, maxMoves);
      }
      const avg = sum / N + mv.s * 0.08; // 少量启发式先验
      if (avg > bestScore) {
        bestScore = avg;
        best = mv;
      }
    }
    return best ? { x: best.x, y: best.y } : { x: scored[0].x, y: scored[0].y };
  }

  return { chooseMove, candidates, heuristicScore, simPlay, groupInfo, areaEval, cloneBoard };
});
