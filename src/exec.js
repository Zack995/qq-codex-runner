'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sanitizeText, log } = require('./util');

const config = require('./config');
const {
  BACKEND_PROBE_TIMEOUT_MS,
  PROGRESS_HEARTBEAT_INTERVAL_MS
} = config;
const {
  EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_DISABLED
} = config.loadRuntimeConfig();

const { parseExecJsonEventLine, parseExecJsonEvents } = require('./state');

// Registered by main.js (or whoever owns sendReply implementation)
// so the progress reporter can write back to the chat without
// importing main.js (avoids circular deps).
let sendReplyImpl = async () => {};

function setSendReplyImpl(fn) {
  if (typeof fn === 'function') sendReplyImpl = fn;
}

async function sendReply(context, message) {
  return sendReplyImpl(context, message);
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

function formatProgressReply(message) {
  const normalized = sanitizeText(message);
  if (!normalized) return '';
  return `进度：\n${normalized}`;
}

function createProgressReporter(context, parseEvent) {
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
        await sendReplyImpl(context, normalized);
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

module.exports = {
  setSendReplyImpl,
  sendReply,
  spawnProbeVersion,
  summarizeProbeFailure,
  describeBackendRuntimeError,
  formatProgressReply,
  createProgressReporter,
  runAgentChildProcess
};
