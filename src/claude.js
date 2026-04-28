'use strict';

const {
  sanitizeText,
  log,
  compactWhitespace,
  addTokenUsage,
  normalizeTokenUsage,
  formatTokenNumber
} = require('./util');

const config = require('./config');
const { CLAUDE_PERMISSION_MODE_BY_ACCESS } = config;
const {
  CLAUDE_BIN,
  RUNNER_CLAUDE_HOME
} = config.loadRuntimeConfig();

const {
  runnerState,
  bumpSessionGeneration,
  persistRunnerState
} = require('./state');

const {
  runAgentChildProcess,
  describeBackendRuntimeError,
  sendReply
} = require('./exec');

const { summarizeCommandForProgress } = require('./codex');

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

function summarizeClaudeFailure(stderr, stdout, events) {
  const errorMessage = extractClaudeErrorFromEvents(events || []);
  if (errorMessage) return errorMessage;
  const combined = sanitizeText([stderr, stdout].filter(Boolean).join('\n'));
  if (!combined) return 'Claude 未返回可解析的输出。';
  return combined.split('\n').slice(-12).join('\n');
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
      await sendReply(
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

module.exports = {
  normalizeClaudeUsage,
  extractSessionIdFromClaudeEvents,
  extractFinalMessageFromClaudeEvents,
  extractClaudeErrorFromEvents,
  isClaudeSessionNotFoundError,
  extractTokenUsageFromClaudeEvents,
  extractClaudeResultMeta,
  extractLastTurnContextSize,
  formatClaudeContextLines,
  describeClaudeToolForProgress,
  extractProgressUpdateFromClaudeEvent,
  summarizeClaudeFailure,
  buildClaudeArgs,
  runClaudeExec,
  runClaudeExecOnce
};
