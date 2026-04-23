# qq-codex-runner

把 QQ / 微信消息桥接到本地 `codex` 或 `claude` CLI 会话的轻量 runner。

X: [@btc_cczzc](https://x.com/btc_cczzc)

## 适合什么场景

- 在 QQ 或微信里直接驱动本机 `codex` 或 `claude`（Claude Code CLI）
- 同一聊天下 `codex` 和 `claude` 各自保留独立会话，按需 `/backend` 切换
- 按渠道、对话对象、工作目录复用独立上下文
- 串行处理消息，避免多个请求把同一条会话打乱
- 长任务执行时，把中间进度简要流式发回 QQ / 微信
- 运行中切换工作目录、权限模式、后端，或热更新微信登录状态

## 主要能力

- 同一个进程同时支持多 QQ 机器人和多微信账号，互不串扰
- 每个 bot / 账号可以起别称（在 `/status` 和日志里直观区分）
- 支持 QQ 频道消息和 C2C 私聊
- 支持通过微信后端 HTTP API 接入微信文本消息
- 双后端：`codex exec --json`（复用 `threadId`）和 `claude -p --output-format stream-json`（复用 `session_id`）
- 按「bot/account + 对话对象 + 工作目录 + 后端」独立缓存会话，任一维度不同即是独立会话
- 切换后端前自动检测 CLI 可用性（未安装硬拒绝、未登录仅警告）
- 运行时捕获到认证错误会在回复里附带排查提示
- 进程重启后恢复上次工作目录、权限模式、各 scope 的后端选择和已知会话
- 支持 `/cwd` 搜索并切换本地目录
- 支持 `/backend`、`/new`、`/allow`、`/skip`、`/reject`
- 支持查看线程 ID / Session ID、最近一轮 Token、上下文窗口和自动压缩阈值
- 支持把命令执行摘要和工具调用摘要流式发回 QQ / 微信
- 支持运行时扫码登录 / 登出微信，无需重启服务

## 环境要求

- Node.js 22+
- 至少一个可用后端：`codex` CLI（已登录）或 `claude` CLI（已登录 / `ANTHROPIC_API_KEY` 有效）
- 一个可用的 QQ 机器人应用，具备 `QQ_BOT_APP_ID` 和 `QQ_BOT_SECRET`
- 如需微信，还要有可用的微信后端网关

## 快速开始

```bash
git clone git@github.com:Zack995/qq-codex-runner.git
cd qq-codex-runner
npm install
cp .env.example .env
```

最少配置（单 QQ 机器人）：

```env
QQ_BOT_APP_ID=your_app_id
QQ_BOT_SECRET=your_app_secret
```

多 QQ 机器人（`QQ_BOTS` 优先于 `QQ_BOT_APP_ID`）：

```env
QQ_BOTS=[{"id":"main","name":"主号","appId":"111","secret":"aaa"},{"id":"test","name":"测试号","appId":"222","secret":"bbb"}]
```

- `id` 是 session 隔离键；多机器人时不同 `id` 下的会话互不影响
- `name` 是展示用的别称（`/status`、日志里能看到），省略则回落到 `id`
- 升级前已有的会话若只配一个机器人，启动时会自动迁移到该 `id` 下；配了多个则保守丢弃（参见下文"运行逻辑"）

单机器人用 legacy 配置时，别称默认叫 **`qq机器人`**；想改成别的，设 `QQ_BOT_NAME=xxx`。

微信支持多账号：

```bash
node main.js --weixin-login --weixin-account work --weixin-name 工作号
```

- 登录成功后下次启动自动拉起
- `WEIXIN_ACCOUNTS=a,b` 作为白名单只启一部分
- `WEIXIN_NAMES={"default":"微信机器人","work":"工作号"}` 可在 env 层批量覆盖别称
- 默认 `default` 账号的别称是 **`微信机器人`**，其他账号默认用 `accountId` 本身

常用配置：

```env
# Codex 后端
CODEX_BIN=./bin/codex
CODEX_HOME=../.codex
RUNNER_CODEX_HOME=../.codex-qq-runner
CODEX_EXEC_TIMEOUT_MS=1800000
CODEX_AUTO_COMPACT_TOKEN_LIMIT=500000

# Claude Code 后端
CLAUDE_BIN=claude
RUNNER_CLAUDE_HOME=../.claude-qq-runner

# 新会话默认后端（不设则为 codex）
RUNNER_DEFAULT_BACKEND=claude

# 通用
RUNNER_WORKDIR=.
RUNNER_ADD_DIRS=./workspace,./shared
CODEX_ACCESS_MODE=safe

# 微信
WEIXIN_ENABLED=true
WEIXIN_ACCOUNT_ID=default
WEIXIN_BASE_URL=
WEIXIN_TOKEN=
WEIXIN_BOT_TYPE=3
```

说明：

- `RUNNER_CODEX_HOME` / `RUNNER_CLAUDE_HOME` 建议单独设置，避免和你手动开的 CLI 共用会话存储
- `CODEX_EXEC_TIMEOUT_MS` 是"无新输出超时"，不是总执行时长；Claude 后端复用这一超时
- `CODEX_AUTO_COMPACT_TOKEN_LIMIT` 会覆盖 runner 会话的 Codex 自动压缩阈值
- 如果 `config.toml` 里的压缩阈值设得很高，聊天里会看起来像"不压缩"
- `CODEX_ACCESS_MODE` 同时控制两个后端的权限：`read→plan`、`write/safe→acceptEdits`、`full→bypassPermissions`
- `RUNNER_DEFAULT_BACKEND` 只影响首次进入某个聊天时的默认后端；之后 `/backend` 切换会被持久化

## 启动与管理

前台启动：

```bash
npm start
```

后台常驻：

```bash
./scripts/start.sh
```

查看状态：

```bash
./scripts/status.sh
```

查看日志：

```bash
tail -f logs/runner.log
```

停止：

```bash
./scripts/stop.sh
```

正常启动后，日志里应出现（单机器人别称默认叫 `qq机器人`）：

```text
[qq-codex-runner] QQ bot connected: qq机器人（1903879189）
```

配置了多机器人时，每个机器人会各自打印一行；微信账号会打印 `Starting Weixin client for account <id>.`。

## 微信登录

启动服务后，在另一个终端执行：

```bash
node main.js --weixin-login
```

常用参数：

```bash
node main.js --weixin-login --weixin-account default
node main.js --weixin-login --weixin-account work --weixin-name 工作号
node main.js --weixin-login --weixin-login-force
node main.js --weixin-logout --weixin-account default
```

- `--weixin-name <别称>` 在扫码的同时把别称写入 state；之后在 `/status` 里显示
- 不传 `--weixin-name` 时，`default` 账号的别称默认为 `微信机器人`，其他账号默认为 `accountId`
- 需要批量改别称也可以设 env `WEIXIN_NAMES={"default":"微信机器人","work":"工作号"}`（env 优先级高于 state）

扫码登录成功后：

- runner 会保存 `accountId`、`name`、`token`、`baseUrl`
- 正在运行的服务会自动热加载微信客户端
- 不需要重启 `./scripts/start.sh`

## 常用指令

- `/help`
  查看指令帮助
- `/status`
  查看运行状态、当前后端、工作目录、权限模式、最近一轮 Token
- `/queue`
  查看当前队列状态
- `/session`
  查看当前聊天在当前目录的后端、线程 ID / Session ID、最近一轮 Token、待审批状态
- `/cwd`
  查看当前工作目录
- `/cwd <目录>`
  切换到指定目录
- `/cwd <关键字>`
  搜索本地目录并返回候选
- `/cwd <编号>`
  选择最近一次搜索结果
- `/access <read|write|safe|full>`
  切换权限模式并清空队列；现有会话保留，下一条消息以新权限继续（同时影响 codex sandbox 与 claude permission-mode）
- `/backend`
  查看当前聊天的后端，并检测 codex / claude 两个 CLI 的可用性
- `/backend <codex|claude>`
  切换当前聊天的后端（按聊天维度独立生效，codex / claude 会话各自保留）
- `/new`
  重置当前聊天在当前目录的当前后端会话（另一后端的会话不受影响）
- `/restart`
  清空队列并重置 runner 保存的全部会话
- `/allow`
  批准待审批命令（仅 Codex）
- `/skip`
  跳过待审批命令（仅 Codex）
- `/reject`
  拒绝待审批命令并重置当前会话（仅 Codex）

## 运行逻辑

- 同一工作目录下，QQ、微信和手动终端里的 `codex` / `claude` 默认彼此隔离
- 同时支持多 QQ 机器人和多微信账号；每条消息带着来源 bot/account 进入队列，回复也由对应 client 发出，不会串号
- 会话按「bot/account + 对话对象 + 工作目录 + 后端」缓存，任一维度不同就是独立会话（QQ 的 key 形如 `qq:{botId}:channel:X` 或 `qq:{botId}:c2c:X`，微信形如 `weixin:{accountId}:direct:X`）
- 升级后启动时，若检测到老格式会话（`qq:channel:X` 无 botId）且只配了一个 QQ 机器人，自动迁移到该 `id` 下；配了多个则丢弃老会话并在日志提示
- Codex 走 `codex exec --json`，复用 `threadId`；Claude 走 `claude -p --output-format stream-json --verbose`，复用 `session_id`
- `/backend` 切换前会跑 `--version` 自检：不可执行直接拒绝；凭据缺失会附警告但仍允许切换
- 运行时若 stderr 命中 `401 / unauthorized / invalid api key / not logged in / credential` 等关键词，错误回复会追加对应 CLI 的排查提示
- 执行中会转发命令执行摘要和工具调用摘要；长时间无新事件才补低频心跳
- 最终仍只回一次正式答复，避免把中间过程和最终结论混在一起
- `/access` 切换权限模式时会清空队列并终止正在运行的任务，但现有会话保留；下一条消息会以新权限继续
- `/cwd` 切目录时会清空等待队列；切回旧目录会恢复该目录旧会话
- Claude Code 的权限走 `--permission-mode`，无 Codex 的 `<approval_request>` 交互审批流程；`/allow` `/skip` `/reject` 仅对 Codex 生效

## 排查建议

如果没有回复，优先看：

```bash
./scripts/status.sh
tail -n 80 logs/runner.log
cat logs/runner-state.json
```

重点排查：

- QQ 是否已连接
- 微信账号是否已写入 `runner-state.json`
- 日志里是否出现 `QQ bot connected.` 或 `Starting Weixin client ...`
- 是否存在待审批命令但没有回复 `/allow`、`/skip` 或 `/reject`

## 额外说明

- `.env`、日志和 PID 文件默认不会进入 Git
- 如需给 `codex` 额外传参，可以用：

```bash
node main.js -- --model gpt-5.4
```

- 如需指定 `codex` 可执行路径，可以用：

```bash
node main.js --cmd ./bin/codex
```

- 如需指定 `claude` 可执行路径，设 `CLAUDE_BIN` 环境变量即可：

```bash
CLAUDE_BIN=/opt/claude/claude ./scripts/start.sh
```

- 如需把 runner 的 Claude 会话目录与手动 `claude` 隔离，设 `RUNNER_CLAUDE_HOME`（会作为 `CLAUDE_CONFIG_DIR` 传给子进程）
