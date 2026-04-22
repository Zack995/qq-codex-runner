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

function parseExecJsonEventLine(line) {
  const normalized = sanitizeText(line);
  if (!normalized) return null;
  try {
    return JSON.parse(normalized);
  } catch (_) {
    return null;
  }
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== 'object') return null;

  const inputTokens = Math.max(0, Number(value.input_tokens ?? value.inputTokens ?? 0) || 0);
  const cachedInputTokens = Math.max(
    0,
    Number(value.cached_input_tokens ?? value.cachedInputTokens ?? 0) || 0
  );
  const outputTokens = Math.max(0, Number(value.output_tokens ?? value.outputTokens ?? 0) || 0);
  const reasoningOutputTokens = Math.max(
    0,
    Number(value.reasoning_output_tokens ?? value.reasoningOutputTokens ?? 0) || 0
  );
  const totalTokens = Math.max(
    0,
    Number(value.total_tokens ?? value.totalTokens ?? (inputTokens + outputTokens + reasoningOutputTokens)) || 0
  );

  if (
    inputTokens === 0 &&
    cachedInputTokens === 0 &&
    outputTokens === 0 &&
    reasoningOutputTokens === 0 &&
    totalTokens === 0
  ) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function addTokenUsage(left, right) {
  const normalizedLeft = normalizeTokenUsage(left);
  const normalizedRight = normalizeTokenUsage(right);
  if (!normalizedLeft && !normalizedRight) return null;
  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;

  return {
    inputTokens: normalizedLeft.inputTokens + normalizedRight.inputTokens,
    cachedInputTokens: normalizedLeft.cachedInputTokens + normalizedRight.cachedInputTokens,
    outputTokens: normalizedLeft.outputTokens + normalizedRight.outputTokens,
    reasoningOutputTokens: normalizedLeft.reasoningOutputTokens + normalizedRight.reasoningOutputTokens,
    totalTokens: normalizedLeft.totalTokens + normalizedRight.totalTokens
  };
}

function extractTokenUsageFromExecEvents(events) {
  const state = {
    lastUsage: null,
    totalUsage: null
  };

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;

    if (sanitizeText(event.type) === 'turn.completed') {
      const usage = normalizeTokenUsage(event.usage);
      if (usage) {
        state.lastUsage = usage;
      }
      continue;
    }

    const payload = event.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (sanitizeText(payload.type) !== 'token_count') continue;
    const info = payload.info;
    if (!info || typeof info !== 'object') continue;

    const lastUsage = normalizeTokenUsage(info.last_token_usage || info.lastTokenUsage);
    const totalUsage = normalizeTokenUsage(info.total_token_usage || info.totalTokenUsage);
    if (lastUsage) {
      state.lastUsage = lastUsage;
    }
    if (totalUsage) {
      state.totalUsage = totalUsage;
    }
  }

  return state;
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

function formatTokenNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function formatTokenUsage(usage) {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) return '暂无';

  const parts = [
    `输入 ${formatTokenNumber(normalized.inputTokens)}`
  ];
  if (normalized.cachedInputTokens > 0) {
    parts[0] += `（缓存 ${formatTokenNumber(normalized.cachedInputTokens)}）`;
  }
  parts.push(`输出 ${formatTokenNumber(normalized.outputTokens)}`);
  if (normalized.reasoningOutputTokens > 0) {
    parts.push(`推理 ${formatTokenNumber(normalized.reasoningOutputTokens)}`);
  }
  parts.push(`合计 ${formatTokenNumber(normalized.totalTokens)}`);
  return parts.join('，');
}

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
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
    if (!event.is_error && sanitizeText(event.subtype) !== 'error') continue;
    return sanitizeText(event.result || event.error || event.message) || 'Claude 返回错误但未提供详细信息';
  }
  return '';
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
const PROGRESS_HEARTBEAT_INTERVAL_MS = 25 * 1000;
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
const VALID_BACKENDS = new Set(['codex', 'claude']);
const BACKEND_LABELS = { codex: 'Codex', claude: 'Claude Code' };
const DEFAULT_BACKEND = (() => {
  const raw = sanitizeText(process.env.RUNNER_DEFAULT_BACKEND).toLowerCase();
  return VALID_BACKENDS.has(raw) ? raw : 'codex';
})();
const CLAUDE_BIN = sanitizeText(process.env.CLAUDE_BIN) || 'claude';
const RUNNER_CLAUDE_HOME = (() => {
  const raw = sanitizeText(process.env.RUNNER_CLAUDE_HOME || '');
  return raw ? resolveInputPath(raw) : '';
})();
const CLAUDE_PERMISSION_MODE_BY_ACCESS = {
  read: 'plan',
  write: 'acceptEdits',
  safe: 'acceptEdits',
  full: 'bypassPermissions'
};
const BACKEND_PROBE_TIMEOUT_MS = 5000;
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
  addDirs: DEFAULT_ADD_DIRS.slice(),
  backends: { ...(initialRunnerState.backends || {}) }
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
  const backend = options.backend || 'codex';
  const parts = [];
  if (includePolicy && backend === 'codex') {
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

function getCodexSessionsDirPath() {
  const configHome = RUNNER_CODEX_HOME || PRIMARY_CODEX_HOME;
  if (!configHome) return '';
  return path.join(configHome, 'sessions');
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

function createCodexSessionState(scopeKey, workdir, backend = 'codex') {
  const normalizedBackend = VALID_BACKENDS.has(backend) ? backend : 'codex';
  return {
    scopeKey,
    workdir: resolveInputPath(workdir),
    backend: normalizedBackend,
    hasConversation: false,
    threadId: null,
    generation: 0,
    lastTokenUsage: null,
    totalTokenUsage: null
  };
}

function getActiveBackend(scopeKey) {
  const key = sanitizeText(scopeKey);
  if (!key) return DEFAULT_BACKEND;
  const stored = sanitizeText(
    runnerState && runnerState.backends ? runnerState.backends[key] : ''
  ).toLowerCase();
  if (stored && VALID_BACKENDS.has(stored)) return stored;
  return DEFAULT_BACKEND;
}

function setActiveBackend(scopeKey, backend) {
  const key = sanitizeText(scopeKey);
  const normalized = sanitizeText(backend).toLowerCase();
  if (!key || !VALID_BACKENDS.has(normalized)) return;
  if (!runnerState.backends) {
    runnerState.backends = {};
  }
  runnerState.backends[key] = normalized;
}

function findCodexRolloutFileByThreadId(threadId) {
  const normalizedThreadId = sanitizeText(threadId);
  const sessionsDir = getCodexSessionsDirPath();
  if (!normalizedThreadId || !sessionsDir) return '';

  const targetSuffix = `${normalizedThreadId}.jsonl`;
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(targetSuffix)) {
        return fullPath;
      }
    }
  }

  return '';
}

function loadPersistedTokenUsageByThreadId(threadId) {
  const rolloutFile = findCodexRolloutFileByThreadId(threadId);
  if (!rolloutFile) return { lastUsage: null, totalUsage: null };

  let content = '';
  try {
    content = fs.readFileSync(rolloutFile, 'utf8');
  } catch (_) {
    return { lastUsage: null, totalUsage: null };
  }

  return extractTokenUsageFromExecEvents(parseExecJsonEvents(content));
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
    accessMode: fallbackAccessMode,
    backends: {}
  };

  const persistedWorkdir = persistedState ? resolveExistingDirectory(persistedState.workdir) : null;
  if (persistedWorkdir) {
    nextState.workdir = persistedWorkdir;
  }

  const persistedAccessMode = sanitizeText(persistedState && persistedState.accessMode);
  if (persistedAccessMode && VALID_ACCESS_MODES.has(persistedAccessMode.toLowerCase())) {
    nextState.accessMode = persistedAccessMode.toLowerCase();
  }

  if (persistedState && persistedState.backends && typeof persistedState.backends === 'object') {
    for (const [scope, backend] of Object.entries(persistedState.backends)) {
      const normalizedScope = sanitizeText(scope);
      const normalizedBackend = sanitizeText(backend).toLowerCase();
      if (!normalizedScope) continue;
      if (!VALID_BACKENDS.has(normalizedBackend)) continue;
      nextState.backends[normalizedScope] = normalizedBackend;
    }
  }

  return nextState;
}

function buildSessionIdentity(scopeKey, workdir, backend = 'codex') {
  const normalizedBackend = VALID_BACKENDS.has(backend) ? backend : 'codex';
  return `${sanitizeText(scopeKey) || 'runner:default'}::${resolveInputPath(workdir)}::${normalizedBackend}`;
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

    const rawBackend = sanitizeText(record.backend).toLowerCase();
    const backend = VALID_BACKENDS.has(rawBackend) ? rawBackend : 'codex';

    const key = buildSessionIdentity(scopeKey, resolvedWorkdir, backend);
    const persistedLastTokenUsage = normalizeTokenUsage(record.lastTokenUsage || record.last_token_usage);
    const persistedTotalTokenUsage = normalizeTokenUsage(record.totalTokenUsage || record.total_token_usage);
    const hydratedTokenUsage = (!persistedLastTokenUsage && !persistedTotalTokenUsage && backend === 'codex')
      ? loadPersistedTokenUsageByThreadId(threadId)
      : { lastUsage: persistedLastTokenUsage, totalUsage: persistedTotalTokenUsage };
    codexSessions.set(key, {
      scopeKey,
      workdir: resolvedWorkdir,
      backend,
      hasConversation: true,
      threadId,
      generation: 0,
      lastTokenUsage: normalizeTokenUsage(hydratedTokenUsage.lastUsage),
      totalTokenUsage: normalizeTokenUsage(hydratedTokenUsage.totalUsage)
    });
  }
}

function getScopedSession(scopeKey, workdir = runnerState.workdir, backend) {
  const resolvedWorkdir = resolveInputPath(workdir);
  const resolvedBackend = VALID_BACKENDS.has(backend) ? backend : getActiveBackend(scopeKey);
  const key = buildSessionIdentity(scopeKey, resolvedWorkdir, resolvedBackend);
  if (!codexSessions.has(key)) {
    codexSessions.set(key, createCodexSessionState(scopeKey, resolvedWorkdir, resolvedBackend));
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

function ensureSessionTokenUsage(session, options = {}) {
  if (!session || !session.threadId) {
    return {
      lastUsage: normalizeTokenUsage(session && session.lastTokenUsage),
      totalUsage: normalizeTokenUsage(session && session.totalTokenUsage)
    };
  }

  let updated = false;
  if (!normalizeTokenUsage(session.lastTokenUsage) || !normalizeTokenUsage(session.totalTokenUsage)) {
    const hydratedTokenUsage = loadPersistedTokenUsageByThreadId(session.threadId);
    if (!normalizeTokenUsage(session.lastTokenUsage) && hydratedTokenUsage.lastUsage) {
      session.lastTokenUsage = hydratedTokenUsage.lastUsage;
      updated = true;
    }
    if (!normalizeTokenUsage(session.totalTokenUsage) && hydratedTokenUsage.totalUsage) {
      session.totalTokenUsage = hydratedTokenUsage.totalUsage;
      updated = true;
    }
  }

  if (updated && options.persist !== false) {
    persistRunnerState();
  }

  return {
    lastUsage: normalizeTokenUsage(session.lastTokenUsage),
    totalUsage: normalizeTokenUsage(session.totalTokenUsage)
  };
}

function buildPersistedRunnerState() {
  const sessionRecords = [];
  for (const session of codexSessions.values()) {
    if (session && session.hasConversation && session.threadId) {
      sessionRecords.push({
        scopeKey: session.scopeKey,
        workdir: session.workdir,
        backend: session.backend || 'codex',
        threadId: session.threadId,
        lastTokenUsage: normalizeTokenUsage(session.lastTokenUsage),
        totalTokenUsage: normalizeTokenUsage(session.totalTokenUsage)
      });
    }
  }

  sessionRecords.sort((left, right) => {
    if (left.scopeKey === right.scopeKey) {
      if (left.workdir === right.workdir) {
        return String(left.backend).localeCompare(String(right.backend));
      }
      return left.workdir.localeCompare(right.workdir);
    }
    return left.scopeKey.localeCompare(right.scopeKey);
  });

  const sortedBackends = {};
  if (runnerState.backends && typeof runnerState.backends === 'object') {
    for (const scope of Object.keys(runnerState.backends).sort()) {
      const value = sanitizeText(runnerState.backends[scope]).toLowerCase();
      if (VALID_BACKENDS.has(value)) {
        sortedBackends[scope] = value;
      }
    }
  }

  return {
    version: 3,
    workdir: runnerState.workdir,
    accessMode: runnerState.accessMode,
    backends: sortedBackends,
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
  session.lastTokenUsage = null;
  session.totalTokenUsage = null;
  session.generation += 1;
}

function getSessionForContext(context, workdir = runnerState.workdir, backend) {
  return getScopedSession(getContextSessionScopeKey(context), workdir, backend);
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
    '',
    '【基础】',
    '/help - 查看帮助',
    '/status - 查看运行状态（后端、连接、队列、目录、权限、最近 Token）',
    '/queue - 查看队列状态（当前任务、排队数、后端是否忙碌）',
    '/session - 查看当前聊天会话：后端、线程/Session ID、Token、待审批',
    '',
    '【工作目录】',
    '/cwd - 查看当前工作目录',
    '/cwd <目录> - 切换工作目录；切回旧目录会恢复该目录会话',
    '/cwd <关键字> - 搜索本地目录（最多 5 个候选）',
    '/cwd <编号> - 选择最近一次搜索结果中的目录',
    '',
    '【权限模式】',
    '/access - 查看当前权限模式',
    '/access <read|write|safe|full> - 切换权限模式、清空队列、重置所有会话',
    '  · Codex sandbox：read-only / workspace-write / workspace-write / danger-full-access',
    '  · Claude permission-mode：plan / acceptEdits / acceptEdits / bypassPermissions',
    '',
    '【后端切换】',
    '/backend - 查看当前后端，并检测 codex / claude 两个 CLI 的可用性',
    '/backend <codex|claude> - 切换当前聊天的后端（按聊天维度独立生效）',
    '  · 切换前会检测二进制是否可执行；不可执行直接拒绝',
    '  · 未检测到凭据（auth 文件 / API key）仅警告，不阻断切换',
    '  · codex 和 claude 在同一聊天下各自保留独立会话，不会互相覆盖',
    '',
    '【会话管理】',
    '/new - 重置当前聊天在当前目录的当前后端会话（另一后端会话不受影响）',
    '/restart - 清空队列并重置所有会话（不区分后端）',
    '',
    '【审批（仅 Codex）】',
    '/allow - 批准待审批命令',
    '/skip - 跳过待审批命令',
    '/reject - 拒绝待审批命令并重置当前目录会话'
  ].join('\n');
}

function getStatusMessage(context) {
  const scopeKey = getContextSessionScopeKey(context);
  const backend = getActiveBackend(scopeKey);
  const currentSession = getSessionForContext(context, runnerState.workdir, backend);
  const tokenUsage = ensureSessionTokenUsage(currentSession);
  const lines = [
    '运行状态：',
    `QQ 已连接：${qqBot ? (qqBot.ready ? '是' : '否') : '否'}`,
    `微信已启用：${weixinBot ? '是' : '否'}`,
    `微信已连接：${weixinBot ? (weixinBot.ready ? '是' : '否') : '否'}`,
    `当前后端：${BACKEND_LABELS[backend]}`,
    `后端忙碌中：${codexProcess.busy ? '是' : '否'}`,
    `当前目录会话已建立：${currentSession.hasConversation ? '是' : '否'}`,
    `已缓存目录会话：${countActiveSessions()}`,
    `队列长度：${taskQueue.length}`,
    `存在待审批：${pendingApproval ? '是' : '否'}`,
    `工作目录：${runnerState.workdir}`,
    `权限模式：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}`
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
    const permissionMode = CLAUDE_PERMISSION_MODE_BY_ACCESS[runnerState.accessMode] || 'default';
    lines.push(
      `Runner CLAUDE_CONFIG_DIR：${RUNNER_CLAUDE_HOME || '继承系统默认'}`,
      `Claude 权限模式：${permissionMode}`
    );
  }

  lines.push(`最近一轮 Token：${formatTokenUsage(tokenUsage.lastUsage)}`);
  return lines.join('\n');
}

function getQueueMessage() {
  const activeBackend = codexProcess.session && codexProcess.session.backend
    ? BACKEND_LABELS[codexProcess.session.backend] || codexProcess.session.backend
    : '';
  return [
    '队列状态：',
    `当前执行任务：${activeTask ? (activeTask.kind === 'approval' ? '审批任务' : '普通任务') : '无'}`,
    `排队任务数：${taskQueue.length}`,
    `后端忙碌中：${codexProcess.busy ? (activeBackend ? `是（${activeBackend}）` : '是') : '否'}`
  ].join('\n');
}

function getSessionMessage(context) {
  const scopeKey = getContextSessionScopeKey(context);
  const backend = getActiveBackend(scopeKey);
  const currentSession = getSessionForContext(context, runnerState.workdir, backend);
  const tokenUsage = ensureSessionTokenUsage(currentSession);
  const threadLabel = backend === 'claude' ? 'Session ID' : '线程 ID';
  const lines = [
    '会话状态：',
    `当前会话键：${currentSession.scopeKey}`,
    `当前后端：${BACKEND_LABELS[backend]}`,
    `当前目录会话已建立：${currentSession.hasConversation ? '是' : '否'}`,
    `后端忙碌中：${codexProcess.busy ? '是' : '否'}`,
    `当前目录会话代次：${currentSession.generation}`,
    `当前目录${threadLabel}：${currentSession.threadId || '无'}`,
    `已缓存目录会话：${countActiveSessions()}`,
    `存在待审批：${pendingApproval ? '是' : '否'}`,
    `工作目录：${runnerState.workdir}`,
    `权限模式：${VALID_ACCESS_MODES.get(runnerState.accessMode).label}`
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
    const permissionMode = CLAUDE_PERMISSION_MODE_BY_ACCESS[runnerState.accessMode] || 'default';
    lines.push(
      `Runner CLAUDE_CONFIG_DIR：${RUNNER_CLAUDE_HOME || '继承系统默认'}`,
      `Claude 权限模式：${permissionMode}`
    );
  }

  lines.push(`最近一轮 Token：${formatTokenUsage(tokenUsage.lastUsage)}`);
  if (pendingApproval) {
    lines.push(`待审批命令：${pendingApproval.command}`);
  }
  return lines.join('\n');
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

function runCodexExec(prompt, session, workdir, context) {
  return new Promise((resolve, reject) => {
    const generation = session.generation;
    const outputFile = path.join(os.tmpdir(), `qq-codex-runner-last-${process.pid}-${Date.now()}.txt`);
    const args = buildCodexArgs(prompt, outputFile, session, workdir);
    const progressReporter = createProgressReporter(context);
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
        try {
          child.kill('SIGTERM');
        } catch (_) {}
        codexProcess.child = null;
        codexProcess.busy = false;
        codexProcess.session = null;
        if (generation !== session.generation) {
          void progressReporter.stop().then(() => {
            resolve(null);
          });
          return;
        }
        void progressReporter.stop().then(() => {
          reject(
            new Error(
              `Codex execution timed out after ${Math.floor(
                EXEC_TIMEOUT_MS / 1000
              )} seconds without new output. You can increase CODEX_EXEC_TIMEOUT_MS or set it to 0 to disable this timeout.`
            )
          );
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
      codexProcess.child = null;
      codexProcess.busy = false;
      codexProcess.session = null;
      void (async () => {
        await progressReporter.stop();
        if (generation !== session.generation) {
          resolve(null);
          return;
        }
        reject(error);
      })();
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearExecTimeout();
      codexProcess.child = null;
      codexProcess.busy = false;
      codexProcess.session = null;
      void (async () => {
        handleStdoutEvent(parseExecJsonEventLine(stdoutBuffer));
        await progressReporter.stop();

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
          const hint = describeBackendRuntimeError('codex', stderr, stdout);
          reject(new Error(summarizeExecFailure(stderr, stdout) + hint));
          return;
        }

        const events = parseExecJsonEvents(stdout);
        const threadId = extractThreadIdFromExecEvents(events);
        const tokenUsage = extractTokenUsageFromExecEvents(events);
        if (threadId) {
          session.threadId = threadId;
        }
        if (tokenUsage.lastUsage) {
          session.lastTokenUsage = tokenUsage.lastUsage;
        }
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
        if (!normalized) {
          reject(new Error('Codex finished without a final reply.'));
          return;
        }

        resolve(normalized);
      })();
    });
  });
}

function buildClaudeArgs(prompt, session, workdir) {
  void workdir;
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  const accessMode = runnerState.accessMode;
  const permissionMode = CLAUDE_PERMISSION_MODE_BY_ACCESS[accessMode] || 'default';
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

function runClaudeExec(prompt, session, workdir, context) {
  return new Promise((resolve, reject) => {
    const generation = session.generation;
    const args = buildClaudeArgs(prompt, session, workdir);
    const progressReporter = createProgressReporter(context, extractProgressUpdateFromClaudeEvent);

    const spawnEnv = {
      ...process.env,
      TERM: process.env.TERM || 'xterm-256color'
    };
    if (RUNNER_CLAUDE_HOME) {
      spawnEnv.CLAUDE_CONFIG_DIR = RUNNER_CLAUDE_HOME;
    }

    let child;
    try {
      child = childProcess.spawn(CLAUDE_BIN, args, {
        cwd: workdir,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      void progressReporter.stop().then(() => {
        if (error && error.code === 'ENOENT') {
          reject(new Error(
            `未找到 claude 可执行文件：${CLAUDE_BIN}。请安装 Claude Code CLI 或设置 CLAUDE_BIN。`
          ));
          return;
        }
        reject(error);
      });
      return;
    }

    codexProcess.child = child;
    codexProcess.busy = true;
    codexProcess.session = session;

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
        codexProcess.child = null;
        codexProcess.busy = false;
        codexProcess.session = null;
        if (generation !== session.generation) {
          void progressReporter.stop().then(() => resolve(null));
          return;
        }
        void progressReporter.stop().then(() => {
          reject(
            new Error(
              `Claude execution timed out after ${Math.floor(
                EXEC_TIMEOUT_MS / 1000
              )} seconds without new output. You can increase CODEX_EXEC_TIMEOUT_MS or set it to 0 to disable this timeout.`
            )
          );
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
      codexProcess.child = null;
      codexProcess.busy = false;
      codexProcess.session = null;
      void (async () => {
        await progressReporter.stop();
        if (generation !== session.generation) {
          resolve(null);
          return;
        }
        if (error && error.code === 'ENOENT') {
          reject(new Error(
            `未找到 claude 可执行文件：${CLAUDE_BIN}。请安装 Claude Code CLI 或设置 CLAUDE_BIN。`
          ));
          return;
        }
        reject(error);
      })();
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearExecTimeout();
      codexProcess.child = null;
      codexProcess.busy = false;
      codexProcess.session = null;
      void (async () => {
        handleStdoutEvent(parseExecJsonEventLine(stdoutBuffer));
        await progressReporter.stop();

        if (generation !== session.generation) {
          resolve(null);
          return;
        }

        const events = parseExecJsonEvents(stdout);

        if (signal) {
          reject(new Error(`Claude process exited with signal ${signal}.`));
          return;
        }

        const sessionId = extractSessionIdFromClaudeEvents(events);
        const tokenUsage = extractTokenUsageFromClaudeEvents(events);
        const claudeError = extractClaudeErrorFromEvents(events);
        const finalMessage = extractFinalMessageFromClaudeEvents(events);

        if (sessionId) {
          session.threadId = sessionId;
        }
        if (tokenUsage.lastUsage) {
          session.lastTokenUsage = tokenUsage.lastUsage;
        }
        if (tokenUsage.totalUsage) {
          session.totalTokenUsage = tokenUsage.totalUsage;
        } else if (tokenUsage.lastUsage) {
          session.totalTokenUsage = addTokenUsage(session.totalTokenUsage, tokenUsage.lastUsage);
        }
        if (events.length > 0 || sanitizeText(finalMessage)) {
          session.hasConversation = true;
          persistRunnerState();
        }

        if (code !== 0) {
          const hint = describeBackendRuntimeError('claude', stderr, stdout);
          reject(new Error(summarizeClaudeFailure(stderr, stdout, events) + hint));
          return;
        }

        if (claudeError) {
          const hint = describeBackendRuntimeError('claude', stderr, stdout);
          reject(new Error(`Claude 返回错误：${claudeError}${hint}`));
          return;
        }

        const normalized = sanitizeText(finalMessage);
        if (!normalized) {
          reject(new Error('Claude 执行完成但未返回内容。'));
          return;
        }
        resolve(normalized);
      })();
    });
  });
}

async function resetCodexSession(context) {
  resetSessionState(getSessionForContext(context));
  pendingApproval = null;
  clearRecentWorkdirSearch();
  stopActiveCodexProcess();
  persistRunnerState();

  await safeSendReply(context, '当前会话已重置，下一条消息会启动新的对话。');
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
  const nextSession = getScopedSession(scopeKey, runnerState.workdir, normalized);
  const sessionHint = nextSession.hasConversation
    ? `已恢复该后端之前的会话（线程 ${nextSession.threadId || '未知'}）。`
    : '这是该后端的首次会话，下一条消息会新开对话。';
  await safeSendReply(context, `已切换到 ${BACKEND_LABELS[normalized]} 后端。\n${sessionHint}${suffix}`);
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
  const backend = task.backend && VALID_BACKENDS.has(task.backend)
    ? task.backend
    : getActiveBackend(task.sessionScopeKey);
  const session = getScopedSession(task.sessionScopeKey, task.workdir, backend);

  if (codexProcess.busy) {
    await safeSendReply(task.context, `${BACKEND_LABELS[backend]} 正在处理上一条消息，请稍候。`);
    return;
  }

  await safeSendReply(task.context, `开始执行（${BACKEND_LABELS[backend]}），队列剩余 ${taskQueue.length} 条。`);

  try {
    const includePolicy = !(session.hasConversation && session.threadId);
    const prompt = task.kind === 'approval'
      ? buildApprovalPrompt(task.action, pendingApproval, { includePolicy })
      : buildUserPrompt(task.input, { includePolicy, backend });

    const reply = backend === 'claude'
      ? await runClaudeExec(prompt, session, task.workdir, task.context)
      : await runCodexExec(prompt, session, task.workdir, task.context);
    if (!reply) {
      return;
    }

    const approval = backend === 'codex' ? parseApprovalRequest(reply) : null;

    if (approval) {
      pendingApproval = {
        command: approval.command,
        reason: approval.reason,
        context: task.context,
        workdir: task.workdir,
        sessionScopeKey: task.sessionScopeKey,
        backend
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
      sessionScopeKey: pendingApproval.sessionScopeKey,
      backend: pendingApproval.backend || 'codex'
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
    sessionScopeKey: context.sessionScopeKey,
    backend: getActiveBackend(context.sessionScopeKey)
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
