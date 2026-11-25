# Antigravity4Lark

**用飞书 / Lark 随时随地双向对话、巡检并统筹本机所有 Google Antigravity 桌面端智能体。**

无需公网服务器、无需内网穿透、**零第三方 npm 依赖**。本项目结合 **SQLite 本地会话状态**、**JSONL 完整对话日志**、**内置 `agentapi`**、**Electron CDP (`:9223`)** 以及飞书官方 CLI（`lark-cli`）的长连接总线，将你的飞书变成 **Google Antigravity「总控中心 + 多工作区多会话」全自动移动指挥台**。

---

## 为什么 Antigravity4Lark 和 Cursor 连飞书的架构很不一样？

虽然灵感同样源自 [Feishu_Agent_for_Cursor](https://github.com/Keffee/Feishu_Agent_for_Cursor)，但 **Google Antigravity 2.0 桌面端** 与 **Cursor IDE** 的底层机制存在本质差异，因此本项目没有照搬纯 DOM 爬虫，而是采用了更稳健的 **混合双通道架构（SQLite + Transcript + `agentapi` + 精准 CDP）**：

| 维度 | Cursor 飞书桥（纯 CDP DOM 模式） | Antigravity4Lark（混合双通道模式） |
| --- | --- | --- |
| **会话发现与状态监控** | 依赖 CDP 遍历虚拟侧边栏 DOM 与停止图标，易受前端改版与虚拟列表未挂载影响 | 直接用 Node 原生 `node:sqlite` 只读 `~/.gemini/antigravity/conversation_summaries.db`，天然区分顶层会话、Swarm 子智能体、`isTurnRunning` 与 `not_fully_idle` |
| **回复与提问提取** | 抓取聊天面板 DOM 节点（长回复易被虚拟滚动截断） | 直接解析 `transcript.jsonl` + `transcript_full.jsonl`（按 `step_index` 自动回溯 `truncated_fields`），并完整解析 `ask_question` 结构化问题与选项 |
| **外部消息下发** | 通过 CDP `:9222` 注入输入框 | **双通道**：外部飞书守护进程经严格过滤后的 CDP `:9223`（仅匹配 `127.0.0.1` Antigravity 主界面，忽略内置浏览器网页标签，按 `a[href*="/c/<id>"]` 跨项目直达并注入 `[aria-label="Message input"]`）；总控会话内部调 `ag-ctl.mjs` 同项目优先走原生 `agentapi`，跨项目权限受限时自动回退 CDP `:9223` |
| **后台定时器与噪声抑制** | 无后台 `schedule` 定时器概念 | 深度适配 Antigravity 的异步后台任务与 `schedule` 定时器机制：自动过滤后台工具假阳性等待、静默例行定时巡检、**决策问询自动穿透**、同轮多段正文自动合并、过滤运行中可自愈的工具报错 |
| **多桥共享同一飞书机器人** | 作为无前缀默认兜底 | 严格使用 `#ag` / `@ag` / `#agy` / `#antigravity` 前缀与 `【AG · Antigravity】` 标识，支持与 Cursor / Codex / Kimi 桥接共享同一 `lark-cli` `_bus` 长连接且互不串线 |

---

## 整体架构

```text
飞书 / Lark 客户端
   │
   ▼ (唯一 WebSocket 长连接)
lark-cli event _bus (本地 bus.sock 广播 fan-out，零丢包)
   └── Antigravity4Lark (feishu.mjs · LaunchAgent 常驻)
          ├── [只读会话状态] node:sqlite ──> ~/.gemini/antigravity/conversation_summaries.db
          ├── [完整内容解析] transcript.jsonl + transcript_full.jsonl (truncated_fields 自动回溯)
          ├── [智能监控推送] AntigravityWatcher (2s 轮询 · 防刷屏 · 决策穿透 · ask_question 展开 · 同轮合并)
          ├── [外部消息注入] Electron CDP (127.0.0.1:9223) ──> Antigravity 主界面 (忽略内置网页标签)
          ├── [内部同项目调度] ~/.gemini/antigravity/bin/agentapi (供总控在终端调用 ag-ctl.mjs)
          ├── [本地状态与 IPC] ~/.antigravity-feishu/state.json (0600) + bridge.sock (0600)
          └── [一键自愈/启动] #ag 重启cdp + start-antigravity.sh + Antigravity CDP.app
```

---

## 核心特性

### 1. 总控中心 + 跨工作区多会话调度
- 支持锁定一个常驻会话作为 **👑 总控中心**（通过 `AG_DEFAULT_CONVERSATION_ID` 或 `#ag 默认 <编号>` 持久化）。
- 在飞书发送 `#ag 你的需求`（不指定 `@N` 且不引用其他子会话）时，自动注入 `[飞书 → Antigravity 总控]` 路由上下文交给总控思考处理；总控可随时调用本地 `node ag-ctl.mjs list|read|send|new|status` 跨工作区查看、统筹或向其他 Antigravity 对话分发任务。
- 发送 `#ag @N 内容` 或 **左滑引用回复**任意会话的通知卡片，消息 100% 原文直达目标会话。

### 2. 智能防打扰监控（针对 Antigravity 深度打磨）
- **后台定时器防刷屏**：识别 `schedule` 定时器与后台异步 `run_command` 产生的过渡句，例行巡检静默不打扰；
- **用户直问必达**：只要回复是在直接回答你刚发出的显式消息（如“汇报进度”），即使模型顺手挂了下次 `schedule` 定时器，依然立即推送；
- **关键决策自动穿透**：后台定时循环中一旦正文出现明显决策请求（如 `请确认`、`方案 A / 方案 B`、`请选择`、`是否继续` 等），立即穿透推送到飞书，方便手机左滑引用拍板；
- **`ask_question` 完整展开**：自动解析结构化提问与全部编号选项并清晰渲染到飞书卡片；
- **同轮正文防吞合并**：当长回复刚生成完毕、后台任务结束消息紧接着触发一行补充附注时，自动合并同轮所有未推送的有效正文一起发出，绝不吞掉主回复；
- **过滤可自愈的瞬时报错**：智能体运行中出现可自动重试的工具报错（如 `edit_file` 文本不匹配）不误报，仅在轮次真正中止于致命异常时推送告警。

### 3. 零依赖 & 一键运维
- **零第三方 npm 依赖**：直接基于 Node.js `>= 22`（推荐 `v24+`）内置的 `node:sqlite`、`WebSocket`、`fetch`、`node:test`。
- **飞书一键重启 CDP**：Antigravity 自动升级重启丢失 `:9223` 后，人在外面直接在飞书发 `#ag 重启cdp` 即可远程补开并在就绪后收到通知。
- **macOS 快捷启动器**：运行 `./install-launcher.sh` 生成 `~/Applications/Antigravity CDP.app`（支持 Spotlight / Raycast / Dock）：`:9223` 在线时仅切前台绝不误重启，未开时自动带端口启动。

---

## 环境要求

- **操作系统**：macOS（内置 `LaunchAgent` 后台常驻与 `.app` 快捷启动器脚本）
- **Node.js**：`>= 22.5`（需支持内置 `node:sqlite` 与原生 `WebSocket`，推荐 Node `v24+`）
- **Google Antigravity 桌面端**：`/Applications/Antigravity.app`
- **飞书官方 CLI (`lark-cli`)**：已安装并完成机器人登录配置（参考 [larksuite/cli](https://github.com/larksuite/cli)）

---

## 快速上手

### 第 1 步：克隆仓库

```bash
git clone https://github.com/Keffee/Antigravity4Lark.git
cd Antigravity4Lark
```

### 第 2 步：配置 `.env`

```bash
cp .env.example .env
```

编辑 `.env`（已被 `.gitignore` 忽略，不会被提交到 Git）：

```ini
# 必填：你的飞书 open_id（留空先跑 npm start 并给机器人发 `#ag 帮助`，终端会打印你的 open_id）
FEISHU_OPEN_ID=ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 可选：锁定某个会话 UUID 作为默认总控（也可在飞书用 `#ag 默认 1` 动态设置）
AG_DEFAULT_CONVERSATION_ID=

# 可选：主动推送模式 all（默认全量）| bound（仅总控及绑定会话）| off
AG_PUSH_MODE=all

# 可选：Electron CDP 端口（默认 9223，避开 Cursor 的 9222）
AG_CDP_URL=http://127.0.0.1:9223
```

### 第 3 步：带 CDP 端口启动 Antigravity（`:9223`）

```bash
./start-antigravity.sh
```

> 推荐顺手安装 macOS 快捷启动器，之后从 Spotlight / Raycast / Dock 打开 **Antigravity CDP** 即可永远自带 `:9223`（已在线时只切窗口，绝不打断运行中的会话）：
> ```bash
> ./install-launcher.sh
> ```

### 第 4 步：启动后台服务

```bash
# 前台调试运行
npm start

# 安装为 macOS 开机自启后台服务（com.antigravity-feishu.bridge）
./service.sh install
./service.sh status
./service.sh logs
./service.sh restart
./service.sh uninstall
```

---

## 飞书指令参考

支持前缀 `#ag`、`@ag`、`#agy`、`@agy`、`#antigravity`、`@antigravity`；**左滑引用回复**任意带 `【AG · Antigravity】` 标识的消息时无需前缀即可续聊对应会话。

| 飞书指令 | 说明 |
| --- | --- |
| `#ag` / `#ag 帮助` / `#ag ?` | 查看完整指令与路由说明 |
| `#ag 状态` / `#ag list` / `#ag /ps` | 列出所有 Antigravity 顶层会话 `#seq`、运行状态、工作区、`👑 总控` 标记及 CDP 状态 |
| `#ag 读 2` / `#ag /read 2` | 读取 `#2` 会话最近完整轮次内容（自动回溯 `transcript_full.jsonl`） |
| `#ag 你的任务` | 发给默认总控会话（若左滑引用了某子会话消息，则直达该子会话） |
| `#ag @2 你的任务` / `#ag #2 你的任务` | 跳过总控，原文直达 `#2` 会话 |
| `#ag 新建 [目录] [初始任务]` | 在桌面端新建会话并提交首个任务 |
| `#ag 默认 2` / `#ag /default 2` | 将 `#2` 设为默认总控会话并持久化 |
| `#ag 推送` | 查看当前主动推送模式 |
| `#ag 推送 全量` / `仅绑定` / `关` | 动态切换主动推送范围（`all` / `bound` / `off`） |
| `#ag 重启cdp` / `#ag relaunch` | 升级重启后 `:9223` 掉线时，在飞书一键远程重启 Antigravity 并恢复 `:9223` |
| `#ag 停止 [N]` / `#ag /stop [N]` | 通过 CDP `:9223` 点击停止生成按钮 |
| `#ag 允许` / `#ag 拒绝` / `#ag /ok` | 通过 CDP `:9223` 点击工具审批/确认按钮 |

---

## `ag-ctl.mjs` 本地命令行工具

供总控 Agent 或本地终端直接检查、读取、跨工作区派发与诊断：

```bash
node ag-ctl.mjs list [--all] [--json]               # 列出活跃会话（--all 包含 Swarm/子智能体）
node ag-ctl.mjs read <ref> [--json]                  # 读取会话最近轮次（支持 #N / N / UUID 前缀）
node ag-ctl.mjs send <ref> <message>                 # 向指定会话发送消息（同项目走 agentapi，跨项目自动回退 CDP）
node ag-ctl.mjs new [--dir <d>] [--model <m>] <msg>  # 新建会话并发送首条消息
node ag-ctl.mjs default [ref]                        # 查看或设置默认总控会话
node ag-ctl.mjs status                               # 查看数据库、agentapi、推送模式与 CDP 状态
node ag-ctl.mjs stop                                 # 触发停止生成（需 CDP :9223）
node ag-ctl.mjs click [approve|reject|N]             # 点击审批/确认按钮（需 CDP :9223）
node ag-ctl.mjs inspect-cdp                          # 诊断当前 CDP :9223 锁定的 Antigravity 主界面 DOM
```

---

## 多桥共享同一个飞书机器人（共存指南）

`lark-cli event _bus` 只维护一条到飞书的 WebSocket，并通过本地 UDS (`bus.sock`) 将事件完整广播给所有消费者，因此你可以让 **Antigravity4Lark (`#ag`)** 与 **Cursor（无前缀默认）**、**Codex (`#cx`)**、**Kimi (`#km`)** 共享同一个飞书机器人：

- **本仓库侧**：默认不截获无前缀消息，显式忽略 `#cu`/`#cursor`/`#cx`/`#codex`/`#km`/`#kimi`，引用回复严格按 `reply_to` 优先于 `root_id` 并跨读 `~/.cursor-remote-lite/msg-routes.json`、`~/.codex-feishu/state.json`、`~/.kimi-feishu/state.json` 防串线。
- **其他桥接侧**：如果你的默认兜底桥（如 Cursor）同时在线，只需在其前缀过滤中忽略 `/^[#@](?:ag|agy|antigravity)(?:\s|[@#:]|$)/i`，并在跨桥引用判断中检查 `~/.antigravity-feishu/state.json`（及 `【AG · Antigravity】` 标识）即可实现零冲突共存。

---

## 项目结构

```text
.
├── feishu.mjs             # 飞书事件监听、主动推送守护进程、UDS IPC 与代码热退出重启
├── ag-ctl.mjs             # 本地/总控 CLI 工具（支持同项目 agentapi + 跨项目 CDP 自动回退）
├── lib/
│   ├── antigravity.mjs    # node:sqlite 会话发现、transcript(_full).jsonl 解析、agentapi 封装
│   ├── cdp.mjs            # Electron CDP (:9223) 客户端（仅锁 127.0.0.1 主界面、侧栏切换、输入提交、按钮点击）
│   ├── watcher.mjs        # 2s 智能监控引擎（防刷屏、决策穿透、ask_question 展开、同轮合并、瞬时报错过滤）
│   ├── router.mjs         # 飞书指令解析、多桥前缀/引用互排、#ag 重启cdp 远程自愈
│   ├── lark.mjs           # lark-cli 长连接消费保活、Markdown 分段、230028 邮箱脱敏重试
│   ├── state.mjs          # ~/.antigravity-feishu/state.json 原子持久化（0700/0600）
│   ├── config.mjs         # 零依赖 .env 加载器
│   └── ipc.mjs            # 本地 UDS (~/.antigravity-feishu/bridge.sock, 0600) IPC 服务
├── test/                  # Node 原生 node:test 单元测试套件（npm test）
├── start-antigravity.sh   # 通过一次性 LaunchAgent 安全重启 Antigravity 开启 CDP :9223
├── install-launcher.sh    # 生成 macOS 快捷启动器 ~/Applications/Antigravity CDP.app
├── service.sh             # macOS LaunchAgent 后台常驻服务管理脚本
├── .env.example           # 环境变量配置模板（真实配置写入被 .gitignore 忽略的 .env）
├── package.json
└── LICENSE
```

---

## 运行测试

```bash
npm test
```

---

## 开源致谢

- 飞书事件长连接与消息收发基于官方 **[larksuite/cli (`lark-cli`)](https://github.com/larksuite/cli)**。
- 飞书多 Agent 总控交互体验与多桥共存路由规范延续自 **[Feishu_Agent_for_Cursor](https://github.com/Keffee/Feishu_Agent_for_Cursor)**（最初受 [Suchenl/cursor-remote-lite](https://github.com/Suchenl/cursor-remote-lite) 与 [len5ky/CursorRemote](https://github.com/len5ky/CursorRemote) 启发）。

---

## License

本项目采用 [MIT License](LICENSE) 开源。
