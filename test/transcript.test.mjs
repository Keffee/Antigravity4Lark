import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseTranscriptLines, createAntigravityClient } from '../lib/antigravity.mjs';

test('parseTranscriptLines handles truncated_fields, non-sequential step_index, and extracts latest turn', () => {
  const compact = [
    JSON.stringify({ step_index: 100, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-19T08:00:00Z', content: 'init' }),
    JSON.stringify({ step_index: 105, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-19T08:01:00Z', content: 'first prompt' }),
    JSON.stringify({ step_index: 106, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-19T08:01:05Z', content: '', tool_calls: [{ name: 'read_file', args: { Path: '/a' } }] }),
    JSON.stringify({ step_index: 107, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-19T08:01:06Z', content: 'truncated...', truncated_fields: ['content'] }),
    JSON.stringify({ step_index: 108, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-19T08:01:10Z', content: 'short...', truncated_fields: ['content'], tool_calls: [] }),
  ];
  const full = [
    JSON.stringify({ step_index: 100, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'init' }),
    JSON.stringify({ step_index: 105, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'first prompt' }),
    JSON.stringify({ step_index: 106, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [{ name: 'read_file', args: { Path: '/a' } }] }),
    JSON.stringify({ step_index: 107, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'full tool output' }),
    JSON.stringify({ step_index: 108, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-19T08:01:10Z', content: 'FULL FINAL REPLY CONTENT', tool_calls: [] }),
  ];

  const res = parseTranscriptLines(compact, full);
  assert.equal(res.totalSteps, 5);
  assert.deepEqual(res.lastUserInput, {
    stepIndex: 105,
    content: 'first prompt',
    createdAt: '2026-11-19T08:01:00Z',
  });
  assert.deepEqual(res.lastAssistantReply, {
    stepIndex: 108,
    content: 'FULL FINAL REPLY CONTENT',
    createdAt: '2026-11-19T08:01:10Z',
  });
  assert.equal(res.lastError, null);
  assert.equal(res.pendingToolCall, null);
  assert.equal(res.recentTurns.length, 2);
  assert.equal(res.recentTurns[1].role, 'assistant');
  assert.equal(res.recentTurns[1].content, 'FULL FINAL REPLY CONTENT');
});

test('parseTranscriptLines detects pending tool call and error after last user input', () => {
  const pendingCompact = [
    JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: 't1', content: 'run tests' }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: 't2', content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: 't3', content: '' }),
  ];
  const pendingRes = parseTranscriptLines(pendingCompact, []);
  assert.equal(pendingRes.lastAssistantReply, null);
  assert.deepEqual(pendingRes.pendingToolCall, {
    stepIndex: 3,
    name: 'run_command',
    createdAt: 't3',
  });

  const errorCompact = [
    JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: 't1', content: 'do it' }),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: 't2', error: 'Rate limit reached' }),
  ];
  const errorRes = parseTranscriptLines(errorCompact, []);
  assert.deepEqual(errorRes.lastError, {
    stepIndex: 2,
    kind: 'fatal',
    message: 'Rate limit reached',
    createdAt: 't2',
  });
});

test('createAntigravityClient reads SQLite conversation_summaries and transcripts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-client-test-'));
  try {
    const dbPath = path.join(tmp, 'conversation_summaries.db');
    const brainDir = path.join(tmp, 'brain');
    const logsDir = path.join(brainDir, '11111111-1111-1111-1111-111111111111', '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT "",
        preview TEXT NOT NULL DEFAULT "",
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL,
        workspace_uris TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT "",
        source TEXT NOT NULL DEFAULT "",
        project_id TEXT NOT NULL DEFAULT "",
        agent_name TEXT NOT NULL DEFAULT "",
        parent_conversation_id TEXT NOT NULL DEFAULT "",
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        battle_id TEXT NOT NULL DEFAULT "",
        winning_conversation_id TEXT NOT NULL DEFAULT "",
        not_fully_idle NUMERIC NOT NULL DEFAULT false,
        killed NUMERIC NOT NULL DEFAULT false,
        last_user_input_time DATETIME NOT NULL DEFAULT "",
        last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
        app_data_dir TEXT NOT NULL DEFAULT "",
        raw_summary BLOB,
        group_id TEXT NOT NULL DEFAULT ""
      );
    `);
    db.prepare(`
      INSERT INTO conversation_summaries
      (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, parent_conversation_id, nesting_depth, not_fully_idle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '11111111-1111-1111-1111-111111111111',
      'Top Session',
      'Preview',
      4,
      '2026-11-19 10:00:00',
      '["file:///Users/test/my%20repo"]',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      0,
      0,
    );
    db.prepare(`
      INSERT INTO conversation_summaries
      (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, parent_conversation_id, nesting_depth, not_fully_idle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '22222222-2222-2222-2222-222222222222',
      'Subagent',
      '',
      2,
      '2026-11-19 10:01:00',
      '[]',
      'CASCADE_RUN_STATUS_RUNNING',
      '11111111-1111-1111-1111-111111111111',
      1,
      1,
    );
    db.close();

    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: 't0', content: 'hi' }),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: 't1', content: 'hello!', tool_calls: [] }),
      ].join('\n'),
    );

    const execCalls = [];
    const client = createAntigravityClient({
      dbPath,
      brainDir,
      agentapiBin: '/mock/agentapi',
      _execFile: async (bin, args) => {
        execCalls.push({ bin, args });
        if (args[0] === 'new-conversation') {
          return { stdout: 'Created 33333333-3333-3333-3333-333333333333', stderr: '' };
        }
        return { stdout: '{"ok":true}', stderr: '' };
      },
    });

    const topOnly = client.listConversations();
    assert.equal(topOnly.length, 1);
    assert.equal(topOnly[0].id, '11111111-1111-1111-1111-111111111111');
    assert.equal(topOnly[0].workspace, '/Users/test/my repo');
    assert.equal(topOnly[0].isRunning, false);
    assert.equal(topOnly[0].hasTranscript, true);

    const all = client.listConversations({ includeSubagents: true });
    assert.equal(all.length, 2);

    const tr = client.readTranscript('11111111-1111-1111-1111-111111111111');
    assert.equal(tr.exists, true);
    assert.equal(tr.lastAssistantReply.content, 'hello!');

    const created = await client.createConversation('- leading dash prompt', { model: 'flash' });
    assert.equal(created.ok, true);
    assert.equal(created.conversationId, '33333333-3333-3333-3333-333333333333');
    assert.deepEqual(execCalls[0].args, ['new-conversation', '--model=flash', '--', '- leading dash prompt']);

    const sent = await client.sendMessage('11111111-1111-1111-1111-111111111111', '--help');
    assert.equal(sent.ok, true);
    assert.deepEqual(execCalls[1].args, ['send-message', '--', '11111111-1111-1111-1111-111111111111', '--help']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseTranscriptLines handles SYSTEM_MESSAGE turns and intermediate PLANNER_RESPONSE with content + tool_calls', () => {
  const lines = [
    JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: 't0', content: 'agentapi prompt' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: 't1', content: 'Let me check...', tool_calls: [{ name: 'read_file', args: {} }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: 't2', content: 'file body' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: 't3', content: 'Final answer after tool', tool_calls: [] }),
  ];
  const res = parseTranscriptLines(lines, []);
  assert.equal(res.lastUserInput, null);
  assert.deepEqual(res.lastAssistantReply, {
    stepIndex: 3,
    content: 'Final answer after tool',
    createdAt: 't3',
  });
  assert.equal(res.recentTurns.length, 1);
  assert.equal(res.recentTurns[0].content, 'Final answer after tool');
});

test('createAntigravityClient surfaces JSON error field from agentapi stdout', async () => {
  const client = createAntigravityClient({
    agentapiBin: '/mock/agentapi',
    _execFile: async () => ({
      stdout: JSON.stringify({ response: {}, error: 'recipient not found' }),
      stderr: '',
    }),
  });
  const res = await client.sendMessage('11111111-1111-1111-1111-111111111111', 'hi');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'recipient not found');
});

test('parseTranscriptLines ignores schedule/background tasks as pendingToolCall and tags interim background-command replies', () => {
  const bgCommandTurn = [
    JSON.stringify({ step_index: 177, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: 't1', content: '', tool_calls: [{ name: 'run_command', args: {} }] }),
    JSON.stringify({ step_index: 178, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: 't2', content: 'Tool is running as a background task with task id: x/task-1' }),
    JSON.stringify({ step_index: 179, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: 't3', content: 'Interim transition sentence while command runs', tool_calls: [] }),
  ];
  const r1 = parseTranscriptLines(bgCommandTurn, []);
  assert.equal(r1.pendingToolCall, null);
  assert.equal(r1.lastAssistantReply.stepIndex, 179);
  assert.equal(r1.lastAssistantReply.afterBackgroundCommand, true);

  const scheduleMidStep = [
    ...bgCommandTurn,
    JSON.stringify({ step_index: 180, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: 't4', content: 'Background task finished' }),
    JSON.stringify({ step_index: 181, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: 't5', content: '', tool_calls: [{ name: 'schedule', args: { DurationSeconds: 150 } }] }),
    JSON.stringify({ step_index: 182, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: 't6', content: 'Tool is running as a background task with task id: x/timer-1' }),
  ];
  const r2 = parseTranscriptLines(scheduleMidStep, []);
  assert.equal(r2.pendingToolCall, null);

  const scheduleDoneTurn = [
    ...scheduleMidStep,
    JSON.stringify({ step_index: 183, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: 't7', content: 'Final conclusion after background command completed', tool_calls: [] }),
  ];
  const r3 = parseTranscriptLines(scheduleDoneTurn, []);
  assert.equal(r3.pendingToolCall, null);
  assert.equal(r3.lastAssistantReply.stepIndex, 183);
  assert.equal(r3.lastAssistantReply.afterBackgroundCommand, undefined);
  assert.equal(r3.lastAssistantReply.afterScheduleTimer, true);
});
