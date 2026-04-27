'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeText,
  log,
  resolveInputPath,
  normalizeTokenUsage,
  parsePositiveInteger,
  readTopLevelTomlValue
} = require('./util');

const config = require('./config');
const {
  VALID_BACKENDS,
  VALID_ACCESS_MODES,
  PERSIST_DEBOUNCE_MS
} = config;

const {
  RUNNER_STATE_FILE,
  PRIMARY_CODEX_HOME,
  RUNNER_CODEX_HOME,
  CODEX_CONTEXT_WINDOW_OVERRIDE,
  CODEX_AUTO_COMPACT_TOKEN_LIMIT_OVERRIDE,
  DEFAULT_BACKEND,
  DEFAULT_WORKDIR,
  DEFAULT_ADD_DIRS
} = config.loadRuntimeConfig();

let persistDebounceTimer = null;
let runnerStateWatcher = null;

// === Pure event parsers (used by hydration; also exported for codex.js) ===

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

// === Codex paths and config helpers ===

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

// === Codex rollouts ===

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

// === Persistence load ===

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

// === Initial state computation ===

const persistedRunnerState = loadPersistedRunnerState();
const initialRunnerState = deriveInitialRunnerState(persistedRunnerState);

const runnerState = {
  workdir: initialRunnerState.workdir,
  workdirs: { ...(initialRunnerState.workdirs || {}) },
  accessMode: initialRunnerState.accessMode,
  accessModes: { ...(initialRunnerState.accessModes || {}) },
  addDirs: DEFAULT_ADD_DIRS.slice(),
  backends: { ...(initialRunnerState.backends || {}) }
};

const weixinState = deriveInitialWeixinState(persistedRunnerState);

const sessionQueues = new Map();
const activeRuns = new Map();
const pendingApprovals = new Map();
const codexSessions = new Map();
const recentWorkdirSearches = new Map();
const qqBots = new Map();
const weixinBots = new Map();

if (!VALID_ACCESS_MODES.has(runnerState.accessMode)) {
  runnerState.accessMode = 'safe';
}

// === Identity helpers ===

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

// === Per-scope helpers ===

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

// === Sessions ===

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

function getScopedSession(scopeKey, workdir = runnerState.workdir, backend) {
  const resolvedWorkdir = resolveInputPath(workdir);
  const resolvedBackend = VALID_BACKENDS.has(backend) ? backend : getActiveBackend(scopeKey);
  const key = buildSessionIdentity(scopeKey, resolvedWorkdir, resolvedBackend);
  if (!codexSessions.has(key)) {
    codexSessions.set(key, createCodexSessionState(scopeKey, resolvedWorkdir, resolvedBackend));
  }
  return codexSessions.get(key);
}

function getSessionForContext(context, workdir, backend) {
  const scopeKey = getContextSessionScopeKey(context);
  const resolvedWorkdir = workdir || getWorkdirForScope(scopeKey);
  return getScopedSession(scopeKey, resolvedWorkdir, backend);
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
      totalTokenUsage: normalizeTokenUsage(hydratedTokenUsage.totalUsage),
      lastClaudeMeta: record.lastClaudeMeta && typeof record.lastClaudeMeta === 'object'
        ? {
            numTurns: Number(record.lastClaudeMeta.numTurns || 0) || 0,
            durationMs: Number(record.lastClaudeMeta.durationMs || 0) || 0,
            apiDurationMs: Number(record.lastClaudeMeta.apiDurationMs || 0) || 0,
            totalCostUsd: Number(record.lastClaudeMeta.totalCostUsd || 0) || 0,
            currentContextTokens: Number(record.lastClaudeMeta.currentContextTokens || 0) || 0
          }
        : null
    });
  }
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

// === Run / queue helpers ===

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

// === Approvals ===

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

// === Workdir search state ===

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

function getSearchSelection(scopeKey, target) {
  const selection = sanitizeText(target);
  if (!/^\d+$/.test(selection)) return null;
  const index = Number(selection);
  const entry = getRecentWorkdirSearch(scopeKey);
  if (!entry || !Array.isArray(entry.matches)) return null;
  if (index < 1 || index > entry.matches.length) return null;
  return entry.matches[index - 1];
}

// === Persistence write ===

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
        totalTokenUsage: normalizeTokenUsage(session.totalTokenUsage),
        lastClaudeMeta: session.lastClaudeMeta || null
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

// === Weixin state helpers ===

function buildWeixinContextTokenKey(accountId, peerId) {
  return `${sanitizeText(accountId) || 'default'}:${sanitizeText(peerId) || 'unknown'}`;
}

// In-place mutation so that exported weixinState reference stays valid.
function syncWeixinStateFromDisk() {
  const latestState = loadPersistedRunnerState();
  if (!latestState) return;
  const fresh = deriveInitialWeixinState(latestState);
  for (const k of Object.keys(weixinState)) delete weixinState[k];
  Object.assign(weixinState, fresh);
}

// === Watcher ===

function startRunnerStateWatcher(onChange) {
  if (runnerStateWatcher) return;
  runnerStateWatcher = fs.watchFile(
    RUNNER_STATE_FILE,
    { interval: 1000 },
    () => {
      if (typeof onChange === 'function') {
        try { onChange(); } catch (_) {}
      }
    }
  );
}

function stopRunnerStateWatcher() {
  if (!runnerStateWatcher) return;
  fs.unwatchFile(RUNNER_STATE_FILE);
  runnerStateWatcher = null;
}

// === Module init: hydrate sessions and schedule initial persist ===

hydratePersistedCodexSessions(persistedRunnerState);
persistRunnerState();

module.exports = {
  // mutable state objects
  runnerState,
  weixinState,
  // Maps
  sessionQueues,
  activeRuns,
  pendingApprovals,
  codexSessions,
  recentWorkdirSearches,
  qqBots,
  weixinBots,
  // pure parsers
  parseExecJsonEvents,
  parseExecJsonEventLine,
  extractTokenUsageFromExecEvents,
  extractThreadIdFromExecEvents,
  // codex paths/config
  getCodexConfigFilePath,
  getCodexSessionsDirPath,
  getEffectiveCodexContextWindow,
  getEffectiveCodexAutoCompactTokenLimit,
  formatCodexConfigValue,
  getCodexAutoCompactStatus,
  findCodexRolloutFileByThreadId,
  loadPersistedTokenUsageByThreadId,
  // persistence
  loadPersistedRunnerState,
  deriveInitialRunnerState,
  deriveInitialWeixinState,
  resolveExistingDirectory,
  buildPersistedRunnerState,
  persistRunnerState,
  persistRunnerStateNow,
  // identity
  buildSessionIdentity,
  getContextSessionScopeKey,
  sessionIdentityForContext,
  sessionIdentityForTask,
  // per-scope
  getActiveBackend,
  setActiveBackend,
  getWorkdirForScope,
  setWorkdirForScope,
  getAccessModeForScope,
  setAccessModeForScope,
  // sessions
  createCodexSessionState,
  getScopedSession,
  getSessionForContext,
  hydratePersistedCodexSessions,
  countActiveSessions,
  ensureSessionTokenUsage,
  bumpSessionGeneration,
  resetSessionState,
  // run/queue
  stopActiveRun,
  stopAllActiveRuns,
  anyRunBusy,
  totalQueuedTasks,
  queueDepthForSession,
  enqueueToSessionQueue,
  clearQueueForSession,
  clearAllQueues,
  // approvals
  findPendingApprovalByScope,
  // workdir search
  clearRecentWorkdirSearch,
  clearAllRecentWorkdirSearches,
  setRecentWorkdirSearch,
  getRecentWorkdirSearch,
  getSearchSelection,
  // weixin state
  buildWeixinContextTokenKey,
  syncWeixinStateFromDisk,
  // watcher
  startRunnerStateWatcher,
  stopRunnerStateWatcher
};
