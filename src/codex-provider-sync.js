'use strict';

const fs = require('fs');
const path = require('path');

const {
  sanitizeText,
  escapeRegExp,
  log
} = require('./util');

const PROVIDER_ROOT_KEYS = ['OPENAI_API_KEY', 'base_url', 'model_catalog_json'];
const BUILTIN_MODEL_PROVIDERS_WITHOUT_TABLE = new Set(['openai']);

function pathIsDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function pathIsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
}

function writeFileIfChanged(filePath, content) {
  const normalizedContent = String(content || '');
  const current = readFileIfExists(filePath);
  if (current === normalizedContent) return false;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalizedContent, 'utf8');
  return true;
}

function copyFileIfChanged(sourceFile, targetFile) {
  const sourceContent = readFileIfExists(sourceFile);
  if (!sourceContent) {
    if (!fs.existsSync(targetFile)) return { synced: false, reason: 'missing_source_auth' };
    fs.unlinkSync(targetFile);
    return { synced: true, reason: 'removed_target_auth' };
  }

  return {
    synced: writeFileIfChanged(targetFile, sourceContent),
    reason: 'auth'
  };
}

function firstTableLineIndex(lines) {
  const index = lines.findIndex((line) => parseTomlTableHeader(line));
  return index < 0 ? lines.length : index;
}

function findTopLevelKeyLineIndex(lines, key) {
  const normalizedKey = sanitizeText(key);
  if (!normalizedKey) return -1;
  const limit = firstTableLineIndex(lines);
  const pattern = new RegExp(`^\\s*${escapeRegExp(normalizedKey)}\\s*=`);
  for (let index = 0; index < limit; index += 1) {
    if (pattern.test(lines[index])) return index;
  }
  return -1;
}

function parseTopLevelStringValue(content, key) {
  const lines = String(content || '').split(/\r?\n/);
  const lineIndex = findTopLevelKeyLineIndex(lines, key);
  if (lineIndex < 0) return '';
  const rawLine = lines[lineIndex];
  const separatorIndex = rawLine.indexOf('=');
  if (separatorIndex < 0) return '';
  const rawValue = rawLine.slice(separatorIndex + 1).replace(/\s+#.*$/, '').trim();
  if (!rawValue) return '';
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

function removeTopLevelKey(content, key) {
  const lines = String(content || '').split(/\r?\n/);
  const lineIndex = findTopLevelKeyLineIndex(lines, key);
  if (lineIndex < 0) return String(content || '');

  lines.splice(lineIndex, 1);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function readTopLevelRawValue(content, key) {
  const lines = String(content || '').split(/\r?\n/);
  const lineIndex = findTopLevelKeyLineIndex(lines, key);
  if (lineIndex < 0) return '';
  const rawLine = lines[lineIndex];
  const separatorIndex = rawLine.indexOf('=');
  if (separatorIndex < 0) return '';
  return rawLine.slice(separatorIndex + 1).trim();
}

function upsertTopLevelRawValue(content, key, rawValue) {
  const normalizedKey = sanitizeText(key);
  const normalizedValue = sanitizeText(rawValue);
  if (!normalizedKey || !normalizedValue) return String(content || '');
  const line = `${normalizedKey} = ${normalizedValue}`;
  const current = String(content || '').trimEnd();
  const lines = current.split(/\r?\n/);
  const lineIndex = findTopLevelKeyLineIndex(lines, normalizedKey);
  if (lineIndex >= 0) {
    lines[lineIndex] = line;
    return lines.join('\n');
  }
  return current ? `${line}\n${current}` : line;
}

function syncProviderRootKeys(targetContent, sourceContent) {
  let nextContent = String(targetContent || '');
  for (const key of PROVIDER_ROOT_KEYS) {
    const sourceValue = readTopLevelRawValue(sourceContent, key);
    nextContent = removeTopLevelKey(nextContent, key);
    if (sourceValue) {
      nextContent = upsertTopLevelRawValue(nextContent, key, sourceValue);
    }
  }
  return nextContent;
}

function extractTomlTable(content, tableName) {
  const normalizedTableName = sanitizeText(tableName);
  if (!normalizedTableName) return '';
  const lines = String(content || '').split(/\r?\n/);
  const headerPattern = new RegExp(`^\\s*\\[${escapeRegExp(normalizedTableName)}\\]\\s*$`);
  const startIndex = lines.findIndex((line) => headerPattern.test(line));
  if (startIndex < 0) return '';

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const header = parseTomlTableHeader(lines[index]);
    if (header && header !== normalizedTableName && !header.startsWith(`${normalizedTableName}.`)) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n').trim();
}

function removeTomlTable(content, tableName) {
  const normalizedTableName = sanitizeText(tableName);
  if (!normalizedTableName) return String(content || '');
  const lines = String(content || '').split(/\r?\n/);
  const headerPattern = new RegExp(`^\\s*\\[${escapeRegExp(normalizedTableName)}\\]\\s*$`);
  const startIndex = lines.findIndex((line) => headerPattern.test(line));
  if (startIndex < 0) return String(content || '');

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const header = parseTomlTableHeader(lines[index]);
    if (header && header !== normalizedTableName && !header.startsWith(`${normalizedTableName}.`)) {
      endIndex = index;
      break;
    }
  }

  lines.splice(startIndex, endIndex - startIndex);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function parseTomlTableHeader(line) {
  const match = String(line || '').match(/^\s*\[([^\]]+)\]\s*$/);
  return match ? sanitizeText(match[1]) : '';
}

function listModelProviderNames(content) {
  const names = [];
  const seen = new Set();
  for (const line of String(content || '').split(/\r?\n/)) {
    const header = parseTomlTableHeader(line);
    const name = header.startsWith('model_providers.')
      ? sanitizeText(header.slice('model_providers.'.length))
      : '';
    if (!name || name.includes('.')) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function resolveSourceProviderName(content, fixedProvider = '') {
  const explicit = sanitizeText(fixedProvider);
  if (explicit) return explicit;

  const configured = parseTopLevelStringValue(content, 'model_provider');
  if (configured) return configured;

  const providerNames = listModelProviderNames(content);
  return providerNames.length === 1 ? providerNames[0] : '';
}

function upsertTopLevelStringValue(content, key, value) {
  const normalizedKey = sanitizeText(key);
  const normalizedValue = sanitizeText(value);
  if (!normalizedKey || !normalizedValue) return String(content || '');
  const line = `${normalizedKey} = ${JSON.stringify(normalizedValue)}`;
  const current = String(content || '').trimEnd();
  const lines = current.split(/\r?\n/);
  const lineIndex = findTopLevelKeyLineIndex(lines, normalizedKey);
  if (lineIndex >= 0) {
    lines[lineIndex] = line;
    return lines.join('\n');
  }
  return current ? `${line}\n${current}` : line;
}

function mergeProviderConfig(targetContent, providerName, providerTable, sourceContent = '') {
  const provider = sanitizeText(providerName);
  const table = sanitizeText(providerTable);
  if (!provider || !table) return String(targetContent || '');

  const previousProvider = parseTopLevelStringValue(targetContent, 'model_provider');
  let nextContent = syncProviderRootKeys(targetContent, sourceContent);
  nextContent = upsertTopLevelStringValue(nextContent, 'model_provider', provider);
  if (previousProvider && previousProvider !== provider) {
    nextContent = removeTomlTable(nextContent, `model_providers.${previousProvider}`);
  }
  nextContent = removeTomlTable(nextContent, `model_providers.${provider}`);
  nextContent = nextContent.trimEnd();
  return `${nextContent ? `${nextContent}\n\n` : ''}${table}\n`;
}

function mergeBuiltinProviderConfig(targetContent, providerName, sourceContent = '') {
  const provider = sanitizeText(providerName);
  if (!provider) return String(targetContent || '');

  const previousProvider = parseTopLevelStringValue(targetContent, 'model_provider');
  let nextContent = syncProviderRootKeys(targetContent, sourceContent);
  nextContent = upsertTopLevelStringValue(nextContent, 'model_provider', provider);
  if (previousProvider && previousProvider !== provider) {
    nextContent = removeTomlTable(nextContent, `model_providers.${previousProvider}`);
  }
  nextContent = removeTomlTable(nextContent, `model_providers.${provider}`);
  return nextContent.trimEnd() ? `${nextContent.trimEnd()}\n` : '';
}

function clearProviderConfig(targetContent) {
  const previousProvider = parseTopLevelStringValue(targetContent, 'model_provider');
  let nextContent = String(targetContent || '');
  for (const key of ['model_provider', ...PROVIDER_ROOT_KEYS]) {
    nextContent = removeTopLevelKey(nextContent, key);
  }
  if (previousProvider) {
    nextContent = removeTomlTable(nextContent, `model_providers.${previousProvider}`);
  }
  return nextContent.trimEnd() ? `${nextContent.trimEnd()}\n` : '';
}

function syncCodexProviderConfig(options = {}) {
  const enabled = Boolean(options.enabled);
  const sourceHome = sanitizeText(options.sourceHome);
  const targetHome = sanitizeText(options.targetHome);
  const syncAuth = options.syncAuth !== false;
  if (!enabled || !sourceHome || !targetHome || sourceHome === targetHome) {
    return { synced: false, reason: enabled ? 'same_or_missing_home' : 'disabled' };
  }

  const sourceFile = path.join(sourceHome, 'config.toml');
  const targetFile = path.join(targetHome, 'config.toml');
  const sourceAuthFile = path.join(sourceHome, 'auth.json');
  const targetAuthFile = path.join(targetHome, 'auth.json');
  if (!pathIsDirectory(sourceHome)) {
    return { synced: false, reason: 'missing_source_home' };
  }

  const sourceConfigExists = pathIsFile(sourceFile);
  const sourceAuthExists = pathIsFile(sourceAuthFile);
  if (!sourceConfigExists && !sourceAuthExists) {
    return { synced: false, reason: 'missing_source_config' };
  }

  const sourceContent = sourceConfigExists ? readFileIfExists(sourceFile) : '';

  const provider = resolveSourceProviderName(sourceContent, options.providerName);
  const targetContent = readFileIfExists(targetFile);
  let nextContent = targetContent;
  let configSynced = false;
  let configReason = '';

  if (!provider) {
    nextContent = clearProviderConfig(targetContent);
    configReason = 'cleared_missing_model_provider';
  } else {
    const providerTable = extractTomlTable(sourceContent, `model_providers.${provider}`);
    if (!providerTable) {
      if (!BUILTIN_MODEL_PROVIDERS_WITHOUT_TABLE.has(provider)) {
        return { synced: false, reason: 'missing_provider_table', provider };
      }
      nextContent = mergeBuiltinProviderConfig(targetContent, provider, sourceContent);
      configReason = 'builtin_provider';
    } else {
      nextContent = mergeProviderConfig(targetContent, provider, providerTable, sourceContent);
      configReason = 'provider';
    }
  }

  if (nextContent !== targetContent) {
    writeFileIfChanged(targetFile, nextContent);
    configSynced = true;
  }

  const authResult = syncAuth
    ? copyFileIfChanged(sourceAuthFile, targetAuthFile)
    : { synced: false, reason: 'auth_sync_disabled' };
  const synced = configSynced || authResult.synced;

  if (!synced) {
    return {
      synced: false,
      reason: 'unchanged',
      configReason,
      provider,
      configSynced: false,
      authSynced: false,
      auth: authResult
    };
  }

  const details = [
    configSynced ? (provider ? `provider=${provider}` : 'provider=cleared') : null,
    authResult.synced ? 'auth.json' : null
  ].filter(Boolean).join(', ');
  log(`Synced Codex provider config: ${details}`);
  return {
    synced: true,
    reason: configReason,
    configReason,
    provider,
    configSynced,
    authSynced: authResult.synced,
    auth: authResult
  };
}

module.exports = {
  readFileIfExists,
  pathIsDirectory,
  pathIsFile,
  parseTopLevelStringValue,
  removeTopLevelKey,
  readTopLevelRawValue,
  upsertTopLevelRawValue,
  syncProviderRootKeys,
  parseTomlTableHeader,
  listModelProviderNames,
  resolveSourceProviderName,
  extractTomlTable,
  removeTomlTable,
  upsertTopLevelStringValue,
  mergeProviderConfig,
  mergeBuiltinProviderConfig,
  clearProviderConfig,
  syncCodexProviderConfig
};
