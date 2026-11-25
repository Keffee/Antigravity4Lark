#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { StateStore } from './lib/state.mjs';
import { LarkClient } from './lib/lark.mjs';
import { FeishuRouter, CDP_SETUP_HINT } from './lib/router.mjs';
import { startIpcServer } from './lib/ipc.mjs';
import { createAntigravityClient } from './lib/antigravity.mjs';
import { createCdpClient } from './lib/cdp.mjs';
import { AntigravityWatcher } from './lib/watcher.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const state = new StateStore(config.stateFile, {
  defaultConversationId: config.defaultConversationId,
  pushMode: config.pushMode,
});

const client = createAntigravityClient(config);
const cdp = createCdpClient(config);
const lark = new LarkClient(config);
const router = new FeishuRouter({ config, state, client, cdp, lark });

function formatEventMessage(ev) {
  const conv = ev.conversation || {};
  const seq = conv.seq || state.assignSeq(conv.id) || '?';
  const title = conv.title || conv.id || '未命名会话';
  const defaultId = state.getDefaultConversationId();
  const isMaster = Boolean(conv.id && (defaultId ? conv.id === defaultId : seq === 1));
  const roleLabel = isMaster ? `👑 总控 (#${seq})` : `会话 #${seq}`;
  const footer = `引用本条回复可继续；发送 \`#ag @${seq} 内容\` 可直达。`;

  if (ev.type === 'error') {
    return `${config.marker} **${roleLabel} 执行异常 · ${title}**\n\n${ev.text || '执行过程中发生错误'}\n\n---\n${footer}`;
  }
  if (ev.type === 'waiting') {
    const btns = Array.isArray(ev.buttons) && ev.buttons.length
      ? `\n\n⏳ **可点按钮**：${ev.buttons.map((b, i) => `\`[${i + 1}] ${b.label || b}\``).join(' ')}`
      : '';
    const actionTip = Array.isArray(ev.buttons) && ev.buttons.length
      ? '引用本条回复 `允许` 或 `拒绝` 即可操作；也可在桌面端处理。'
      : '如已开启 CDP (:9223) 可引用回复 `允许`/`拒绝`，或在桌面端确认。';
    return `${config.marker} **${roleLabel} 等待确认 · ${title}**\n\n${ev.text || '检测到会话可能正在等待确认'}${btns}\n\n---\n${actionTip}`;
  }

  const replyHead = isMaster ? `👑 总控 (#${seq}) 回复` : `🔔 会话 #${seq} 回复`;
  return `${config.marker} **${replyHead} · ${title}**\n\n${ev.text || '（本轮已完成）'}\n\n---\n${footer}`;
}

const watcher = new AntigravityWatcher({
  client,
  cdp,
  state,
  config,
  onEvent: async ev => {
    const conv = ev.conversation;
    if (!conv?.id) return;
    if (ev.type === 'error' || ev.type === 'waiting') {
      state.data.lastAlertConversationId = conv.id;
      state.save();
    }
    const text = formatEventMessage(ev);
    await lark.sendMarkdown(text, {
      onMessageId: msgId => state.recordMessageRoute(msgId, conv.id),
    });
    console.log(`[主动推送] #${conv.seq || state.getSeq(conv.id)} (${ev.type}) step=${ev.stepIndex}`);
  },
});

async function resolveSession(ref) {
  const topLevel = state.syncConversations(await client.listConversations({ includeSubagents: false }));
  const hit = state.resolveRef(ref, topLevel);
  if (hit || !String(ref || '').trim()) {
    return hit;
  }
  const all = state.syncConversations(await client.listConversations({ includeSubagents: true }));
  return state.resolveRef(ref, all);
}

const ipc = startIpcServer(config.sockPath, async req => {
  const cmd = req.command;
  if (cmd === 'list') {
    const list = await client.listConversations({ includeSubagents: Boolean(req.all) });
    return state.syncConversations(list);
  }
  if (cmd === 'read') {
    const conv = await resolveSession(req.ref);
    if (!conv) throw new Error(`找不到会话: ${req.ref}`);
    const transcript = await client.readTranscript(conv.id);
    return { conversation: conv, transcript };
  }
  if (cmd === 'new') {
    const hasLs = Boolean(String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim());
    const res = hasLs
      ? await client.createConversation(req.prompt, { cwd: req.dir || config.workdir, model: req.model })
      : await cdp.createConversation(req.prompt);
    if (!res.ok) {
      throw new Error(res.available === false ? CDP_SETUP_HINT : (res.error || res.stderr || '创建会话失败'));
    }
    let seq = null;
    if (res.conversationId) {
      seq = state.assignSeq(res.conversationId);
      state.bindConversation(res.conversationId);
    }
    return { ...res, seq };
  }
  if (cmd === 'send') {
    const conv = await resolveSession(req.ref);
    if (!conv) throw new Error(`找不到会话: ${req.ref}`);
    const seq = conv.seq || state.assignSeq(conv.id);
    state.bindConversation(conv.id);
    const hasLs = Boolean(String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim());
    const res = hasLs
      ? await client.sendMessage(conv.id, req.prompt)
      : await cdp.sendMessage(conv, req.prompt);
    if (!res.ok) {
      throw new Error(res.available === false ? CDP_SETUP_HINT : (res.error || res.stderr || '发送失败'));
    }
    return { ...res, seq, title: conv.title || conv.id };
  }
  if (cmd === 'bind') {
    if (!req.id) throw new Error('bind 需要会话 ID');
    const seq = state.assignSeq(req.id);
    state.bindConversation(req.id);
    return { id: req.id, seq };
  }
  if (cmd === 'cdpInspect') {
    return cdp.inspectDom();
  }
  if (cmd === 'default') {
    if (!req.ref) {
      const conv = await resolveSession('');
      if (!conv) throw new Error('当前没有可用默认会话');
      return conv;
    }
    const conv = await resolveSession(req.ref);
    if (!conv) throw new Error(`找不到会话: ${req.ref}`);
    state.setDefaultConversationId(conv.id);
    state.bindConversation(conv.id);
    return conv;
  }
  if (cmd === 'status') {
    const health = await client.healthCheck();
    const cdpStatus = await cdp.isAvailable().catch(() => ({ available: false }));
    return {
      health,
      cdp: cdpStatus,
      pushMode: state.getPushMode(),
      defaultConversationId: state.getDefaultConversationId(),
    };
  }
  if (cmd === 'stop') {
    return cdp.clickStop();
  }
  if (cmd === 'click') {
    return cdp.clickApproval(req.choice || 'approve');
  }
  throw new Error(`未知 IPC 指令: ${cmd}`);
});

const watchedFiles = [
  path.join(rootDir, '.env'),
  path.join(rootDir, 'feishu.mjs'),
  path.join(rootDir, 'ag-ctl.mjs'),
  path.join(rootDir, 'lib', 'config.mjs'),
  path.join(rootDir, 'lib', 'state.mjs'),
  path.join(rootDir, 'lib', 'lark.mjs'),
  path.join(rootDir, 'lib', 'router.mjs'),
  path.join(rootDir, 'lib', 'ipc.mjs'),
  path.join(rootDir, 'lib', 'antigravity.mjs'),
  path.join(rootDir, 'lib', 'cdp.mjs'),
  path.join(rootDir, 'lib', 'watcher.mjs'),
];

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const file of watchedFiles) fs.unwatchFile(file);
  watcher.stop();
  lark.stopConsumer();
  ipc.close();
  process.exit(exitCode);
}

for (const file of watchedFiles) {
  fs.watchFile(file, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      console.log(`[热重载] 检测到 ${path.basename(file)} 变更，退出等待服务管理器重启…`);
      shutdown(0);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`== Antigravity4Lark 启动：仅接收 #ag/@ag/#agy/#antigravity 或引用 ${config.marker} 的消息 ==`);
console.log(`数据库：${config.dbPath}；推送模式：${state.getPushMode()}；CDP：${config.cdpUrl}`);
if (!config.feishuOpenId) {
  console.warn('⚠️ 未配置 FEISHU_OPEN_ID；给机器人发送一条 #ag 消息可在日志查看你的 open_id');
}

await watcher.start();
if (config.dryRun) {
  console.log('干跑模式 (AG_DRY_RUN=1)：不启动 lark-cli 事件消费');
} else {
  lark.startConsumer(event => router.handle(event));
}
