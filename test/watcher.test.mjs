import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityWatcher, needsUserDecision } from '../lib/watcher.mjs';

function makeMemoryState({ pushMode = 'bound', defaultId = 'conv-1', boundIds = [] } = {}) {
  const pushed = new Map();
  const seqs = new Map();
  let nextSeq = 0;
  const bound = new Set(boundIds);
  let saves = 0;

  return {
    getPushMode: () => pushMode,
    getDefaultConversationId: () => defaultId,
    isBound: id => bound.has(id),
    assignSeq: id => {
      if (!seqs.has(id)) seqs.set(id, ++nextSeq);
      return seqs.get(id);
    },
    getSeq: id => seqs.get(id) || null,
    hasPushedStep: (id, step) => pushed.get(id)?.has(step) || false,
    markPushedStep: (id, step) => {
      if (!pushed.has(id)) pushed.set(id, new Set());
      pushed.get(id).add(step);
    },
    save: () => {
      saves++;
    },
    getSaves: () => saves,
  };
}

test('AntigravityWatcher establishes baseline without emitting history, then emits new reply without duplicates', async () => {
  let stepState = 'initial';
  const events = [];
  const state = makeMemoryState({ pushMode: 'bound', defaultId: 'conv-1' });

  const client = {
    listConversations: () => [
      { id: 'conv-1', title: 'Main', isRunning: stepState === 'running' },
      { id: 'conv-2', title: 'Unbound', isRunning: false },
    ],
    readTranscript: id => {
      if (id === 'conv-2') {
        return {
          exists: true,
          lastUserInput: { stepIndex: 1, content: 'other', createdAt: 't1' },
          lastAssistantReply: { stepIndex: 2, content: 'unbound reply', createdAt: 't2' },
          lastError: null,
          pendingToolCall: null,
        };
      }
      if (stepState === 'initial') {
        return {
          exists: true,
          lastUserInput: { stepIndex: 1, content: 'old q', createdAt: 't1' },
          lastAssistantReply: { stepIndex: 2, content: 'old reply', createdAt: 't2' },
          lastError: null,
          pendingToolCall: null,
        };
      }
      if (stepState === 'running') {
        return {
          exists: true,
          lastUserInput: { stepIndex: 3, content: 'new q', createdAt: 't3' },
          lastAssistantReply: null,
          lastError: null,
          pendingToolCall: null,
        };
      }
      return {
        exists: true,
        lastUserInput: { stepIndex: 3, content: 'new q', createdAt: 't3' },
        lastAssistantReply: { stepIndex: 4, content: 'new reply', createdAt: 't4' },
        lastError: null,
        pendingToolCall: null,
      };
    },
  };

  const watcher = new AntigravityWatcher({
    client,
    state,
    config: { pollIntervalMs: 1000, waitingThresholdMs: 15000 },
    onEvent: async ev => {
      events.push(ev);
    },
  });

  // 1st poll: baseline only
  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // 2nd poll: running
  stepState = 'running';
  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // 3rd poll: completed -> emits reply
  stepState = 'done';
  await watcher.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'reply');
  assert.equal(events[0].stepIndex, 4);
  assert.equal(events[0].text, 'new reply');

  // 4th poll: duplicate check -> no new event
  await watcher.pollOnce();
  assert.equal(events.length, 1);
});

test('AntigravityWatcher emits waiting event with CDP buttons and error events', async () => {
  const events = [];
  const state = makeMemoryState({ pushMode: 'all', defaultId: 'conv-1' });
  let phase = 'baseline';

  const client = {
    listConversations: () => [
      { id: 'conv-1', title: 'Main', isRunning: phase === 'waiting' },
    ],
    readTranscript: () => {
      if (phase === 'baseline') {
        return {
          exists: true,
          lastUserInput: null,
          lastAssistantReply: null,
          lastError: null,
          pendingToolCall: null,
        };
      }
      if (phase === 'waiting') {
        return {
          exists: true,
          lastUserInput: { stepIndex: 1, content: 'run it', createdAt: 't1' },
          lastAssistantReply: null,
          lastError: null,
          pendingToolCall: { stepIndex: 2, name: 'run_command', createdAt: 't2' },
        };
      }
      return {
        exists: true,
        lastUserInput: { stepIndex: 1, content: 'run it', createdAt: 't1' },
        lastAssistantReply: null,
        lastError: { stepIndex: 3, message: 'Permission denied', createdAt: 't3' },
        pendingToolCall: null,
      };
    },
  };

  const cdp = {
    getUiState: async () => ({
      available: true,
      hasStopButton: true,
      approvalButtons: ['Allow', 'Reject'],
    }),
  };

  const watcher = new AntigravityWatcher({
    client,
    cdp,
    state,
    config: { waitingThresholdMs: 15000 },
    onEvent: async ev => {
      events.push(ev);
    },
  });

  await watcher.pollOnce();
  assert.equal(events.length, 0);

  phase = 'waiting';
  await watcher.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'waiting');
  assert.deepEqual(events[0].buttons, ['Allow', 'Reject']);

  // Second poll while still waiting should not re-emit
  await watcher.pollOnce();
  assert.equal(events.length, 1);

  phase = 'error';
  await watcher.pollOnce();
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'error');
  assert.equal(events[1].text, 'Permission denied');
  assert.equal(watcher._pendingSince.size, 0);
});

test('AntigravityWatcher emits reply for SYSTEM_MESSAGE-driven turn without new USER_INPUT', async () => {
  const events = [];
  const state = makeMemoryState({ pushMode: 'bound', defaultId: 'conv-1' });
  let turn = 1;

  const client = {
    listConversations: () => [{ id: 'conv-1', title: 'Main', isRunning: false }],
    readTranscript: () => ({
      exists: true,
      lastUserInput: { stepIndex: 1, content: 'initial user prompt', createdAt: 't1' },
      lastAssistantReply:
        turn === 1
          ? { stepIndex: 2, content: 'first reply', createdAt: 't2' }
          : { stepIndex: 5, content: 'reply to agentapi send-message', createdAt: 't5' },
      lastError: null,
      pendingToolCall: null,
    }),
  };

  const watcher = new AntigravityWatcher({
    client,
    state,
    onEvent: async ev => events.push(ev),
  });

  await watcher.pollOnce();
  assert.equal(events.length, 0);

  turn = 2;
  await watcher.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'reply');
  assert.equal(events[0].stepIndex, 5);
  assert.equal(events[0].text, 'reply to agentapi send-message');
});

test('AntigravityWatcher suppresses interim replies during isTurnRunning/background command wait and never guesses waiting by timeout', async () => {
  const events = [];
  const state = makeMemoryState({ pushMode: 'all', defaultId: 'conv-3' });
  let phase = 'baseline';

  const client = {
    listConversations: () => [
      {
        id: 'conv-3',
        title: 'Background Job Runner',
        isTurnRunning: phase === 'mid_turn' || phase === 'schedule_running',
        isRunning: phase !== 'baseline',
        notFullyIdle: phase !== 'baseline',
      },
    ],
    readTranscript: () => {
      if (phase === 'baseline') {
        return {
          exists: true,
          lastUserInput: { stepIndex: 170, content: 'start', createdAt: 't0' },
          lastAssistantReply: { stepIndex: 175, content: 'old reply', createdAt: 't1' },
          lastError: null,
          pendingToolCall: null,
          recentTurns: [{ role: 'assistant', stepIndex: 175, content: 'old reply', createdAt: 't1' }],
        };
      }
      if (phase === 'bg_cmd_interim') {
        // step=179: interim message right after backgrounded run_command while notFullyIdle=true
        return {
          exists: true,
          lastUserInput: { stepIndex: 170, content: 'start', createdAt: 't0' },
          lastAssistantReply: {
            stepIndex: 179,
            content: '批量任务已全部提交，正在汇总初始执行状态。',
            createdAt: 't2',
            afterBackgroundCommand: true,
          },
          lastError: null,
          pendingToolCall: null,
          recentTurns: [
            { role: 'assistant', stepIndex: 175, content: 'old reply', createdAt: 't1' },
            { role: 'assistant', stepIndex: 179, content: '批量任务已全部提交...', createdAt: 't2' },
          ],
        };
      }
      if (phase === 'schedule_running') {
        // step=182: schedule tool running without CDP approval buttons -> no waiting alert!
        return {
          exists: true,
          lastUserInput: { stepIndex: 170, content: 'start', createdAt: 't0' },
          lastAssistantReply: {
            stepIndex: 179,
            content: '批量任务已全部提交...',
            createdAt: 't2',
            afterBackgroundCommand: true,
          },
          lastError: null,
          pendingToolCall: { stepIndex: 182, name: 'run_command', createdAt: 't3' },
          recentTurns: [],
        };
      }
      // phase === 'final_idle_with_schedule_timer': status is IDLE (!isTurnRunning), notFullyIdle=true due to schedule timer, step=183 is final conclusion
      return {
        exists: true,
        lastUserInput: { stepIndex: 170, content: 'start', createdAt: 't0' },
        lastAssistantReply: {
          stepIndex: 183,
          content: '最终调度汇总结论（step=183）',
          createdAt: 't4',
        },
        lastError: null,
        pendingToolCall: null,
        recentTurns: [
          { role: 'assistant', stepIndex: 175, content: 'old reply', createdAt: 't1' },
          { role: 'assistant', stepIndex: 179, content: '批量任务已全部提交...', createdAt: 't2' },
          { role: 'assistant', stepIndex: 183, content: '最终调度汇总结论（step=183）', createdAt: 't4' },
        ],
      };
    },
  };

  const watcher = new AntigravityWatcher({
    client,
    cdp: { getUiState: async () => ({ available: false }) },
    state,
    config: { waitingThresholdMs: 0 },
    onEvent: async ev => events.push(ev),
  });

  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // Interim reply after backgrounded run_command must NOT be pushed
  phase = 'bg_cmd_interim';
  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // Tool running without CDP buttons and not ask_question must NOT trigger timeout-guessed waiting
  phase = 'schedule_running';
  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // Turn reaches IDLE at step=183 -> pushes ONLY step=183 and marks step=179 as pushed
  phase = 'final_idle_with_schedule_timer';
  await watcher.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'reply');
  assert.equal(events[0].stepIndex, 183);
  assert.equal(events[0].text, '最终调度汇总结论（step=183）');
  assert.equal(state.hasPushedStep('conv-3', 179), true);
  assert.equal(state.hasPushedStep('conv-3', 183), true);
});

test('AntigravityWatcher breaks through background schedule suppression when reply asks for a user decision', async () => {
  assert.equal(needsUserDecision('已设置 150 秒定时器自动巡检调度与落盘进展，无需手动操作。'), false);
  assert.equal(needsUserDecision('批量任务已全部提交，正在汇总初始执行状态。'), false);
  assert.equal(
    needsUserDecision('请确认数据处理策略：\n1. 方案 A（推荐）\n2. 方案 B（严格校验）'),
    true,
  );

  const events = [];
  const state = makeMemoryState({ pushMode: 'all', defaultId: 'conv-1' });
  let phase = 'baseline';

  const client = {
    listConversations: () => [
      {
        id: 'conv-3',
        title: 'Demo Experiment',
        isTurnRunning: false,
        isRunning: true,
        notFullyIdle: true,
      },
    ],
    readTranscript: () => {
      if (phase === 'baseline') {
        return {
          exists: true,
          lastAssistantReply: { stepIndex: 100, content: '旧进度', createdAt: 't0', afterBackgroundCommand: true },
          lastError: null,
          pendingToolCall: null,
          recentTurns: [],
        };
      }
      if (phase === 'patrol') {
        return {
          exists: true,
          lastAssistantReply: {
            stepIndex: 110,
            content: '当前后台任务进度：已完成 23 / 29 项，已设 12 分钟定时器继续巡检，无需手动操作。',
            createdAt: 't1',
            afterBackgroundCommand: true,
          },
          lastError: null,
          pendingToolCall: null,
          recentTurns: [],
        };
      }
      return {
        exists: true,
        lastAssistantReply: {
          stepIndex: 120,
          content: '请确认数据处理策略：\n1. 方案 A（推荐）\n2. 方案 B（严格校验）\n\n已设 12 分钟定时器持续推进。',
          createdAt: 't2',
          afterBackgroundCommand: true,
        },
        lastError: null,
        pendingToolCall: null,
        recentTurns: [],
      };
    },
  };

  const watcher = new AntigravityWatcher({
    client,
    state,
    onEvent: async ev => events.push(ev),
  });

  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // Pure background timer progress update stays silent while notFullyIdle=true
  phase = 'patrol';
  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // Decision question breaks through immediately even though 12m timer keeps notFullyIdle=true
  phase = 'decision';
  await watcher.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'reply');
  assert.equal(events[0].stepIndex, 120);
  assert.match(events[0].text, /请确认/);
});

test('AntigravityWatcher suppresses transient mid-turn tool errors while isTurnRunning is true', async () => {
  const events = [];
  const state = makeMemoryState({ pushMode: 'all', defaultId: 'conv-1' });
  let phase = 'baseline';

  const client = {
    listConversations: () => [
      {
        id: 'conv-12',
        title: 'Review Docs Status',
        isTurnRunning: phase === 'mid_tool_err',
        isRunning: phase === 'mid_tool_err',
        notFullyIdle: phase === 'mid_tool_err',
      },
    ],
    readTranscript: () => {
      if (phase === 'baseline') {
        return {
          exists: true,
          lastAssistantReply: null,
          lastError: null,
          pendingToolCall: null,
          recentTurns: [],
        };
      }
      if (phase === 'mid_tool_err') {
        return {
          exists: true,
          lastAssistantReply: null,
          lastError: {
            stepIndex: 259,
            kind: 'tool',
            message: 'target content not found in the file',
            createdAt: 't1',
          },
          pendingToolCall: null,
          recentTurns: [],
        };
      }
      return {
        exists: true,
        lastAssistantReply: null,
        lastError: {
          stepIndex: 265,
          kind: 'fatal',
          message: 'RESOURCE_EXHAUSTED (code 429)',
          createdAt: 't2',
        },
        pendingToolCall: null,
        recentTurns: [],
      };
    },
  };

  const watcher = new AntigravityWatcher({
    client,
    state,
    onEvent: async ev => events.push(ev),
  });

  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // Mid-turn recoverable edit_file error must NOT be pushed while agent is still running
  phase = 'mid_tool_err';
  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // Real fatal error that stops the turn (!isTurnRunning) IS pushed
  phase = 'fatal_stopped';
  await watcher.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].stepIndex, 265);
  assert.match(events[0].text, /429/);
});

test('AntigravityWatcher merges multiple unpushed substantive replies in the same turn instead of swallowing the main answer', async () => {
  const events = [];
  const state = makeMemoryState({ pushMode: 'all', defaultId: 'conv-1' });
  let phase = 'baseline';

  const client = {
    listConversations: () => [
      {
        id: 'conv-2',
        title: 'Demo Experiment',
        isTurnRunning: false,
        isRunning: true,
        notFullyIdle: true,
      },
    ],
    readTranscript: () => {
      if (phase === 'baseline') {
        return {
          exists: true,
          lastAssistantReply: { stepIndex: 2618, content: 'old', createdAt: 't0' },
          currentTurnReplies: [{ stepIndex: 2618, content: 'old', createdAt: 't0' }],
          lastError: null,
          pendingToolCall: null,
          recentTurns: [],
        };
      }
      return {
        exists: true,
        lastAssistantReply: { stepIndex: 2630, content: '（注：当前任务仍保持正常运行。）', createdAt: 't2' },
        currentTurnReplies: [
          { stepIndex: 2628, content: '分析结论：完整长分析正文。', createdAt: 't1' },
          { stepIndex: 2630, content: '（注：当前任务仍保持正常运行。）', createdAt: 't2' },
        ],
        lastError: null,
        pendingToolCall: null,
        recentTurns: [
          { role: 'assistant', stepIndex: 2628, content: '分析结论：完整长分析正文。', createdAt: 't1' },
          { role: 'assistant', stepIndex: 2630, content: '（注：当前任务仍保持正常运行。）', createdAt: 't2' },
        ],
      };
    },
  };

  const watcher = new AntigravityWatcher({
    client,
    state,
    onEvent: async ev => events.push(ev),
  });

  await watcher.pollOnce();
  assert.equal(events.length, 0);

  phase = 'done';
  await watcher.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].stepIndex, 2630);
  assert.match(events[0].text, /分析结论：完整长分析正文/);
  assert.match(events[0].text, /当前任务仍保持正常运行/);
  assert.equal(state.hasPushedStep('conv-2', 2628), true);
  assert.equal(state.hasPushedStep('conv-2', 2630), true);
});

test('AntigravityWatcher pushes direct answer to explicit USER_INPUT even when it also sets a schedule timer, but suppresses subsequent automated timer patrols', async () => {
  const events = [];
  const state = makeMemoryState({ pushMode: 'all', defaultId: 'conv-1' });
  let phase = 'baseline';

  const client = {
    listConversations: () => [
      {
        id: 'conv-2',
        title: 'Demo Experiment',
        isTurnRunning: false,
        isRunning: true,
        notFullyIdle: true,
      },
    ],
    readTranscript: () => {
      if (phase === 'baseline') {
        return {
          exists: true,
          lastUserInput: { stepIndex: 3200, content: 'old', createdAt: 't0' },
          lastAssistantReply: { stepIndex: 3227, content: 'old reply', createdAt: 't1', afterScheduleTimer: true },
          currentTurnReplies: [{ stepIndex: 3227, content: 'old reply', createdAt: 't1', afterScheduleTimer: true }],
          lastError: null,
          pendingToolCall: null,
          recentTurns: [],
        };
      }
      if (phase === 'user_progress_report') {
        // User explicitly asked "汇报进度" at step 3330; agent checked jobs, set schedule timer, replied at step 3360
        return {
          exists: true,
          lastUserInput: { stepIndex: 3330, content: '汇报进度', createdAt: 't2' },
          lastAssistantReply: { stepIndex: 3360, content: '当前进度汇报：整体运行健康，零故障。', createdAt: 't3', afterScheduleTimer: true },
          currentTurnReplies: [{ stepIndex: 3360, content: '当前进度汇报：整体运行健康，零故障。', createdAt: 't3', afterScheduleTimer: true }],
          lastError: null,
          pendingToolCall: null,
          recentTurns: [],
        };
      }
      // Subsequent automated schedule timer wakeup (no new USER_INPUT) -> suppressed!
      return {
        exists: true,
        lastUserInput: { stepIndex: 3330, content: '汇报进度', createdAt: 't2' },
        lastAssistantReply: { stepIndex: 3390, content: '10 分钟例行定时巡检：仍在稳定训练中。', createdAt: 't4', afterScheduleTimer: true },
        currentTurnReplies: [
          { stepIndex: 3360, content: '当前进度汇报：整体运行健康，零故障。', createdAt: 't3', afterScheduleTimer: true },
          { stepIndex: 3390, content: '10 分钟例行定时巡检：仍在稳定训练中。', createdAt: 't4', afterScheduleTimer: true },
        ],
        lastError: null,
        pendingToolCall: null,
        recentTurns: [],
      };
    },
  };

  const watcher = new AntigravityWatcher({
    client,
    state,
    onEvent: async ev => events.push(ev),
  });

  await watcher.pollOnce();
  assert.equal(events.length, 0);

  // Direct answer to user's "汇报进度" MUST be pushed even though it set a schedule timer
  phase = 'user_progress_report';
  await watcher.pollOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].stepIndex, 3360);
  assert.match(events[0].text, /当前进度汇报/);

  // Later automated timer patrol without a new USER_INPUT stays silent
  phase = 'auto_patrol';
  await watcher.pollOnce();
  assert.equal(events.length, 1);
});
