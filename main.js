#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

function loadDotEnv(filename = '.env') {
  const envPath = path.resolve(process.cwd(), filename);
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');

    if (typeof process.env[key] === 'undefined') {
      process.env[key] = value;
    }
  }
}

function usage(exitCode = 1) {
  const message = [
    'Usage:',
    '  qq-codex-runner [--cmd <codex-bin>] -- <codex args...>',
    '  qq-codex-runner --help'
  ].join('\n');
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function parseBoolean(value, defaultValue) {
  if (typeof value !== 'string' || value.length === 0) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value === 'string' && value.length > 0) return value;
  process.stderr.write(`Missing required environment variable: ${name}\n`);
  process.exit(1);
}

function sanitizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function parseList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((item) => sanitizeText(item))
    .filter(Boolean);
}

function expandHomeDir(value) {
  const normalized = sanitizeText(value);
  if (!normalized) return normalized;
  if (normalized === '~') return os.homedir();
  if (normalized.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  return normalized;
}

function resolveInputPath(value) {
  return path.resolve(expandHomeDir(value));
}

function stripAtMentions(text) {
  return String(text || '').replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitMessage(text, maxLength) {
  const normalized = sanitizeText(text);
  if (!normalized) return [];

  const chunks = [];
  let rest = normalized;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n', maxLength);
    if (cut < maxLength * 0.4) {
      cut = rest.lastIndexOf(' ', maxLength);
    }
    if (cut < maxLength * 0.4) {
      cut = maxLength;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function log(message) {
  process.stderr.write(`[qq-codex-runner] ${message}\n`);
}

function nextMsgSeq() {
  return Math.floor(Math.random() * 65535) + 1;
}

function requestJson(method, urlString, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body ? JSON.stringify(body) : null;

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'qq-codex-runner',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
              }
            : {}),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (_) {
            parsed = data;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          const error = new Error(
            `HTTP ${res.statusCode} ${res.statusMessage || ''}: ${
              parsed && parsed.message
                ? parsed.message
                : typeof parsed === 'string'
                  ? parsed
                  : 'request failed'
            }`
          );
          error.statusCode = res.statusCode;
          error.responseBody = parsed;
          reject(error);
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
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

class QQBotClient {
  constructor(config) {
    this.appId = config.appId;
    this.secret = config.secret;
    this.apiBase = config.apiBase;
    this.tokenBase = config.tokenBase;
    this.intents = config.intents;
    this.intentsBitmask = intentsToBitmask(config.intents);
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.ws = null;
    this.seq = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.ready = false;
    this.stopped = false;
    this.handlers = [];
  }

  authorizationHeader() {
    return `QQBot ${this.accessToken}`;
  }

  commonHeaders() {
    return {
      Authorization: this.authorizationHeader(),
      'X-Union-Appid': this.appId
    };
  }

  async ensureAccessToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.accessToken && now < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const tokenUrl = new URL('/app/getAppAccessToken', this.tokenBase).toString();
    const response = await requestJson('POST', tokenUrl, {}, {
      appId: this.appId,
      clientSecret: this.secret
    });

    if (!response || !response.access_token) {
      throw new Error('Failed to obtain QQ bot access token.');
    }

    this.accessToken = response.access_token;
    const expiresIn = Number(response.expires_in || 0);
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    return this.accessToken;
  }

  async request(method, pathname, body) {
    await this.ensureAccessToken();
    const url = new URL(pathname, this.apiBase).toString();
    try {
      return await requestJson(method, url, this.commonHeaders(), body);
    } catch (error) {
      if (error && (error.statusCode === 401 || error.statusCode === 403)) {
        await this.ensureAccessToken(true);
        return requestJson(method, url, this.commonHeaders(), body);
      }
      throw error;
    }
  }

  async getGateway() {
    return this.request('GET', '/gateway/bot');
  }

  async sendChannelMessage(channelId, payload) {
    return this.request('POST', `/channels/${channelId}/messages`, payload);
  }

  async sendC2CMessage(openid, payload) {
    return this.request('POST', `/v2/users/${openid}/messages`, payload);
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  dispatchMessage(eventType, message) {
    for (const handler of this.handlers) {
      Promise.resolve(handler(eventType, message)).catch((error) => {
        log(`Message handler failed: ${error && error.message ? error.message : String(error)}`);
      });
    }
  }

  clearHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  startHeartbeat(intervalMs) {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
      }
    }, intervalMs);
  }

  scheduleReconnect(delayMs = 2000) {
    if (this.stopped || this.reconnectTimer) return;
    this.ready = false;
    this.clearHeartbeat();

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (error) {
        log(`Reconnect failed: ${error && error.message ? error.message : String(error)}`);
        this.scheduleReconnect(Math.min(delayMs * 2, 30_000));
      }
    }, delayMs);
  }

  identifyPayload() {
    return {
      op: 2,
      d: {
        token: this.authorizationHeader(),
        intents: this.intentsBitmask,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: 'qq-codex-runner',
          $device: 'qq-codex-runner'
        }
      }
    };
  }

  async connect() {
    await this.ensureAccessToken();
    const gateway = await this.getGateway();
    if (!gateway || !gateway.url) {
      throw new Error('Gateway URL missing from QQ API response.');
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(gateway.url);
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch (_) {}
        reject(error);
      };

      ws.on('message', (raw) => {
        let packet;
        try {
          packet = JSON.parse(String(raw));
        } catch (error) {
          log(`Failed to parse websocket packet: ${String(error)}`);
          return;
        }

        if (typeof packet.s === 'number') {
          this.seq = packet.s;
        }

        if (packet.op === 10 && packet.d && packet.d.heartbeat_interval) {
          this.ws = ws;
          ws.send(JSON.stringify(this.identifyPayload()));
          this.startHeartbeat(packet.d.heartbeat_interval);
          return;
        }

        if (packet.t === 'READY') {
          this.ready = true;
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (packet.op === 9) {
          fail(new Error('QQ websocket invalid session.'));
          return;
        }

        if (
          packet.t === 'AT_MESSAGE_CREATE' ||
          packet.t === 'MESSAGE_CREATE' ||
          packet.t === 'C2C_MESSAGE_CREATE'
        ) {
          this.dispatchMessage(packet.t, packet.d);
        }
      });

      ws.on('close', () => {
        this.ws = null;
        this.clearHeartbeat();
        if (!settled) {
          fail(new Error('QQ websocket closed before READY.'));
          return;
        }
        this.scheduleReconnect();
      });

      ws.on('error', (error) => {
        if (!settled) {
          fail(error);
          return;
        }
        log(`QQ websocket error: ${error && error.message ? error.message : String(error)}`);
      });
    });
  }

  async close() {
    this.stopped = true;
    this.ready = false;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }
}

function parseArgs(argv) {
  const delimiterIndex = argv.indexOf('--');
  const runnerArgs = delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
  const codexArgs = delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1);
  let command = process.env.CODEX_BIN || 'codex';

  for (let index = 0; index < runnerArgs.length; index += 1) {
    const token = runnerArgs[index];
    if (token === '-h' || token === '--help') usage(0);
    if (token === '--cmd') {
      const next = runnerArgs[index + 1];
      if (!next) usage(1);
      command = next;
      index += 1;
      continue;
    }
    usage(1);
  }

  return { command, codexArgs };
}

function parseExecJsonEvents(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (_) {}
  }
  return events;
}

function summarizeExecFailure(stderr, stdout) {
  const combined = sanitizeText([stderr, stdout].filter(Boolean).join('\n'));
  if (!combined) return 'Codex did not return readable output.';
  return combined.split('\n').slice(-12).join('\n');
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
  'You are working through a QQ bot runner.',
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

function buildAgentPolicyPrompt() {
  if (runnerState.accessMode === 'full') {
    return [
      '你正在通过 QQ 机器人与用户协作。',
      '当前权限模式是完全访问。',
      '你可以直接执行完成任务所需的操作。'
    ].join('\n');
  }

  return APPROVAL_POLICY_PROMPT;
}

function buildUserPrompt(input) {
  return `${buildAgentPolicyPrompt()}\n\n[User message]\n${input}\n[/User message]`;
}

function buildApprovalPrompt(action, pendingApproval) {
  const policyPrompt = buildAgentPolicyPrompt();
  if (!pendingApproval) return policyPrompt;
  if (action === 'allow') {
    return [
      policyPrompt,
      '',
      'The user approved your last requested command.',
      `Approved command: ${pendingApproval.command}`,
      `Reason: ${pendingApproval.reason || 'not provided'}`,
      'Continue the original task.'
    ].join('\n');
  }
  return [
    policyPrompt,
    '',
    'The user rejected the last requested command for execution.',
    `Blocked command: ${pendingApproval.command}`,
    'Continue the original task without executing that command.'
  ].join('\n');
}

loadDotEnv();

const { command, codexArgs } = parseArgs(process.argv.slice(2));
const qqBot = new QQBotClient({
  appId: requireEnv('QQ_BOT_APP_ID'),
  secret: process.env.QQ_BOT_SECRET || process.env.QQ_BOT_CLIENT_SECRET || requireEnv('QQ_BOT_SECRET'),
  intents: parseIntents(process.env.QQ_BOT_INTENTS),
  apiBase:
    process.env.QQ_BOT_API_BASE ||
    (parseBoolean(process.env.QQ_BOT_SANDBOX, false)
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com'),
  tokenBase: process.env.QQ_BOT_TOKEN_BASE || 'https://bots.qq.com'
});

const MAX_BOT_MESSAGE_LENGTH = 1500;
const EXEC_TIMEOUT_MS = Number(process.env.CODEX_EXEC_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_WORKDIR_SEARCH_RESULTS = 5;
const MAX_WORKDIR_SEARCH_DIRS = 2500;
const WORKDIR_SYSTEM_SEARCH_TIMEOUT_MS = 3000;
const WORKDIR_SYSTEM_SEARCH_MAX_BUFFER = 512 * 1024;
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
const DEFAULT_WORKDIR = resolveInputPath(process.env.RUNNER_WORKDIR || process.cwd());
const DEFAULT_ADD_DIRS = parseList(process.env.RUNNER_ADD_DIRS).map((item) => resolveInputPath(item));
const VALID_ACCESS_MODES = new Map([
  ['read', { label: '只读', sandbox: 'read-only', bypass: false }],
  ['write', { label: '工作区可写', sandbox: 'workspace-write', bypass: false }],
  ['safe', { label: '安全模式', sandbox: 'workspace-write', bypass: false }],
  ['full', { label: '完全访问', sandbox: 'danger-full-access', bypass: true }]
]);

const taskQueue = [];
let activeTask = null;
let pendingApproval = null;
const workdirSessions = new Map();
let codexProcess = {
  busy: false,
  child: null,
  session: null
};
let runnerState = {
  workdir: DEFAULT_WORKDIR,
  accessMode: sanitizeText(process.env.CODEX_ACCESS_MODE || 'safe').toLowerCase(),
  addDirs: DEFAULT_ADD_DIRS.slice()
};
let recentWorkdirSearch = {
  query: '',
  matches: []
};

if (!VALID_ACCESS_MODES.has(runnerState.accessMode)) {
  runnerState.accessMode = 'safe';
}

function createWorkdirSessionState() {
  return {
    hasConversation: false,
    generation: 0
  };
}

function getWorkdirSession(workdir = runnerState.workdir) {
  const key = resolveInputPath(workdir);
  if (!workdirSessions.has(key)) {
    workdirSessions.set(key, createWorkdirSessionState());
  }
  return workdirSessions.get(key);
}

function getCurrentSession() {
  return getWorkdirSession(runnerState.workdir);
}

function countActiveSessions() {
  let count = 0;
  for (const session of workdirSessions.values()) {
    if (session.hasConversation) count += 1;
  }
  return count;
}

function bumpSessionGeneration(session) {
  if (!session) return;
  session.generation += 1;
}

function resetSessionState(session) {
  if (!session) return;
  session.hasConversation = false;
  session.generation += 1;
}

function stopActiveCodexProcess(signal = 'SIGTERM') {
  const child = codexProcess.child;
  if (!child) return;
  bumpSessionGeneration(codexProcess.session);
  try {
    child.kill(signal);
  } catch (_) {}
}

function clearRecentWorkdirSearch() {
  recentWorkdirSearch = {
    query: '',
    matches: []
  };
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

function getSearchSelection(target) {
  const selection = sanitizeText(target);
  if (!/^\d+$/.test(selection)) return null;
  const index = Number(selection);
  if (index < 1 || index > recentWorkdirSearch.matches.length) return null;
  return recentWorkdirSearch.matches[index - 1];
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
    '/help - 查看帮助',
    '/status - 查看运行状态',
    '/queue - 查看当前队列状态',
    '/session - 查看当前工作目录的 Codex 会话状态',
    '/cwd - 查看当前工作目录',
    '/cwd <目录> - 切换到指定目录；切回旧目录会恢复该目录会话',
    '/cwd <关键字> - 用本地系统搜索目录并展示最多 5 个候选',
    '/cwd <编号> - 选择最近一次搜索结果中的目录',
    '/access - 查看当前权限模式',
    '/access <read|write|safe|full> - 切换权限模式、清空队列并重置所有目录会话',
    '/new - 重置当前工作目录的 Codex 会话',
    '/restart - 清空队列并重置所有目录会话',
    '/allow - 批准待审批命令',
    '/skip - 跳过待审批命令',
    '/reject - 拒绝待审批命令并重置当前目录会话'
  ].join('\n');
}

function getStatusMessage() {
  const currentSession = getCurrentSession();
  return [
    '运行状态：',
    `QQ 已连接：${qqBot.ready ? '是' : '否'}`,
    `Codex 忙碌中：${codexProcess.busy ? '是' : '否'}`,
    `当前目录会话已建立：${currentSession.hasConversation ? '是' : '否'}`,
    `已缓存目录会话：${countActiveSessions()}`,
    `队列长度：${taskQueue.length}`,
    `存在待审批：${pendingApproval ? '是' : '否'}`,
    `工作目录：${runnerState.workdir}`,
    `权限模式：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}`
  ].join('\n');
}

function getQueueMessage() {
  return [
    '队列状态：',
    `当前执行任务：${activeTask ? (activeTask.kind === 'approval' ? '审批任务' : '普通任务') : '无'}`,
    `排队任务数：${taskQueue.length}`,
    `Codex 忙碌中：${codexProcess.busy ? '是' : '否'}`
  ].join('\n');
}

function getSessionMessage() {
  const currentSession = getCurrentSession();
  return [
    '会话状态：',
    `当前目录会话已建立：${currentSession.hasConversation ? '是' : '否'}`,
    `Codex 忙碌中：${codexProcess.busy ? '是' : '否'}`,
    `当前目录会话代次：${currentSession.generation}`,
    `已缓存目录会话：${countActiveSessions()}`,
    `存在待审批：${pendingApproval ? '是' : '否'}`,
    `工作目录：${runnerState.workdir}`,
    `权限模式：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}`,
    pendingApproval ? `待审批命令：${pendingApproval.command}` : null
  ].filter(Boolean).join('\n');
}

function getWorkdirMessage() {
  return [
    '工作目录状态：',
    `当前目录：${runnerState.workdir}`,
    runnerState.addDirs.length > 0 ? `附加可写目录：${runnerState.addDirs.join(', ')}` : '附加可写目录：无'
  ].join('\n');
}

function getAccessMessage() {
  return [
    '权限模式：',
    `当前模式：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}`,
    '可选模式：read / write / safe / full'
  ].join('\n');
}

function buildContext(eventType, message) {
  if (eventType === 'C2C_MESSAGE_CREATE') {
    return {
      type: 'c2c',
      openid:
        message && message.author
          ? message.author.user_openid || message.author.union_openid || message.author.id
          : null,
      messageId: message.id
    };
  }

  return {
    type: 'channel',
    channelId: message.channel_id,
    messageId: message.id
  };
}

async function sendReply(context, content) {
  const parts = splitMessage(content, MAX_BOT_MESSAGE_LENGTH);
  for (const part of parts) {
    if (context.type === 'c2c') {
      await qqBot.sendC2CMessage(context.openid, {
        content: part,
        msg_id: context.messageId,
        msg_type: 0,
        msg_seq: nextMsgSeq()
      });
      continue;
    }

    await qqBot.sendChannelMessage(context.channelId, {
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

function buildCodexArgs(prompt, outputFile) {
  const currentSession = getCurrentSession();
  const args = currentSession.hasConversation
    ? ['exec', 'resume', '--last']
    : ['exec'];
  const accessConfig = VALID_ACCESS_MODES.get(runnerState.accessMode) || VALID_ACCESS_MODES.get('safe');
  args.push('-C', runnerState.workdir);
  args.push('-s', accessConfig.sandbox);
  for (const addDir of runnerState.addDirs) {
    args.push('--add-dir', addDir);
  }
  if (accessConfig.bypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  args.push('--skip-git-repo-check', '--json', '--output-last-message', outputFile);
  args.push(...codexArgs);
  args.push(prompt);
  return args;
}

function runCodexExec(prompt) {
  return new Promise((resolve, reject) => {
    const session = getCurrentSession();
    const generation = session.generation;
    const outputFile = path.join(os.tmpdir(), `qq-codex-runner-last-${process.pid}-${Date.now()}.txt`);
    const args = buildCodexArgs(prompt, outputFile);
    const child = childProcess.spawn(command, args, {
      cwd: runnerState.workdir,
      env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    codexProcess.child = child;
    codexProcess.busy = true;
    codexProcess.session = session;

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      codexProcess.child = null;
      codexProcess.busy = false;
      codexProcess.session = null;
      if (generation !== session.generation) {
        resolve(null);
        return;
      }
      reject(new Error(`Codex execution timed out after ${Math.floor(EXEC_TIMEOUT_MS / 1000)} seconds.`));
    }, EXEC_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      codexProcess.child = null;
      codexProcess.busy = false;
      codexProcess.session = null;
      if (generation !== session.generation) {
        resolve(null);
        return;
      }
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      codexProcess.child = null;
      codexProcess.busy = false;
      codexProcess.session = null;

      let finalMessage = '';
      try {
        finalMessage = fs.readFileSync(outputFile, 'utf8');
      } catch (_) {}
      try {
        fs.unlinkSync(outputFile);
      } catch (_) {}

      if (generation !== session.generation) {
        resolve(null);
        return;
      }

      if (signal) {
        reject(new Error(`Codex process exited with signal ${signal}.`));
        return;
      }

      if (code !== 0) {
        reject(new Error(summarizeExecFailure(stderr, stdout)));
        return;
      }

      const events = parseExecJsonEvents(stdout);
      if (events.length > 0 || sanitizeText(finalMessage)) {
        session.hasConversation = true;
      }

      const normalized = sanitizeText(finalMessage);
      if (!normalized) {
        reject(new Error('Codex finished without a final reply.'));
        return;
      }

      resolve(normalized);
    });
  });
}

async function resetCodexSession(context) {
  resetSessionState(getCurrentSession());
  pendingApproval = null;
  clearRecentWorkdirSearch();
  stopActiveCodexProcess();

  await safeSendReply(context, 'Codex 会话已重置，下一条消息会启动新的对话。');
}

async function restartRunner(context) {
  stopActiveCodexProcess();
  pendingApproval = null;
  taskQueue.length = 0;
  clearRecentWorkdirSearch();
  workdirSessions.clear();

  await safeSendReply(context, 'Runner 状态已重启：队列已清空，所有目录会话已重置。');
}

async function switchWorkdir(context, rawDir, options = {}) {
  const resolved = resolveInputPath(rawDir);
  const currentDir = runnerState.workdir;
  const { fromSearchSelection = false } = options;

  if (resolved === currentDir) {
    clearRecentWorkdirSearch();
    await safeSendReply(context, `当前已经在该目录：${resolved}`);
    return;
  }

  stopActiveCodexProcess();
  pendingApproval = null;
  taskQueue.length = 0;
  clearRecentWorkdirSearch();

  runnerState.workdir = resolved;
  const targetSession = getCurrentSession();
  const switchHint = fromSearchSelection ? '已根据搜索结果切换工作目录。' : '已切换工作目录。';
  const sessionHint = targetSession.hasConversation
    ? '已恢复该目录之前的 Codex 会话。'
    : '这是该目录的首次会话，下一条消息会新开对话。';
  await safeSendReply(context, `${switchHint}\n当前目录：${resolved}\n${sessionHint}`);
}

async function handleWorkdirCommand(context, rawDir) {
  const target = sanitizeText(rawDir);
  if (!target) {
    await safeSendReply(context, getWorkdirMessage());
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

  const selection = getSearchSelection(target);
  if (selection) {
    await switchWorkdir(context, selection, { fromSearchSelection: true });
    return;
  }

  if (stat && !stat.isDirectory()) {
    await safeSendReply(context, `目标不是目录：${resolved}`);
    return;
  }

  const matches = searchLocalDirectories(target);
  recentWorkdirSearch = {
    query: target,
    matches
  };
  await safeSendReply(context, formatWorkdirSearchMessage(target, matches));
}

async function switchAccessMode(context, rawMode) {
  const mode = sanitizeText(rawMode).toLowerCase();
  if (!mode) {
    await safeSendReply(context, getAccessMessage());
    return;
  }

  if (!VALID_ACCESS_MODES.has(mode)) {
    await safeSendReply(context, `不支持的权限模式：${mode}\n可选模式：read / write / safe / full`);
    return;
  }

  runnerState.accessMode = mode;
  stopActiveCodexProcess();
  pendingApproval = null;
  taskQueue.length = 0;
  clearRecentWorkdirSearch();
  workdirSessions.clear();

  await safeSendReply(
    context,
    `权限模式已切换为：${VALID_ACCESS_MODES.get(mode).label}\n已清空等待队列，并重置所有目录会话。`
  );
}

async function executeTask(task) {
  runnerState.workdir = task.workdir;

  if (codexProcess.busy) {
    await safeSendReply(task.context, 'Codex 正在处理上一条消息，请稍候。');
    return;
  }

  await safeSendReply(task.context, `开始执行，队列剩余 ${taskQueue.length} 条。`);

  try {
    const prompt = task.kind === 'approval'
      ? buildApprovalPrompt(task.action, pendingApproval)
      : buildUserPrompt(task.input);

    const reply = await runCodexExec(prompt);
    if (!reply) {
      return;
    }
    const approval = parseApprovalRequest(reply);

    if (approval) {
      pendingApproval = {
        command: approval.command,
        reason: approval.reason,
        context: task.context,
        workdir: task.workdir
      };
      const approvalMessage = [
        '检测到需要审批的操作：',
        approval.command,
        approval.reason ? `原因：${approval.reason}` : null,
        '请回复 /allow、/skip 或 /reject。'
      ].filter(Boolean).join('\n');
      await safeSendReply(task.context, approvalMessage);
      return;
    }

    pendingApproval = null;
    await safeSendReply(task.context, reply);
  } catch (error) {
    await safeSendReply(task.context, error && error.message ? error.message : String(error));
  }
}

async function processQueue() {
  if (activeTask || taskQueue.length === 0) return;
  if (pendingApproval && taskQueue[0] && taskQueue[0].kind !== 'approval') return;

  const task = taskQueue.shift();
  if (!task) return;

  activeTask = task;
  try {
    await executeTask(task);
  } finally {
    activeTask = null;
    if (!codexProcess.busy && taskQueue.length > 0) {
      void processQueue();
    }
  }
}

async function enqueueMessage(eventType, message) {
  if (!message || !message.author) return;
  if (message.author.bot) return;
  if (String(message.author.id || '') === String(qqBot.appId)) return;

  const rawContent = sanitizeText(message.content);
  const input = eventType === 'AT_MESSAGE_CREATE' ? stripAtMentions(rawContent) : rawContent;
  if (!input) return;

  const context = buildContext(eventType, message);
  const [commandWord, ...restParts] = input.split(/\s+/);
  const commandArg = restParts.join(' ').trim();

  if (input === '/help') {
    await safeSendReply(context, getHelpMessage());
    return;
  }

  if (input === '/status') {
    await safeSendReply(context, getStatusMessage());
    return;
  }

  if (input === '/queue') {
    await safeSendReply(context, getQueueMessage());
    return;
  }

  if (input === '/session') {
    await safeSendReply(context, getSessionMessage());
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

  if (input === '/new') {
    await resetCodexSession(context);
    return;
  }

  if (input === '/restart') {
    await restartRunner(context);
    return;
  }

  if (input === '/reject') {
    if (!pendingApproval) {
      await safeSendReply(context, '当前没有待审批的操作。');
      return;
    }
    await resetCodexSession(context);
    return;
  }

  if (input === '/allow' || input === '/skip') {
    if (!pendingApproval) {
      await safeSendReply(context, '当前没有待审批的操作。');
      return;
    }

    const approvalTask = {
      kind: 'approval',
      action: input === '/allow' ? 'allow' : 'skip',
      input,
      context,
      workdir: pendingApproval.workdir
    };

    const queuedAhead = activeTask ? 1 : 0;
    taskQueue.unshift(approvalTask);
    if (queuedAhead > 0) {
      await safeSendReply(context, `已加入队列，前面还有 ${queuedAhead} 个任务。`);
    }
    void processQueue();
    return;
  }

  if (pendingApproval) {
    await safeSendReply(context, '当前有待审批操作，请先回复 /allow、/skip 或 /reject。');
    return;
  }

  if (context.type === 'c2c' && !context.openid) {
    log(`Ignoring C2C message without openid: ${message.id}`);
    return;
  }

  const task = {
    kind: 'user',
    action: null,
    input,
    context,
    workdir: runnerState.workdir
  };

  const queuedAhead = (activeTask ? 1 : 0) + taskQueue.length;
  taskQueue.push(task);
  if (queuedAhead > 0) {
    await safeSendReply(context, `已加入队列，前面还有 ${queuedAhead} 个任务。`);
  }
  void processQueue();
}

qqBot.onMessage(enqueueMessage);

for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signalName, async () => {
    if (codexProcess && codexProcess.child) {
      try {
        codexProcess.child.kill(signalName);
      } catch (_) {}
    }
    await qqBot.close();
    process.exit(0);
  });
}

qqBot.connect().then(() => {
  log('QQ bot connected.');
}).catch((error) => {
  log(`Failed to start QQ bot client: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
