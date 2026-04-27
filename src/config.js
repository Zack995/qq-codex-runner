'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeText,
  log,
  resolveInputPath,
  parseList,
  parseBoolean,
  getPositiveIntegerEnv
} = require('./util');

function usage(exitCode = 1) {
  const message = [
    'Usage:',
    '  qq-codex-runner [--cmd <codex-bin>] [--full | --force-access <mode>] -- <codex args...>',
    '  qq-codex-runner --weixin-login [--weixin-account <id>] [--weixin-name <alias>] [--weixin-login-force]',
    '  qq-codex-runner --weixin-logout [--weixin-account <id>]',
    '  qq-codex-runner --help',
    '',
    'Options:',
    '  --full               Boot with every session forced to access-mode=full',
    '                       (clears any per-scope /access overrides; equivalent to',
    '                        --force-access full)',
    '  --force-access <m>   Same as --full, but with a chosen mode (read|write|safe|full)'
  ].join('\n');
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const delimiterIndex = argv.indexOf('--');
  const runnerArgs = delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
  const codexArgs = delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1);
  let command = process.env.CODEX_BIN || 'codex';
  let mode = 'runner';
  let weixinAccountId = sanitizeText(process.env.WEIXIN_ACCOUNT_ID || 'default') || 'default';
  let weixinLoginForce = false;
  let weixinName = '';
  let forceAccessMode = '';

  for (let index = 0; index < runnerArgs.length; index += 1) {
    const token = runnerArgs[index];
    if (token === '-h' || token === '--help') usage(0);
    if (token === '--weixin-login') {
      mode = 'weixin-login';
      continue;
    }
    if (token === '--weixin-logout') {
      mode = 'weixin-logout';
      continue;
    }
    if (token === '--weixin-login-force') {
      weixinLoginForce = true;
      continue;
    }
    if (token === '--weixin-account') {
      const next = runnerArgs[index + 1];
      if (!next) usage(1);
      weixinAccountId = sanitizeText(next) || weixinAccountId;
      index += 1;
      continue;
    }
    if (token === '--weixin-name') {
      const next = runnerArgs[index + 1];
      if (!next) usage(1);
      weixinName = sanitizeText(next);
      index += 1;
      continue;
    }
    if (token === '--cmd') {
      const next = runnerArgs[index + 1];
      if (!next) usage(1);
      command = next;
      index += 1;
      continue;
    }
    if (token === '--full') {
      forceAccessMode = 'full';
      continue;
    }
    if (token === '--force-access') {
      const next = runnerArgs[index + 1];
      if (!next) usage(1);
      forceAccessMode = sanitizeText(next).toLowerCase();
      index += 1;
      continue;
    }
    usage(1);
  }

  return { command, codexArgs, mode, weixinAccountId, weixinLoginForce, weixinName, forceAccessMode };
}

const INTENT_FLAGS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30
};

function parseIntents(value) {
  const defaults = ['PUBLIC_GUILD_MESSAGES', 'GROUP_AND_C2C'];
  const intents = typeof value === 'string' && value.trim()
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : defaults;

  const invalid = intents.filter((item) => !(item in INTENT_FLAGS));
  if (invalid.length > 0) {
    process.stderr.write(`Invalid QQ_BOT_INTENTS values: ${invalid.join(', ')}\n`);
    process.exit(1);
  }
  return intents;
}

function intentsToBitmask(intents) {
  return intents.reduce((sum, name) => sum | INTENT_FLAGS[name], 0);
}

const CODEX_HOME_TEMPLATE_ITEMS = [
  'auth.json',
  'config.toml',
  'AGENTS.md',
  'rules',
  'skills',
  'vendor_imports'
];

function copyCodexHomeTemplate(sourceRoot, targetRoot) {
  if (!sourceRoot || !targetRoot) return;
  if (sourceRoot === targetRoot) return;
  if (!fs.existsSync(sourceRoot)) return;

  let sourceStat;
  try {
    sourceStat = fs.statSync(sourceRoot);
  } catch (_) {
    return;
  }
  if (!sourceStat.isDirectory()) return;

  for (const relativePath of CODEX_HOME_TEMPLATE_ITEMS) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) continue;

    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
    log(`Copied Codex config asset: ${relativePath}`);
  }
}

function prepareCodexHome(rawPath, sourcePath) {
  const normalized = sanitizeText(rawPath);
  if (!normalized) return '';

  const resolved = resolveInputPath(normalized);
  fs.mkdirSync(resolved, { recursive: true });
  copyCodexHomeTemplate(
    sanitizeText(sourcePath) ? resolveInputPath(sourcePath) : '',
    resolved
  );

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`RUNNER_CODEX_HOME is not a directory: ${resolved}`);
  }

  return resolved;
}

const VALID_ACCESS_MODES = new Map([
  ['read', { label: '只读', sandbox: 'read-only', bypass: false }],
  ['write', { label: '工作区可写', sandbox: 'workspace-write', bypass: false }],
  ['safe', { label: '安全模式', sandbox: 'workspace-write', bypass: false }],
  ['full', { label: '完全访问', sandbox: 'danger-full-access', bypass: true }]
]);
const VALID_BACKENDS = new Set(['codex', 'claude']);
const BACKEND_LABELS = { codex: 'Codex', claude: 'Claude Code' };
const CLAUDE_PERMISSION_MODE_BY_ACCESS = {
  read: 'plan',
  write: 'acceptEdits',
  safe: 'acceptEdits',
  full: 'bypassPermissions'
};

const MAX_BOT_MESSAGE_LENGTH = 1500;
const PROGRESS_HEARTBEAT_INTERVAL_MS = 25 * 1000;
const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000;
const BACKEND_PROBE_TIMEOUT_MS = 5000;
const MAX_WORKDIR_SEARCH_RESULTS = 5;
const MAX_WORKDIR_SEARCH_DIRS = 2500;
const WORKDIR_SYSTEM_SEARCH_TIMEOUT_MS = 3000;
const WORKDIR_SYSTEM_SEARCH_MAX_BUFFER = 512 * 1024;
const PERSIST_DEBOUNCE_MS = 200;
const DEFAULT_MAX_CONCURRENCY = 3;

const WORKDIR_SEARCH_SKIP_NAMES = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.svn',
  '.Trash',
  '.yarn',
  'Applications',
  'Library',
  'System',
  'Volumes',
  'node_modules'
]);

let cachedRuntimeConfig = null;

function loadRuntimeConfig() {
  if (cachedRuntimeConfig) return cachedRuntimeConfig;
  const RAW_EXEC_TIMEOUT_MS = Number(process.env.CODEX_EXEC_TIMEOUT_MS);
  const EXEC_TIMEOUT_MS = Number.isFinite(RAW_EXEC_TIMEOUT_MS)
    ? RAW_EXEC_TIMEOUT_MS
    : DEFAULT_EXEC_TIMEOUT_MS;
  const EXEC_TIMEOUT_DISABLED = EXEC_TIMEOUT_MS <= 0;

  const RAW_MAX_CONCURRENCY = Number(process.env.RUNNER_MAX_CONCURRENCY);
  const MAX_CONCURRENCY = Number.isFinite(RAW_MAX_CONCURRENCY) && RAW_MAX_CONCURRENCY > 0
    ? Math.floor(RAW_MAX_CONCURRENCY)
    : DEFAULT_MAX_CONCURRENCY;

  const PRIMARY_CODEX_HOME = sanitizeText(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const RUNNER_CODEX_HOME = prepareCodexHome(
    process.env.RUNNER_CODEX_HOME || process.env.CODEX_HOME || '',
    PRIMARY_CODEX_HOME
  );
  const CODEX_CONTEXT_WINDOW_OVERRIDE = getPositiveIntegerEnv('CODEX_CONTEXT_WINDOW');
  const CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE = getPositiveIntegerEnv('CODEX_AUTO_COMPACT_TOKEN_LIMIT');

  const CLAUDE_BIN = sanitizeText(process.env.CLAUDE_BIN) || 'claude';
  const RUNNER_CLAUDE_HOME = (() => {
    const raw = sanitizeText(process.env.RUNNER_CLAUDE_HOME || '');
    return raw ? resolveInputPath(raw) : '';
  })();

  const DEFAULT_BACKEND = (() => {
    const raw = sanitizeText(process.env.RUNNER_DEFAULT_BACKEND).toLowerCase();
    return VALID_BACKENDS.has(raw) ? raw : 'claude';
  })();

  const DEFAULT_WORKDIR = resolveInputPath(process.env.RUNNER_WORKDIR || process.cwd());
  const DEFAULT_ADD_DIRS = parseList(process.env.RUNNER_ADD_DIRS).map((item) => resolveInputPath(item));

  const WEIXIN_ENABLED = parseBoolean(process.env.WEIXIN_ENABLED, true);
  const WEIXIN_ACCOUNT_ID = sanitizeText(process.env.WEIXIN_ACCOUNT_ID || 'default') || 'default';

  const RUNNER_STATE_FILE = path.resolve(process.cwd(), 'logs', 'runner-state.json');

  const result = {
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
  };
  cachedRuntimeConfig = result;
  return result;
}

module.exports = {
  usage,
  parseArgs,
  INTENT_FLAGS,
  parseIntents,
  intentsToBitmask,
  CODEX_HOME_TEMPLATE_ITEMS,
  copyCodexHomeTemplate,
  prepareCodexHome,
  VALID_ACCESS_MODES,
  VALID_BACKENDS,
  BACKEND_LABELS,
  CLAUDE_PERMISSION_MODE_BY_ACCESS,
  MAX_BOT_MESSAGE_LENGTH,
  PROGRESS_HEARTBEAT_INTERVAL_MS,
  DEFAULT_EXEC_TIMEOUT_MS,
  BACKEND_PROBE_TIMEOUT_MS,
  MAX_WORKDIR_SEARCH_RESULTS,
  MAX_WORKDIR_SEARCH_DIRS,
  WORKDIR_SYSTEM_SEARCH_TIMEOUT_MS,
  WORKDIR_SYSTEM_SEARCH_MAX_BUFFER,
  PERSIST_DEBOUNCE_MS,
  DEFAULT_MAX_CONCURRENCY,
  WORKDIR_SEARCH_SKIP_NAMES,
  loadRuntimeConfig
};
