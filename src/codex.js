'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeText,
  compactWhitespace,
  addTokenUsage,
  normalizeTokenUsage
} = require('./util');

const config = require('./config');
const { VALID_ACCESS_MODES } = config;
const {
  RUNNER_CODEX_HOME,
  CODEX_CONTEXT_WINDOW_OVERRIDE,
  CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE
} = config.loadRuntimeConfig();

const {
  runnerState,
  extractTokenUsageFromExecEvents,
  extractThreadIdFromExecEvents,
  persistRunnerState
} = require('./state');

const {
  runAgentChildProcess,
  describeBackendRuntimeError
} = require('./exec');

// Codex CLI bin + extra args supplied by main.js after parseArgs.
let codexBin = process.env.CODEX_BIN || 'codex';
let codexExtraArgs = [];

function setCodexBin(bin) {
  if (typeof bin === 'string' && bin.length > 0) codexBin = bin;
}

function setCodexExtraArgs(args) {
  codexExtraArgs = Array.isArray(args) ? args.slice() : [];
}

function getCodexBin() {
  return codexBin;
}

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

    // Codex final answers arrive as item.completed/agent_message and are also
    // written to --output-last-message. Only commentary should be streamed as
    // progress, otherwise the chat sees the same content once as "进度" and
    // again as the final reply.
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

function buildUserPrompt(input, options = {}) {
  return buildChatTurnPrompt(input, options);
}

function buildApprovalPrompt(action, pendingApproval, options = {}) {
  return buildApprovalTurnPrompt(action, pendingApproval, options);
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
  args.push(...codexExtraArgs);
  args.push(prompt);
  return args;
}

function runCodexExec(prompt, session, workdir, context, run, accessMode) {
  const outputFile = path.join(os.tmpdir(), `qq-codex-runner-last-${process.pid}-${Date.now()}.txt`);
  const args = buildCodexArgs(prompt, outputFile, session, workdir, accessMode);
  const env = { ...process.env, TERM: process.env.TERM || 'xterm-256color' };
  if (RUNNER_CODEX_HOME) env.CODEX_HOME = RUNNER_CODEX_HOME;

  return runAgentChildProcess({
    bin: codexBin,
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

module.exports = {
  setCodexBin,
  setCodexExtraArgs,
  getCodexBin,
  summarizeExecFailure,
  summarizeCommandForProgress,
  describeFunctionCallForProgress,
  extractProgressUpdateFromExecEvent,
  parseApprovalRequest,
  APPROVAL_POLICY_PROMPT,
  buildAgentPolicyPrompt,
  buildChatTurnPrompt,
  buildApprovalTurnPrompt,
  buildUserPrompt,
  buildApprovalPrompt,
  buildCodexArgs,
  runCodexExec
};
