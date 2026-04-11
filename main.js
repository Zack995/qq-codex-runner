#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
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
    '  qq-codex-runner --weixin-login [--weixin-account <id>] [--weixin-login-force]',
    '  qq-codex-runner --weixin-logout [--weixin-account <id>]',
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

function parsePositiveInteger(value) {
  const normalized = sanitizeText(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function getPositiveIntegerEnv(name) {
  const rawValue = sanitizeText(process.env[name]);
  if (!rawValue) return null;

  const parsed = parsePositiveInteger(rawValue);
  if (parsed === null) {
    log(`Ignoring invalid ${name}: ${rawValue}`);
    return null;
  }

  return parsed;
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTopLevelTomlValue(filePath, key) {
  if (!filePath || !key) return null;

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }

  const match = content.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.+)$`, 'm'));
  if (!match) return null;

  const withoutComment = match[1].replace(/\s+#.*$/, '').trim();
  if (!withoutComment) return null;

  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }

  if (/^-?\d+$/.test(withoutComment)) {
    return Number(withoutComment);
  }

  if (/^(true|false)$/i.test(withoutComment)) {
    return withoutComment.toLowerCase() === 'true';
  }

  return withoutComment;
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

function requestJsonWithTimeout(method, urlString, headers = {}, body, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  return new Promise(async (resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const controller = new AbortController();
    const signals = [controller.signal];
    if (options.signal) {
      signals.push(options.signal);
    }
    const signal = signals.length > 1 ? AbortSignal.any(signals) : controller.signal;
    const timer = timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const response = await fetch(urlString, {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload).toString()
              }
            : {}),
          ...headers
        },
        body: payload,
        signal
      });

      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_) {
        parsed = text;
      }

      if (response.status >= 200 && response.status < 300) {
        resolve(parsed);
        return;
      }

      const error = new Error(
        `HTTP ${response.status} ${response.statusText || ''}: ${
          parsed && parsed.message
            ? parsed.message
            : typeof parsed === 'string'
              ? parsed
              : 'request failed'
        }`
      );
      error.statusCode = response.status;
      error.responseBody = parsed;
      reject(error);
    } catch (error) {
      reject(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

async function requestTextWithTimeout(urlString, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const headers = options.headers || {};
  const controller = new AbortController();
  const signals = [controller.signal];
  if (options.signal) {
    signals.push(options.signal);
  }
  const signal = signals.length > 1 ? AbortSignal.any(signals) : controller.signal;
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(urlString, {
      method: options.method || 'GET',
      headers,
      signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || ''}: ${text}`);
    }
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
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

class WeixinClient {
  constructor(config) {
    this.accountId = config.accountId || 'default';
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    this.token = config.token || '';
    this.longPollTimeoutMs = Number(config.longPollTimeoutMs || 35_000);
    this.apiTimeoutMs = Number(config.apiTimeoutMs || 15_000);
    this.handlers = [];
    this.ready = false;
    this.stopped = false;
    this.runningPromise = null;
    this.activePollController = null;
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  dispatchMessage(eventType, message) {
    for (const handler of this.handlers) {
      Promise.resolve(handler(eventType, message)).catch((error) => {
        log(`Weixin message handler failed: ${error && error.message ? error.message : String(error)}`);
      });
    }
  }

  commonHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
    };

    if (sanitizeText(this.token)) {
      headers.Authorization = `Bearer ${sanitizeText(this.token)}`;
    }

    return headers;
  }

  async request(pathname, body, timeoutMs, controller) {
    const url = new URL(pathname, `${this.baseUrl}/`).toString();
    return requestJsonWithTimeout('POST', url, this.commonHeaders(), body, {
      timeoutMs,
      signal: controller ? controller.signal : undefined
    });
  }

  setSyncCursor(cursor) {
    weixinState.syncCursor = sanitizeText(cursor);
    persistRunnerState();
  }

  getSyncCursor() {
    return sanitizeText(weixinState.syncCursor);
  }

  setContextToken(peerId, token) {
    const normalizedPeerId = sanitizeText(peerId);
    const normalizedToken = sanitizeText(token);
    if (!normalizedPeerId || !normalizedToken) return;
    weixinState.contextTokens[buildWeixinContextTokenKey(this.accountId, normalizedPeerId)] = normalizedToken;
    persistRunnerState();
  }

  getContextToken(peerId) {
    const normalizedPeerId = sanitizeText(peerId);
    if (!normalizedPeerId) return '';
    return sanitizeText(weixinState.contextTokens[buildWeixinContextTokenKey(this.accountId, normalizedPeerId)]);
  }

  shouldProcessInboundMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (Number(message.message_type || 0) === 2) return false;
    if (!sanitizeText(message.from_user_id)) return false;
    if (!extractWeixinText(message)) return false;
    return true;
  }

  async pollOnce() {
    const controller = new AbortController();
    this.activePollController = controller;

    try {
      const response = await this.request(
        'ilink/bot/getupdates',
        {
          get_updates_buf: this.getSyncCursor(),
          base_info: {
            channel_version: 'qq-codex-runner'
          }
        },
        this.longPollTimeoutMs,
        controller
      );

      if ((Number(response && response.ret) || 0) !== 0 || (Number(response && response.errcode) || 0) !== 0) {
        throw new Error(
          `Weixin getupdates failed: ret=${Number(response && response.ret) || 0} errcode=${
            Number(response && response.errcode) || 0
          } errmsg=${sanitizeText(response && response.errmsg) || 'unknown error'}`
        );
      }

      if (response && typeof response.longpolling_timeout_ms === 'number' && response.longpolling_timeout_ms > 0) {
        this.longPollTimeoutMs = response.longpolling_timeout_ms;
      }

      if (sanitizeText(response && response.get_updates_buf)) {
        this.setSyncCursor(response.get_updates_buf);
      }

      const messages = Array.isArray(response && response.msgs) ? response.msgs : [];
      if (messages.length > 0) {
        log(`Weixin poll received ${messages.length} message(s).`);
      }
      for (const message of messages) {
        if (!this.shouldProcessInboundMessage(message)) {
          log(
            `Weixin message skipped: type=${Number(message && message.message_type || 0)} state=${
              Number(message && message.message_state || 0)
            } from=${sanitizeText(message && message.from_user_id) || 'unknown'}`
          );
          continue;
        }
        if (sanitizeText(message.context_token)) {
          this.setContextToken(message.from_user_id, message.context_token);
        }
        log(`Weixin inbound accepted: from=${sanitizeText(message.from_user_id)} text="${extractWeixinText(message).slice(0, 60)}"`);
        this.dispatchMessage('WEIXIN_MESSAGE_CREATE', message);
      }

      this.ready = true;
    } finally {
      if (this.activePollController === controller) {
        this.activePollController = null;
      }
    }
  }

  async sendTextMessage(toUserId, text, contextToken) {
    const normalizedToUserId = sanitizeText(toUserId);
    if (!normalizedToUserId) {
      throw new Error('Weixin target user id is missing.');
    }
    const clientId = crypto.randomUUID();

    const response = await this.request(
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: normalizedToUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: sanitizeText(contextToken) || undefined,
          item_list: [
            {
              type: 1,
              text_item: { text: String(text || '') }
            }
          ]
        },
        base_info: {
          channel_version: 'qq-codex-runner'
        }
      },
      this.apiTimeoutMs
    );

    if ((Number(response && response.ret) || 0) !== 0 || (Number(response && response.errcode) || 0) !== 0) {
      throw new Error(
        `Weixin sendmessage failed: ret=${Number(response && response.ret) || 0} errcode=${
          Number(response && response.errcode) || 0
        } errmsg=${sanitizeText(response && response.errmsg) || 'unknown error'}`
      );
    }

    log(
      `Weixin outbound sent: to=${normalizedToUserId} clientId=${clientId} textLen=${String(text || '').length}`
    );
  }

  async connect() {
    if (this.runningPromise) return this.runningPromise;
    this.stopped = false;
    this.runningPromise = (async () => {
      while (!this.stopped) {
        try {
          await this.pollOnce();
        } catch (error) {
          this.ready = false;
          if (this.stopped) break;
          if (error && error.name === 'AbortError') {
            continue;
          }
          log(`Weixin poll failed: ${error && error.message ? error.message : String(error)}`);
          await sleep(2000);
        }
      }
    })().finally(() => {
      this.runningPromise = null;
      this.ready = false;
    });

    return this.runningPromise;
  }

  async close() {
    this.stopped = true;
    this.ready = false;
    if (this.activePollController) {
      this.activePollController.abort();
      this.activePollController = null;
    }
    if (this.runningPromise) {
      try {
        await this.runningPromise;
      } catch (_) {}
    }
  }
}

function parseArgs(argv) {
  const delimiterIndex = argv.indexOf('--');
  const runnerArgs = delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
  const codexArgs = delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1);
  let command = process.env.CODEX_BIN || 'codex';
  let mode = 'runner';
  let weixinAccountId = sanitizeText(process.env.WEIXIN_ACCOUNT_ID || 'default') || 'default';
  let weixinLoginForce = false;

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
    if (token === '--cmd') {
      const next = runnerArgs[index + 1];
      if (!next) usage(1);
      command = next;
      index += 1;
      continue;
    }
    usage(1);
  }

  return { command, codexArgs, mode, weixinAccountId, weixinLoginForce };
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

function extractThreadIdFromExecEvents(events) {
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (sanitizeText(event.type) === 'thread.started' && sanitizeText(event.thread_id)) {
      return sanitizeText(event.thread_id);
    }
  }
  return null;
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

function createQQBotClient() {
  return new QQBotClient({
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
}

const WEIXIN_LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const WEIXIN_LOGIN_BOT_TYPE = sanitizeText(process.env.WEIXIN_BOT_TYPE || '3') || '3';
const WEIXIN_QR_FETCH_TIMEOUT_MS = 10_000;
const WEIXIN_QR_POLL_TIMEOUT_MS = 35_000;
const WEIXIN_QR_TOTAL_TIMEOUT_MS = 8 * 60 * 1000;

async function fetchWeixinQrCode(botType = WEIXIN_LOGIN_BOT_TYPE) {
  const url = new URL('ilink/bot/get_bot_qrcode', `${WEIXIN_LOGIN_BASE_URL}/`);
  url.searchParams.set('bot_type', botType);
  const rawText = await requestTextWithTimeout(url.toString(), {
    timeoutMs: WEIXIN_QR_FETCH_TIMEOUT_MS
  });
  return JSON.parse(rawText);
}

async function pollWeixinQrStatus(qrcode, apiBaseUrl = WEIXIN_LOGIN_BASE_URL) {
  const url = new URL('ilink/bot/get_qrcode_status', `${apiBaseUrl}/`);
  url.searchParams.set('qrcode', qrcode);
  try {
    const rawText = await requestTextWithTimeout(url.toString(), {
      timeoutMs: WEIXIN_QR_POLL_TIMEOUT_MS
    });
    return JSON.parse(rawText);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw error;
  }
}

async function runWeixinLoginFlow(accountId, force = false) {
  const normalizedAccountId = sanitizeText(accountId) || 'default';
  if (!force) {
    const existing = getStoredWeixinAccount(normalizedAccountId);
    if (existing && sanitizeText(existing.token)) {
      process.stdout.write(`Weixin account already configured: ${normalizedAccountId}\n`);
      process.stdout.write(`Base URL: ${existing.baseUrl || WEIXIN_LOGIN_BASE_URL}\n`);
      return 0;
    }
  }

  const qr = await fetchWeixinQrCode();
  const qrcode = sanitizeText(qr && qr.qrcode);
  const qrcodeUrl = sanitizeText(qr && qr.qrcode_img_content);
  if (!qrcode || !qrcodeUrl) {
    throw new Error('Weixin QR login failed: qrcode response is incomplete.');
  }

  process.stdout.write('Weixin QR code is ready.\n');
  process.stdout.write('Use WeChat to scan the following URL / QR image:\n');
  process.stdout.write(`${qrcodeUrl}\n`);
  process.stdout.write(`Polling login status for account: ${normalizedAccountId}\n`);

  let currentBaseUrl = WEIXIN_LOGIN_BASE_URL;
  const deadline = Date.now() + WEIXIN_QR_TOTAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await pollWeixinQrStatus(qrcode, currentBaseUrl);
    const currentStatus = sanitizeText(status && status.status);

    if (currentStatus === 'scaned_but_redirect' && sanitizeText(status && status.redirect_host)) {
      currentBaseUrl = `https://${sanitizeText(status.redirect_host)}`;
      continue;
    }

    if (currentStatus === 'wait' || currentStatus === 'scaned') {
      await sleep(1000);
      continue;
    }

    if (currentStatus === 'expired') {
      throw new Error('Weixin QR code expired before confirmation. Please retry.');
    }

    if (currentStatus === 'confirmed') {
      const botToken = sanitizeText(status && status.bot_token);
      const ilinkBotId = sanitizeText(status && status.ilink_bot_id) || normalizedAccountId;
      const baseUrl = sanitizeText(status && status.baseurl) || currentBaseUrl || WEIXIN_LOGIN_BASE_URL;
      const userId = sanitizeText(status && status.ilink_user_id);

      if (!botToken) {
        throw new Error('Weixin login confirmed but bot token is missing.');
      }

      setStoredWeixinAccount({
        accountId: ilinkBotId,
        token: botToken,
        baseUrl,
        userId
      });

      process.stdout.write(
        `Weixin login succeeded.\nAccount ID: ${ilinkBotId}\nBase URL: ${baseUrl}\n` +
        'If the runner service is already running, it will pick up this login automatically within about 1 second.\n'
      );
      return 0;
    }

    throw new Error(`Unexpected Weixin QR status: ${currentStatus || 'unknown'}`);
  }

  throw new Error('Weixin login timed out. Please retry.');
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

function buildAgentPolicyPrompt() {
  if (runnerState.accessMode === 'full') {
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

const { command, codexArgs, mode, weixinAccountId, weixinLoginForce } = parseArgs(process.argv.slice(2));
let qqBot = null;
const WEIXIN_ENABLED = parseBoolean(process.env.WEIXIN_ENABLED, true);

const MAX_BOT_MESSAGE_LENGTH = 1500;
const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000;
const RAW_EXEC_TIMEOUT_MS = Number(process.env.CODEX_EXEC_TIMEOUT_MS);
const EXEC_TIMEOUT_MS = Number.isFinite(RAW_EXEC_TIMEOUT_MS)
  ? RAW_EXEC_TIMEOUT_MS
  : DEFAULT_EXEC_TIMEOUT_MS;
const EXEC_TIMEOUT_DISABLED = EXEC_TIMEOUT_MS <= 0;
const MAX_WORKDIR_SEARCH_RESULTS = 5;
const MAX_WORKDIR_SEARCH_DIRS = 2500;
const WORKDIR_SYSTEM_SEARCH_TIMEOUT_MS = 3000;
const WORKDIR_SYSTEM_SEARCH_MAX_BUFFER = 512 * 1024;
const RUNNER_STATE_FILE = path.resolve(process.cwd(), 'logs', 'runner-state.json');
const PRIMARY_CODEX_HOME = sanitizeText(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const RUNNER_CODEX_HOME = prepareCodexHome(
  process.env.RUNNER_CODEX_HOME || process.env.CODEX_HOME || '',
  PRIMARY_CODEX_HOME
);
const CODEX_CONTEXT_WINDOW_OVERRIDE = getPositiveIntegerEnv('CODEX_CONTEXT_WINDOW');
const CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE = getPositiveIntegerEnv('CODEX_AUTO_COMPACT_TOKEN_LIMIT');
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
const persistedRunnerState = loadPersistedRunnerState();
const initialRunnerState = deriveInitialRunnerState(persistedRunnerState);

const taskQueue = [];
let activeTask = null;
let pendingApproval = null;
const codexSessions = new Map();
let codexProcess = {
  busy: false,
  child: null,
  session: null
};
let runnerState = {
  workdir: initialRunnerState.workdir,
  accessMode: initialRunnerState.accessMode,
  addDirs: DEFAULT_ADD_DIRS.slice()
};
let recentWorkdirSearch = {
  query: '',
  matches: []
};
let weixinState = deriveInitialWeixinState(persistedRunnerState);
let weixinBot = null;
let runnerStateWatcher = null;

function buildChatTurnPrompt(input, options = {}) {
  const includePolicy = options.includePolicy !== false;
  const parts = [];
  if (includePolicy) {
    parts.push(buildAgentPolicyPrompt(), '');
  }
  parts.push(`[User message]\n${input}\n[/User message]`);
  return parts.join('\n');
}

function buildApprovalTurnPrompt(action, approval, options = {}) {
  const includePolicy = options.includePolicy !== false;
  const parts = [];
  if (includePolicy) {
    parts.push(buildAgentPolicyPrompt(), '');
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

function getCodexConfigFilePath() {
  const configHome = RUNNER_CODEX_HOME || PRIMARY_CODEX_HOME;
  if (!configHome) return '';
  return path.join(configHome, 'config.toml');
}

function getEffectiveCodexContextWindow() {
  if (CODEX_CONTEXT_WINDOW_OVERRIDE) return CODEX_CONTEXT_WINDOW_OVERRIDE;
  return parsePositiveInteger(readTopLevelTomlValue(getCodexConfigFilePath(), 'model_context_window'));
}

function getEffectiveCodexAutoCompactTokenLimit() {
  if (CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE) {
    return CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE;
  }
  return parsePositiveInteger(readTopLevelTomlValue(getCodexConfigFilePath(), 'model_auto_compact_token_limit'));
}

function formatCodexConfigValue(value, options = {}) {
  if (!value) return '未配置';
  if (options.overridden) return `${value}（env 覆盖）`;
  return String(value);
}

function getCodexAutoCompactStatus() {
  const contextWindow = getEffectiveCodexContextWindow();
  const compactLimit = getEffectiveCodexAutoCompactTokenLimit();
  if (!compactLimit) {
    return '未配置自动压缩阈值';
  }
  if (contextWindow && compactLimit >= Math.floor(contextWindow * 0.8)) {
    return '阈值接近上下文窗口，可能较难触发自动压缩';
  }
  return '已启用';
}
const WEIXIN_ACCOUNT_ID = sanitizeText(process.env.WEIXIN_ACCOUNT_ID || 'default') || 'default';

if (!VALID_ACCESS_MODES.has(runnerState.accessMode)) {
  runnerState.accessMode = 'safe';
}

hydratePersistedCodexSessions(persistedRunnerState);
persistRunnerState();

function createCodexSessionState(scopeKey, workdir) {
  return {
    scopeKey,
    workdir: resolveInputPath(workdir),
    hasConversation: false,
    threadId: null,
    generation: 0
  };
}

function loadPersistedRunnerState() {
  let rawContent = '';
  try {
    rawContent = fs.readFileSync(RUNNER_STATE_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    log(`Failed to read runner state: ${error && error.message ? error.message : String(error)}`);
    return null;
  }

  try {
    const parsed = JSON.parse(rawContent);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    log(`Failed to parse runner state: ${error && error.message ? error.message : String(error)}`);
    return null;
  }
}

function deriveInitialWeixinState(persistedState) {
  const state = {
    syncCursor: '',
    contextTokens: {},
    accounts: {},
    defaultAccountId: 'default'
  };

  if (!persistedState || !persistedState.weixin || typeof persistedState.weixin !== 'object') {
    return state;
  }

  const nextCursor = sanitizeText(persistedState.weixin.syncCursor);
  if (nextCursor) {
    state.syncCursor = nextCursor;
  }

  if (persistedState.weixin.contextTokens && typeof persistedState.weixin.contextTokens === 'object') {
    for (const [peerId, token] of Object.entries(persistedState.weixin.contextTokens)) {
      const normalizedPeerId = sanitizeText(peerId);
      const normalizedToken = sanitizeText(token);
      if (!normalizedPeerId || !normalizedToken) continue;
      state.contextTokens[normalizedPeerId] = normalizedToken;
    }
  }

  if (persistedState.weixin.accounts && typeof persistedState.weixin.accounts === 'object') {
    for (const [accountId, value] of Object.entries(persistedState.weixin.accounts)) {
      const normalizedAccountId = sanitizeText(accountId);
      if (!normalizedAccountId || !value || typeof value !== 'object') continue;
      state.accounts[normalizedAccountId] = {
        accountId: normalizedAccountId,
        token: sanitizeText(value.token),
        baseUrl: sanitizeText(value.baseUrl),
        userId: sanitizeText(value.userId)
      };
    }
  }

  const defaultAccountId = sanitizeText(persistedState.weixin.defaultAccountId);
  if (defaultAccountId) {
    state.defaultAccountId = defaultAccountId;
  }

  return state;
}

function buildWeixinContextTokenKey(accountId, peerId) {
  return `${sanitizeText(accountId) || 'default'}:${sanitizeText(peerId) || 'unknown'}`;
}

function getStoredWeixinAccount(accountId) {
  const normalizedAccountId = sanitizeText(accountId) || 'default';
  return weixinState.accounts[normalizedAccountId] || null;
}

function setStoredWeixinAccount(account) {
  const normalizedAccountId = sanitizeText(account && account.accountId) || 'default';
  weixinState.accounts[normalizedAccountId] = {
    accountId: normalizedAccountId,
    token: sanitizeText(account && account.token),
    baseUrl: sanitizeText(account && account.baseUrl),
    userId: sanitizeText(account && account.userId)
  };
  weixinState.defaultAccountId = normalizedAccountId;
  persistRunnerState();
}

function clearStoredWeixinAccount(accountId) {
  const normalizedAccountId = sanitizeText(accountId) || 'default';
  delete weixinState.accounts[normalizedAccountId];
  for (const key of Object.keys(weixinState.contextTokens)) {
    if (key.startsWith(`${normalizedAccountId}:`)) {
      delete weixinState.contextTokens[key];
    }
  }
  const prefix = `weixin:${normalizedAccountId}:direct:`;
  for (const [sessionKey, session] of codexSessions.entries()) {
    if (session.scopeKey && session.scopeKey.startsWith(prefix)) {
      codexSessions.delete(sessionKey);
    }
  }
  if (weixinBot && weixinBot.accountId === normalizedAccountId) {
    weixinBot.ready = false;
  }
  if (weixinState.defaultAccountId === normalizedAccountId) {
    const remainingAccountId = Object.keys(weixinState.accounts)[0];
    weixinState.defaultAccountId = remainingAccountId || 'default';
  }
  persistRunnerState();
}

function resolveWeixinRuntimeAccount(accountId) {
  const requestedAccountId = sanitizeText(accountId) || '';
  const normalizedAccountId = requestedAccountId || weixinState.defaultAccountId || 'default';
  const stored = getStoredWeixinAccount(normalizedAccountId) || getStoredWeixinAccount(weixinState.defaultAccountId);
  return {
    accountId: sanitizeText(stored && stored.accountId) || normalizedAccountId,
    token: sanitizeText(process.env.WEIXIN_TOKEN) || sanitizeText(stored && stored.token),
    baseUrl:
      sanitizeText(process.env.WEIXIN_BASE_URL) ||
      sanitizeText(stored && stored.baseUrl) ||
      'https://ilinkai.weixin.qq.com',
    userId: sanitizeText(stored && stored.userId)
  };
}

function syncWeixinStateFromDisk() {
  const latestState = loadPersistedRunnerState();
  if (!latestState) return;
  weixinState = deriveInitialWeixinState(latestState);
}

function getDesiredWeixinAccount() {
  const account = resolveWeixinRuntimeAccount(WEIXIN_ACCOUNT_ID);
  const hasCredentials = Boolean(sanitizeText(account.token));
  return {
    ...account,
    enabled: WEIXIN_ENABLED && hasCredentials
  };
}

async function refreshWeixinClient() {
  syncWeixinStateFromDisk();
  const desiredAccount = getDesiredWeixinAccount();

  if (!desiredAccount.enabled) {
    if (weixinBot) {
      const closingBot = weixinBot;
      weixinBot = null;
      log(`Stopping Weixin client for account ${closingBot.accountId}.`);
      await closingBot.close();
    }
    return;
  }

  if (
    weixinBot &&
    weixinBot.accountId === desiredAccount.accountId &&
    sanitizeText(weixinBot.baseUrl) === sanitizeText(desiredAccount.baseUrl) &&
    sanitizeText(weixinBot.token) === sanitizeText(desiredAccount.token)
  ) {
    return;
  }

  if (weixinBot) {
    const closingBot = weixinBot;
    weixinBot = null;
    log(`Reloading Weixin client for account ${closingBot.accountId}.`);
    await closingBot.close();
  }

  const nextBot = new WeixinClient({
    accountId: desiredAccount.accountId,
    baseUrl: desiredAccount.baseUrl,
    token: desiredAccount.token,
    longPollTimeoutMs: Number(process.env.WEIXIN_LONG_POLL_TIMEOUT_MS || 35_000)
  });
  nextBot.onMessage(enqueueMessage);
  weixinBot = nextBot;
  log(`Starting Weixin client for account ${nextBot.accountId}.`);
  nextBot.connect().catch((error) => {
    log(`Failed to start Weixin client: ${error && error.message ? error.message : String(error)}`);
  });
}

function startRunnerStateWatcher() {
  if (runnerStateWatcher) return;
  runnerStateWatcher = fs.watchFile(
    RUNNER_STATE_FILE,
    { interval: 1000 },
    () => {
      void refreshWeixinClient();
    }
  );
}

function stopRunnerStateWatcher() {
  if (!runnerStateWatcher) return;
  fs.unwatchFile(RUNNER_STATE_FILE);
  runnerStateWatcher = null;
}

function resolveExistingDirectory(targetPath) {
  const normalized = sanitizeText(targetPath);
  if (!normalized) return null;
  const resolved = resolveInputPath(normalized);
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return resolved;
}

function deriveInitialRunnerState(persistedState) {
  const fallbackAccessMode = sanitizeText(process.env.CODEX_ACCESS_MODE || 'safe').toLowerCase();
  const nextState = {
    workdir: DEFAULT_WORKDIR,
    accessMode: fallbackAccessMode
  };

  const persistedWorkdir = persistedState ? resolveExistingDirectory(persistedState.workdir) : null;
  if (persistedWorkdir) {
    nextState.workdir = persistedWorkdir;
  }

  const persistedAccessMode = sanitizeText(persistedState && persistedState.accessMode);
  if (persistedAccessMode && VALID_ACCESS_MODES.has(persistedAccessMode.toLowerCase())) {
    nextState.accessMode = persistedAccessMode.toLowerCase();
  }

  return nextState;
}

function buildSessionIdentity(scopeKey, workdir) {
  return `${sanitizeText(scopeKey) || 'runner:default'}::${resolveInputPath(workdir)}`;
}

function getContextSessionScopeKey(context) {
  if (!context) return 'runner:default';
  if (sanitizeText(context.sessionScopeKey)) {
    return sanitizeText(context.sessionScopeKey);
  }
  if (context.platform === 'weixin') {
    return `weixin:${sanitizeText(context.accountId) || 'default'}:direct:${sanitizeText(context.peerId) || 'unknown'}`;
  }
  if (context.type === 'c2c') {
    return `qq:c2c:${sanitizeText(context.openid) || 'unknown'}`;
  }
  return `qq:channel:${sanitizeText(context.channelId) || 'unknown'}`;
}

function hydratePersistedCodexSessions(persistedState) {
  if (!persistedState || !Array.isArray(persistedState.codexSessions)) return;

  for (const record of persistedState.codexSessions) {
    if (!record || typeof record !== 'object') continue;

    const scopeKey = sanitizeText(record.scopeKey);
    const threadId = sanitizeText(record.threadId);
    const resolvedWorkdir = resolveExistingDirectory(record.workdir);
    if (!scopeKey || !threadId || !resolvedWorkdir) continue;

    const key = buildSessionIdentity(scopeKey, resolvedWorkdir);
    codexSessions.set(key, {
      scopeKey,
      workdir: resolvedWorkdir,
      hasConversation: true,
      threadId,
      generation: 0
    });
  }
}

function getScopedSession(scopeKey, workdir = runnerState.workdir) {
  const resolvedWorkdir = resolveInputPath(workdir);
  const key = buildSessionIdentity(scopeKey, resolvedWorkdir);
  if (!codexSessions.has(key)) {
    codexSessions.set(key, createCodexSessionState(scopeKey, resolvedWorkdir));
  }
  return codexSessions.get(key);
}

function countActiveSessions() {
  let count = 0;
  for (const session of codexSessions.values()) {
    if (session.hasConversation && session.threadId) count += 1;
  }
  return count;
}

function buildPersistedRunnerState() {
  const sessionRecords = [];
  for (const session of codexSessions.values()) {
    if (session && session.hasConversation && session.threadId) {
      sessionRecords.push({
        scopeKey: session.scopeKey,
        workdir: session.workdir,
        threadId: session.threadId
      });
    }
  }

  sessionRecords.sort((left, right) => {
    if (left.scopeKey === right.scopeKey) {
      return left.workdir.localeCompare(right.workdir);
    }
    return left.scopeKey.localeCompare(right.scopeKey);
  });

  return {
    version: 2,
    workdir: runnerState.workdir,
    accessMode: runnerState.accessMode,
    codexSessions: sessionRecords,
    weixin: {
      syncCursor: weixinState.syncCursor,
      contextTokens: { ...weixinState.contextTokens },
      accounts: { ...weixinState.accounts },
      defaultAccountId: weixinState.defaultAccountId
    }
  };
}

function persistRunnerState() {
  const payload = JSON.stringify(buildPersistedRunnerState(), null, 2);
  const tempFile = `${RUNNER_STATE_FILE}.tmp`;

  try {
    fs.mkdirSync(path.dirname(RUNNER_STATE_FILE), { recursive: true });
    fs.writeFileSync(tempFile, payload, 'utf8');
    fs.renameSync(tempFile, RUNNER_STATE_FILE);
  } catch (error) {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {}
    log(`Failed to persist runner state: ${error && error.message ? error.message : String(error)}`);
  }
}

function bumpSessionGeneration(session) {
  if (!session) return;
  session.generation += 1;
}

function resetSessionState(session) {
  if (!session) return;
  session.hasConversation = false;
  session.threadId = null;
  session.generation += 1;
}

function getSessionForContext(context, workdir = runnerState.workdir) {
  return getScopedSession(getContextSessionScopeKey(context), workdir);
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
    '/session - 查看当前聊天会话在当前工作目录的 Codex 状态',
    '/cwd - 查看当前工作目录',
    '/cwd <目录> - 切换到指定目录；切回旧目录会恢复该目录会话',
    '/cwd <关键字> - 用本地系统搜索目录并展示最多 5 个候选',
    '/cwd <编号> - 选择最近一次搜索结果中的目录',
    '/access - 查看当前权限模式',
    '/access <read|write|safe|full> - 切换权限模式、清空队列并重置所有目录会话',
    '/new - 重置当前聊天会话在当前工作目录的 Codex 会话',
    '/restart - 清空队列并重置所有目录会话',
    '/allow - 批准待审批命令',
    '/skip - 跳过待审批命令',
    '/reject - 拒绝待审批命令并重置当前目录会话'
  ].join('\n');
}

function getStatusMessage(context) {
  const currentSession = getSessionForContext(context);
  const contextWindow = getEffectiveCodexContextWindow();
  const autoCompactTokenLimit = getEffectiveCodexAutoCompactTokenLimit();
  return [
    '运行状态：',
    `QQ 已连接：${qqBot ? (qqBot.ready ? '是' : '否') : '否'}`,
    `微信已启用：${weixinBot ? '是' : '否'}`,
    `微信已连接：${weixinBot ? (weixinBot.ready ? '是' : '否') : '否'}`,
    `Codex 忙碌中：${codexProcess.busy ? '是' : '否'}`,
    `当前目录会话已建立：${currentSession.hasConversation ? '是' : '否'}`,
    `已缓存目录会话：${countActiveSessions()}`,
    `队列长度：${taskQueue.length}`,
    `存在待审批：${pendingApproval ? '是' : '否'}`,
    `工作目录：${runnerState.workdir}`,
    `权限模式：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}`,
    `Runner CODEX_HOME：${RUNNER_CODEX_HOME || '继承系统默认'}`,
    `Codex 上下文窗口：${formatCodexConfigValue(contextWindow, {
      overridden: Boolean(CODEX_CONTEXT_WINDOW_OVERRIDE)
    })}`,
    `Codex 自动压缩阈值：${formatCodexConfigValue(autoCompactTokenLimit, {
      overridden: Boolean(CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE)
    })}`,
    `自动压缩状态：${getCodexAutoCompactStatus()}`
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

function getSessionMessage(context) {
  const currentSession = getSessionForContext(context);
  const autoCompactTokenLimit = getEffectiveCodexAutoCompactTokenLimit();
  return [
    '会话状态：',
    `当前会话键：${currentSession.scopeKey}`,
    `当前目录会话已建立：${currentSession.hasConversation ? '是' : '否'}`,
    `Codex 忙碌中：${codexProcess.busy ? '是' : '否'}`,
    `当前目录会话代次：${currentSession.generation}`,
    `当前目录线程 ID：${currentSession.threadId || '无'}`,
    `已缓存目录会话：${countActiveSessions()}`,
    `存在待审批：${pendingApproval ? '是' : '否'}`,
    `工作目录：${runnerState.workdir}`,
    `权限模式：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}`,
    `Runner CODEX_HOME：${RUNNER_CODEX_HOME || '继承系统默认'}`,
    `Codex 自动压缩阈值：${formatCodexConfigValue(autoCompactTokenLimit, {
      overridden: Boolean(CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE)
    })}`,
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

function extractWeixinText(message) {
  if (!message || !Array.isArray(message.item_list)) return '';

  for (const item of message.item_list) {
    if (Number(item && item.type) === 1 && item.text_item && typeof item.text_item.text === 'string') {
      return sanitizeText(item.text_item.text);
    }
    if (Number(item && item.type) === 3 && item.voice_item && typeof item.voice_item.text === 'string') {
      return sanitizeText(item.voice_item.text);
    }
  }

  return '';
}

function buildContext(eventType, message) {
  if (eventType === 'WEIXIN_MESSAGE_CREATE') {
    const accountId = weixinBot ? weixinBot.accountId : 'default';
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

  if (eventType === 'C2C_MESSAGE_CREATE') {
    return {
      platform: 'qq',
      type: 'c2c',
      openid:
        message && message.author
          ? message.author.user_openid || message.author.union_openid || message.author.id
          : null,
      messageId: message.id,
      sessionScopeKey: `qq:c2c:${
        sanitizeText(
          message && message.author
            ? message.author.user_openid || message.author.union_openid || message.author.id
            : ''
        ) || 'unknown'
      }`
    };
  }

  return {
    platform: 'qq',
    type: 'channel',
    channelId: message.channel_id,
    messageId: message.id,
    sessionScopeKey: `qq:channel:${sanitizeText(message && message.channel_id) || 'unknown'}`
  };
}

async function sendReply(context, content) {
  const parts = splitMessage(content, MAX_BOT_MESSAGE_LENGTH);
  for (const part of parts) {
    if (context.platform === 'weixin') {
      if (!weixinBot) {
        throw new Error('Weixin client is not configured.');
      }
      await weixinBot.sendTextMessage(
        context.peerId,
        part,
        weixinBot.getContextToken(context.peerId) || context.contextToken || null
      );
      continue;
    }

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

function buildCodexArgs(prompt, outputFile, session, workdir) {
  const args = ['exec'];
  const accessConfig = VALID_ACCESS_MODES.get(runnerState.accessMode) || VALID_ACCESS_MODES.get('safe');
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

function runCodexExec(prompt, session, workdir) {
  return new Promise((resolve, reject) => {
    const generation = session.generation;
    const outputFile = path.join(os.tmpdir(), `qq-codex-runner-last-${process.pid}-${Date.now()}.txt`);
    const args = buildCodexArgs(prompt, outputFile, session, workdir);
    const child = childProcess.spawn(command, args, {
      cwd: workdir,
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        ...(RUNNER_CODEX_HOME ? { CODEX_HOME: RUNNER_CODEX_HOME } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    codexProcess.child = child;
    codexProcess.busy = true;
    codexProcess.session = session;

    let stdout = '';
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
        reject(
          new Error(
            `Codex execution timed out after ${Math.floor(
              EXEC_TIMEOUT_MS / 1000
            )} seconds without new output. You can increase CODEX_EXEC_TIMEOUT_MS or set it to 0 to disable this timeout.`
          )
        );
      }, EXEC_TIMEOUT_MS);
    };

    refreshExecTimeout();

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
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
      clearExecTimeout();
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
      const threadId = extractThreadIdFromExecEvents(events);
      if (threadId) {
        session.threadId = threadId;
      }
      if (events.length > 0 || sanitizeText(finalMessage)) {
        session.hasConversation = true;
        persistRunnerState();
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
  resetSessionState(getSessionForContext(context));
  pendingApproval = null;
  clearRecentWorkdirSearch();
  stopActiveCodexProcess();
  persistRunnerState();

  await safeSendReply(context, 'Codex 会话已重置，下一条消息会启动新的对话。');
}

async function restartRunner(context) {
  stopActiveCodexProcess();
  pendingApproval = null;
  taskQueue.length = 0;
  clearRecentWorkdirSearch();
  codexSessions.clear();
  persistRunnerState();

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
  const targetSession = getSessionForContext(context, resolved);
  persistRunnerState();
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
  codexSessions.clear();
  persistRunnerState();

  await safeSendReply(
    context,
    `权限模式已切换为：${VALID_ACCESS_MODES.get(mode).label}\n已清空等待队列，并重置所有目录会话。`
  );
}

async function executeTask(task) {
  runnerState.workdir = task.workdir;
  const session = getScopedSession(task.sessionScopeKey, task.workdir);

  if (codexProcess.busy) {
    await safeSendReply(task.context, 'Codex 正在处理上一条消息，请稍候。');
    return;
  }

  await safeSendReply(task.context, `开始执行，队列剩余 ${taskQueue.length} 条。`);

  try {
    const includePolicy = !(session.hasConversation && session.threadId);
    const prompt = task.kind === 'approval'
      ? buildApprovalPrompt(task.action, pendingApproval, { includePolicy })
      : buildUserPrompt(task.input, { includePolicy });

    const reply = await runCodexExec(prompt, session, task.workdir);
    if (!reply) {
      return;
    }
    const approval = parseApprovalRequest(reply);

    if (approval) {
      pendingApproval = {
        command: approval.command,
        reason: approval.reason,
        context: task.context,
        workdir: task.workdir,
        sessionScopeKey: task.sessionScopeKey
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
  if (!message) return;

  let input = '';
  if (eventType === 'WEIXIN_MESSAGE_CREATE') {
    if (Number(message.message_type || 0) !== 1) return;
    input = extractWeixinText(message);
  } else {
    if (!message.author) return;
    if (message.author.bot) return;
    if (String(message.author.id || '') === String(qqBot.appId)) return;

    const rawContent = sanitizeText(message.content);
    input = eventType === 'AT_MESSAGE_CREATE' ? stripAtMentions(rawContent) : rawContent;
  }

  if (!input) return;

  const context = buildContext(eventType, message);
  if (context.platform === 'weixin' && weixinBot && context.contextToken) {
    weixinBot.setContextToken(context.peerId, context.contextToken);
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
      workdir: pendingApproval.workdir,
      sessionScopeKey: pendingApproval.sessionScopeKey
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

  if (context.platform === 'weixin' && !context.peerId) {
    log(`Ignoring Weixin message without peer id: ${context.messageId}`);
    return;
  }

  const task = {
    kind: 'user',
    action: null,
    input,
    context,
    workdir: runnerState.workdir,
    sessionScopeKey: context.sessionScopeKey
  };

  const queuedAhead = (activeTask ? 1 : 0) + taskQueue.length;
  taskQueue.push(task);
  if (queuedAhead > 0) {
    await safeSendReply(context, `已加入队列，前面还有 ${queuedAhead} 个任务。`);
  }
  void processQueue();
}

async function startRunner() {
  qqBot = createQQBotClient();
  qqBot.onMessage(enqueueMessage);
  startRunnerStateWatcher();

  for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signalName, async () => {
      if (codexProcess && codexProcess.child) {
        try {
          codexProcess.child.kill(signalName);
        } catch (_) {}
      }
      stopRunnerStateWatcher();
      if (weixinBot) {
        await weixinBot.close();
      }
      await qqBot.close();
      process.exit(0);
    });
  }

  await qqBot.connect();
  log('QQ bot connected.');
  await refreshWeixinClient();
}

async function main() {
  if (mode === 'weixin-login') {
    const exitCode = await runWeixinLoginFlow(weixinAccountId, weixinLoginForce);
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
