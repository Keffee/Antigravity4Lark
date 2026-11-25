#!/usr/bin/env node
import { loadConfig } from './lib/config.mjs';
import { StateStore } from './lib/state.mjs';
import { sendIpcRequest } from './lib/ipc.mjs';
import { createAntigravityClient } from './lib/antigravity.mjs';
import { createCdpClient } from './lib/cdp.mjs';

const config = loadConfig();
const args = process.argv.slice(2);
const hasJson = args.includes('--json');
const hasAll = args.includes('--all');

function cleanFlags(rawArgs) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const a = rawArgs[i];
    if (a === '--json' || a === '--all') continue;
    if ((a === '--dir' || a === '--model') && i + 1 < rawArgs.length) {
      flags[a.slice(2)] = rawArgs[++i];
      continue;
    }
    if (a.startsWith('--dir=') || a.startsWith('--model=')) {
      const [k, ...rest] = a.slice(2).split('=');
      flags[k] = rest.join('=');
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

async function callDaemonOrFallback(payload, fallbackFn) {
  try {
    return await sendIpcRequest(config.sockPath, payload, { timeoutMs: 15000 });
  } catch {
    return fallbackFn();
  }
}

function makeFallbackContext() {
  const state = new StateStore(config.stateFile, {
    defaultConversationId: config.defaultConversationId,
    pushMode: config.pushMode,
  });
  const client = createAntigravityClient(config);
  const cdp = createCdpClient(config);
  return { state, client, cdp };
}

async function resolveSessionFallback(state, client, ref) {
  const topLevel = state.syncConversations(await client.listConversations({ includeSubagents: false }));
  const hit = state.resolveRef(ref, topLevel);
  if (hit || !String(ref || '').trim()) {
    return hit;
  }
  const all = state.syncConversations(await client.listConversations({ includeSubagents: true }));
  return state.resolveRef(ref, all);
}

const { positional, flags } = cleanFlags(args);
const [command = 'list', ...rest] = positional;

try {
  if (command === 'list') {
    const list = await callDaemonOrFallback({ command: 'list', all: hasAll }, async () => {
      const { state, client } = makeFallbackContext();
      const raw = await client.listConversations({ includeSubagents: hasAll });
      return state.syncConversations(raw);
    });
    if (hasJson) {
      console.log(JSON.stringify(list, null, 2));
    } else {
      const state = new StateStore(config.stateFile, { defaultConversationId: config.defaultConversationId });
      const defId = state.getDefaultConversationId();
      for (const c of list) {
        const badge = c.isRunning ? 'RUNNING' : 'IDLE';
        const isMaster = defId ? c.id === defId : c.seq === 1;
        const defTag = isMaster ? ', 👑 总控' : '';
        console.log(`#${c.seq} [${badge}] ${c.title || c.id} (id=${c.id.slice(0, 8)}${defTag})`);
        if (c.workspace) console.log(`  ${c.workspace}`);
      }
      if (!list.length) console.log('（暂无会话）');
    }
  } else if (command === 'read') {
    const ref = rest[0];
    if (!ref) throw new Error('用法: node ag-ctl.mjs read <编号或会话ID> [--json]');
    const data = await callDaemonOrFallback({ command: 'read', ref }, async () => {
      const { state, client } = makeFallbackContext();
      const conv = await resolveSessionFallback(state, client, ref);
      if (!conv) throw new Error(`找不到会话: ${ref}`);
      const transcript = await client.readTranscript(conv.id);
      return { conversation: conv, transcript };
    });
    if (hasJson) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`#${data.conversation.seq || '?'} ${data.conversation.title || data.conversation.id}`);
      for (const t of data.transcript.recentTurns || []) {
        console.log(`\n[${t.role} step=${t.stepIndex}]\n${t.content}`);
      }
    }
  } else if (command === 'new') {
    const prompt = rest.join(' ').trim();
    if (!prompt) throw new Error('用法: node ag-ctl.mjs new [--dir <目录>] [--model <模型>] <初始消息>');
    const hasLocalLs = Boolean(String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim());
    let res;
    if (hasLocalLs) {
      const { state, client } = makeFallbackContext();
      const created = await client.createConversation(prompt, {
        cwd: flags.dir || config.workdir,
        model: flags.model,
      });
      if (!created.ok) throw new Error(created.error || created.stderr || '创建失败');
      let seq = null;
      if (created.conversationId) {
        const bound = await sendIpcRequest(config.sockPath, { command: 'bind', id: created.conversationId }).catch(() => null);
        seq = bound?.seq || state.assignSeq(created.conversationId);
        if (!bound) state.bindConversation(created.conversationId);
      }
      res = { ...created, seq };
    } else {
      res = await callDaemonOrFallback(
        { command: 'new', dir: flags.dir, model: flags.model, prompt },
        async () => {
          const { cdp } = makeFallbackContext();
          const created = await cdp.createConversation(prompt);
          if (!created.ok) throw new Error(created.error || '创建失败');
          return created;
        },
      );
    }
    console.log(hasJson ? JSON.stringify(res, null, 2) : `已创建会话${res.seq ? ` #${res.seq}` : ''} (${res.conversationId || '已提交'})`);
  } else if (command === 'send') {
    const [ref, ...msgParts] = rest;
    const message = msgParts.join(' ').trim();
    if (!ref || !message) throw new Error('用法: node ag-ctl.mjs send <编号或会话ID> <消息>');
    const hasLocalLs = Boolean(String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim());
    let res;
    if (hasLocalLs) {
      const { state, client, cdp } = makeFallbackContext();
      const conv = await resolveSessionFallback(state, client, ref);
      if (!conv) throw new Error(`找不到会话: ${ref}`);
      let out = await client.sendMessage(conv.id, message);
      if (!out.ok && /PermissionDenied|does not match target project_id/i.test(String(out.error || out.stderr || ''))) {
        const cdpOut = await callDaemonOrFallback({ command: 'send', ref, prompt: message }, async () => {
          const sent = await cdp.sendMessage(conv, message);
          if (!sent.ok) throw new Error(sent.error || 'CDP 发送失败');
          return { ...sent, seq: conv.seq || state.assignSeq(conv.id), title: conv.title || conv.id };
        });
        out = { ok: true, ...cdpOut };
      }
      if (!out.ok) throw new Error(out.error || out.stderr || '发送失败');
      const bound = await sendIpcRequest(config.sockPath, { command: 'bind', id: conv.id }).catch(() => null);
      const seq = out.seq || bound?.seq || conv.seq || state.assignSeq(conv.id);
      if (!bound) state.bindConversation(conv.id);
      res = { ...out, seq, title: conv.title || conv.id };
    } else {
      res = await callDaemonOrFallback({ command: 'send', ref, prompt: message }, async () => {
        const { state, client, cdp } = makeFallbackContext();
        const conv = await resolveSessionFallback(state, client, ref);
        if (!conv) throw new Error(`找不到会话: ${ref}`);
        const seq = conv.seq || state.assignSeq(conv.id);
        state.bindConversation(conv.id);
        const out = await cdp.sendMessage(conv, message);
        if (!out.ok) throw new Error(out.error || '发送失败');
        return { ...out, seq, title: conv.title || conv.id };
      });
    }
    console.log(hasJson ? JSON.stringify(res, null, 2) : `已发送给 #${res.seq} (${res.title})`);
  } else if (command === 'default') {
    const ref = rest[0] || '';
    const conv = await callDaemonOrFallback({ command: 'default', ref }, async () => {
      const { state, client } = makeFallbackContext();
      const target = await resolveSessionFallback(state, client, ref);
      if (!target) throw new Error(ref ? `找不到会话: ${ref}` : '当前没有可用默认会话');
      if (ref) {
        state.setDefaultConversationId(target.id);
        state.bindConversation(target.id);
      }
      return target;
    });
    if (!conv) throw new Error('当前没有可用默认会话');
    console.log(hasJson ? JSON.stringify(conv, null, 2) : `默认会话: #${conv.seq || '?'} ${conv.title || conv.id}`);
  } else if (command === 'status') {
    const data = await callDaemonOrFallback({ command: 'status' }, async () => {
      const { state, client, cdp } = makeFallbackContext();
      return {
        health: await client.healthCheck(),
        cdp: await cdp.isAvailable().catch(() => ({ available: false })),
        pushMode: state.getPushMode(),
        defaultConversationId: state.getDefaultConversationId(),
      };
    });
    console.log(JSON.stringify(data, null, 2));
  } else if (command === 'stop') {
    const res = await callDaemonOrFallback({ command: 'stop' }, async () => {
      const { cdp } = makeFallbackContext();
      return cdp.clickStop();
    });
    console.log(hasJson ? JSON.stringify(res, null, 2) : (res.ok ? '已触发停止生成' : `未执行停止: ${res.message || 'CDP 未开启'}`));
  } else if (command === 'click') {
    const choice = rest[0] || 'approve';
    const res = await callDaemonOrFallback({ command: 'click', choice }, async () => {
      const { cdp } = makeFallbackContext();
      return cdp.clickApproval(choice);
    });
    console.log(hasJson ? JSON.stringify(res, null, 2) : (res.ok ? `已点击按钮 (${res.message || choice})` : `未点击按钮: ${res.message || 'CDP 未开启'}`));
  } else if (command === 'inspect-cdp') {
    const res = await callDaemonOrFallback({ command: 'cdpInspect' }, async () => {
      const { cdp } = makeFallbackContext();
      return cdp.inspectDom();
    });
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log('用法: node ag-ctl.mjs <list|read|new|send|default|status|stop|click|inspect-cdp> [参数...]');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
