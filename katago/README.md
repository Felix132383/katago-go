# KataGo 引擎配置（TensorFlow.js 版）

本应用通过 **TensorFlow.js**（非 WASM 编译版）运行 KataGo 引擎，参考
[Sir-Teo/web-katrain](https://github.com/Sir-Teo/web-katrain) 的实现：
- 引擎代码位于 `js/katago-engine/`（由 web-katrain 的 TypeScript 源码转译而来，见 `tools/build-engine.mjs`）
- TF.js 运行时与 WASM 后端通过 **CDN（jsdelivr）** 加载，无需编译、无需后端
- 模型为 **KataGo 原始格式（v8~v16）**，浏览器端解析并构建网络

## 当前状态

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `model.bin.gz` | ✅ **已就位** | web-katrain 自带小模型（3.8MB，KataGo v8 格式，已验证 gzip 可解压） |
| `model-v7.bin.gz` | 存档 | 旧 b6c96（v7）——**引擎不支持 v7**，仅留档 |
| `js/katago-engine/` | ✅ 已转译 | web-katrain 引擎 16 个文件 + utils（ESM，语法已校验） |

## 运行依赖（CDN，浏览器自动加载）

| 依赖 | CDN |
| --- | --- |
| @tensorflow/tfjs 4.22.0 | `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/+esm` |
| @tensorflow/tfjs-backend-wasm 4.22.0 | 同上（含 wasm 文件，自动从 jsdelivr 加载） |
| @tensorflow/tfjs-backend-webgpu 4.22.0 | 同上 |
| pako 2.1.0 | `https://cdn.jsdelivr.net/npm/pako@2.1.0/+esm` |

后端选择：**WebGPU → WASM → CPU** 自动降级（worker 内处理）。
WebGPU 需要 iOS 17.4+ / Safari 26+；WASM 单线程在 iPhone 上可用但较慢。

## 模型要求

- 只支持 **KataGo 模型版本 8 ~ 16**（旧 v7 模型如 b6c96 无法解析）
- 推荐模型：`kata1-b18c384nbt-...bin.gz`（约 96MB，更强更慢）
  —— 下载后改名为 `model.bin.gz` 覆盖即可
- 模型格式：KataGo 原始 `.bin` / `.gz` / `.bin.gz`，浏览器端自动解压解析

## 远程引擎地址（可选）

支持从远程加载模型目录（需 CORS）：
- 控制台：`localStorage.setItem('katago.engineUrl', 'https://.../katago/'); location.reload();`
- 或 URL 参数：`?engine=https://.../katago/`

## 验证

1. 打开应用，设置页底部显示「⚡ KataGo 引擎就绪（TensorFlow.js · 后端）」
2. 选「人机对战 → KataGo ⚡」开局，AI 落子时玩家卡显示实时胜率
3. 若提示「引擎加载失败」，多为 CDN（jsdelivr）网络不通；可稍后重试或检查网络

## 重新构建引擎（修改参考代码后）

```bash
node tools/build-engine.mjs
```
（使用 Node 24 内置 TS 转译，无需安装任何工具）
