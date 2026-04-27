'use strict';

const WebSocket = require('ws');

const {
  sanitizeText,
  log,
  requestJson,
  parseBoolean
} = require('./util');

const {
  parseIntents,
  intentsToBitmask
} = require('./config');

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

module.exports = {
  QQBotClient,
  defaultQQApiBase,
  normalizeQQBotEntry,
  loadQQBotConfigs,
  createQQBotClientFromConfig
};
