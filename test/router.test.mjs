import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../lib/state.mjs';
import { FeishuRouter } from '../lib/router.mjs';
import { loadConfig } from '../lib/config.mjs';
import { LarkClient, sanitizeForFeishu, splitMarkdown } from '../lib/lark.mjs';
import { startIpcServer, sendIpcRequest } from '../lib/ipc.mjs';
import { EventEmitter } from 'node:events';

function setupRouter({ pushMode = 'bound', cdp = null, env = { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:12345' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-router-'));
  const state = new StateStore(path.join(dir, 'state.json'), { pushMode });

  const cursorRoutesFile = path.join(dir, 'cursor-routes.json');
  const codexStateFile = path.join(dir, 'codex-state.json');
  const kimiStateFile = path.join(dir, 'kimi-state.json');

  fs.writeFileSync(cursorRoutesFile, JSON.stringify({ om_cursor_1: { chatId: 'c1' } }));
  fs.writeFileSync(codexStateFile, JSON.stringify({ messageRoutes: { om_codex_1: 't1' }, seenMessages: ['om_codex_user_1'] }));
  fs.writeFileSync(kimiStateFile, JSON.stringify({ messageRoutes: { om_kimi_1: 'k1' } }));

  const conversations = [
    { id: 'aaaa1111-0000-0000-0000-000000000001', title: '主工程会话', isRunning: false, workspace: '/tmp/proj-a' },
    { id: 'bbbb2222-0000-0000-0000-000000000002', title: '测试会话', isRunning: true, workspace: '/tmp/proj-b' },
  ];
  state.syncConversations(conversations);
  state.setDefaultConversationId(conversations[0].id);

  const calls = { sentMessages: [], created: [], replies: [] };
  const client = {
    async listConversations() { return conversations; },
    async readTranscript(id) {
      return {
        exists: true,
        recentTurns: [
          { role: 'user', stepIndex: 1, content: `你好 ${id.slice(0, 4)}` },
          { role: 'assistant', stepIndex: 2, content: '已检查完毕' },
        ],
        pendingToolCall: null,
      };
    },
    async sendMessage(id, content) {
      calls.sentMessages.push({ id, content });
      return { ok: true, conversationId: id };
    },
    async createConversation(prompt, opts) {
      calls.created.push({ prompt, opts });
      return { ok: true, conversationId: 'cccc3333-0000-0000-0000-000000000003' };
    },
  };

  const lark = {
    async replyMarkdown(replyToMsgId, text, { onMessageId } = {}) {
      const id = `om_ag_${calls.replies.length + 1}`;
      calls.replies.push({ id, replyToMsgId, text });
      if (onMessageId) await onMessageId(id);
      return id;
    },
  };

  const config = {
    marker: '【AG · Antigravity】',
    feishuOpenId: 'ou_user_1',
    rootDir: dir,
    workdir: '/tmp/default-ws',
  };

  const router = new FeishuRouter({
    config,
    state,
    client,
    cdp,
    lark,
    bridgeFiles: { cursorRoutesFile, codexStateFile, kimiStateFile },
    env,
  });

  return { router, state, calls, conversations };
}

test('ignores unprefixed messages and other bridge prefixes to protect Cursor default fallback', async () => {
  const { router, calls } = setupRouter();

  assert.equal(await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm1', content: '普通消息给Cursor' }), false);
  assert.equal(await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm2', content: '#cx 检查代码' }), false);
  assert.equal(await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm3', content: '@km 状态' }), false);
  assert.equal(await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm4', content: '#cu 状态' }), false);
  assert.equal(calls.replies.length, 0);
  assert.equal(calls.sentMessages.length, 0);
});

test('quote-reply routing obeys reply_to before root_id and excludes other bridges', async () => {
  const { router, state, calls, conversations } = setupRouter();
  state.recordMessageRoute('om_ag_root', conversations[0].id);
  state.recordMessageRoute('om_ag_child', conversations[1].id);

  // Mixed thread: root is Antigravity, direct reply_to is Codex -> must ignore!
  const ignored = await router.handle({
    sender_type: 'user',
    sender_id: 'ou_user_1',
    message_id: 'm_mixed_1',
    reply_to: 'om_codex_1',
    root_id: 'om_ag_root',
    content: '继续Codex任务',
  });
  assert.equal(ignored, false);

  // Direct reply_to Cursor -> must ignore even if root is Antigravity!
  const ignoredCursor = await router.handle({
    sender_type: 'user',
    sender_id: 'ou_user_1',
    message_id: 'm_mixed_2',
    reply_to: 'om_cursor_1',
    root_id: 'om_ag_root',
    content: '继续Cursor任务',
  });
  assert.equal(ignoredCursor, false);

  // Direct reply_to Antigravity child -> routes to child conversation
  const handled = await router.handle({
    sender_type: 'user',
    sender_id: 'ou_user_1',
    message_id: 'm_ag_quote',
    reply_to: 'om_ag_child',
    root_id: 'om_ag_root',
    content: '继续分析测试',
  });
  assert.equal(handled, true);
  assert.equal(calls.sentMessages[0].id, conversations[1].id);
  assert.equal(calls.sentMessages[0].content, '继续分析测试');
});

test('handles #ag, #agy, #antigravity prefixes and all slash/zh shortcuts', async () => {
  const cdpCalls = [];
  const cdp = {
    async isAvailable() { return { available: true }; },
    async clickStop() { cdpCalls.push('stop'); return { ok: true, available: true }; },
    async clickApproval(choice) { cdpCalls.push(choice); return { ok: true, available: true, message: 'Run' }; },
  };
  const { router, state, calls, conversations } = setupRouter({ cdp });

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_help', content: '#ag 帮助' });
  assert.match(calls.replies.at(-1).text, /^【AG · Antigravity】/);

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_ps', content: '@agy 状态' });
  assert.match(calls.replies.at(-1).text, /#1.*主工程会话.*👑 总控/);
  assert.match(calls.replies.at(-1).text, /#2.*测试会话/);

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_master_msg', content: '#ag 统筹一下当前任务' });
  assert.equal(calls.sentMessages.at(-1).id, conversations[0].id);
  assert.match(calls.sentMessages.at(-1).content, /^\[飞书 → Antigravity 总控\]/);
  assert.match(calls.sentMessages.at(-1).content, /ag-ctl\.mjs/);
  assert.match(calls.sentMessages.at(-1).content, /统筹一下当前任务$/);
  assert.match(calls.replies.at(-1).text, /👑 \*\*总控/);

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_read', content: '#ag 读 2' });
  assert.match(calls.replies.at(-1).text, /已检查完毕/);

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_def', content: '#ag 默认 2' });
  assert.equal(state.getDefaultConversationId(), conversations[1].id);

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_push', content: '#antigravity 推送 全量' });
  assert.equal(state.getPushMode(), 'all');

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_new', content: '#ag 新建 ~/work/demo 检查一下' });
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].opts.cwd, path.join(os.homedir(), 'work', 'demo'));
  assert.equal(calls.created[0].prompt, '检查一下');
  assert.equal(state.isBound('cccc3333-0000-0000-0000-000000000003'), true);

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_direct', content: '#ag @1 跑一下单测' });
  assert.equal(calls.sentMessages.at(-1).id, conversations[0].id);
  assert.equal(calls.sentMessages.at(-1).content, '跑一下单测');

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_ok', content: '#ag 允许' });
  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_stop', content: '#ag 停止' });
  assert.deepEqual(cdpCalls, ['approve', 'stop']);
});

test('loadConfig defaults pushMode to all and falls back to cursor .env only for FEISHU_OPEN_ID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cfg-'));
  const localEnv = path.join(dir, '.env');
  const cursorEnv = path.join(dir, 'cursor.env');
  fs.writeFileSync(localEnv, 'AG_MAX_PUSH_LENGTH=6000\n');
  fs.writeFileSync(cursorEnv, 'FEISHU_OPEN_ID=ou_from_cursor\nMASTER_CHAT_ID=should_ignore\n');

  const cfg = loadConfig({}, { envFile: localEnv, fallbackEnvFile: cursorEnv, homeDir: dir });
  assert.equal(cfg.feishuOpenId, 'ou_from_cursor');
  assert.equal(cfg.pushMode, 'all');
  assert.equal(cfg.maxPushLength, 6000);
  assert.equal(cfg.marker, '【AG · Antigravity】');
});

test('IPC server handles half-open client end without write-after-end error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ipc-'));
  const sockPath = path.join(dir, 'bridge.sock');
  const errors = [];
  const ipc = startIpcServer(
    sockPath,
    async req => {
      await new Promise(r => setTimeout(r, 20));
      return { echo: req.command };
    },
    { error: (...args) => errors.push(args.join(' ')) },
  );
  try {
    const res = await sendIpcRequest(sockPath, { command: 'ping' });
    assert.deepEqual(res, { echo: 'ping' });
    assert.equal(errors.length, 0);
  } finally {
    ipc.close();
  }
});

test('LarkClient sanitizes emails, splits long markdown, and retries on 230028', async () => {
  assert.equal(sanitizeForFeishu('contact test@example.com now'), 'contact test[@]example.com now');
  assert.equal(splitMarkdown('a\n'.repeat(300), 250).length > 1, true);

  const spawnedCalls = [];
  const fakeSpawn = (cmd, args) => {
    spawnedCalls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const payloadText = args[args.length - 1];
      if (spawnedCalls.length === 1) {
        child.stderr.emit('data', 'code 230028 sensitive data');
        child.emit('close', 1);
      } else {
        child.stdout.emit('data', JSON.stringify({ ok: true, data: { message_id: 'om_retry_ok' } }));
        child.emit('close', 0);
      }
      assert.ok(payloadText);
    });
    return child;
  };

  const lark = new LarkClient({ larkCli: 'lark-cli', feishuOpenId: 'ou_1', maxPushLength: 4000 }, { spawnFn: fakeSpawn });
  const msgId = await lark.sendMarkdown('ping @user and a@b.com');
  assert.equal(msgId, 'om_retry_ok');
  assert.equal(spawnedCalls.length, 2);
  assert.match(spawnedCalls[1].args.at(-1), /\[at\]/);
});

test('unconfigured default conversation selects first top-level session instead of subagents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-top-def-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const allConvs = [
    { id: 'sub-0001', title: 'Swarm Worker', nestingDepth: 1, parentId: 'top-0001', isRunning: true },
    { id: 'top-0001', title: 'Main Desktop', nestingDepth: 0, parentId: '', isRunning: false },
  ];
  const sent = [];
  const replies = [];
  const router = new FeishuRouter({
    config: { marker: '【AG · Antigravity】', feishuOpenId: 'ou_1', rootDir: dir, workdir: dir },
    state,
    client: {
      async listConversations({ includeSubagents = false } = {}) {
        return includeSubagents ? allConvs : allConvs.filter(c => !c.nestingDepth && !c.parentId);
      },
      async sendMessage(id, content) {
        sent.push({ id, content });
        return { ok: true, conversationId: id };
      },
    },
    lark: {
      async replyMarkdown(replyTo, text, { onMessageId } = {}) {
        const id = `om_${replies.length + 1}`;
        replies.push({ replyTo, text });
        if (onMessageId) await onMessageId(id);
        return id;
      },
    },
    bridgeFiles: {},
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:12345' },
  });

  await router.handle({ sender_type: 'user', sender_id: 'ou_1', message_id: 'm_top_1', content: '#ag 检查状态' });
  assert.equal(sent[0].id, 'top-0001');
  assert.equal(state.getSeq('top-0001'), 1);

  await router.handle({ sender_type: 'user', sender_id: 'ou_1', message_id: 'm_sub_1', content: '#ag @sub-0001 汇报进度' });
  assert.equal(sent[1].id, 'sub-0001');
  assert.equal(state.getSeq('sub-0001'), 2);
});

test('external LaunchAgent without ANTIGRAVITY_LS_ADDRESS routes via CDP and returns friendly hint when 9223 is off', async () => {
  const cdpCalls = [];
  let cdpAvailable = true;
  const cdp = {
    async sendMessage(conv, content) {
      cdpCalls.push({ kind: 'send', conv, content });
      if (!cdpAvailable) return { ok: false, available: false };
      return { ok: true, available: true, switched: 'already_active' };
    },
    async createConversation(prompt) {
      cdpCalls.push({ kind: 'new', prompt });
      if (!cdpAvailable) return { ok: false, available: false };
      return { ok: true, available: true, created: true };
    },
  };

  const { router, calls, conversations } = setupRouter({ cdp, env: {} });

  // 1. Without ANTIGRAVITY_LS_ADDRESS and CDP up: routes to cdp.sendMessage / cdp.createConversation
  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_cdp_1', content: '#ag @2 用CDP发消息' });
  assert.equal(calls.sentMessages.length, 0);
  assert.equal(cdpCalls.length, 1);
  assert.equal(cdpCalls[0].conv.id, conversations[1].id);
  assert.equal(cdpCalls[0].content, '用CDP发消息');
  assert.match(calls.replies.at(-1).text, /已发给 \*\*#2 测试会话\*\*/);

  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_cdp_new', content: '#ag 新建 用CDP新建对话' });
  assert.equal(calls.created.length, 0);
  assert.equal(cdpCalls.length, 2);
  assert.equal(cdpCalls[1].prompt, '用CDP新建对话');

  // 2. When CDP :9223 is not open: returns friendly #ag 重启cdp & start-antigravity.sh prompt
  cdpAvailable = false;
  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_cdp_off', content: '#ag 此时9223未开' });
  assert.match(calls.replies.at(-1).text, /#ag 重启cdp/);
  assert.match(calls.replies.at(-1).text, /start-antigravity\.sh/);
  assert.doesNotMatch(calls.replies.at(-1).text, /ANTIGRAVITY_LS_ADDRESS/);
});

test('handles #ag 重启cdp when CDP is already online or needs relaunch', async () => {
  let cdpOnline = true;
  let relaunchCount = 0;
  const cdp = {
    async isAvailable() {
      return cdpOnline ? { available: true, targets: [{ id: 'p1' }] } : { available: false };
    },
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-relaunch-test-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const replies = [];
  const router = new FeishuRouter({
    config: { marker: '【AG · Antigravity】', feishuOpenId: 'ou_user_1', rootDir: dir, workdir: dir },
    state,
    client: { async listConversations() { return []; } },
    cdp,
    lark: {
      async replyMarkdown(replyTo, text) {
        replies.push({ replyTo, text });
        return `om_${replies.length}`;
      },
    },
    bridgeFiles: {},
    relaunchAntigravity: async () => {
      relaunchCount++;
      cdpOnline = true;
      return { ok: true };
    },
    relaunchPollMs: 0,
    relaunchTimeoutMs: 100,
  });

  // Already online -> no relaunch
  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_r1', content: '#ag 重启cdp' });
  assert.equal(relaunchCount, 0);
  assert.match(replies.at(-1).text, /当前已在线，无需重启/);

  // Offline -> triggers relaunch and confirms ready
  cdpOnline = false;
  await router.handle({ sender_type: 'user', sender_id: 'ou_user_1', message_id: 'm_r2', content: '#ag 重启cdp' });
  assert.equal(relaunchCount, 1);
  assert.match(replies.at(-2).text, /正在后台重启 Antigravity/);
  assert.match(replies.at(-1).text, /已恢复就绪/);
});
