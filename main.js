#!/usr/bin/env node
'use strict';

const { loadDotEnv, log } = require('./src/util');

loadDotEnv();

const {
  parseArgs,
  VALID_ACCESS_MODES,
  loadRuntimeConfig
} = require('./src/config');

loadRuntimeConfig();

const {
  loadQQBotConfigs,
  createQQBotClientFromConfig
} = require('./src/qq');

const {
  runnerState,
  qqBots,
  weixinBots,
  persistRunnerStateNow,
  stopAllActiveRuns,
  startRunnerStateWatcher,
  stopRunnerStateWatcher
} = require('./src/state');

const {
  runWeixinLoginFlow,
  clearStoredWeixinAccount,
  refreshWeixinClients
} = require('./src/weixin');

const { setCodexBin, setCodexExtraArgs } = require('./src/codex');

const { enqueueMessage } = require('./src/commands');

const {
  command,
  codexArgs,
  mode,
  weixinAccountId,
  weixinLoginForce,
  weixinName,
  forceAccessMode
} = parseArgs(process.argv.slice(2));

setCodexBin(command);
setCodexExtraArgs(codexArgs);

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

  startRunnerStateWatcher(() => {
    void refreshWeixinClients(enqueueMessage);
  });

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

  await refreshWeixinClients(enqueueMessage);
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
