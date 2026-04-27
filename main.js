#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const {
  loadDotEnv,
  parseBoolean,
  requireEnv,
  sanitizeText,
  parseList,
  expandHomeDir,
  resolveInputPath,
  stripAtMentions,
  splitMessage,
  log,
  parsePositiveInteger,
  getPositiveIntegerEnv,
  escapeRegExp,
  readTopLevelTomlValue,
  nextMsgSeq,
  requestJson,
  requestJsonWithTimeout,
  sleep,
  requestTextWithTimeout,
  normalizeTokenUsage,
  addTokenUsage,
  formatTokenNumber,
  formatTokenUsage,
  compactWhitespace
} = require('./src/util');

loadDotEnv();

const {
  usage,
  parseArgs,
  INTENT_FLAGS,
  parseIntents,
  intentsToBitmask,
  prepareCodexHome,
  VALID_ACCESS_MODES,
  VALID_BACKENDS,
  BACKEND_LABELS,
  CLAUDE_PERMISSION_MODE_BY_ACCESS,
  MAX_BOT_MESSAGE_LENGTH,
  PROGRESS_HEARTBEAT_INTERVAL_MS,
  BACKEND_PROBE_TIMEOUT_MS,
  MAX_WORKDIR_SEARCH_RESULTS,
  MAX_WORKDIR_SEARCH_DIRS,
  WORKDIR_SYSTEM_SEARCH_TIMEOUT_MS,
  WORKDIR_SYSTEM_SEARCH_MAX_BUFFER,
  PERSIST_DEBOUNCE_MS,
  WORKDIR_SEARCH_SKIP_NAMES,
  loadRuntimeConfig
} = require('./src/config');

const {
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_DISABLED,
  MAX_CONCURRENCY,
  PRIMARY_CODEX_HOME,
  RUNNER_CODEX_HOME,
  CODEX_CONTEXT_WINDOW_OVERRIDE,
  CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE,
  CLAUDE_BIN,
  RUNNER_CLAUDE_HOME,
  DEFAULT_BACKEND,
  DEFAULT_WORKDIR,
  DEFAULT_ADD_DIRS,
  WEIXIN_ENABLED,
  WEIXIN_ACCOUNT_ID,
  RUNNER_STATE_FILE
} = loadRuntimeConfig();

const {
  QQBotClient,
  loadQQBotConfigs,
  createQQBotClientFromConfig
} = require('./src/qq');

const {
  runnerState,
  weixinState,
  sessionQueues,
  activeRuns,
  pendingApprovals,
  codexSessions,
  recentWorkdirSearches,
  qqBots,
  weixinBots,
  parseExecJsonEvents,
  parseExecJsonEventLine,
  extractTokenUsageFromExecEvents,
  extractThreadIdFromExecEvents,
  getCodexConfigFilePath,
  getCodexSessionsDirPath,
  getEffectiveCodexContextWindow,
  getEffectiveCodexAutoCompactTokenLimit,
  formatCodexConfigValue,
  getCodexAutoCompactStatus,
  findCodexRolloutFileByThreadId,
  loadPersistedTokenUsageByThreadId,
  loadPersistedRunnerState,
  deriveInitialRunnerState,
  deriveInitialWeixinState,
  resolveExistingDirectory,
  buildPersistedRunnerState,
  persistRunnerState,
  persistRunnerStateNow,
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
  createCodexSessionState,
  getScopedSession,
  getSessionForContext,
  hydratePersistedCodexSessions,
  countActiveSessions,
  ensureSessionTokenUsage,
  bumpSessionGeneration,
  resetSessionState,
  stopActiveRun,
  stopAllActiveRuns,
  anyRunBusy,
  totalQueuedTasks,
  queueDepthForSession,
  enqueueToSessionQueue,
  clearQueueForSession,
  clearAllQueues,
  findPendingApprovalByScope,
  clearRecentWorkdirSearch,
  clearAllRecentWorkdirSearches,
  setRecentWorkdirSearch,
  getRecentWorkdirSearch,
  getSearchSelection,
  buildWeixinContextTokenKey,
  syncWeixinStateFromDisk,
  startRunnerStateWatcher,
  stopRunnerStateWatcher
} = require('./src/state');

const {
  WeixinClient,
  parseWeixinAccountWhitelist,
  parseWeixinAccountNames,
  defaultWeixinDisplayName,
  extractWeixinText,
  fetchWeixinQrCode,
  pollWeixinQrStatus,
  runWeixinLoginFlow,
  getStoredWeixinAccount,
  setStoredWeixinAccount,
  clearStoredWeixinAccount,
  resolveWeixinRuntimeAccount,
  getDesiredWeixinAccounts,
  refreshWeixinClients
} = require('./src/weixin');

function summarizeExecFailure(stderr, stdout) {
  const combined = sanitizeText([stderr, stdout].filter(Boolean).join('\n'));
  if (!combined) return 'Codex did not return readable output.';
  return combined.split('\n').slice(-12).join('\n');
}

function summarizeCommandForProgress(commandText) {
  const normalized = compactWhitespace(commandText);
  if (!normalized) return '正在执行终端命令';
  if (normalized.length <= 80) {
    return `正在执行命令：${normalized}`;
  }
  return `正在执行命令：${normalized.slice(0, 77)}...`;
}

function describeFunctionCallForProgress(name, argumentsText) {
  const normalizedName = sanitizeText(name);
  if (!normalizedName) return '';

  if (normalizedName === 'exec_command') {
    try {
      const parsed = JSON.parse(argumentsText || '{}');
      return summarizeCommandForProgress(parsed.cmd);
    } catch (_) {
      return '正在执行终端命令';
    }
  }

  if (normalizedName === 'write_stdin') {
    return '正在等待终端命令输出';
  }
  if (normalizedName === 'apply_patch') {
    return '正在修改文件';
  }
  if (normalizedName === 'parallel') {
    return '正在并行收集信息';
  }
  if (normalizedName === 'spawn_agent') {
    return '正在分派子任务';
  }
  if (normalizedName === 'wait_agent') {
    return '正在等待子任务结果';
  }
  if (normalizedName === 'send_input') {
    return '正在向子任务补充信息';
  }
  if (normalizedName === 'open' || normalizedName === 'click' || normalizedName === 'find') {
    return '正在读取页面内容';
  }
  if (normalizedName === 'search_query' || normalizedName === 'image_query') {
    return '正在搜索资料';
  }
  if (normalizedName === 'finance') {
    return '正在查询行情';
  }
  if (normalizedName === 'weather') {
    return '正在查询天气';
  }
  if (normalizedName === 'sports') {
    return '正在查询赛程数据';
  }
  if (normalizedName === 'time') {
    return '正在查询时间信息';
  }

  return `正在调用工具：${normalizedName}`;
}

function extractProgressUpdateFromExecEvent(event) {
  if (!event || typeof event !== 'object') return null;

  if (sanitizeText(event.type) === 'item.started' || sanitizeText(event.type) === 'item.completed') {
    const item = event.item;
    if (!item || typeof item !== 'object') return null;

    if (sanitizeText(item.type) === 'agent_message') {
      const message = sanitizeText(item.text);
      if (!message) return null;
      return {
        kind: 'agent_message',
        message,
        activitySummary: compactWhitespace(message)
      };
    }

    if (sanitizeText(item.type) === 'command_execution') {
      const summary = summarizeCommandForProgress(item.command);
      return {
        kind: 'command_execution',
        message: '',
        activitySummary: summary
      };
    }
  }

  if (sanitizeText(event.type) === 'event_msg') {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return null;

    if (sanitizeText(payload.type) === 'agent_message' && sanitizeText(payload.phase) === 'commentary') {
      const message = sanitizeText(payload.message);
      if (!message) return null;
      return {
        kind: 'agent_message',
        message,
        activitySummary: compactWhitespace(message)
      };
    }

    if (sanitizeText(payload.type) === 'task_started') {
      return {
        kind: 'task_started',
        message: '',
        activitySummary: '任务已启动，正在整理上下文'
      };
    }

    return null;
  }

  if (sanitizeText(event.type) === 'response_item') {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return null;
    if (sanitizeText(payload.type) !== 'function_call') return null;

    const activitySummary = describeFunctionCallForProgress(payload.name, payload.arguments);
    if (!activitySummary) return null;
    return {
      kind: 'function_call',
      message: '',
      activitySummary
    };
  }

  return null;
}

function formatProgressReply(message) {
  const normalized = sanitizeText(message);
  if (!normalized) return '';
  return `进度：\n${normalized}`;
}

function normalizeClaudeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = Math.max(0, Number(value.input_tokens || 0) || 0);
  const cacheCreation = Math.max(0, Number(value.cache_creation_input_tokens || 0) || 0);
  const cacheRead = Math.max(0, Number(value.cache_read_input_tokens || 0) || 0);
  const output = Math.max(0, Number(value.output_tokens || 0) || 0);
  if (input === 0 && cacheCreation === 0 && cacheRead === 0 && output === 0) return null;
  return normalizeTokenUsage({
    input_tokens: input + cacheCreation,
    cached_input_tokens: cacheRead,
    output_tokens: output,
    total_tokens: input + cacheCreation + cacheRead + output
  });
}

function extractSessionIdFromClaudeEvents(events) {
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (sanitizeText(event.type) === 'system' && sanitizeText(event.subtype) === 'init') {
      const sid = sanitizeText(event.session_id);
      if (sid) return sid;
    }
  }
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (sanitizeText(event.type) === 'result') {
      const sid = sanitizeText(event.session_id);
      if (sid) return sid;
    }
  }
  return null;
}

function extractFinalMessageFromClaudeEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || sanitizeText(event.type) !== 'result') continue;
    if (event.is_error) return '';
    const text = sanitizeText(event.result);
    if (text) return text;
  }
  const textParts = [];
  for (const event of events) {
    if (!event || sanitizeText(event.type) !== 'assistant') continue;
    const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const normalized = sanitizeText(block.text);
        if (normalized) textParts.push(normalized);
      }
    }
  }
  return sanitizeText(textParts.join('\n'));
}

function extractClaudeErrorFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || sanitizeText(event.type) !== 'result') continue;
    const subtype = sanitizeText(event.subtype);
    if (!event.is_error && subtype !== 'error' && !subtype.startsWith('error')) continue;
    if (Array.isArray(event.errors) && event.errors.length > 0) {
      const combined = event.errors.map((entry) => sanitizeText(entry)).filter(Boolean).join('; ');
      if (combined) return combined;
    }
    const direct = sanitizeText(event.result || event.error || event.message);
    if (direct) return direct;
    return 'Claude 返回错误但未提供详细信息';
  }
  return '';
}

function isClaudeSessionNotFoundError(message) {
  return /no\s+conversation\s+found/i.test(String(message || ''));
}

function extractTokenUsageFromClaudeEvents(events) {
  const state = { lastUsage: null, totalUsage: null };
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (sanitizeText(event.type) === 'result' && event.usage) {
      const usage = normalizeClaudeUsage(event.usage);
      if (usage) state.lastUsage = usage;
    }
  }
  return state;
}

function extractClaudeResultMeta(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || sanitizeText(event.type) !== 'result') continue;
    return {
      numTurns: Number(event.num_turns || 0) || 0,
      durationMs: Number(event.duration_ms || 0) || 0,
      apiDurationMs: Number(event.duration_api_ms || 0) || 0,
      totalCostUsd: Number(event.total_cost_usd || 0) || 0,
      currentContextTokens: extractLastTurnContextSize(events)
    };
  }
  return null;
}

function extractLastTurnContextSize(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || sanitizeText(event.type) !== 'assistant') continue;
    const usage = event.message && event.message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const input = Math.max(0, Number(usage.input_tokens || 0) || 0);
    const cacheCreation = Math.max(0, Number(usage.cache_creation_input_tokens || 0) || 0);
    const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens || 0) || 0);
    const total = input + cacheCreation + cacheRead;
    if (total > 0) return total;
  }
  return 0;
}

function formatClaudeContextLines(session) {
  const meta = session && session.lastClaudeMeta;
  const lines = [];
  if (meta) {
    if (meta.currentContextTokens > 0) {
      lines.push(`当前上下文：${formatTokenNumber(meta.currentContextTokens)} tokens`);
    }
    const parts = [];
    if (meta.numTurns > 0) parts.push(`内部轮数 ${meta.numTurns}`);
    if (meta.durationMs > 0) parts.push(`耗时 ${(meta.durationMs / 1000).toFixed(1)}s`);
    if (meta.totalCostUsd > 0) parts.push(`成本 $${meta.totalCostUsd.toFixed(4)}`);
    if (parts.length > 0) {
      lines.push(`本次执行：${parts.join('，')}`);
    }
  }
  return lines;
}

function describeClaudeToolForProgress(name, input) {
  const tool = sanitizeText(name);
  if (!tool) return '';
  if (tool === 'Bash') {
    if (input && typeof input === 'object') {
      const cmd = sanitizeText(input.command);
      if (cmd) return summarizeCommandForProgress(cmd);
    }
    return '正在执行终端命令';
  }
  if (tool === 'Read') return '正在读取文件';
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') {
    return '正在修改文件';
  }
  if (tool === 'Glob' || tool === 'Grep') return '正在搜索文件';
  if (tool === 'WebFetch') return '正在读取网页';
  if (tool === 'WebSearch') return '正在搜索资料';
  if (tool === 'TodoWrite') return '正在更新任务清单';
  if (tool === 'Task') return '正在分派子任务';
  if (tool === 'Agent') return '正在分派子代理';
  return `正在调用工具：${tool}`;
}

function extractProgressUpdateFromClaudeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = sanitizeText(event.type);
  if (type === 'system' && sanitizeText(event.subtype) === 'init') {
    return {
      kind: 'task_started',
      message: '',
      activitySummary: '任务已启动，正在整理上下文'
    };
  }
  if (type !== 'assistant') return null;
  const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') {
      const summary = describeClaudeToolForProgress(block.name, block.input);
      if (!summary) continue;
      return {
        kind: 'command_execution',
        message: '',
        activitySummary: summary
      };
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text);
      if (!text) continue;
      return {
        kind: 'agent_message',
        message: '',
        activitySummary: compactWhitespace(text)
      };
    }
  }
  return null;
}

function parseApprovalRequest(message) {
  const match = String(message || '').match(
    /<approval_request>\s*<command>([\s\S]*?)<\/command>\s*<reason>([\s\S]*?)<\/reason>\s*<\/approval_request>/i
  );
  if (!match) return null;
  const command = sanitizeText(match[1]);
  const reason = sanitizeText(match[2]);
  if (!command) return null;
  return { command, reason };
}

function spawnProbeVersion(bin, args = ['--version'], timeoutMs = BACKEND_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({
        ok: false,
        error: (error && error.code) || 'SPAWN_FAILED',
        message: error && error.message ? error.message : String(error)
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ ok: false, error: 'TIMEOUT', stdout, stderr });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        error: (error && error.code) || 'ERROR',
        message: error && error.message ? error.message : String(error),
        stdout,
        stderr
      });
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function summarizeProbeFailure(probe) {
  const detail = sanitizeText(probe.message || probe.stderr || probe.stdout || '');
  if (!detail) return probe.error || 'unknown';
  return detail.split('\n').slice(-3).join('\n');
}

async function checkBackendAvailability(backend) {
  if (backend === 'codex') {
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

function describeBackendRuntimeError(backend, stderr, stdout) {
  const combined = sanitizeText([stderr, stdout].filter(Boolean).join('\n')).toLowerCase();
  if (!combined) return '';
  const authPatterns = [
    /\b401\b/,
    /\b403\b/,
    /unauthoriz/,
    /unauthenticat/,
    /invalid[\s_-]*api[\s_-]*key/,
    /not\s*logged\s*in/,
    /please\s*log\s*in/,
    /authentication\s*failed/,
    /expired[\s_-]*token/,
    /credential/
  ];
  if (!authPatterns.some((pattern) => pattern.test(combined))) return '';
  if (backend === 'claude') {
    return '\n提示：疑似 Claude 认证问题。请运行 `claude login`，或检查 ANTHROPIC_API_KEY / CLAUDE_CONFIG_DIR 是否有效。';
  }
  return '\n提示：疑似 Codex 认证问题。请运行 `codex login`，或检查 OPENAI_API_KEY / CODEX_HOME 是否有效。';
}








const APPROVAL_POLICY_PROMPT = [
  'You are working through a chat bot runner.',
  'Use normal Codex behavior for low-risk read-only work.',
  'If you need to run a higher-risk shell command, do not execute it immediately.',
  'Instead, output exactly this block and nothing else:',
  '<approval_request>',
  '<command>full command</command>',
  '<reason>one short reason</reason>',
  '</approval_request>',
  'When the user later replies /allow, continue and execute that approved command.',
  'When the user replies /skip, do not execute that command and try another path.',
  'When the user replies /reject, cancel the current task.'
].join('\n');

function buildAgentPolicyPrompt(accessMode) {
  const mode = sanitizeText(accessMode).toLowerCase() || runnerState.accessMode;
  if (mode === 'full') {
    return [
      '你正在通过聊天机器人与用户协作。',
      '当前权限模式是完全访问。',
      '你可以直接执行完成任务所需的操作。'
    ].join('\n');
  }

  return APPROVAL_POLICY_PROMPT;
}

function buildUserPrompt(input, options = {}) {
  return buildChatTurnPrompt(input, options);
}

function buildApprovalPrompt(action, pendingApproval, options = {}) {
  return buildApprovalTurnPrompt(action, pendingApproval, options);
}

loadDotEnv();

const { command, codexArgs, mode, weixinAccountId, weixinLoginForce, weixinName, forceAccessMode } = parseArgs(process.argv.slice(2));

function buildChatTurnPrompt(input, options = {}) {
  const includePolicy = options.includePolicy !== false;
  const backend = options.backend || 'codex';
  const accessMode = options.accessMode;
  const parts = [];
  if (includePolicy && backend === 'codex') {
    parts.push(buildAgentPolicyPrompt(accessMode), '');
  }
  parts.push(`[User message]\n${input}\n[/User message]`);
  return parts.join('\n');
}

function buildApprovalTurnPrompt(action, approval, options = {}) {
  const includePolicy = options.includePolicy !== false;
  const accessMode = options.accessMode;
  const parts = [];
  if (includePolicy) {
    parts.push(buildAgentPolicyPrompt(accessMode), '');
  }

  if (!approval) {
    return parts.join('\n').trim();
  }

  if (action === 'allow') {
    parts.push(
      'The user approved your last requested command.',
      `Approved command: ${approval.command}`,
      `Reason: ${approval.reason || 'not provided'}`,
      'Continue the original task.'
    );
    return parts.join('\n');
  }

  parts.push(
    'The user rejected the last requested command for execution.',
    `Blocked command: ${approval.command}`,
    'Continue the original task without executing that command.'
  );
  return parts.join('\n');
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

function createProgressReporter(context, parseEvent = extractProgressUpdateFromExecEvent) {
  let closed = false;
  let lastSentMessage = '';
  let lastSentAt = 0;
  let lastActivitySummary = '仍在处理中，请稍候。';
  let sawCommandExecution = false;
  let sendChain = Promise.resolve();
  let heartbeatTimer = null;

  const queueSend = (message, options = {}) => {
    const normalized = sanitizeText(message);
    if (!normalized || closed) return;
    if (!options.force && normalized === lastSentMessage) return;

    sendChain = sendChain
      .catch(() => {})
      .then(async () => {
        if (closed) return;
        lastSentMessage = normalized;
        lastSentAt = Date.now();
        await safeSendReply(context, normalized);
      });
  };

  return {
    start() {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastSentAt < PROGRESS_HEARTBEAT_INTERVAL_MS) return;
        queueSend(formatProgressReply(lastActivitySummary));
      }, PROGRESS_HEARTBEAT_INTERVAL_MS);
    },
    handleEvent(event) {
      const progress = parseEvent(event);
      if (!progress) return;
      if (sanitizeText(progress.activitySummary)) {
        lastActivitySummary = sanitizeText(progress.activitySummary);
      }
      if (progress.kind === 'command_execution') {
        sawCommandExecution = true;
      }
      if (sanitizeText(progress.message)) {
        if (progress.kind === 'agent_message' && sawCommandExecution) {
          return;
        }
        queueSend(formatProgressReply(progress.message));
      }
    },
    async stop() {
      closed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      await sendChain.catch(() => {});
    }
  };
}

function buildCodexArgs(prompt, outputFile, session, workdir, accessMode) {
  const args = ['exec'];
  const mode = sanitizeText(accessMode).toLowerCase() || runnerState.accessMode;
  const accessConfig = VALID_ACCESS_MODES.get(mode) || VALID_ACCESS_MODES.get('safe');
  args.push('-C', workdir);
  args.push('-s', accessConfig.sandbox);
  if (CODEX_CONTEXT_WINDOW_OVERRIDE) {
    args.push('-c', `model_context_window=${CODEX_CONTEXT_WINDOW_OVERRIDE}`);
  }
  if (CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE) {
    args.push('-c', `model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE}`);
  }
  for (const addDir of runnerState.addDirs) {
    args.push('--add-dir', addDir);
  }
  if (accessConfig.bypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (session && session.hasConversation && session.threadId) {
    args.push('resume', session.threadId);
  }
  args.push('--skip-git-repo-check', '--json', '--output-last-message', outputFile);
  args.push(...codexArgs);
  args.push(prompt);
  return args;
}

function runAgentChildProcess(options) {
  const {
    bin,
    args,
    cwd,
    env,
    session,
    run,
    context,
    parseEvent,
    timeoutLabel,
    spawnErrorMapper,
    onSuccess
  } = options;

  return new Promise((resolve, reject) => {
    const generation = session.generation;
    const progressReporter = createProgressReporter(context, parseEvent);

    let child;
    try {
      child = childProcess.spawn(bin, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      void progressReporter.stop().then(() => {
        const mapped = spawnErrorMapper ? spawnErrorMapper(error) : null;
        reject(mapped || error);
      });
      return;
    }

    if (run) run.child = child;

    let stdout = '';
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let timeout = null;

    const clearExecTimeout = () => {
      if (!timeout) return;
      clearTimeout(timeout);
      timeout = null;
    };

    const refreshExecTimeout = () => {
      if (EXEC_TIMEOUT_DISABLED || settled) return;
      clearExecTimeout();
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch (_) {}
        if (run) run.child = null;
        void progressReporter.stop().then(() => {
          if (generation !== session.generation) {
            resolve(null);
            return;
          }
          reject(new Error(
            `${timeoutLabel} execution timed out after ${Math.floor(
              EXEC_TIMEOUT_MS / 1000
            )} seconds without new output. You can increase CODEX_EXEC_TIMEOUT_MS or set it to 0 to disable this timeout.`
          ));
        });
      }, EXEC_TIMEOUT_MS);
    };

    refreshExecTimeout();
    progressReporter.start();

    const handleStdoutEvent = (event) => {
      if (!event) return;
      progressReporter.handleEvent(event);
    };

    child.stdout.on('data', (chunk) => {
      const text = String(chunk || '');
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        handleStdoutEvent(parseExecJsonEventLine(line));
      }
      refreshExecTimeout();
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
      refreshExecTimeout();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearExecTimeout();
      if (run) run.child = null;
      void (async () => {
        await progressReporter.stop();
        if (generation !== session.generation) {
          resolve(null);
          return;
        }
        const mapped = spawnErrorMapper ? spawnErrorMapper(error) : null;
        reject(mapped || error);
      })();
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearExecTimeout();
      if (run) run.child = null;
      void (async () => {
        handleStdoutEvent(parseExecJsonEventLine(stdoutBuffer));
        await progressReporter.stop();

        if (generation !== session.generation) {
          resolve(null);
          return;
        }

        if (signal) {
          reject(new Error(`${timeoutLabel} process exited with signal ${signal}.`));
          return;
        }

        const events = parseExecJsonEvents(stdout);
        try {
          const result = await onSuccess({ code, stdout, stderr, events });
          if (result && result.error) {
            reject(result.error);
            return;
          }
          resolve(result && result.reply ? result.reply : null);
        } catch (err) {
          reject(err);
        }
      })();
    });
  });
}

function runCodexExec(prompt, session, workdir, context, run, accessMode) {
  const outputFile = path.join(os.tmpdir(), `qq-codex-runner-last-${process.pid}-${Date.now()}.txt`);
  const args = buildCodexArgs(prompt, outputFile, session, workdir, accessMode);
  const env = { ...process.env, TERM: process.env.TERM || 'xterm-256color' };
  if (RUNNER_CODEX_HOME) env.CODEX_HOME = RUNNER_CODEX_HOME;

  return runAgentChildProcess({
    bin: command,
    args,
    cwd: workdir,
    env,
    session,
    run,
    context,
    parseEvent: extractProgressUpdateFromExecEvent,
    timeoutLabel: 'Codex',
    onSuccess: async ({ code, stdout, stderr, events }) => {
      let finalMessage = '';
      try { finalMessage = fs.readFileSync(outputFile, 'utf8'); } catch (_) {}
      try { fs.unlinkSync(outputFile); } catch (_) {}

      if (code !== 0) {
        const hint = describeBackendRuntimeError('codex', stderr, stdout);
        return { error: new Error(summarizeExecFailure(stderr, stdout) + hint) };
      }

      const threadId = extractThreadIdFromExecEvents(events);
      const tokenUsage = extractTokenUsageFromExecEvents(events);
      if (threadId) session.threadId = threadId;
      if (tokenUsage.lastUsage) session.lastTokenUsage = tokenUsage.lastUsage;
      if (tokenUsage.totalUsage) {
        session.totalTokenUsage = tokenUsage.totalUsage;
      } else if (tokenUsage.lastUsage) {
        session.totalTokenUsage = addTokenUsage(session.totalTokenUsage, tokenUsage.lastUsage);
      }
      if (events.length > 0 || sanitizeText(finalMessage)) {
        session.hasConversation = true;
        persistRunnerState();
      }

      const normalized = sanitizeText(finalMessage);
      if (!normalized) return { error: new Error('Codex finished without a final reply.') };
      return { reply: normalized };
    }
  });
}

function buildClaudeArgs(prompt, session, workdir, accessMode) {
  void workdir;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages'
  ];
  const mode = sanitizeText(accessMode).toLowerCase() || runnerState.accessMode;
  const permissionMode = CLAUDE_PERMISSION_MODE_BY_ACCESS[mode] || 'default';
  args.push('--permission-mode', permissionMode);
  for (const addDir of runnerState.addDirs) {
    args.push('--add-dir', addDir);
  }
  if (session && session.hasConversation && session.threadId) {
    args.push('--resume', session.threadId);
  }
  args.push(prompt);
  return args;
}

function summarizeClaudeFailure(stderr, stdout, events) {
  const errorMessage = extractClaudeErrorFromEvents(events || []);
  if (errorMessage) return errorMessage;
  const combined = sanitizeText([stderr, stdout].filter(Boolean).join('\n'));
  if (!combined) return 'Claude 未返回可解析的输出。';
  return combined.split('\n').slice(-12).join('\n');
}

async function runClaudeExec(prompt, session, workdir, context, run, accessMode) {
  try {
    return await runClaudeExecOnce(prompt, session, workdir, context, run, accessMode);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (
      session &&
      session.hasConversation &&
      session.threadId &&
      isClaudeSessionNotFoundError(message)
    ) {
      log(
        `Claude session ${session.threadId} not found on this machine; resetting and retrying as a new session.`
      );
      session.threadId = null;
      session.hasConversation = false;
      session.lastTokenUsage = null;
      bumpSessionGeneration(session);
      persistRunnerState();
      await safeSendReply(
        context,
        '原 session 在本机找不到（可能换了机器或 session 被清），已自动新开一次会话并重试。'
      ).catch(() => {});
      return runClaudeExecOnce(prompt, session, workdir, context, run, accessMode);
    }
    throw error;
  }
}

function runClaudeExecOnce(prompt, session, workdir, context, run, accessMode) {
  const args = buildClaudeArgs(prompt, session, workdir, accessMode);
  const env = { ...process.env, TERM: process.env.TERM || 'xterm-256color' };
  if (RUNNER_CLAUDE_HOME) env.CLAUDE_CONFIG_DIR = RUNNER_CLAUDE_HOME;

  const claudeSpawnErrorMapper = (error) => {
    if (error && error.code === 'ENOENT') {
      return new Error(
        `未找到 claude 可执行文件：${CLAUDE_BIN}。请安装 Claude Code CLI 或设置 CLAUDE_BIN。`
      );
    }
    return null;
  };

  return runAgentChildProcess({
    bin: CLAUDE_BIN,
    args,
    cwd: workdir,
    env,
    session,
    run,
    context,
    parseEvent: extractProgressUpdateFromClaudeEvent,
    timeoutLabel: 'Claude',
    spawnErrorMapper: claudeSpawnErrorMapper,
    onSuccess: async ({ code, stdout, stderr, events }) => {
      const sessionId = extractSessionIdFromClaudeEvents(events);
      const tokenUsage = extractTokenUsageFromClaudeEvents(events);
      const claudeError = extractClaudeErrorFromEvents(events);
      const finalMessage = extractFinalMessageFromClaudeEvents(events);
      const meta = extractClaudeResultMeta(events);

      if (sessionId) session.threadId = sessionId;
      if (tokenUsage.lastUsage) session.lastTokenUsage = tokenUsage.lastUsage;
      if (tokenUsage.totalUsage) {
        session.totalTokenUsage = tokenUsage.totalUsage;
      } else if (tokenUsage.lastUsage) {
        session.totalTokenUsage = addTokenUsage(session.totalTokenUsage, tokenUsage.lastUsage);
      }
      if (meta && meta.numTurns > 0) {
        session.lastClaudeMeta = meta;
      }
      if (events.length > 0 || sanitizeText(finalMessage)) {
        session.hasConversation = true;
        persistRunnerState();
      }

      if (code !== 0) {
        const hint = describeBackendRuntimeError('claude', stderr, stdout);
        return { error: new Error(summarizeClaudeFailure(stderr, stdout, events) + hint) };
      }

      if (claudeError) {
        const hint = describeBackendRuntimeError('claude', stderr, stdout);
        return { error: new Error(`Claude 返回错误：${claudeError}${hint}`) };
      }

      const normalized = sanitizeText(finalMessage);
      if (!normalized) return { error: new Error('Claude 执行完成但未返回内容。') };
      return { reply: normalized };
    }
  });
}

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

async function executeTask(task, run) {
  const backend = run && run.backend
    ? run.backend
    : (task.backend && VALID_BACKENDS.has(task.backend)
      ? task.backend
      : getActiveBackend(task.sessionScopeKey));
  const accessMode = sanitizeText(task.accessMode).toLowerCase()
    || getAccessModeForScope(task.sessionScopeKey);
  const session = (run && run.session)
    || getScopedSession(task.sessionScopeKey, task.workdir, backend);
  const sessionKey = sessionIdentityForTask({ ...task, backend });
  const pendingApprovalForSession = pendingApprovals.get(sessionKey) || null;

  const queueDepth = queueDepthForSession(sessionKey);
  const queueHint = queueDepth > 0 ? `，该会话队列剩余 ${queueDepth} 条` : '';
  await safeSendReply(
    task.context,
    `开始执行（${BACKEND_LABELS[backend]}，并发槽 ${activeRuns.size}/${MAX_CONCURRENCY}${queueHint}）。`
  );

  try {
    const includePolicy = !(session.hasConversation && session.threadId);
    const prompt = task.kind === 'approval'
      ? buildApprovalPrompt(task.action, pendingApprovalForSession, { includePolicy, accessMode })
      : buildUserPrompt(task.input, { includePolicy, backend, accessMode });

    const reply = backend === 'claude'
      ? await runClaudeExec(prompt, session, task.workdir, task.context, run, accessMode)
      : await runCodexExec(prompt, session, task.workdir, task.context, run, accessMode);
    if (!reply) {
      return;
    }

    const approval = backend === 'codex' ? parseApprovalRequest(reply) : null;

    if (approval) {
      pendingApprovals.set(sessionKey, {
        command: approval.command,
        reason: approval.reason,
        context: task.context,
        workdir: task.workdir,
        sessionScopeKey: task.sessionScopeKey,
        backend,
        accessMode
      });
      const approvalMessage = [
        '检测到需要审批的操作：',
        approval.command,
        approval.reason ? `原因：${approval.reason}` : null,
        '请回复 /allow、/skip 或 /reject。'
      ].filter(Boolean).join('\n');
      await safeSendReply(task.context, approvalMessage);
      return;
    }

    pendingApprovals.delete(sessionKey);
    await safeSendReply(task.context, reply);
  } catch (error) {
    await safeSendReply(task.context, error && error.message ? error.message : String(error));
  }
}

function tickQueues() {
  if (sessionQueues.size === 0) return;
  const keys = Array.from(sessionQueues.keys());
  for (const sessionKey of keys) {
    if (activeRuns.size >= MAX_CONCURRENCY) break;
    if (activeRuns.has(sessionKey)) continue;
    const queue = sessionQueues.get(sessionKey);
    if (!queue || queue.length === 0) continue;
    const head = queue[0];
    if (pendingApprovals.has(sessionKey) && head.kind !== 'approval') continue;
    queue.shift();
    if (queue.length === 0) sessionQueues.delete(sessionKey);
    void runTask(sessionKey, head);
  }
}

async function runTask(sessionKey, task) {
  const backend = task.backend || getActiveBackend(task.sessionScopeKey);
  const session = getScopedSession(task.sessionScopeKey, task.workdir, backend);
  const run = {
    task,
    session,
    child: null,
    generation: session.generation,
    backend
  };
  activeRuns.set(sessionKey, run);
  try {
    await executeTask(task, run);
  } finally {
    activeRuns.delete(sessionKey);
    tickQueues();
  }
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

async function startRunner() {
  if (forceAccessMode) {
    if (!VALID_ACCESS_MODES.has(forceAccessMode)) {
      process.stderr.write(
        `Invalid --force-access value: ${forceAccessMode}. Expected one of: read / write / safe / full\n`
      );
      process.exit(1);
    }
    runnerState.accessMode = forceAccessMode;
    runnerState.accessModes = {};
    persistRunnerStateNow();
    log(`Forcing every session to access mode: ${forceAccessMode} (per-scope overrides cleared).`);
  }

  const qqConfigs = loadQQBotConfigs();

  for (const config of qqConfigs) {
    const client = createQQBotClientFromConfig(config);
    client.onMessage((eventType, message) => {
      void enqueueMessage(eventType, message, { botId: client.id });
    });
    qqBots.set(client.id, client);
  }

  startRunnerStateWatcher(() => {
    void refreshWeixinClients(enqueueMessage);
  });

  for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signalName, async () => {
      stopAllActiveRuns(signalName);
      stopRunnerStateWatcher();
      persistRunnerStateNow();
      const closes = [];
      for (const bot of weixinBots.values()) {
        closes.push(Promise.resolve(bot.close()).catch(() => {}));
      }
      for (const bot of qqBots.values()) {
        closes.push(Promise.resolve(bot.close()).catch(() => {}));
      }
      await Promise.all(closes);
      process.exit(0);
    });
  }

  for (const [id, client] of qqBots.entries()) {
    const label = client.name && client.name !== id ? `${client.name}（${id}）` : id;
    try {
      await client.connect();
      log(`QQ bot connected: ${label}`);
    } catch (error) {
      log(
        `QQ bot ${label} failed to connect: ${
          error && error.message ? error.message : String(error)
        }`
      );
    }
  }

  await refreshWeixinClients(enqueueMessage);
}

async function main() {
  if (mode === 'weixin-login') {
    const exitCode = await runWeixinLoginFlow(weixinAccountId, weixinLoginForce, weixinName);
    process.exit(exitCode);
    return;
  }

  if (mode === 'weixin-logout') {
    clearStoredWeixinAccount(weixinAccountId);
    process.stdout.write(
      `Weixin account cleared: ${weixinAccountId}\n` +
      'If the runner service is already running, it will stop the Weixin client automatically within about 1 second.\n'
    );
    process.exit(0);
    return;
  }

  await startRunner();
}

main().catch((error) => {
  log(`Failed to start runner: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
