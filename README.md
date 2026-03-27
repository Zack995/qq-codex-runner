# qq-codex-runner

一个把 QQ 机器人消息桥接到本地 Codex CLI 会话的小型 runner。

它解决的是这类问题：

- 在 QQ 里直接驱动本机 `codex`
- 复用同一个 Codex 会话上下文
- 用队列串行处理消息，避免并发乱序
- 运行中切换工作目录和访问权限模式

## 功能

- 接收 QQ 频道消息和 C2C 私聊消息
- 启动并复用本地 Codex CLI 会话
- 支持 `/new` 重置当前会话
- 支持 `/allow`、`/skip`、`/reject`
- 把 Codex 回复再发回 QQ
- 支持切换工作目录和访问权限模式

## 环境要求

- Node.js 22+
- 本机已安装并登录可用的 `codex` CLI
- 一个可用的 QQ 机器人应用，具备 `AppID` 和 `AppSecret`

## 安装

```bash
git clone git@github.com:Zack995/qq-codex-runner.git
cd qq-codex-runner
npm install
cp .env.example .env
```

最少需要配置：

```env
QQ_BOT_APP_ID=your_app_id
QQ_BOT_SECRET=your_app_secret
```

常用可选配置：

```env
CODEX_BIN=/absolute/path/to/codex
CODEX_HOME=/absolute/path/to/.codex
RUNNER_WORKDIR=/absolute/path/to/workspace
RUNNER_ADD_DIRS=/path/one,/path/two
CODEX_ACCESS_MODE=safe
```

## 启动

前台启动：

```bash
npm start
```

后台常驻：

```bash
./scripts/start.sh
```

停止：

```bash
./scripts/stop.sh
```

查看状态和日志：

```bash
./scripts/status.sh
tail -f ./logs/runner.log
```

## 指令

- `/help`
  查看所有支持的指令

- `/status`
  查看当前运行状态，包括 QQ 连接、会话、队列、权限模式和工作目录

- `/queue`
  查看当前队列状态，包括是否有任务正在执行、排队任务数

- `/session`
  查看当前 Codex 会话状态，包括会话是否已建立、是否忙碌、会话代次、是否存在待审批命令

- `/cwd`
  查看当前工作目录

- `/cwd <目录>`
  切换到指定目录，并重置当前 Codex 会话、清空等待队列

- `/access`
  查看当前权限模式

- `/access <read|write|safe|full>`
  切换权限模式，并重置当前 Codex 会话、清空等待队列

  模式说明：
  - `read`：只读
  - `write`：工作区可写
  - `safe`：安全模式，等同工作区可写
  - `full`：完全访问

- `/new`
  重置当前 Codex 会话，下一条普通消息会新开会话

- `/restart`
  清空等待队列，并重置 runner 当前会话状态

- `/allow`
  批准待审批命令并继续执行

- `/skip`
  跳过待审批命令，让 Codex 换一种方式继续

- `/reject`
  拒绝待审批命令，并直接重置当前会话

## 说明

- `/cwd` 和 `/access` 切换后，会自动重置当前会话并清空等待队列，避免旧上下文混入新目录或新权限模式
- `full` 模式会把 Codex 切到完全访问能力，请只在你明确知道后果时使用
- `.env`、日志和运行时 PID 文件默认不会进入 git

## 开发

如果要给 Codex 追加参数，可以放到 `--` 后面：

```bash
node main.js -- --model gpt-5.4
```

如果要指定 `codex` 可执行路径：

```bash
node main.js --cmd /absolute/path/to/codex
```
