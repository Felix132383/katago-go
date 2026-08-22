/**
 * 调试 go-ai 救援评分
 */
'use strict';
const GoAI = require('../lib/go-ai.js');
const { GoGame } = require('../lib/go-core.js');

const size = 9;
function game(moves) {
  const g = new GoGame(size);
  for (const [x, y, c] of moves) g.play(x, y, c);
  return g;
}
// 救援场景：黑 (4,4) 被白围 → 1 气，气点 (4,5)
const g = game([[4, 4, 0], [4, 3, 1], [3, 4, 1], [5, 4, 1]]);
for (const [x, y] of [[4, 5], [6, 4], [4, 2], [3, 3]]) {
  const s = GoAI.heuristicScore(g.board, size, x, y, 0);
  console.log('落', x + ',' + y, '黑评分:', s === -Infinity ? '-Infinity' : s);
}
// 打吃场景：黑 (4,4)(4,5)，白 (3,4)(5,4)(4,3) → 黑 1 气 (4,6)
const g2 = game([[4, 4, 0], [4, 5, 0], [3, 4, 1], [5, 4, 1], [4, 3, 1]]);
for (const [x, y] of [[4, 6], [5, 3], [3, 3]]) {
  const s = GoAI.heuristicScore(g2.board, size, x, y, 1);
  console.log('落', x + ',' + y, '白评分:', s === -Infinity ? '-Infinity' : s);
}
process.exit(0);
