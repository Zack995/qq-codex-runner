'use strict';

const crypto = require('crypto');

const {
  sanitizeText,
  log,
  sleep,
  requestJsonWithTimeout,
  requestTextWithTimeout
} = require('./util');

const config = require('./config');
const { WEIXIN_ENABLED } = config.loadRuntimeConfig();

const {
  weixinState,
  weixinBots,
  codexSessions,
  persistRunnerState,
  persistRunnerStateNow,
  syncWeixinStateFromDisk,
  buildWeixinContextTokenKey
} = require('./state');

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

async function refreshWeixinClients(onMessage) {
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
    if (typeof onMessage === 'function') {
      client.onMessage((eventType, message) => {
        void onMessage(eventType, message, { accountId: client.accountId });
      });
    }
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

module.exports = {
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
};
