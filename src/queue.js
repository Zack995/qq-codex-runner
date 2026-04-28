'use strict';

const { sanitizeText } = require('./util');

const config = require('./config');
const { VALID_BACKENDS, BACKEND_LABELS } = config;
const { MAX_CONCURRENCY } = config.loadRuntimeConfig();

const {
  sessionQueues,
  activeRuns,
  pendingApprovals,
  getScopedSession,
  sessionIdentityForTask,
  queueDepthForSession,
  getActiveBackend,
  getAccessModeForScope
} = require('./state');

const { sendReply } = require('./exec');

const {
  buildUserPrompt,
  buildApprovalPrompt,
  parseApprovalRequest,
  runCodexExec
} = require('./codex');

const { runClaudeExec } = require('./claude');

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
  await sendReply(
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
      await sendReply(task.context, approvalMessage);
      return;
    }

    pendingApprovals.delete(sessionKey);
    await sendReply(task.context, reply);
  } catch (error) {
    await sendReply(task.context, error && error.message ? error.message : String(error));
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

module.exports = {
  executeTask,
  tickQueues,
  runTask
};
