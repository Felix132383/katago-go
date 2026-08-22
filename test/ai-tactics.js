/**
 * go-ai 增强验证：救援 / 打吃 / 不送死（GoGame 轮流制）
 */
'use strict';
const GoAI = require('../lib/go-ai.js');
const { GoGame } = require('../lib/go-core.js');

const size = 9;
function game(moves) {
  // moves: [x, y] 轮流（黑→白→黑…）
  const g = new GoGame(size);
  for (const [x, y] of moves) g.play(x, y);
  return g;
}
let pass = 0, fail = 0;
const check = (ok, tag) => { if (ok) { pass++; console.log('  ✔ ' + tag); } else { fail++; console.error('  ✘ ' + tag); } };

// 1. 救援：黑 (4,4) 被白围三面 → 1 气，轮到黑应下气点 (4,5) 救棋
{
  const g = game([[4, 4], [4, 3], [5, 5], [3, 4], [4, 2], [5, 4]]);
  // 黑(4,4)(5,5)(4,2)，白(4,3)(3,4)(5,4)。黑 (4,4) 邻 (4,3)白(3,4)白(5,4)白(4,5)空 → 1 气
  const mv = GoAI.chooseMove(g, 'medium');
  const rescue = mv && mv.x === 4 && mv.y === 5;
  check(!!rescue, '救援：1 气黑棋被围，AI 落 ' + (mv ? mv.x + ',' + mv.y : '无') + '（期望 4,5）');
}
// 2. 打吃：黑 (4,4)(4,5) 被白围 → 1 气 (4,6)，轮到白应下 (4,6) 提黑
{
  const board = Array.from({ length: size }, () => Array(size).fill(null));
  for (const [x, y, c] of [[4, 4, 0], [4, 5, 0], [3, 4, 1], [5, 4, 1], [4, 3, 1], [3, 5, 1], [5, 5, 1]]) board[x][y] = c;
  const g = { size: size, current: 1, board: board }; // 轮到白
  const mv = GoAI.chooseMove(g, 'medium');
  const atari = mv && mv.x === 4 && mv.y === 6;
  check(!!atari, '打吃：黑两子 1 气，AI 落 ' + (mv ? mv.x + ',' + mv.y : '无') + '（期望 4,6 提黑）');
}
// 2b. 救援（fakeGame）：黑 (4,4) 1 气，轮到黑应下 (4,5)
{
  const board = Array.from({ length: size }, () => Array(size).fill(null));
  for (const [x, y, c] of [[4, 4, 0], [4, 3, 1], [3, 4, 1], [5, 4, 1]]) board[x][y] = c;
  const g = { size: size, current: 0, board: board }; // 轮到黑
  const mv = GoAI.chooseMove(g, 'medium');
  check(!!(mv && mv.x === 4 && mv.y === 5), '救援（fakeGame）：AI 落 ' + (mv ? mv.x + ',' + mv.y : '无') + '（期望 4,5）');
}
// 3. 不送死：AI 不选自杀点 (0,0)
{
  const g = game([[0, 0], [1, 0], [0, 1]]);
  // 白 (1,0)(0,1) 围黑 (0,0) 角 → 黑 1 气 (1,1)。轮到黑
  const mv = GoAI.chooseMove(g, 'medium');
  const suicide = mv && mv.x === 0 && mv.y === 0;
  check(!suicide, '不送死：自杀点 (0,0) 不被选（落 ' + (mv ? mv.x + ',' + mv.y : '无') + '）');
}
// 4. 简单难度可正常对局
{
  const g = game([[4, 4]]);
  const mv = GoAI.chooseMove(g, 'easy');
  check(!!mv && g.board[mv.x][mv.y] === null, '简单难度正常落子（' + (mv ? mv.x + ',' + mv.y : '无') + '）');
}
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
