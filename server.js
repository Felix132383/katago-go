/**
 * 围棋 KataGo 版 —— 本地预览/测试静态服务器（零依赖）
 * 纯静态应用，部署到任意静态托管（GitHub Pages 等）即可，无需本服务。
 *
 * 启动：npm start（或 node server.js），默认端口 3000，PORT 环境变量可覆盖
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
};

function handler(req, res) {
  let p;
  try {
    p = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400); res.end(); return;
  }
  if (p === '/') p = '/index.html';
  if (p === '/favicon.ico') p = '/icon.svg'; // 浏览器自动请求，映射到应用图标
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('\n  ⚫ 围棋 KataGo 版已启动（纯前端，免后端）');
    console.log('  ➜ 本地访问: http://localhost:' + PORT + '\n');
  });
}

module.exports = { server };
