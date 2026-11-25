import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = '【AG · Antigravity】';

const VALID_PUSH_MODES = new Set(['bound', 'all', 'off']);

/**
 * Parse a .env file into a key-value map without mutating process.env.
 */
export function parseEnvFile(file, allowedKeys = null) {
  const result = {};
  if (!file) return result;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return result;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawVal] = match;
    if (allowedKeys && !allowedKeys.includes(key)) continue;
    result[key] = rawVal.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

export function normalizePushMode(value, fallback = 'all') {
  const v = String(value || '').trim().toLowerCase();
  if (VALID_PUSH_MODES.has(v)) return v;
  return fallback;
}

/**
 * Load Antigravity-Feishu configuration from env and local .env.
 * Optionally falls back to reading FEISHU_OPEN_ID from FEISHU_OPEN_ID_FALLBACK_ENV when missing.
 */
export function loadConfig(env = process.env, options = {}) {
  const home = options.homeDir || os.homedir();
  const envFile = options.envFile === undefined ? path.join(rootDir, '.env') : options.envFile;

  const localEnv = parseEnvFile(envFile);
  const merged = { ...localEnv };
  for (const [k, v] of Object.entries(env || {})) {
    if (v !== undefined) merged[k] = v;
  }

  const fallbackEnvFile =
    options.fallbackEnvFile === undefined
      ? (String(merged.FEISHU_OPEN_ID_FALLBACK_ENV || '').trim()
          ? path.resolve(rootDir, String(merged.FEISHU_OPEN_ID_FALLBACK_ENV).trim())
          : null)
      : options.fallbackEnvFile;

  if (!String(merged.FEISHU_OPEN_ID || '').trim() && fallbackEnvFile) {
    const fallbackEnv = parseEnvFile(fallbackEnvFile, ['FEISHU_OPEN_ID']);
    if (fallbackEnv.FEISHU_OPEN_ID) {
      merged.FEISHU_OPEN_ID = fallbackEnv.FEISHU_OPEN_ID;
    }
  }

  const localLark = path.join(home, '.local', 'bin', 'lark-cli');
  const stateDir = path.resolve(merged.AG_STATE_DIR || path.join(home, '.antigravity-feishu'));
  const dataDir = path.resolve(merged.AG_DATA_DIR || path.join(home, '.gemini', 'antigravity'));
  const codexStateDir = path.resolve(merged.CODEX_STATE_DIR || path.join(home, '.codex-feishu'));
  const kimiStateDir = path.resolve(merged.KIMI_STATE_DIR || path.join(home, '.kimi-feishu'));

  return {
    marker: MARKER,
    rootDir,
    feishuOpenId: String(merged.FEISHU_OPEN_ID || '').trim(),
    larkCli: String(merged.LARK_CLI || (fs.existsSync(localLark) ? localLark : 'lark-cli')).trim(),
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    sockPath: path.join(stateDir, 'bridge.sock'),
    dataDir,
    dbPath: merged.AG_DB_PATH
      ? path.resolve(merged.AG_DB_PATH)
      : path.join(dataDir, 'conversation_summaries.db'),
    brainDir: merged.AG_BRAIN_DIR
      ? path.resolve(merged.AG_BRAIN_DIR)
      : path.join(dataDir, 'brain'),
    agentapiBin: String(merged.AG_AGENTAPI_BIN || path.join(dataDir, 'bin', 'agentapi')).trim(),
    workdir: path.resolve(merged.AG_WORKDIR || rootDir),
    defaultConversationId: String(merged.AG_DEFAULT_CONVERSATION_ID || '').trim(),
    pushMode: normalizePushMode(merged.AG_PUSH_MODE, 'all'),
    pollIntervalMs: Math.max(500, Number(merged.AG_POLL_INTERVAL_MS) || 2000),
    maxPushLength: Math.max(500, Number(merged.AG_MAX_PUSH_LENGTH) || 4000),
    cdpUrl: String(merged.AG_CDP_URL || 'http://127.0.0.1:9223').replace(/\/$/, ''),
    dryRun: String(merged.AG_DRY_RUN || '') === '1',
    bridgeFiles: {
      cursorRoutesFile: merged.CURSOR_ROUTES_FILE
        ? path.resolve(merged.CURSOR_ROUTES_FILE)
        : path.join(home, '.cursor-remote-lite', 'msg-routes.json'),
      codexStateFile: path.join(codexStateDir, 'state.json'),
      kimiStateFile: path.join(kimiStateDir, 'state.json'),
    },
  };
}
