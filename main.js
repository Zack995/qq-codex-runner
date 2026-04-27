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

let persistDebounceTimer = null;

class QQBotClient {
  constructor(config) {
    this.id = sanitizeText(config.id) || sanitizeText(config.appId);
    this.name = sanitizeText(config.name) || this.id;
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
    this.seenMessageIds = new Map();
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
    const messageId = sanitizeText(message && (message.id || message.message_id));
    if (messageId) {
      const now = Date.now();
      for (const [id, ts] of this.seenMessageIds) {
        if (now - ts > 60_000) {
          this.seenMessageIds.delete(id);
        } else {
          break;
        }
      }
      if (this.seenMessageIds.has(messageId)) {
        log(`QQ bot ${this.id} duplicate event ${eventType} / message ${messageId} ignored.`);
        return;
      }
      this.seenMessageIds.set(messageId, now);
    }
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
    this.name = sanitizeText(config.name) || defaultWeixinDisplayName(this.accountId);
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    this.token = config.token || '';
    this.longPollTimeoutMs = Number(config.longPollTimeoutMs || 35_000);
    this.apiTimeoutMs = Number(config.apiTimeoutMs || 15_000);
    this.handlers = [];
    this.ready = false;
    this.stopped = false;
    this.runningPromise = null;
    this.activePollController = null;
    this.seenMessageIds = new Map();
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  dispatchMessage(eventType, message) {
    const messageId = sanitizeText(
      message && (message.message_id || message.seq || message.session_id)
    );
    if (messageId) {
      const now = Date.now();
      for (const [id, ts] of this.seenMessageIds) {
        if (now - ts > 60_000) {
          this.seenMessageIds.delete(id);
        } else {
          break;
        }
      }
      if (this.seenMessageIds.has(messageId)) {
        log(`Weixin ${this.accountId} duplicate event ${eventType} / message ${messageId} ignored.`);
        return;
      }
      this.seenMessageIds.set(messageId, now);
    }
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
    const normalized = sanitizeText(cursor);
    if (!weixinState.syncCursors) weixinState.syncCursors = {};
    if (normalized) {
      weixinState.syncCursors[this.accountId] = normalized;
    } else {
      delete weixinState.syncCursors[this.accountId];
    }
    persistRunnerState();
  }

  getSyncCursor() {
    if (!weixinState.syncCursors) return '';
    return sanitizeText(weixinState.syncCursors[this.accountId]);
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

function defaultQQApiBase(sandbox) {
  return parseBoolean(sandbox, false)
    ? 'https://sandbox.api.sgroup.qq.com'
    : 'https://api.sgroup.qq.com';
}

function normalizeQQBotEntry(entry, index, seenIds) {
  const appId = sanitizeText(entry && (entry.appId || entry.app_id));
  const secret = sanitizeText(
    (entry && (entry.secret || entry.clientSecret || entry.client_secret)) || ''
  );
  if (!appId || !secret) {
    process.stderr.write(`QQ_BOTS[${index}] is missing appId or secret\n`);
    process.exit(1);
  }
  const id = sanitizeText(entry && entry.id) || appId;
  if (seenIds.has(id)) {
    process.stderr.write(`QQ_BOTS contains duplicate bot id: ${id}\n`);
    process.exit(1);
  }
  seenIds.add(id);

  const entrySandbox = entry && entry.sandbox !== undefined ? String(entry.sandbox) : '';
  const intents = parseIntents(
    sanitizeText(entry && entry.intents) || process.env.QQ_BOT_INTENTS
  );
  const apiBase =
    sanitizeText(entry && (entry.apiBase || entry.api_base)) ||
    process.env.QQ_BOT_API_BASE ||
    defaultQQApiBase(entrySandbox || process.env.QQ_BOT_SANDBOX);
  const tokenBase =
    sanitizeText(entry && (entry.tokenBase || entry.token_base)) ||
    process.env.QQ_BOT_TOKEN_BASE ||
    'https://bots.qq.com';
  const name = sanitizeText(entry && entry.name) || id;

  return { id, name, appId, secret, intents, apiBase, tokenBase };
}

function loadQQBotConfigs() {
  const raw = sanitizeText(process.env.QQ_BOTS);
  if (!raw) {
    process.stderr.write(
      'QQ_BOTS is required. Set it to a JSON array of bot configs, e.g.\n' +
      '  QQ_BOTS=[{"id":"main","name":"主号","appId":"111","secret":"aaa"}]\n'
    );
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`Invalid QQ_BOTS JSON: ${error && error.message ? error.message : error}\n`);
    process.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    process.stderr.write('QQ_BOTS must be a non-empty JSON array.\n');
    process.exit(1);
  }
  const seenIds = new Set();
  return parsed.map((entry, index) => normalizeQQBotEntry(entry, index, seenIds));
}

function createQQBotClientFromConfig(config) {
  return new QQBotClient({
    id: config.id,
    name: config.name,
    appId: config.appId,
    secret: config.secret,
    intents: config.intents,
    apiBase: config.apiBase,
    tokenBase: config.tokenBase
  });
}

function parseWeixinAccountWhitelist() {
  const raw = sanitizeText(process.env.WEIXIN_ACCOUNTS);
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((item) => sanitizeText(item))
    .filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
}

function parseWeixinAccountNames() {
  const raw = sanitizeText(process.env.WEIXIN_NAMES);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log('Ignoring WEIXIN_NAMES: expected a JSON object like {"default":"微信机器人"}');
      return {};
    }
    const result = {};
    for (const [accountId, name] of Object.entries(parsed)) {
      const normalizedId = sanitizeText(accountId);
      const normalizedName = sanitizeText(name);
      if (normalizedId && normalizedName) {
        result[normalizedId] = normalizedName;
      }
    }
    return result;
  } catch (error) {
    log(`Ignoring invalid WEIXIN_NAMES JSON: ${error && error.message ? error.message : error}`);
    return {};
  }
}

function defaultWeixinDisplayName(accountId) {
  const normalized = sanitizeText(accountId);
  if (!normalized || normalized === 'default') return '微信机器人';
  return normalized;
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

async function runWeixinLoginFlow(accountId, force = false, name = '') {
  const normalizedAccountId = sanitizeText(accountId) || 'default';
  const normalizedName = sanitizeText(name);
  if (!force) {
    const existing = getStoredWeixinAccount(normalizedAccountId);
    if (existing && sanitizeText(existing.token)) {
      if (normalizedName && sanitizeText(existing.name) !== normalizedName) {
        setStoredWeixinAccount({ ...existing, name: normalizedName });
        process.stdout.write(`Weixin account alias updated: ${normalizedAccountId} -> ${normalizedName}\n`);
      }
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
        name: normalizedName,
        token: botToken,
        baseUrl,
        userId
      });

      const displayName = normalizedName || defaultWeixinDisplayName(ilinkBotId);
      process.stdout.write(
        `Weixin login succeeded.\nAccount ID: ${ilinkBotId}\nAlias: ${displayName}\nBase URL: ${baseUrl}\n` +
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
const qqBots = new Map();
const persistedRunnerState = loadPersistedRunnerState();
const initialRunnerState = deriveInitialRunnerState(persistedRunnerState);

const sessionQueues = new Map();    // sessionKey -> task[]
const activeRuns = new Map();       // sessionKey -> { task, session, child, generation, backend }
const pendingApprovals = new Map(); // sessionKey -> approval record
const codexSessions = new Map();
let runnerState = {
  workdir: initialRunnerState.workdir,
  workdirs: { ...(initialRunnerState.workdirs || {}) },
  accessMode: initialRunnerState.accessMode,
  accessModes: { ...(initialRunnerState.accessModes || {}) },
  addDirs: DEFAULT_ADD_DIRS.slice(),
  backends: { ...(initialRunnerState.backends || {}) }
};
const recentWorkdirSearches = new Map();
let weixinState = deriveInitialWeixinState(persistedRunnerState);
const weixinBots = new Map();
let runnerStateWatcher = null;

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

function getWorkdirForScope(scopeKey) {
  const key = sanitizeText(scopeKey);
  if (key && runnerState.workdirs && runnerState.workdirs[key]) {
    return runnerState.workdirs[key];
  }
  return runnerState.workdir;
}

function setWorkdirForScope(scopeKey, workdir) {
  const key = sanitizeText(scopeKey);
  const resolved = sanitizeText(workdir);
  if (!key || !resolved) return;
  if (!runnerState.workdirs) runnerState.workdirs = {};
  runnerState.workdirs[key] = resolved;
}

function getAccessModeForScope(scopeKey) {
  const key = sanitizeText(scopeKey);
  if (key && runnerState.accessModes) {
    const stored = sanitizeText(runnerState.accessModes[key]).toLowerCase();
    if (stored && VALID_ACCESS_MODES.has(stored)) return stored;
  }
  return runnerState.accessMode;
}

function setAccessModeForScope(scopeKey, mode) {
  const key = sanitizeText(scopeKey);
  const normalized = sanitizeText(mode).toLowerCase();
  if (!key || !VALID_ACCESS_MODES.has(normalized)) return;
  if (!runnerState.accessModes) runnerState.accessModes = {};
  runnerState.accessModes[key] = normalized;
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
    syncCursors: {},
    contextTokens: {},
    accounts: {},
    defaultAccountId: 'default'
  };

  if (!persistedState || !persistedState.weixin || typeof persistedState.weixin !== 'object') {
    return state;
  }

  if (persistedState.weixin.syncCursors && typeof persistedState.weixin.syncCursors === 'object') {
    for (const [accountId, cursor] of Object.entries(persistedState.weixin.syncCursors)) {
      const normalizedAccountId = sanitizeText(accountId);
      const normalizedCursor = sanitizeText(cursor);
      if (normalizedAccountId && normalizedCursor) {
        state.syncCursors[normalizedAccountId] = normalizedCursor;
      }
    }
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
        name: sanitizeText(value.name),
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
  const previous = weixinState.accounts[normalizedAccountId] || {};
  weixinState.accounts[normalizedAccountId] = {
    accountId: normalizedAccountId,
    name: sanitizeText(account && account.name) || sanitizeText(previous.name),
    token: sanitizeText(account && account.token),
    baseUrl: sanitizeText(account && account.baseUrl),
    userId: sanitizeText(account && account.userId)
  };
  weixinState.defaultAccountId = normalizedAccountId;
  persistRunnerStateNow();
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
  const existingBot = weixinBots.get(normalizedAccountId);
  if (existingBot) {
    existingBot.ready = false;
  }
  if (weixinState.defaultAccountId === normalizedAccountId) {
    const remainingAccountId = Object.keys(weixinState.accounts)[0];
    weixinState.defaultAccountId = remainingAccountId || 'default';
  }
  persistRunnerStateNow();
}

function resolveWeixinRuntimeAccount(accountId) {
  const requestedAccountId = sanitizeText(accountId) || '';
  const normalizedAccountId = requestedAccountId || weixinState.defaultAccountId || 'default';
  const stored = getStoredWeixinAccount(normalizedAccountId) || getStoredWeixinAccount(weixinState.defaultAccountId);
  const resolvedAccountId = sanitizeText(stored && stored.accountId) || normalizedAccountId;
  const nameOverrides = parseWeixinAccountNames();
  const name =
    sanitizeText(nameOverrides[resolvedAccountId]) ||
    sanitizeText(stored && stored.name) ||
    defaultWeixinDisplayName(resolvedAccountId);
  return {
    accountId: resolvedAccountId,
    name,
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

function getDesiredWeixinAccounts() {
  if (!WEIXIN_ENABLED) return new Map();

  const whitelist = parseWeixinAccountWhitelist();
  const desired = new Map();
  const accountIds = Object.keys(weixinState.accounts || {});

  for (const accountId of accountIds) {
    if (whitelist && !whitelist.has(accountId)) continue;
    const runtime = resolveWeixinRuntimeAccount(accountId);
    if (!sanitizeText(runtime.token)) continue;
    desired.set(runtime.accountId, runtime);
  }

  return desired;
}

async function refreshWeixinClients() {
  syncWeixinStateFromDisk();
  const desired = getDesiredWeixinAccounts();

  const toClose = [];
  for (const [accountId, bot] of weixinBots.entries()) {
    const runtime = desired.get(accountId);
    if (!runtime) {
      weixinBots.delete(accountId);
      toClose.push(bot);
      continue;
    }
    if (
      sanitizeText(bot.baseUrl) !== sanitizeText(runtime.baseUrl) ||
      sanitizeText(bot.token) !== sanitizeText(runtime.token)
    ) {
      weixinBots.delete(accountId);
      toClose.push(bot);
    }
  }

  await Promise.all(
    toClose.map((bot) => {
      log(`Stopping Weixin client for account ${bot.accountId}.`);
      return Promise.resolve(bot.close()).catch(() => {});
    })
  );

  for (const [accountId, runtime] of desired.entries()) {
    const existing = weixinBots.get(accountId);
    if (existing) {
      const nextName = sanitizeText(runtime.name) || existing.name;
      if (nextName && nextName !== existing.name) {
        existing.name = nextName;
      }
      continue;
    }
    const client = new WeixinClient({
      accountId: runtime.accountId,
      name: runtime.name,
      baseUrl: runtime.baseUrl,
      token: runtime.token,
      longPollTimeoutMs: Number(process.env.WEIXIN_LONG_POLL_TIMEOUT_MS || 35_000)
    });
    client.onMessage((eventType, message) => {
      void enqueueMessage(eventType, message, { accountId: client.accountId });
    });
    weixinBots.set(accountId, client);
    log(`Starting Weixin client for account ${client.accountId}.`);
    client.connect().catch((error) => {
      log(
        `Failed to start Weixin client ${client.accountId}: ${
          error && error.message ? error.message : String(error)
        }`
      );
    });
  }
}

function startRunnerStateWatcher() {
  if (runnerStateWatcher) return;
  runnerStateWatcher = fs.watchFile(
    RUNNER_STATE_FILE,
    { interval: 1000 },
    () => {
      void refreshWeixinClients();
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
    workdirs: {},
    accessMode: fallbackAccessMode,
    accessModes: {},
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

  if (persistedState && persistedState.accessModes && typeof persistedState.accessModes === 'object') {
    for (const [scope, mode] of Object.entries(persistedState.accessModes)) {
      const normalizedScope = sanitizeText(scope);
      const normalizedMode = sanitizeText(mode).toLowerCase();
      if (!normalizedScope) continue;
      if (!VALID_ACCESS_MODES.has(normalizedMode)) continue;
      nextState.accessModes[normalizedScope] = normalizedMode;
    }
  }

  if (persistedState && persistedState.workdirs && typeof persistedState.workdirs === 'object') {
    for (const [scope, workdir] of Object.entries(persistedState.workdirs)) {
      const normalizedScope = sanitizeText(scope);
      const resolved = resolveExistingDirectory(workdir);
      if (!normalizedScope || !resolved) continue;
      nextState.workdirs[normalizedScope] = resolved;
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
  const botId = sanitizeText(context.botId) || 'default';
  if (context.type === 'c2c') {
    return `qq:${botId}:c2c:${sanitizeText(context.openid) || 'unknown'}`;
  }
  return `qq:${botId}:channel:${sanitizeText(context.channelId) || 'unknown'}`;
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

  const sortedWorkdirs = {};
  if (runnerState.workdirs && typeof runnerState.workdirs === 'object') {
    for (const scope of Object.keys(runnerState.workdirs).sort()) {
      const value = sanitizeText(runnerState.workdirs[scope]);
      if (value) sortedWorkdirs[scope] = value;
    }
  }

  const sortedAccessModes = {};
  if (runnerState.accessModes && typeof runnerState.accessModes === 'object') {
    for (const scope of Object.keys(runnerState.accessModes).sort()) {
      const value = sanitizeText(runnerState.accessModes[scope]).toLowerCase();
      if (VALID_ACCESS_MODES.has(value)) sortedAccessModes[scope] = value;
    }
  }

  return {
    version: 4,
    workdir: runnerState.workdir,
    workdirs: sortedWorkdirs,
    accessMode: runnerState.accessMode,
    accessModes: sortedAccessModes,
    backends: sortedBackends,
    codexSessions: sessionRecords,
    weixin: {
      syncCursors: { ...(weixinState.syncCursors || {}) },
      contextTokens: { ...weixinState.contextTokens },
      accounts: { ...weixinState.accounts },
      defaultAccountId: weixinState.defaultAccountId
    }
  };
}

function persistRunnerStateNow() {
  if (persistDebounceTimer) {
    clearTimeout(persistDebounceTimer);
    persistDebounceTimer = null;
  }
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

function persistRunnerState() {
  if (persistDebounceTimer) return;
  persistDebounceTimer = setTimeout(() => {
    persistDebounceTimer = null;
    persistRunnerStateNow();
  }, PERSIST_DEBOUNCE_MS);
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

function getSessionForContext(context, workdir, backend) {
  const scopeKey = getContextSessionScopeKey(context);
  const resolvedWorkdir = workdir || getWorkdirForScope(scopeKey);
  return getScopedSession(scopeKey, resolvedWorkdir, backend);
}

function stopActiveRun(sessionKey, signal = 'SIGTERM') {
  const run = activeRuns.get(sessionKey);
  if (!run) return;
  if (run.session) bumpSessionGeneration(run.session);
  if (run.child) {
    try { run.child.kill(signal); } catch (_) {}
  }
}

function stopAllActiveRuns(signal = 'SIGTERM') {
  for (const sessionKey of Array.from(activeRuns.keys())) {
    stopActiveRun(sessionKey, signal);
  }
}

function anyRunBusy() {
  return activeRuns.size > 0;
}

function totalQueuedTasks() {
  let total = 0;
  for (const queue of sessionQueues.values()) total += queue.length;
  return total;
}

function queueDepthForSession(sessionKey) {
  const queue = sessionQueues.get(sessionKey);
  return queue ? queue.length : 0;
}

function enqueueToSessionQueue(sessionKey, task, options = {}) {
  if (!sessionQueues.has(sessionKey)) sessionQueues.set(sessionKey, []);
  const queue = sessionQueues.get(sessionKey);
  if (options.priority) {
    queue.unshift(task);
  } else {
    queue.push(task);
  }
}

function clearQueueForSession(sessionKey) {
  sessionQueues.delete(sessionKey);
}

function clearAllQueues() {
  sessionQueues.clear();
}

function findPendingApprovalByScope(scopeKey) {
  const target = sanitizeText(scopeKey);
  if (!target) return null;
  for (const [sessionKey, approval] of pendingApprovals.entries()) {
    if (approval && approval.sessionScopeKey === target) {
      return { sessionKey, approval };
    }
  }
  return null;
}

function sessionIdentityForContext(context, backend) {
  const scopeKey = getContextSessionScopeKey(context);
  const resolvedBackend = backend || getActiveBackend(scopeKey);
  return buildSessionIdentity(scopeKey, getWorkdirForScope(scopeKey), resolvedBackend);
}

function sessionIdentityForTask(task) {
  return buildSessionIdentity(
    task.sessionScopeKey,
    task.workdir,
    task.backend || 'codex'
  );
}

function clearRecentWorkdirSearch(scopeKey) {
  const key = sanitizeText(scopeKey);
  if (key) {
    recentWorkdirSearches.delete(key);
  }
}

function clearAllRecentWorkdirSearches() {
  recentWorkdirSearches.clear();
}

function setRecentWorkdirSearch(scopeKey, query, matches) {
  const key = sanitizeText(scopeKey);
  if (!key) return;
  recentWorkdirSearches.set(key, { query: sanitizeText(query), matches: Array.isArray(matches) ? matches : [] });
}

function getRecentWorkdirSearch(scopeKey) {
  const key = sanitizeText(scopeKey);
  if (!key) return null;
  return recentWorkdirSearches.get(key) || null;
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

function getSearchSelection(scopeKey, target) {
  const selection = sanitizeText(target);
  if (!/^\d+$/.test(selection)) return null;
  const index = Number(selection);
  const entry = getRecentWorkdirSearch(scopeKey);
  if (!entry || !Array.isArray(entry.matches)) return null;
  if (index < 1 || index > entry.matches.length) return null;
  return entry.matches[index - 1];
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
  }

  lines.push(`最近一轮 Token：${formatTokenUsage(tokenUsage.lastUsage)}`);
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
  }

  lines.push(`最近一轮 Token：${formatTokenUsage(tokenUsage.lastUsage)}`);
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

      if (sessionId) session.threadId = sessionId;
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

  startRunnerStateWatcher();

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

  await refreshWeixinClients();
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
