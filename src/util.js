'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

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

const NUL_RE = new RegExp(String.fromCharCode(0), 'g');

function sanitizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(NUL_RE, '')
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

module.exports = {
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
};
