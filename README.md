# 围棋 · KataGo 版（独立纯前端应用，免后端）

给 iOS 用户使用的围棋应用：**完全静态网页，独立项目，无需任何后端服务器**。
托管到任意静态站点（GitHub Pages / Cloudflare Pages / Netlify 等）即可使用，
iPhone Safari 打开后可选「添加到主屏幕」全屏运行。

> 本项目独立于「棋遇」在线对战平台。围棋规则与基础 AI 内置在 `lib/`，
> KataGo 强 AI 通过 **TensorFlow.js**（CDN 加载，无需编译）运行。

## 功能

- **人机对战**：内置基础 AI（简单 = 启发式，中等 = 启发式 + 蒙特卡洛），
  以及 **KataGo 强 AI**（TensorFlow.js 引擎，WebGPU/WASM/CPU 自动降级，未就绪自动降级中等 AI）
- **本地双人**：同一设备轮流落子
- **9 / 13 / 19 路**，执黑 / 执白 / 随机，单击或双击确认落子（防误触）
- 完整规则：提子、禁入点、打劫、贴目（19 路 7.5 目 / 小棋盘 5.5 目）
- 悔棋、停一手、认输、**提前数子**、重新开局
- **对局存档 + 复盘**：历史对局保存在本机（localStorage），随时回放
- KataGo 对局显示 AI 方实时**胜率**
- PWA：可添加到 iOS 主屏幕，独立窗口运行

## 本地运行 / 测试

```bash
npm start        # 启动本地静态服务器 → http://localhost:3000
npm test         # 浏览器冒烟测试（需本机 Chrome）
```

## 部署（免后端）

全部是静态文件，任何静态托管都能跑：

- **GitHub Pages**：把本目录内容推到仓库，仓库 Settings → Pages 开启即可
- **Cloudflare Pages / Netlify**：构建命令留空，发布目录填本目录

> 运行时依赖（TensorFlow.js 4.22.0、tfjs-backend-wasm/webgpu、pako）通过
> **jsdelivr CDN** 自动加载，无需本地文件。模型 `katago/model.bin.gz`（v8 格式）已随项目提供。
> 若网络无法访问 CDN，KataGo 档自动降级为内置中等 AI（应用启动时提示）。

## KataGo 引擎说明

- 引擎代码：`js/katago-engine/`（由 [Sir-Teo/web-katrain](https://github.com/Sir-Teo/web-katrain) 的 TS 源码转译，MIT）
- 重新构建：`node tools/build-engine.mjs`（Node 24 内置转译，无需安装工具）
- 模型：`katago/model.bin.gz`（web-katrain 自带小模型，KataGo v8 格式，3.8MB）；
  可替换为更强的 v8~16 模型（如 b18c384nbt，约 96MB），改名为 `model.bin.gz` 即可
- 详见 `katago/README.md`

## 目录结构

```
katago-go/
├── index.html            # 入口
├── manifest.webmanifest  # PWA 配置
├── icon.svg              # 图标
├── server.js             # 仅本地预览/测试用的静态服务器（零依赖；部署不需要）
├── css/style.css         # 移动端优先样式
├── js/
│   ├── app.js            # 对局逻辑 / 存档 / 复盘 / AI 调度
│   ├── board.js          # 棋盘渲染
│   ├── katago.js         # KataGo 客户端（module worker 管理 + 降级）
│   └── katago-engine/    # TF.js KataGo 引擎（web-katrain 转译，ESM）
├── lib/
│   ├── go-core.js        # 围棋规则引擎（提子/禁入点/打劫/数子）
│   └── go-ai.js          # 基础 AI（简单 = 启发式，中等 = 启发式 + 蒙特卡洛）
├── katago/               # KataGo 模型（model.bin.gz v8 格式，已就位）
├── web-katrain-reference/# web-katrain TS 参考源码（供重新构建引擎）
├── tools/build-engine.mjs# 引擎转译脚本
└── test/smoke.js         # 浏览器冒烟测试
```
