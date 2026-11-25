import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const NON_BLOCKING_TOOL_RE = /^(schedule|swarm_wait|manage_task|manage_subagents)$/i;

function isBackgroundTaskGeneric(step) {
  if (!step || step.type !== 'GENERIC') return false;
  return /Tool is running as a background task/i.test(String(step.content || ''));
}

function parseJsonLine(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractAskQuestions(tc) {
  if (!tc || !/^ask_question$/i.test(tc.name || '')) return null;
  let raw = tc.args?.questions;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw
    .filter(q => q && typeof q.question === 'string')
    .map(q => ({
      question: q.question.trim(),
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      isMultiSelect: Boolean(q.is_multi_select),
    }));
}

function normalizeErrorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function parseWorkspaceUris(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
  } catch {
    // Fallback for plain URI or newline/comma separated values
  }
  return text
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function uriToPath(uri) {
  if (!uri) return '';
  const str = String(uri).trim();
  if (!str.startsWith('file://')) return str;
  const withoutScheme = str.slice('file://'.length);
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

/**
 * Parse compact transcript.jsonl lines and resolve any truncated_fields from transcript_full.jsonl.
 * Note: step_index may have gaps or start > 0, so fullLines are matched by step_index first and
 * then by 0-based line index.
 */
export function parseTranscriptLines(compactLines = [], fullLines = []) {
  const parsedFull = [];
  const fullByStepIndex = new Map();

  for (let i = 0; i < (fullLines?.length || 0); i++) {
    const obj = parseJsonLine(fullLines[i]);
    parsedFull[i] = obj;
    if (obj && obj.step_index !== undefined && obj.step_index !== null) {
      fullByStepIndex.set(obj.step_index, obj);
    }
  }

  const steps = [];
  for (let i = 0; i < (compactLines?.length || 0); i++) {
    const entry = parseJsonLine(compactLines[i]);
    if (!entry) continue;

    let merged = entry;
    if (Array.isArray(entry.truncated_fields) && entry.truncated_fields.length > 0) {
      const fullEntry =
        (entry.step_index !== undefined && entry.step_index !== null
          ? fullByStepIndex.get(entry.step_index)
          : null) || parsedFull[i];
      if (fullEntry && typeof fullEntry === 'object') {
        merged = { ...entry };
        for (const field of entry.truncated_fields) {
          if (field in fullEntry) {
            merged[field] = fullEntry[field];
          }
        }
      }
    }
    steps.push(merged);
  }

  const recentTurns = [];
  let lastUserIdx = -1;
  let lastUserInput = null;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const stepIndex = Number.isFinite(Number(s.step_index)) ? Number(s.step_index) : i;
    const createdAt = s.created_at || '';

    if (s.type === 'USER_INPUT' && (s.source === 'USER_EXPLICIT' || s.content)) {
      const content = String(s.content ?? '');
      lastUserIdx = i;
      lastUserInput = { stepIndex, content, createdAt };
      recentTurns.push({ role: 'user', stepIndex, content, createdAt });
    } else if (
      s.type === 'PLANNER_RESPONSE' &&
      s.source === 'MODEL' &&
      s.status === 'DONE' &&
      !(Array.isArray(s.tool_calls) && s.tool_calls.length > 0) &&
      typeof s.content === 'string' &&
      s.content.length > 0
    ) {
      recentTurns.push({ role: 'assistant', stepIndex, content: s.content, createdAt });
    } else if (s.type === 'ERROR_MESSAGE') {
      const message = normalizeErrorText(s.error || s.content || 'Unknown error');
      recentTurns.push({ role: 'error', stepIndex, content: message, createdAt });
    } else if (s.type === 'GENERIC' && s.status === 'ERROR') {
      const message = normalizeErrorText(s.error || s.content || 'Tool execution error');
      recentTurns.push({ role: 'error', stepIndex, content: message, createdAt });
    }
  }

  // Evaluate current turn (after lastUserInput, or from start if no USER_INPUT exists)
  let lastAssistantReply = null;
  let lastAssistantStepPos = -1;
  const currentTurnReplies = [];
  let lastError = null;
  let lastErrorStepPos = -1;
  let lastPlannerAnyPos = -1;
  let subturnPlannerTools = [];
  let subturnGenericIdx = 0;
  let subturnHasBgCommand = false;
  let subturnHasScheduleTimer = false;

  for (let i = lastUserIdx + 1; i < steps.length; i++) {
    const s = steps[i];
    const stepIndex = Number.isFinite(Number(s.step_index)) ? Number(s.step_index) : i;
    const createdAt = s.created_at || '';

    if (s.type === 'SYSTEM_MESSAGE' || s.type === 'USER_INPUT') {
      subturnPlannerTools = [];
      subturnGenericIdx = 0;
      subturnHasBgCommand = false;
      subturnHasScheduleTimer = false;
    }

    if (s.type === 'PLANNER_RESPONSE') {
      lastPlannerAnyPos = i;
      if (Array.isArray(s.tool_calls) && s.tool_calls.length > 0) {
        subturnPlannerTools = s.tool_calls;
        subturnGenericIdx = 0;
      }
    }

    if (s.type === 'GENERIC') {
      const tc = subturnPlannerTools[subturnGenericIdx] || subturnPlannerTools[0];
      subturnGenericIdx++;
      const toolName = tc?.name || '';
      if (s.status === 'RUNNING' || isBackgroundTaskGeneric(s)) {
        if (/^schedule$/i.test(toolName)) {
          subturnHasScheduleTimer = true;
        } else if (!NON_BLOCKING_TOOL_RE.test(toolName)) {
          subturnHasBgCommand = true;
        }
      }
    }

    if (
      s.type === 'PLANNER_RESPONSE' &&
      s.source === 'MODEL' &&
      s.status === 'DONE' &&
      !(Array.isArray(s.tool_calls) && s.tool_calls.length > 0) &&
      typeof s.content === 'string' &&
      s.content.length > 0
    ) {
      lastAssistantReply = {
        stepIndex,
        content: s.content,
        createdAt,
        ...(subturnHasBgCommand ? { afterBackgroundCommand: true } : {}),
        ...(subturnHasScheduleTimer ? { afterScheduleTimer: true } : {}),
      };
      currentTurnReplies.push(lastAssistantReply);
      lastAssistantStepPos = i;
    } else if (s.type === 'ERROR_MESSAGE') {
      lastError = {
        stepIndex,
        kind: 'fatal',
        message: normalizeErrorText(s.error || s.content || 'Unknown error'),
        createdAt,
      };
      lastErrorStepPos = i;
    } else if (s.type === 'GENERIC' && s.status === 'ERROR') {
      lastError = {
        stepIndex,
        kind: 'tool',
        message: normalizeErrorText(s.error || s.content || 'Tool execution error'),
        createdAt,
      };
      lastErrorStepPos = i;
    }
  }

  // Clear error if the model recovered and produced a subsequent planner step/reply
  if (lastError && (lastAssistantStepPos > lastErrorStepPos || lastPlannerAnyPos > lastErrorStepPos)) {
    lastError = null;
  }

  // Detect pending tool call in the current turn after any completed assistant reply
  let pendingToolCall = null;
  const searchFrom = Math.max(lastUserIdx + 1, lastAssistantStepPos + 1);
  let lastPlannerWithTools = null;
  let lastPlannerPos = -1;
  for (let i = searchFrom; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'PLANNER_RESPONSE' && Array.isArray(s.tool_calls) && s.tool_calls.length > 0) {
      lastPlannerWithTools = s;
      lastPlannerPos = i;
    }
  }

  // Do not treat completed turns (where a tool-less PLANNER_RESPONSE followed the last tool call) as pending
  const hasFinalPlannerAfterTools =
    lastPlannerPos >= 0 &&
    steps
      .slice(lastPlannerPos + 1)
      .some(
        s =>
          s.type === 'PLANNER_RESPONSE' &&
          !(Array.isArray(s.tool_calls) && s.tool_calls.length > 0),
      );

  if (lastPlannerWithTools && !hasFinalPlannerAfterTools) {
    const genericAfter = steps
      .slice(lastPlannerPos + 1)
      .filter(s => s.type === 'GENERIC');
    const runningGeneric = genericAfter.find(
      s => s.status === 'RUNNING' && !isBackgroundTaskGeneric(s),
    );
    if (runningGeneric) {
      const runningIdx = genericAfter.indexOf(runningGeneric);
      const tc = lastPlannerWithTools.tool_calls[runningIdx] || lastPlannerWithTools.tool_calls[0];
      const toolName = tc?.name || 'tool';
      if (!NON_BLOCKING_TOOL_RE.test(toolName)) {
        const questions = extractAskQuestions(tc);
        pendingToolCall = {
          stepIndex: Number.isFinite(Number(runningGeneric.step_index))
            ? Number(runningGeneric.step_index)
            : lastPlannerPos,
          name: toolName,
          createdAt: runningGeneric.created_at || lastPlannerWithTools.created_at || '',
          ...(questions ? { questions } : {}),
        };
      }
    } else if (genericAfter.length < lastPlannerWithTools.tool_calls.length) {
      const tc = lastPlannerWithTools.tool_calls[genericAfter.length] || lastPlannerWithTools.tool_calls[0];
      const toolName = tc?.name || 'tool';
      if (!NON_BLOCKING_TOOL_RE.test(toolName)) {
        const questions = extractAskQuestions(tc);
        pendingToolCall = {
          stepIndex: Number.isFinite(Number(lastPlannerWithTools.step_index))
            ? Number(lastPlannerWithTools.step_index)
            : lastPlannerPos,
          name: toolName,
          createdAt: lastPlannerWithTools.created_at || '',
          ...(questions ? { questions } : {}),
        };
      }
    }
  }

  return {
    totalSteps: steps.length,
    lastUserInput,
    lastAssistantReply,
    currentTurnReplies,
    lastError,
    pendingToolCall,
    recentTurns,
  };
}

export function createAntigravityClient(config = {}) {
  const dataDir = config.dataDir || path.join(process.env.HOME || '', '.gemini', 'antigravity');
  const dbPath = config.dbPath || path.join(dataDir, 'conversation_summaries.db');
  const brainDir = config.brainDir || path.join(dataDir, 'brain');
  const agentapiBin = config.agentapiBin || path.join(dataDir, 'bin', 'agentapi');
  const defaultWorkdir = config.workdir || process.cwd();
  const execImpl = config._execFile || execFileAsync;

  function transcriptPaths(conversationId) {
    const logsDir = path.join(brainDir, conversationId, '.system_generated', 'logs');
    return {
      compact: path.join(logsDir, 'transcript.jsonl'),
      full: path.join(logsDir, 'transcript_full.jsonl'),
    };
  }

  function withDb(fn) {
    if (!fs.existsSync(dbPath)) return null;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      return fn(db);
    } catch {
      try {
        db?.close();
      } catch {}
      db = new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true });
      return fn(db);
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  function mapRow(row) {
    if (!row) return null;
    const workspaceUris = parseWorkspaceUris(row.workspace_uris);
    const status = row.status || '';
    const notFullyIdle = Boolean(row.not_fully_idle);
    const isTurnRunning = status !== '' && status !== 'CASCADE_RUN_STATUS_IDLE';
    const isRunning = isTurnRunning || notFullyIdle;
    const { compact } = transcriptPaths(row.conversation_id);
    return {
      id: row.conversation_id,
      title: row.title || '',
      preview: row.preview || '',
      status,
      isTurnRunning,
      isRunning,
      notFullyIdle,
      killed: Boolean(row.killed),
      stepCount: Number(row.step_count || 0),
      lastModifiedTime: row.last_modified_time || '',
      workspaceUris,
      workspace: uriToPath(workspaceUris[0] || ''),
      parentId: row.parent_conversation_id || '',
      nestingDepth: Number(row.nesting_depth || 0),
      agentName: row.agent_name || '',
      hasTranscript: fs.existsSync(compact),
    };
  }

  function listConversations({ includeSubagents = false, limit = 30 } = {}) {
    const rows = withDb(db => {
      const where = includeSubagents
        ? ''
        : "WHERE COALESCE(nesting_depth, 0) = 0 AND (parent_conversation_id IS NULL OR parent_conversation_id = '')";
      const sql = `
        SELECT conversation_id, title, preview, step_count, last_modified_time,
               workspace_uris, status, agent_name, parent_conversation_id,
               nesting_depth, not_fully_idle, killed
        FROM conversation_summaries
        ${where}
        ORDER BY last_modified_time DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(Number(limit) || 30);
    });
    if (!rows) return [];
    return rows.map(mapRow);
  }

  function getConversation(conversationId) {
    if (!conversationId) return null;
    const row = withDb(db =>
      db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  workspace_uris, status, agent_name, parent_conversation_id,
                  nesting_depth, not_fully_idle, killed
           FROM conversation_summaries
           WHERE conversation_id = ?`,
        )
        .get(conversationId),
    );
    return mapRow(row);
  }

  async function getMetadata(conversationId) {
    if (!conversationId) return { ok: false, error: 'conversationId is required' };
    try {
      const { stdout } = await execImpl(
        agentapiBin,
        ['get-conversation-metadata', conversationId],
        { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      );
      return JSON.parse(stdout);
    } catch (error) {
      return { ok: false, error: error?.stderr?.trim() || error?.message || String(error) };
    }
  }

  function readTranscript(conversationId, { maxTurns = 6 } = {}) {
    const empty = {
      exists: false,
      totalSteps: 0,
      lastUserInput: null,
      lastAssistantReply: null,
      lastError: null,
      pendingToolCall: null,
      recentTurns: [],
    };
    if (!conversationId) return empty;
    const { compact, full } = transcriptPaths(conversationId);
    if (!fs.existsSync(compact)) return empty;

    const compactLines = fs.readFileSync(compact, 'utf8').split(/\r?\n/);
    const fullLines = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').split(/\r?\n/) : [];
    const parsed = parseTranscriptLines(compactLines, fullLines);
    const recentTurns = maxTurns > 0 ? parsed.recentTurns.slice(-maxTurns) : parsed.recentTurns;
    return {
      exists: true,
      ...parsed,
      recentTurns,
    };
  }

  function extractAgentApiError(stdout = '', stderr = '', fallback = '') {
    for (const chunk of [stdout, stderr]) {
      const text = String(chunk || '').trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
          return parsed.error.trim();
        }
      } catch {
        // Ignore non-JSON chunks
      }
    }
    return String(stderr || '').trim() || String(fallback || '').trim() || 'agentapi failed';
  }

  async function sendMessage(conversationId, content, { title } = {}) {
    if (!conversationId || !content) {
      return { ok: false, conversationId: conversationId || '', stdout: '', stderr: '', error: 'conversationId and content are required' };
    }
    const args = ['send-message'];
    if (title) args.push(`--title=${title}`);
    args.push('--', conversationId, String(content));
    try {
      const { stdout = '', stderr = '' } = await execImpl(agentapiBin, args, {
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      });
      try {
        const parsed = JSON.parse(String(stdout || '').trim());
        if (parsed?.error) {
          return { ok: false, conversationId, stdout, stderr, error: String(parsed.error) };
        }
      } catch {}
      return { ok: true, conversationId, stdout, stderr };
    } catch (error) {
      return {
        ok: false,
        conversationId,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        error: extractAgentApiError(error?.stdout, error?.stderr, error?.message),
      };
    }
  }

  async function createConversation(prompt, { cwd, model, title, profile } = {}) {
    if (!prompt) {
      return { ok: false, conversationId: null, stdout: '', stderr: '', error: 'prompt is required' };
    }
    const args = ['new-conversation'];
    if (model) args.push(`--model=${model}`);
    if (title) args.push(`--title=${title}`);
    if (profile) args.push(`--profile=${profile}`);
    args.push('--', String(prompt));

    const targetCwd = cwd || defaultWorkdir;
    const opts = {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    };
    if (targetCwd && fs.existsSync(targetCwd)) {
      opts.cwd = targetCwd;
    }

    try {
      const { stdout = '', stderr = '' } = await execImpl(agentapiBin, args, opts);
      let conversationId = null;
      try {
        const parsed = JSON.parse(String(stdout || '').trim());
        if (parsed?.error) {
          return { ok: false, conversationId: null, stdout, stderr, error: String(parsed.error) };
        }
        conversationId =
          parsed?.conversationId ||
          parsed?.conversation_id ||
          parsed?.response?.conversationId ||
          parsed?.response?.conversation_id ||
          null;
      } catch {
        // Fallback to regex extraction from stdout/stderr
      }
      if (!conversationId) {
        const m = UUID_RE.exec(`${stdout}\n${stderr}`);
        conversationId = m ? m[0] : null;
      }
      return { ok: true, conversationId, stdout, stderr };
    } catch (error) {
      return {
        ok: false,
        conversationId: null,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        error: extractAgentApiError(error?.stdout, error?.stderr, error?.message),
      };
    }
  }

  function healthCheck() {
    const dbExists = fs.existsSync(dbPath);
    const agentapiExists = fs.existsSync(agentapiBin);
    if (!dbExists) {
      return { dbExists, agentapiExists, conversationCount: 0 };
    }
    try {
      const row = withDb(db => db.prepare('SELECT COUNT(*) AS cnt FROM conversation_summaries').get());
      return {
        dbExists,
        agentapiExists,
        conversationCount: Number(row?.cnt || 0),
      };
    } catch (error) {
      return {
        dbExists,
        agentapiExists,
        conversationCount: 0,
        error: error?.message || String(error),
      };
    }
  }

  return {
    listConversations,
    getConversation,
    getMetadata,
    readTranscript,
    sendMessage,
    createConversation,
    healthCheck,
  };
}
