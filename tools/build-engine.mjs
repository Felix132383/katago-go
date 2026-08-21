/**
 * 构建脚本：把 web-katrain 的 TypeScript 引擎转译为浏览器可用的 ESM JS
 * - 用 Node 24 内置 stripTypeScriptTypes(mode:'transform') 转译（无需安装任何工具）
 * - 裸包 import（@tensorflow/tfjs 等）改为 jsdelivr CDN +esm
 * - 相对 import 补 .js 扩展名（浏览器原生 ESM 要求）
 * - 自补 web-katrain 缺失的 utils（publicUrl / animationFrame）
 * - worker.ts 的 setWasmPaths 指向 CDN 的 tfjs-backend-wasm 目录
 *
 * 运行：node tools/build-engine.mjs
 */
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, '..', 'web-katrain-reference', 'engine-katago');
const OUT = join(ROOT, '..', 'js', 'katago-engine');

/** TF.js / pako 统一打入本地 bundle（lib/tfjs/tfjs-bundle.js，esbuild 构建产物） */
const BUNDLE_SPEC = '../../lib/tfjs/tfjs-bundle.js';

const WASM_DIR_URL = null; // 不再用 CDN；wasm 与 worker 同目录 + setWasmPaths 绝对化

/** 重写单个 import 语句：裸包 → 本地 bundle；相对路径补 .js */
function rewriteImport(stmt) {
  const m = stmt.match(/^(import\s+.*?\s+from\s+)(['"])(.+?)\2|^(import\s+)(['"])(.+?)\5/);
  if (!m) return stmt;
  const spec = m[3] || m[6];
  let newStmt = stmt;

  if (spec === '@tensorflow/tfjs' && /import\s+\*\s+as\s+tf\b/.test(stmt)) {
    // import * as tf from '@tensorflow/tfjs' -> import { tf } from bundle
    newStmt = `import { tf } from '${BUNDLE_SPEC}';`;
  } else if (spec === '@tensorflow/tfjs-backend-wasm' && /import\s*\{/.test(stmt)) {
    // import { setThreadsCount, setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
    newStmt = stmt.replace(/['"][^'"]+['"]/, `'${BUNDLE_SPEC}'`);
  } else if (spec === 'pako') {
    // import pako from 'pako' -> import { pako } from bundle
    newStmt = `import { pako } from '${BUNDLE_SPEC}';`;
  } else if (spec === '@tensorflow/tfjs-backend-webgpu' || spec === '@tensorflow/tfjs-backend-wasm') {
    // 副作用 import：bundle 已包含 webgpu/wasm 后端注册
    newStmt = '';
  } else if (spec.startsWith('../../utils/')) {
    newStmt = stmt.replace(/['"][^'"]+['"]/, `'./utils/${spec.slice('../../utils/'.length)}.js'`);
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    if (!spec.endsWith('.js') && !spec.endsWith('.mjs')) {
      newStmt = stmt.replace(/['"][^'"]+['"]/, `'${spec}.js'`);
    }
  }
  return newStmt;
}

function transformFile(rel) {
  const srcPath = join(SRC, rel);
  const src = readFileSync(srcPath, 'utf8');
  let js;
  try {
    js = stripTypeScriptTypes(src, { mode: 'transform' });
  } catch (e) {
    throw new Error(`转译失败 ${rel}: ${e.message}`);
  }
  // 逐行重写 import（import type 已被 transform 移除）
  const lines = js.split('\n').map((line) => {
    const t = line.trim();
    if (t.startsWith('import ') || t.startsWith('import\t')) {
      if (t.includes('import type')) return ''; // 保险：残留的 import type 删除
      return rewriteImport(line);
    }
    return line;
  });
  js = lines.join('\n');

  // worker.ts 特殊处理：setWasmPaths 指向本地 wasm 目录（绝对化，跨部署子路径稳定）
  if (rel === 'worker.ts') {
    js = js
      .split('\n')
      .map((line) =>
        line.includes('setWasmPaths(')
          ? `    setWasmPaths(new URL('../../lib/tfjs/', import.meta.url).href);`
          : line
      )
      .join('\n');
    // 保留 worker-started 调试消息（import 完成后立即发出，便于定位加载耗时）
    if (!js.includes('worker-started')) {
      js = js.replace('let model = null;', "self.postMessage({ type: 'debug', step: 'worker-started' });\nlet model = null;");
    }
    // 移除 publicUrl import（不再需要）
    js = js.replace(/import\s*\{[^}]*publicUrl[^}]*\}\s*from\s*'[^']*';\n?/g, '');
  }
  return js;
}

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'utils'), { recursive: true });

const files = [
  'analyzeMcts.ts', 'backendFallback.ts', 'binModelParser.ts', 'evalV8.ts',
  'fastBoard.ts', 'featuresV7.ts', 'featuresV7Fast.ts', 'limits.ts',
  'loadModelV8.ts', 'modelDefaults.ts', 'modelV8.ts', 'positionInputsV7.ts',
  'scoreValue.ts', 'searchParams.ts', 'types.ts', 'worker.ts',
];
for (const f of files) {
  const outName = f.replace(/\.ts$/, '.js');
  const js = transformFile(f);
  writeFileSync(join(OUT, outName), js);
  console.log(`  ✓ ${outName}`);
}

// 自补 utils 模块
writeFileSync(
  join(OUT, 'utils', 'publicUrl.js'),
  "// 自补模块：web-katrain 的 publicUrl（Vite BASE_URL）。纯静态根部署原样返回。\nexport function publicUrl(p) { return p; }\n"
);
writeFileSync(
  join(OUT, 'utils', 'animationFrame.js'),
  "// 自补模块：web-katrain 的 getAnimationNow。\nexport function getAnimationNow() { return performance.now(); }\n"
);
writeFileSync(
  join(OUT, 'utils', 'gameLogic.js'),
  "// 自补模块：web-katrain 缺失的 utils/gameLogic（featuresV7 依赖）。\nexport function getOpponent(player) {\n  return player === 'black' ? 'white' : 'black';\n}\n"
);
console.log('  ✓ utils/publicUrl.js / animationFrame.js / gameLogic.js');

// 复制 TF.js WASM 二进制到 worker 同目录（tfjs 默认相对 worker 找 wasm + setWasmPaths 双保险）
const wasmSrc = join(ROOT, '..', 'lib', 'tfjs');
for (const f of ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm', 'tfjs-backend-wasm-threaded-simd.wasm']) {
  const srcFile = join(wasmSrc, f);
  if (existsSync(srcFile)) {
    writeFileSync(join(OUT, f), readFileSync(srcFile));
    console.log('  ✓ ' + f);
  }
}

console.log('\n引擎已转译到 js/katago-engine/（共 ' + files.length + ' 个文件 + utils + wasm）');
