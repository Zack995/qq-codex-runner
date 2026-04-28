'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeText,
  log,
  splitMessage,
  resolveInputPath,
  stripAtMentions,
  nextMsgSeq,
  formatTokenUsage
} = require('./util');

const config = require('./config');
const {
  VALID_ACCESS_MODES,
  VALID_BACKENDS,
  BACKEND_LABELS,
  CLAUDE_PERMISSION_MODE_BY_ACCESS,
  MAX_BOT_MESSAGE_LENGTH,
  MAX_WORKDIR_SEARCH_RESULTS,
  MAX_WORKDIR_SEARCH_DIRS,
  WORKDIR_SYSTEM_SEARCH_TIMEOUT_MS,
  WORKDIR_SYSTEM_SEARCH_MAX_BUFFER,
  WORKDIR_SEARCH_SKIP_NAMES
} = config;
const {
  MAX_CONCURRENCY,
  PRIMARY_CODEX_HOME,
  RUNNER_CODEX_HOME,
  CODEX_CONTEXT_WINDOW_OVERRIDE,
  CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE,
  CLAUDE_BIN,
  RUNNER_CLAUDE_HOME,
  DEFAULT_WORKDIR,
  WEIXIN_ENABLED
} = config.loadRuntimeConfig();

const {
  runnerState,
  sessionQueues,
  activeRuns,
  pendingApprovals,
  codexSessions,
  qqBots,
  weixinBots,
  getEffectiveCodexContextWindow,
  getEffectiveCodexAutoCompactTokenLimit,
  formatCodexConfigValue,
  getCodexAutoCompactStatus,
  buildSessionIdentity,
  getContextSessionScopeKey,
  sessionIdentityForContext,
  sessionIdentityForTask,
  getActiveBackend,
  setActiveBackend,
  getWorkdirForScope,
  setWorkdirForScope,
  getAccessModeForScope,
  setAccessModeForScope,
  getScopedSession,
  getSessionForContext,
  countActiveSessions,
  ensureSessionTokenUsage,
  resetSessionState,
  stopActiveRun,
  stopAllActiveRuns,
  totalQueuedTasks,
  queueDepthForSession,
  enqueueToSessionQueue,
  clearQueueForSession,
  clearAllQueues,
  findPendingApprovalByScope,
  clearRecentWorkdirSearch,
  clearAllRecentWorkdirSearches,
  setRecentWorkdirSearch,
  getSearchSelection,
  persistRunnerState
} = require('./state');

const {
  setSendReplyImpl,
  spawnProbeVersion,
  summarizeProbeFailure
} = require('./exec');

const { getCodexBin } = require('./codex');
const { formatClaudeContextLines } = require('./claude');

const { extractWeixinText } = require('./weixin');

const { tickQueues } = require('./queue');

async function checkBackendAvailability(backend) {
  if (backend === 'codex') {
    const command = getCodexBin();
    const probe = await spawnProbeVersion(command);
    if (!probe.ok && probe.error === 'ENOENT') {
      return {
        ok: false,
        reason: 'missing_binary',
        message: `未找到 codex 可执行文件：${command}。请先安装 codex，或设置 CODEX_BIN / --cmd 指向正确路径。`
      };
    }
    if (!probe.ok) {
      return {
        ok: false,
        reason: 'binary_error',
        message: `codex --version 执行失败：${summarizeProbeFailure(probe)}`
      };
    }
    const authDir = RUNNER_CODEX_HOME || PRIMARY_CODEX_HOME;
    const authFile = authDir ? path.join(authDir, 'auth.json') : '';
    const hasAuthFile = (() => {
      if (!authFile) return false;
      try { return fs.statSync(authFile).isFile(); } catch (_) { return false; }
    })();
    const hasEnvKey = Boolean(sanitizeText(process.env.OPENAI_API_KEY));
    if (!hasAuthFile && !hasEnvKey) {
      return {
        ok: true,
        warn: 'auth_unknown',
        message: `codex 已安装，但未检测到凭据（${authFile || '~/.codex/auth.json'} 不存在，且未设置 OPENAI_API_KEY）。如实际已登录可忽略，否则请运行 \`codex login\`。`
      };
    }
    return { ok: true };
  }

  if (backend === 'claude') {
    const probe = await spawnProbeVersion(CLAUDE_BIN);
    if (!probe.ok && probe.error === 'ENOENT') {
      return {
        ok: false,
        reason: 'missing_binary',
        message: `未找到 claude 可执行文件：${CLAUDE_BIN}。请安装 Claude Code CLI（npm i -g @anthropic-ai/claude-code），或设置 CLAUDE_BIN 指向正确路径。`
      };
    }
    if (!probe.ok) {
      return {
        ok: false,
        reason: 'binary_error',
        message: `claude --version 执行失败：${summarizeProbeFailure(probe)}`
      };
    }
    const configDir = RUNNER_CLAUDE_HOME || path.join(os.homedir(), '.claude');
    const credFile = path.join(configDir, '.credentials.json');
    const hasCredFile = (() => {
      try { return fs.statSync(credFile).isFile(); } catch (_) { return false; }
    })();
    const hasEnvKey = Boolean(sanitizeText(process.env.ANTHROPIC_API_KEY));
    if (!hasCredFile && !hasEnvKey) {
      return {
        ok: true,
        warn: 'auth_unknown',
        message: `claude 已安装，但未检测到凭据（${credFile} 不存在，且未设置 ANTHROPIC_API_KEY）。如实际已登录可忽略，否则请运行 \`claude login\`。`
      };
    }
    return { ok: true };
  }

  return { ok: false, reason: 'unknown_backend', message: `未知后端：${backend}` };
}

function getWorkdirSearchRoots() {
  const roots = [runnerState.workdir, DEFAULT_WORKDIR, ...runnerState.addDirs, os.homedir()];
  const uniqueRoots = [];
  const seen = new Set();

  for (const rawRoot of roots) {
    const resolved = resolveInputPath(rawRoot);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
    } catch (_) {
      continue;
    }

    uniqueRoots.push(resolved);
  }

  return uniqueRoots;
}

function shouldSkipSearchDir(name) {
  if (!name) return false;
  if (WORKDIR_SEARCH_SKIP_NAMES.has(name)) return true;
  if (name.startsWith('.') && name !== '.config') return true;
  return false;
}

function shouldSkipSearchPath(targetPath) {
  const resolved = resolveInputPath(targetPath);
  const segments = resolved.split(path.sep).filter(Boolean);
  return segments.some((segment) => shouldSkipSearchDir(segment));
}

function isDirectoryPath(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function normalizeDirectoryMatches(paths, limit = MAX_WORKDIR_SEARCH_RESULTS) {
  const matches = [];
  const seen = new Set();

  for (const rawPath of paths) {
    const resolved = resolveInputPath(rawPath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    if (!isDirectoryPath(resolved)) continue;
    if (shouldSkipSearchPath(resolved)) continue;

    matches.push(resolved);
    if (matches.length >= limit) break;
  }

  return matches;
}

function escapeMdfindQueryValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function searchDirectoriesWithMdfind(query, roots, limit = MAX_WORKDIR_SEARCH_RESULTS) {
  if (process.platform !== 'darwin') return [];

  const keyword = sanitizeText(query);
  if (!keyword) return [];

  const escapedKeyword = escapeMdfindQueryValue(keyword);
  const predicate = [
    `((kMDItemFSName == "*${escapedKeyword}*"cd)`,
    `|| (kMDItemPath == "*${escapedKeyword}*"cd))`,
    '&& (kMDItemContentTypeTree == "public.folder")'
  ].join(' ');

  const rawMatches = [];
  for (const root of roots) {
    const search = childProcess.spawnSync(
      'mdfind',
      ['-onlyin', root, predicate],
      {
        encoding: 'utf8',
        timeout: WORKDIR_SYSTEM_SEARCH_TIMEOUT_MS,
        maxBuffer: WORKDIR_SYSTEM_SEARCH_MAX_BUFFER
      }
    );

    if (search.error || search.status !== 0) {
      continue;
    }

    rawMatches.push(
      ...String(search.stdout || '')
        .split(/\r?\n/)
        .map((line) => sanitizeText(line))
        .filter(Boolean)
    );
  }

  return normalizeDirectoryMatches(rawMatches, limit);
}

function searchLocalDirectoriesByTraversal(query, limit = MAX_WORKDIR_SEARCH_RESULTS) {
  const keyword = sanitizeText(query).toLowerCase();
  if (!keyword) return [];

  const rawMatches = [];
  const queued = [];
  const seenDirs = new Set();

  for (const root of getWorkdirSearchRoots()) {
    queued.push(root);
    seenDirs.add(root);
  }

  let visitedCount = 0;
  while (queued.length > 0 && rawMatches.length < limit && visitedCount < MAX_WORKDIR_SEARCH_DIRS) {
    const currentDir = queued.shift();
    visitedCount += 1;

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

      const fullPath = path.join(currentDir, entry.name);
      const normalizedName = entry.name.toLowerCase();
      const normalizedPath = fullPath.toLowerCase();

      if (
        (normalizedName.includes(keyword) || normalizedPath.includes(keyword))
      ) {
        rawMatches.push(fullPath);
        if (rawMatches.length >= limit) break;
      }

      if (shouldSkipSearchDir(entry.name)) continue;
      if (seenDirs.has(fullPath)) continue;
      seenDirs.add(fullPath);
      queued.push(fullPath);
    }
  }

  return normalizeDirectoryMatches(rawMatches, limit);
}

function searchLocalDirectories(query, limit = MAX_WORKDIR_SEARCH_RESULTS) {
  const roots = getWorkdirSearchRoots();
  const systemMatches = searchDirectoriesWithMdfind(query, roots, limit);
  if (systemMatches.length > 0) {
    return systemMatches;
  }

  return searchLocalDirectoriesByTraversal(query, limit);
}

function formatWorkdirSearchMessage(query, matches) {
  if (matches.length === 0) {
    return [
      `没有找到匹配目录：${query}`,
      '你可以直接发送绝对路径，或继续用 /cwd <关键字> 搜索。'
    ].join('\n');
  }

  const lines = [`找到最多 ${matches.length} 个目录候选：`];
  for (let index = 0; index < matches.length; index += 1) {
    lines.push(`${index + 1}. ${matches[index]}`);
  }
  lines.push('请发送 /cwd <编号> 选择目录，或继续发送 /cwd <关键字> 重新搜索。');
  return lines.join('\n');
}

function getHelpMessage() {
  return [
    '可用指令：',
    '',
    '/help - 帮助',
    '/status - 运行状态（接入 bot、所有连接、并发槽、目录、权限、Token）',
    '/queue - 队列状态（并发槽、活跃会话、等待队列）',
    '/session - 当前会话：后端、线程/Session ID、该会话队列、Token',
    '',
    '/cwd - 查看当前工作目录',
    '/cwd <目录|关键字|编号> - 切换 / 搜索 / 按编号选择目录（热切）',
    '',
    '/access - 查看当前权限模式',
    '/access <read|write|safe|full> - 热切权限模式（对新任务生效）',
    '',
    '/backend - 查看当前后端 + 检测 codex / claude 可用性',
    '/backend <codex|claude> - 切换当前聊天的后端（按聊天独立生效）',
    '',
    '/new - 重置当前会话（仅影响当前 bot/用户/目录/后端）',
    '/restart - 停止所有任务、清空所有队列、重置所有会话',
    '',
    '/allow /skip /reject - 审批待确认命令（仅 Codex）'
  ].join('\n');
}

function formatClientStatuses(entries, emptyLabel) {
  if (entries.length === 0) return emptyLabel;
  return entries.map(({ name, id, ready }) => {
    const label = name && name !== id ? `${name}（${id}）` : id;
    return `${label}${ready ? ' ✓' : ' ✗'}`;
  }).join('，');
}

function getStatusMessage(context) {
  const scopeKey = getContextSessionScopeKey(context);
  const backend = getActiveBackend(scopeKey);
  const scopeWorkdir = getWorkdirForScope(scopeKey);
  const scopeAccessMode = getAccessModeForScope(scopeKey);
  const currentSession = getSessionForContext(context, scopeWorkdir, backend);
  const tokenUsage = ensureSessionTokenUsage(currentSession);
  const qqEntries = Array.from(qqBots.values()).map((b) => ({ id: b.id, name: b.name, ready: b.ready }));
  const weixinEntries = Array.from(weixinBots.values()).map((b) => ({ id: b.accountId, name: b.name, ready: b.ready }));
  const activeBotId = sanitizeText(context && context.botId);
  const activeAccountId = sanitizeText(context && context.accountId);
  const activeQQBot = activeBotId ? qqBots.get(activeBotId) : null;
  const activeWeixinBot = activeAccountId ? weixinBots.get(activeAccountId) : null;
  const currentClientLabel = context && context.platform === 'weixin'
    ? `微信 ${activeWeixinBot ? activeWeixinBot.name : (activeAccountId || '(未知)')}`
    : `QQ ${activeQQBot ? activeQQBot.name : (activeBotId || '(未知)')}`;
  const callerSessionKey = sessionIdentityForContext(context, backend);
  const callerQueueDepth = queueDepthForSession(callerSessionKey);
  const callerRunActive = activeRuns.has(callerSessionKey);
  const callerPending = findPendingApprovalByScope(scopeKey);
  const lines = [
    '运行状态：',
    `当前接入：${currentClientLabel}`,
    `QQ 机器人：${formatClientStatuses(qqEntries, '未配置')}`,
    `微信账号：${WEIXIN_ENABLED ? formatClientStatuses(weixinEntries, '无已登录账号') : '已禁用'}`,
    `当前后端：${BACKEND_LABELS[backend]}`,
    `当前会话是否在跑：${callerRunActive ? '是' : '否'}`,
    `当前会话队列：${callerQueueDepth}`,
    `全局并发：${activeRuns.size}/${MAX_CONCURRENCY}（总排队 ${totalQueuedTasks()} 条）`,
    `当前目录会话已建立：${currentSession.hasConversation ? '是' : '否'}`,
    `已缓存目录会话：${countActiveSessions()}`,
    `存在待审批（当前聊天）：${callerPending ? '是' : '否'}`,
    `工作目录：${scopeWorkdir}`,
    `权限模式：${VALID_ACCESS_MODES.get(scopeAccessMode).label}（全局默认：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}）`
  ];

  if (backend === 'codex') {
    const contextWindow = getEffectiveCodexContextWindow();
    const autoCompactTokenLimit = getEffectiveCodexAutoCompactTokenLimit();
    lines.push(
      `Runner CODEX_HOME：${RUNNER_CODEX_HOME || '继承系统默认'}`,
      `Codex 上下文窗口：${formatCodexConfigValue(contextWindow, {
        overridden: Boolean(CODEX_CONTEXT_WINDOW_OVERRIDE)
      })}`,
      `Codex 自动压缩阈值：${formatCodexConfigValue(autoCompactTokenLimit, {
        overridden: Boolean(CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE)
      })}`,
      `自动压缩状态：${getCodexAutoCompactStatus()}`
    );
  } else {
    const permissionMode = CLAUDE_PERMISSION_MODE_BY_ACCESS[scopeAccessMode] || 'default';
    lines.push(
      `Runner CLAUDE_CONFIG_DIR：${RUNNER_CLAUDE_HOME || '继承系统默认'}`,
      `Claude 权限模式：${permissionMode}`
    );
    for (const extra of formatClaudeContextLines(currentSession)) {
      lines.push(extra);
    }
  }

  lines.push(
    `${backend === 'claude' ? '最近一次执行 Token（CLI 调用累计含内部多轮）' : '最近一轮 Token'}：${formatTokenUsage(tokenUsage.lastUsage)}`
  );
  return lines.join('\n');
}

function getQueueMessage() {
  const lines = [
    '队列状态：',
    `全局并发：${activeRuns.size}/${MAX_CONCURRENCY}`,
    `总排队任务：${totalQueuedTasks()}`,
    `活跃会话：${activeRuns.size}`
  ];
  if (activeRuns.size > 0) {
    lines.push('正在执行：');
    for (const run of activeRuns.values()) {
      const backendLabel = BACKEND_LABELS[run.backend] || run.backend;
      const taskKind = run.task && run.task.kind === 'approval' ? '审批任务' : '普通任务';
      lines.push(`  · ${run.session.scopeKey} [${backendLabel}] ${taskKind}`);
    }
  }
  if (sessionQueues.size > 0) {
    lines.push('等待队列：');
    for (const [sessionKey, queue] of sessionQueues.entries()) {
      if (queue.length === 0) continue;
      const sample = queue[0];
      const backendLabel = BACKEND_LABELS[sample && sample.backend] || (sample && sample.backend) || 'codex';
      lines.push(`  · ${sessionKey.split('::')[0]} [${backendLabel}] × ${queue.length}`);
    }
  }
  return lines.join('\n');
}

function getSessionMessage(context) {
  const scopeKey = getContextSessionScopeKey(context);
  const backend = getActiveBackend(scopeKey);
  const scopeWorkdir = getWorkdirForScope(scopeKey);
  const scopeAccessMode = getAccessModeForScope(scopeKey);
  const currentSession = getSessionForContext(context, scopeWorkdir, backend);
  const tokenUsage = ensureSessionTokenUsage(currentSession);
  const threadLabel = backend === 'claude' ? 'Session ID' : '线程 ID';
  const callerSessionKey = sessionIdentityForContext(context, backend);
  const callerQueueDepth = queueDepthForSession(callerSessionKey);
  const callerRunActive = activeRuns.has(callerSessionKey);
  const callerPendingEntry = findPendingApprovalByScope(scopeKey);
  const callerPending = callerPendingEntry ? callerPendingEntry.approval : null;
  const lines = [
    '会话状态：',
    `当前会话键：${currentSession.scopeKey}`,
    `当前后端：${BACKEND_LABELS[backend]}`,
    `当前目录会话已建立：${currentSession.hasConversation ? '是' : '否'}`,
    `该会话是否在跑：${callerRunActive ? '是' : '否'}`,
    `该会话队列：${callerQueueDepth}`,
    `当前目录会话代次：${currentSession.generation}`,
    `当前目录${threadLabel}：${currentSession.threadId || '无'}`,
    `已缓存目录会话：${countActiveSessions()}`,
    `存在待审批（当前聊天）：${callerPending ? '是' : '否'}`,
    `工作目录：${scopeWorkdir}`,
    `权限模式：${VALID_ACCESS_MODES.get(scopeAccessMode).label}`
  ];

  if (backend === 'codex') {
    const autoCompactTokenLimit = getEffectiveCodexAutoCompactTokenLimit();
    lines.push(
      `Runner CODEX_HOME：${RUNNER_CODEX_HOME || '继承系统默认'}`,
      `Codex 自动压缩阈值：${formatCodexConfigValue(autoCompactTokenLimit, {
        overridden: Boolean(CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE)
      })}`
    );
  } else {
    const permissionMode = CLAUDE_PERMISSION_MODE_BY_ACCESS[scopeAccessMode] || 'default';
    lines.push(
      `Runner CLAUDE_CONFIG_DIR：${RUNNER_CLAUDE_HOME || '继承系统默认'}`,
      `Claude 权限模式：${permissionMode}`
    );
    for (const extra of formatClaudeContextLines(currentSession)) {
      lines.push(extra);
    }
  }

  lines.push(
    `${backend === 'claude' ? '最近一次执行 Token（CLI 调用累计含内部多轮）' : '最近一轮 Token'}：${formatTokenUsage(tokenUsage.lastUsage)}`
  );
  if (callerPending) {
    lines.push(`待审批命令：${callerPending.command}`);
  }
  return lines.join('\n');
}

function getWorkdirMessage(context) {
  const scopeKey = context ? getContextSessionScopeKey(context) : '';
  const scopeWorkdir = scopeKey ? getWorkdirForScope(scopeKey) : runnerState.workdir;
  const lines = [
    '工作目录状态：',
    `当前聊天目录：${scopeWorkdir}`
  ];
  if (scopeWorkdir !== runnerState.workdir) {
    lines.push(`全局默认：${runnerState.workdir}`);
  }
  lines.push(
    runnerState.addDirs.length > 0
      ? `附加可写目录：${runnerState.addDirs.join(', ')}`
      : '附加可写目录：无'
  );
  return lines.join('\n');
}

function getAccessMessage(context) {
  const scopeKey = context ? getContextSessionScopeKey(context) : '';
  const scopeMode = scopeKey ? getAccessModeForScope(scopeKey) : runnerState.accessMode;
  const lines = [
    '权限模式：',
    `当前聊天模式：${VALID_ACCESS_MODES.get(scopeMode).label}`
  ];
  if (scopeMode !== runnerState.accessMode) {
    lines.push(`全局默认：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}`);
  }
  lines.push('可选模式：read / write / safe / full');
  return lines.join('\n');
}

function buildContext(eventType, message, source = {}) {
  if (eventType === 'WEIXIN_MESSAGE_CREATE') {
    const accountId = sanitizeText(source.accountId) || 'default';
    const peerId = sanitizeText(message && message.from_user_id);
    return {
      platform: 'weixin',
      type: 'weixin',
      accountId,
      peerId,
      contextToken: sanitizeText(message && message.context_token),
      messageId: String(
        (message && (message.message_id || message.seq || message.session_id || Date.now())) || Date.now()
      ),
      sessionScopeKey: `weixin:${accountId}:direct:${peerId || 'unknown'}`
    };
  }

  const botId = sanitizeText(source.botId) || 'default';

  if (eventType === 'C2C_MESSAGE_CREATE') {
    const openid =
      message && message.author
        ? message.author.user_openid || message.author.union_openid || message.author.id
        : null;
    return {
      platform: 'qq',
      type: 'c2c',
      botId,
      openid,
      messageId: message.id,
      sessionScopeKey: `qq:${botId}:c2c:${sanitizeText(openid) || 'unknown'}`
    };
  }

  return {
    platform: 'qq',
    type: 'channel',
    botId,
    channelId: message.channel_id,
    messageId: message.id,
    sessionScopeKey: `qq:${botId}:channel:${sanitizeText(message && message.channel_id) || 'unknown'}`
  };
}

async function sendReply(context, content) {
  const parts = splitMessage(content, MAX_BOT_MESSAGE_LENGTH);
  for (const part of parts) {
    if (context.platform === 'weixin') {
      const accountId = sanitizeText(context.accountId);
      const client = accountId ? weixinBots.get(accountId) : null;
      if (!client) {
        throw new Error(`Weixin client is not configured for account: ${accountId || '(unknown)'}`);
      }
      await client.sendTextMessage(
        context.peerId,
        part,
        client.getContextToken(context.peerId) || context.contextToken || null
      );
      continue;
    }

    const botId = sanitizeText(context.botId);
    const qqClient = botId ? qqBots.get(botId) : null;
    if (!qqClient) {
      throw new Error(`QQ bot is not configured for id: ${botId || '(unknown)'}`);
    }

    if (context.type === 'c2c') {
      await qqClient.sendC2CMessage(context.openid, {
        content: part,
        msg_id: context.messageId,
        msg_type: 0,
        msg_seq: nextMsgSeq()
      });
      continue;
    }

    await qqClient.sendChannelMessage(context.channelId, {
      content: part,
      msg_id: context.messageId
    });
  }
}

async function safeSendReply(context, content) {
  try {
    await sendReply(context, content);
  } catch (error) {
    log(`Failed to send reply: ${error && error.message ? error.message : String(error)}`);
  }
}

// Wire safeSendReply into the exec layer so progress reporter and
// claude.js's session-not-found recovery message can write to chat.
setSendReplyImpl(safeSendReply);

async function resetCodexSession(context) {
  const scopeKey = getContextSessionScopeKey(context);
  const session = getSessionForContext(context);
  const sessionKey = buildSessionIdentity(session.scopeKey, session.workdir, session.backend);
  resetSessionState(session);
  pendingApprovals.delete(sessionKey);
  clearQueueForSession(sessionKey);
  stopActiveRun(sessionKey);
  clearRecentWorkdirSearch(scopeKey);
  persistRunnerState();

  await safeSendReply(context, '当前会话已重置，下一条消息会启动新的对话。');
}

async function restartRunner(context) {
  stopAllActiveRuns();
  pendingApprovals.clear();
  clearAllQueues();
  clearAllRecentWorkdirSearches();
  codexSessions.clear();
  persistRunnerState();

  await safeSendReply(context, 'Runner 状态已重启：已停止所有任务、清空所有队列并重置全部会话。');
}

async function switchWorkdir(context, rawDir, options = {}) {
  const resolved = resolveInputPath(rawDir);
  const scopeKey = getContextSessionScopeKey(context);
  const currentDir = getWorkdirForScope(scopeKey);
  const { fromSearchSelection = false } = options;

  if (resolved === currentDir) {
    clearRecentWorkdirSearch(scopeKey);
    await safeSendReply(context, `当前已经在该目录：${resolved}`);
    return;
  }

  clearRecentWorkdirSearch(scopeKey);
  setWorkdirForScope(scopeKey, resolved);
  const targetSession = getSessionForContext(context, resolved);
  persistRunnerState();

  const switchHint = fromSearchSelection
    ? '已根据搜索结果切换当前聊天的工作目录（热切，已在跑的任务按原目录跑完）。'
    : '已切换当前聊天的工作目录（热切，已在跑的任务按原目录跑完）。';
  const sessionHint = targetSession.hasConversation
    ? '已恢复该目录之前的会话。'
    : '这是该目录的首次会话，下一条消息会新开对话。';
  await safeSendReply(context, `${switchHint}\n当前目录：${resolved}\n${sessionHint}`);
}

async function handleWorkdirCommand(context, rawDir) {
  const target = sanitizeText(rawDir);
  if (!target) {
    await safeSendReply(context, getWorkdirMessage(context));
    return;
  }

  const resolved = resolveInputPath(target);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {}

  if (stat && stat.isDirectory()) {
    await switchWorkdir(context, resolved);
    return;
  }

  const scopeKey = getContextSessionScopeKey(context);
  const selection = getSearchSelection(scopeKey, target);
  if (selection) {
    await switchWorkdir(context, selection, { fromSearchSelection: true });
    return;
  }

  if (stat && !stat.isDirectory()) {
    await safeSendReply(context, `目标不是目录：${resolved}`);
    return;
  }

  const matches = searchLocalDirectories(target);
  setRecentWorkdirSearch(scopeKey, target, matches);
  await safeSendReply(context, formatWorkdirSearchMessage(target, matches));
}

function formatBackendCheck(check) {
  if (!check) return '未知';
  if (!check.ok) return `不可用（${check.message}）`;
  if (check.warn) return `可用（警告：${check.message}）`;
  return '可用';
}

async function handleBackendCommand(context, rawArg) {
  const scopeKey = getContextSessionScopeKey(context);
  const current = getActiveBackend(scopeKey);
  const normalized = sanitizeText(rawArg).toLowerCase();

  if (!normalized) {
    const [codexCheck, claudeCheck] = await Promise.all([
      checkBackendAvailability('codex'),
      checkBackendAvailability('claude')
    ]);
    const lines = [
      '后端状态：',
      `当前后端：${BACKEND_LABELS[current]}`,
      `Codex：${formatBackendCheck(codexCheck)}`,
      `Claude：${formatBackendCheck(claudeCheck)}`,
      '切换请发送 /backend codex 或 /backend claude。'
    ];
    await safeSendReply(context, lines.join('\n'));
    return;
  }

  if (!VALID_BACKENDS.has(normalized)) {
    await safeSendReply(context, `不支持的后端：${normalized}\n可选：codex / claude`);
    return;
  }

  if (normalized === current) {
    await safeSendReply(context, `当前已是 ${BACKEND_LABELS[normalized]} 后端。`);
    return;
  }

  const check = await checkBackendAvailability(normalized);
  if (!check.ok) {
    await safeSendReply(context, `切换到 ${BACKEND_LABELS[normalized]} 失败：${check.message}`);
    return;
  }

  setActiveBackend(scopeKey, normalized);
  persistRunnerState();
  const suffix = check.warn ? `\n注意：${check.message}` : '';
  const nextSession = getScopedSession(scopeKey, getWorkdirForScope(scopeKey), normalized);
  const sessionHint = nextSession.hasConversation
    ? `已恢复该后端之前的会话（线程 ${nextSession.threadId || '未知'}）。`
    : '这是该后端的首次会话，下一条消息会新开对话。';
  await safeSendReply(context, `已切换到 ${BACKEND_LABELS[normalized]} 后端。\n${sessionHint}${suffix}`);
}

async function switchAccessMode(context, rawMode) {
  const mode = sanitizeText(rawMode).toLowerCase();
  if (!mode) {
    await safeSendReply(context, getAccessMessage(context));
    return;
  }

  if (!VALID_ACCESS_MODES.has(mode)) {
    await safeSendReply(context, `不支持的权限模式：${mode}\n可选模式：read / write / safe / full`);
    return;
  }

  const scopeKey = getContextSessionScopeKey(context);
  const current = getAccessModeForScope(scopeKey);
  if (current === mode) {
    await safeSendReply(
      context,
      `当前聊天已是该权限模式：${VALID_ACCESS_MODES.get(mode).label}`
    );
    return;
  }

  setAccessModeForScope(scopeKey, mode);
  persistRunnerState();

  await safeSendReply(
    context,
    `当前聊天的权限模式已热切换为：${VALID_ACCESS_MODES.get(mode).label}\n已在跑的任务保持旧权限跑完；排队中的任务和下一条消息会以新权限启动；其他聊天不受影响。`
  );
}

async function enqueueMessage(eventType, message, source = {}) {
  if (!message) return;

  let input = '';
  if (eventType === 'WEIXIN_MESSAGE_CREATE') {
    if (Number(message.message_type || 0) !== 1) return;
    input = extractWeixinText(message);
  } else {
    if (!message.author) return;
    if (message.author.bot) return;
    const sourceBot = qqBots.get(sanitizeText(source.botId));
    if (sourceBot && String(message.author.id || '') === String(sourceBot.appId)) return;

    const rawContent = sanitizeText(message.content);
    input = eventType === 'AT_MESSAGE_CREATE' ? stripAtMentions(rawContent) : rawContent;
  }

  if (!input) return;

  const context = buildContext(eventType, message, source);
  if (context.platform === 'weixin' && context.contextToken) {
    const client = weixinBots.get(context.accountId);
    if (client) client.setContextToken(context.peerId, context.contextToken);
  }
  const [commandWord, ...restParts] = input.split(/\s+/);
  const commandArg = restParts.join(' ').trim();

  if (input === '/help') {
    await safeSendReply(context, getHelpMessage());
    return;
  }

  if (input === '/status') {
    await safeSendReply(context, getStatusMessage(context));
    return;
  }

  if (input === '/queue') {
    await safeSendReply(context, getQueueMessage());
    return;
  }

  if (input === '/session') {
    await safeSendReply(context, getSessionMessage(context));
    return;
  }

  if (commandWord === '/cwd') {
    await handleWorkdirCommand(context, commandArg);
    return;
  }

  if (commandWord === '/access') {
    await switchAccessMode(context, commandArg);
    return;
  }

  if (commandWord === '/backend') {
    await handleBackendCommand(context, commandArg);
    return;
  }

  if (input === '/new') {
    await resetCodexSession(context);
    return;
  }

  if (input === '/restart') {
    await restartRunner(context);
    return;
  }

  const scopeKey = context.sessionScopeKey;
  const scopedApprovalEntry = findPendingApprovalByScope(scopeKey);
  const scopedApproval = scopedApprovalEntry ? scopedApprovalEntry.approval : null;

  if (input === '/reject') {
    if (!scopedApproval) {
      await safeSendReply(context, '当前没有待审批的操作。');
      return;
    }
    await resetCodexSession(context);
    return;
  }

  if (input === '/allow' || input === '/skip') {
    if (!scopedApproval) {
      await safeSendReply(context, '当前没有待审批的操作。');
      return;
    }

    const approvalTask = {
      kind: 'approval',
      action: input === '/allow' ? 'allow' : 'skip',
      input,
      context,
      workdir: scopedApproval.workdir,
      sessionScopeKey: scopedApproval.sessionScopeKey,
      backend: scopedApproval.backend || 'codex',
      accessMode: scopedApproval.accessMode
        || getAccessModeForScope(scopedApproval.sessionScopeKey)
    };
    const approvalSessionKey = sessionIdentityForTask(approvalTask);
    enqueueToSessionQueue(approvalSessionKey, approvalTask, { priority: true });
    tickQueues();
    return;
  }

  if (scopedApproval) {
    await safeSendReply(context, '当前有待审批操作，请先回复 /allow、/skip 或 /reject。');
    return;
  }

  if (context.type === 'c2c' && !context.openid) {
    log(`Ignoring C2C message without openid: ${message.id}`);
    return;
  }

  if (context.platform === 'weixin' && !context.peerId) {
    log(`Ignoring Weixin message without peer id: ${context.messageId}`);
    return;
  }

  const task = {
    kind: 'user',
    action: null,
    input,
    context,
    workdir: getWorkdirForScope(context.sessionScopeKey),
    sessionScopeKey: context.sessionScopeKey,
    backend: getActiveBackend(context.sessionScopeKey),
    accessMode: getAccessModeForScope(context.sessionScopeKey)
  };
  const taskSessionKey = sessionIdentityForTask(task);
  const depthBefore = queueDepthForSession(taskSessionKey);
  const isSessionRunning = activeRuns.has(taskSessionKey);
  const queuedAhead = depthBefore + (isSessionRunning ? 1 : 0);
  enqueueToSessionQueue(taskSessionKey, task);
  if (queuedAhead > 0) {
    await safeSendReply(context, `已加入该会话队列，前面还有 ${queuedAhead} 个任务。`);
  } else if (activeRuns.size >= MAX_CONCURRENCY) {
    await safeSendReply(context, `已加入队列，全局并发 ${activeRuns.size}/${MAX_CONCURRENCY} 已满，待空闲槽释放后执行。`);
  }
  tickQueues();
}

module.exports = {
  checkBackendAvailability,
  getWorkdirSearchRoots,
  shouldSkipSearchDir,
  shouldSkipSearchPath,
  isDirectoryPath,
  normalizeDirectoryMatches,
  escapeMdfindQueryValue,
  searchDirectoriesWithMdfind,
  searchLocalDirectoriesByTraversal,
  searchLocalDirectories,
  formatWorkdirSearchMessage,
  getHelpMessage,
  formatClientStatuses,
  getStatusMessage,
  getQueueMessage,
  getSessionMessage,
  getWorkdirMessage,
  getAccessMessage,
  buildContext,
  sendReply,
  safeSendReply,
  resetCodexSession,
  restartRunner,
  switchWorkdir,
  handleWorkdirCommand,
  formatBackendCheck,
  handleBackendCommand,
  switchAccessMode,
  enqueueMessage
};
