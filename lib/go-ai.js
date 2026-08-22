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
   * V1.2 增强（启发式强化）：
   *   提子 × 50（提高） + 自身气 × 4 + 救援被打吃的己方棋 × 30/块
   *   + 打吃对方 × 20/块 + 连接己方棋块 × 25 + 空邻居 × 2
   *   + 星位偏好 + 中心微偏好
   */
  function heuristicScore(board, size, x, y, color) {
    const opp = 1 - color;
    // 落子前：统计邻接己方/对方棋块的气数（救援/打吃评估）与己方棋块数（连接评估）
    let preOwnOneLib = 0; // 落子前邻接的"1 气"己方棋块数（被打吃）
    let preOppOneLib = 0; // 落子前邻接的"1 气"对方棋块数（可打吃）
    let ownClusters = 0;
    {
      const seen = new Set();
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
        const v = board[nx][ny];
        if (v === null) continue;
        const g = groupInfo(board, size, nx, ny);
        if (v === color) {
          if (g.liberties.size === 1) preOwnOneLib++;
          const key = g.stones[0][0] + ',' + g.stones[0][1];
          if (!seen.has('o' + key)) {
            seen.add('o' + key);
            ownClusters++;
          }
        } else if (g.liberties.size === 1) {
          preOppOneLib++;
        }
      }
    }
    // V1.2 修复：simPlay 会修改棋盘，全程在克隆棋盘上进行，避免污染调用方棋盘
    const sim = cloneBoard(board);
    const res = simPlay(sim, size, x, y, color);
    if (!res.ok) return -Infinity;
    let score = res.captured.length * 50; // 提子（权重提高）
    const own = groupInfo(sim, size, x, y);
    score += own.liberties.size * 4; // 自身气
    // 救援：救回被打吃的己方棋块（落子前 1 气且未被提 → 落子后气数恢复）
    score += preOwnOneLib * 30;
    // 打吃：使对方棋块进入 1 气状态
    score += preOppOneLib * 20;
    // 连接：落子连接两个及以上己方棋块（加强厚势）
    if (ownClusters >= 2) score += 25;
    let open = 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < size && ny >= 0 && ny < size && board[nx][ny] === null) open++;
    }
    score += open * 2;
    // 星位/角部偏好（引导布局）
    const star = size >= 15 ? 3 : size >= 11 ? 3 : 2;
    const onStar =
      (Math.abs(x - star) <= 1 || Math.abs(x - (size - 1 - star)) <= 1) &&
      (Math.abs(y - star) <= 1 || Math.abs(y - (size - 1 - star)) <= 1);
    if (onStar) score += 3;
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
      // 前 5 名加权随机选（V1.2：更多候选 + 权重偏向前列，模拟更贴近真实棋感）
      const topN = Math.min(5, scored.length);
      let pick;
      if (topN <= 1) {
        pick = scored[0];
      } else {
        const weights = [];
        let wSum = 0;
        for (let i = 0; i < topN; i++) {
          const w = topN - i; // 排名权重：第 1 名最可能被选
          weights.push(w);
          wSum += w;
        }
        let r = Math.random() * wSum;
        let idx = 0;
        for (let i = 0; i < topN; i++) {
          r -= weights[i];
          if (r <= 0) { idx = i; break; }
        }
        pick = scored[idx];
      }
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
      // 简单：80% 最优 / 20% 次优（V1.2：保留新手感但不再明显让棋）
      const r = Math.random();
      const idx = r < 0.8 ? 0 : 1;
      return { x: scored[Math.min(idx, scored.length - 1)].x, y: scored[Math.min(idx, scored.length - 1)].y };
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
