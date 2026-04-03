# qq-codex-runner

一个把 QQ / 微信消息桥接到本地 Codex CLI 会话的小型 runner。

它解决的是这类问题：

- 在 QQ 或微信里直接驱动本机 `codex`
- 按工作目录和渠道会话复用各自独立的 Codex 上下文
- 用队列串行处理消息，避免并发乱序
- 运行中切换工作目录和访问权限模式
- 服务运行期间动态接入或移除微信账号，无需重启

## 功能

- 同一个 runner 进程可同时支持 QQ 和微信
- 接收 QQ 频道消息和 C2C 私聊消息
- 支持通过微信后端 HTTP API 接入微信文本消息
- 支持参考 OpenClaw Weixin 的扫码授权流程接入微信
- 按工作目录启动并复用本地 Codex CLI 会话
- 进程重启后恢复上次工作目录、权限模式和已知目录会话
- 同一工作目录下，QQ、微信和 runner 自己管理的 Codex 线程彼此隔离
- 支持 `/cwd` 本地目录搜索与编号选择
- 支持 `/new` 重置当前目录会话
- 支持 `/allow`、`/skip`、`/reject`
- 把 Codex 回复再发回 QQ
- 支持切换工作目录和访问权限模式

## 环境要求

- Node.js 22+
- 本机已安装并登录可用的 `codex` CLI
- 一个可用的 QQ 机器人应用，具备 `AppID` 和 `AppSecret`
- 如果要接入微信，还需要一个可用的微信后端网关

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
CODEX_BIN=./bin/codex
CODEX_HOME=../.codex
RUNNER_CODEX_HOME=../.codex-qq-runner
RUNNER_WORKDIR=.
RUNNER_ADD_DIRS=./workspace,./shared
CODEX_ACCESS_MODE=safe
CODEX_EXEC_TIMEOUT_MS=1800000
WEIXIN_ENABLED=true
WEIXIN_ACCOUNT_ID=default
WEIXIN_BASE_URL=
WEIXIN_TOKEN=
WEIXIN_BOT_TYPE=3
```

说明：

- `RUNNER_WORKDIR` 是首次启动或没有运行时状态文件时的默认目录
- 一旦 runner 已运行过，后续进程重启会优先恢复上次保存的工作目录和权限模式
- `CODEX_EXEC_TIMEOUT_MS` 表示“无新输出超时”，不是固定总时长；设为 `0` 可禁用
- `RUNNER_CODEX_HOME` 用于让 runner 使用独立的 Codex 状态目录，避免和你手动开的 `codex` 混用 `resume --last`
  runner 在首次初始化该目录时，会从现有 `CODEX_HOME` 复制必要配置文件（如 `auth.json`、`config.toml`），避免出现 API key 或 base URL 缺失
- `WEIXIN_*` 配置控制微信长轮询接入；当前先支持文本收发
- 服务运行中执行扫码登录命令后，微信客户端会自动热加载，无需重启 runner
- 微信可以通过扫码登录写入本地凭证，登录后无需手工填写 `WEIXIN_TOKEN`
- 常驻服务模式仍然会启动 QQ 客户端，所以正常运行服务时仍需配置 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`
- `node main.js --weixin-login` 和 `node main.js --weixin-logout` 可以独立执行，用于在服务运行期间管理微信账号

### 微信扫码登录

参考 `@tencent-weixin/openclaw-weixin` 的接入方式，当前项目提供了独立登录命令：

```bash
node main.js --weixin-login
```

可选参数：

```bash
node main.js --weixin-login --weixin-account my-weixin
node main.js --weixin-login --weixin-login-force
node main.js --weixin-logout --weixin-account my-weixin
```

登录流程：

1. 命令会请求微信二维码登录地址
2. 终端输出二维码链接，使用微信扫码确认
3. 登录成功后，本地会保存 `accountId`、`bot token`、`baseUrl`
4. 如果 runner 服务已经在运行，约 1 秒内会自动拉起微信客户端，无需重启
5. 后续只要 `WEIXIN_ENABLED=true`，runner 重启后也会自动复用该微信账号

### 同时使用 QQ 和微信

常驻服务启动后：

- QQ 会按现有配置正常连接
- 微信账号如果已经扫码登录成功，也会自动连接
- 你可以在服务运行期间再次执行 `node main.js --weixin-login` 完成微信授权
- 登录成功后，运行中的 runner 会自动热加载微信客户端，不需要重启
- 执行 `node main.js --weixin-logout --weixin-account <id>` 后，运行中的 runner 也会自动停止对应微信账号

## 执行教程

下面是一套从 0 到可用的最短操作路径，适合第一次把 QQ、微信和 Codex 跑通。

### 1. 准备 `.env`

至少先配置 QQ 和 Codex：

```env
QQ_BOT_APP_ID=your_app_id
QQ_BOT_SECRET=your_app_secret
CODEX_BIN=./bin/codex
CODEX_HOME=../.codex
RUNNER_CODEX_HOME=../.codex-qq-runner
WEIXIN_ENABLED=true
WEIXIN_ACCOUNT_ID=default
WEIXIN_BOT_TYPE=3
```

说明：

- `RUNNER_CODEX_HOME` 强烈建议单独设置，这样 runner 和你手动终端里的 `codex` 不会共用同一套会话存储
- 如果你已经有固定的微信后端地址，也可以提前写入 `WEIXIN_BASE_URL`
- 如果暂时没有 `WEIXIN_TOKEN`，没关系，可以后面通过扫码登录写入

### 2. 启动服务

后台启动：

```bash
./scripts/start.sh
```

确认服务已运行：

```bash
./scripts/status.sh
```

查看实时日志：

```bash
tail -f ./logs/runner.log
```

正常情况下你会看到：

- `QQ bot connected.`

### 3. 先验证 QQ

在 QQ 里发一条最简单的命令：

```text
/help
```

如果能收到回复，说明：

- QQ 收消息正常
- runner 队列正常
- 回复发送正常

### 4. 在服务运行时扫码登录微信

不要停服务，直接在另一个终端执行：

```bash
node main.js --weixin-login
```

如果你想给微信账号指定逻辑名：

```bash
node main.js --weixin-login --weixin-account default
```

命令会输出二维码链接，使用微信扫码并确认授权。

登录成功后：

- 本地状态文件会写入微信账号信息
- 运行中的服务会在约 1 秒内自动热加载微信客户端
- 不需要重启 `./scripts/start.sh`

你可以用下面的命令确认状态已写入：

```bash
cat ./logs/runner-state.json
```

正常情况下你会看到：

- `weixin.accounts` 不再是空对象
- 里面包含 `accountId`、`token`、`baseUrl`

### 5. 验证微信收发

扫码成功后，在微信里先发：

```text
/help
```

然后再发：

```text
/status
```

如果两条都能收到回复，说明：

- 微信长轮询收消息正常
- 微信发消息正常
- 队列和命令分发正常

### 6. 验证 Codex 交互

在微信或 QQ 里继续发：

```text
请告诉我当前工作目录
```

或者：

```text
请读取 package.json 并告诉我这个项目做什么
```

如果能正常回答，说明：

- 渠道消息已经成功进入 Codex 执行链路
- 本地 `codex` 调用正常
- 结果能正确回发到 QQ / 微信

### 7. 验证 QQ / 微信 / 手动 codex 不串上下文

你可以用下面的方法做最小验证。

先在 QQ 发：

```text
记住一句话：这是 QQ 的上下文
```

再在微信发：

```text
你记得我刚才说的话吗
```

正常预期：

- 微信不应该读到 QQ 的那句内容

如果你还想验证 runner 和手动终端里的 `codex` 也隔离，可以在终端手动进入同一项目目录运行一条 `codex`，然后再回 QQ / 微信问刚才内容。正常情况下，runner 不会恢复到你手动开的那条最近会话。

### 8. 微信登出

如果你要移除当前微信账号：

```bash
node main.js --weixin-logout --weixin-account default
```

运行中的服务会自动停掉对应微信客户端，不需要重启。

### 9. 常用排查

如果微信扫码后一直没有回复，先看：

```bash
tail -n 80 ./logs/runner.log
cat ./logs/runner-state.json
```

重点排查：

- `runner-state.json` 里 `weixin.accounts` 是否为空
- 日志里是否出现 `Starting Weixin client for account ...`
- 是否出现 `Weixin poll failed: ...`
- 是否出现 `Weixin inbound accepted: ...`
- 是否出现 `Weixin message skipped: ...`

如果出现“只回复第一条，后面不回复”，优先确认：

- 日志里第二条消息有没有进入 `Weixin poll received ...`
- 第二条有没有被 `Weixin message skipped: ...` 过滤
- 微信后端的 `sendmessage` 是否正常接受带 `client_id`、`message_type`、`message_state` 的请求

## 启动

前台启动：

```bash
npm start
```

后台常驻：

```bash
./scripts/start.sh
```

说明：

- 后台服务启动的是同一个 runner 进程，QQ 和微信都会在这个进程里运行
- 微信是否真正连接，取决于是否已经存在可用的微信登录凭证

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
  查看当前运行状态，包括 QQ / 微信连接、会话、队列、权限模式和工作目录

- `/queue`
  查看当前队列状态，包括是否有任务正在执行、排队任务数

- `/session`
  查看当前工作目录下、当前聊天会话对应的 Codex 状态，包括线程 ID、是否已建立、是否忙碌、会话代次、是否存在待审批命令

- `/cwd`
  查看当前工作目录

- `/cwd <目录>`
  切换到指定目录，并清空等待队列

  行为说明：
  - 如果当前聊天会话在该目录之前已经建立过 Codex 会话，切回去会恢复该聊天在该目录原来的上下文
  - 如果是第一次切到该目录，下一条普通消息会创建一个新会话

- `/cwd <关键字>`
  优先使用本地系统文件搜索来查找目录，最多返回 5 个候选结果，方便选择工作目录

- `/cwd <编号>`
  选择最近一次 `/cwd <关键字>` 搜索结果中的某个目录

- `/access`
  查看当前权限模式

- `/access <read|write|safe|full>`
  切换权限模式，并重置所有目录会话、清空等待队列

  模式说明：
  - `read`：只读
  - `write`：工作区可写
  - `safe`：安全模式，等同工作区可写
  - `full`：完全访问

- `/new`
  只重置当前工作目录对应的 Codex 会话，下一条普通消息会在该目录新开会话

- `/restart`
  清空等待队列，并重置 runner 保存的所有目录会话状态

- `/allow`
  批准待审批命令并继续执行

- `/skip`
  跳过待审批命令，让 Codex 换一种方式继续

- `/reject`
  拒绝待审批命令，并直接重置当前工作目录会话

## 说明

- `/cwd` 切换目录时会清空等待队列；目录之间的会话彼此独立，切回旧目录会恢复该目录之前的会话
- runner 进程重启后，会优先恢复上次保存的工作目录、权限模式和已知目录会话；如果没有状态文件，才回退到 `RUNNER_WORKDIR` 或启动目录
- 同一工作目录下，QQ 与微信会按“渠道 + 对话对象 + 工作目录”分别恢复不同的 Codex 线程，不会共享 `resume --last`
- 如果配置了 `RUNNER_CODEX_HOME`，runner 会把自己的 Codex 状态与手动终端里的 `codex` 隔离开，进一步降低上下文混用风险
- 微信扫码登录成功后，凭证会保存到本地运行时状态文件；runner 会优先使用本地保存的微信凭证，其次才是 `.env` 里的 `WEIXIN_TOKEN` / `WEIXIN_BASE_URL`
- 运行中的 runner 会监听本地运行时状态文件；扫码登录或登出微信后，会自动热更新微信连接状态
- `/cwd <关键字>` 在 macOS 上会优先使用 Spotlight 索引搜索目录；如果系统搜索不可用或没有结果，会回退到内置目录遍历
- `/access` 切换后会清空等待队列，并重置所有目录会话，避免不同权限模式下的上下文混用
- `full` 模式会把 Codex 切到完全访问能力，请只在你明确知道后果时使用
- `.env`、日志和运行时 PID 文件默认不会进入 git

## 开发

如果要给 Codex 追加参数，可以放到 `--` 后面：

```bash
node main.js -- --model gpt-5.4
```

如果要指定 `codex` 可执行路径：

```bash
node main.js --cmd ./bin/codex
```
