import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MARKER } from './config.mjs';

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const AG_PREFIX_RE = /^[#@](?:ag|agy|antigravity)(?:\s+|$)/i;
const OTHER_BRIDGE_PREFIX_RE = /^[#@](?:cu|cursor|cx|codex|km|kimi)(?:\s|[@#:]|$)/i;
export const CDP_SETUP_HINT =
  'CDP 调试端口（9223）未开启：请直接在飞书回复 `#ag 重启cdp` 一键重启开启，或在项目目录运行 ./start-antigravity.sh。';

/**
 * Check if a Feishu message_id belongs to Cursor, Codex, or Kimi bridges.
 */
export function isOwnedByOtherBridge(messageId, bridgeFiles = {}) {
  if (!messageId) return false;

  if (bridgeFiles.cursorRoutesFile) {
    try {
      const cursor = JSON.parse(fs.readFileSync(bridgeFiles.cursorRoutesFile, 'utf8'));
      if (cursor && Object.prototype.hasOwnProperty.call(cursor, messageId)) return true;
    } catch {}
  }

  for (const stateFile of [bridgeFiles.codexStateFile, bridgeFiles.kimiStateFile]) {
    if (!stateFile) continue;
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (data?.messageRoutes && Object.prototype.hasOwnProperty.call(data.messageRoutes, messageId)) {
        return true;
      }
      if (Array.isArray(data?.seenMessages) && data.seenMessages.includes(messageId)) {
        return true;
      }
    } catch {}
  }

  return false;
}

export function formatHelpText(ctlPath = 'ag-ctl.mjs') {
  return [
    `${MARKER} **飞书控制 Antigravity 指南**`,
    '',
    '- `#ag 你的任务`：发给当前默认会话（可用 `#ag 默认 N` 切换）',
    '- `#ag @2 你的任务` 或 `#ag #2 你的任务`：直达 `#2` 会话',
    '- **左滑引用回复** Antigravity 回推消息：直接继续对应会话',
    '- `#ag 状态` / `#ag list` / `#ag ps`：查看全部顶层会话编号与运行状态',
    '- `#ag 读 2` / `#ag 查看 2`：查看 `#2` 最近完整对话内容',
    '- `#ag 新建 [目录] [初始任务]`：创建新会话并可选提交首个任务',
    '- `#ag 默认 N`：将 `#N` 设为默认会话',
    '- `#ag 推送 [全量|仅绑定|关]`：查看或切换主动推送范围（默认全量）',
    '- `#ag 重启cdp` / `#ag relaunch`：一键重启 Antigravity 桌面端并开启 CDP (`:9223`)',
    '- `#ag 停止 [N]` / `允许` / `拒绝`：通过可选 CDP (`:9223`) 触发停止或审批点击',
    '',
    `本地或主控可执行 \`node ${ctlPath} list|read|send|new|default|stop|click\`。`,
  ].join('\n');
}

function expandHomeDir(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function formatPushModeLabel(mode) {
  if (mode === 'all') return '全量 (`all`)';
  if (mode === 'off') return '关闭 (`off`)';
  return '仅绑定 (`bound`)';
}

function shortenWorkspace(uriOrPath) {
  if (!uriOrPath) return '';
  const cleaned = String(uriOrPath).replace(/^file:\/\//, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length ? parts.slice(-2).join('/') : cleaned;
}

/**
 * Feishu / Lark message router for Antigravity bridge.
 * Strictly obeys multi-bridge coexistence rules when sharing a single Lark bot:
 * - Only accepts #ag/@ag/#agy/#antigravity prefix or quote-replies owned by Antigravity.
 * - Never intercepts unprefixed/unquoted messages (leaving room for a default fallback bridge).
 * - Checks direct reply_to ownership before falling back to root_id.
 */
export class FeishuRouter {
  constructor({
    config,
    state,
    client,
    cdp = null,
    lark,
    bridgeFiles = null,
    env = process.env,
    logger = console,
    relaunchAntigravity = null,
    relaunchPollMs = 1500,
    relaunchTimeoutMs = 25000,
  }) {
    this.config = config;
    this.state = state;
    this.client = client;
    this.cdp = cdp;
    this.lark = lark;
    this.bridgeFiles = bridgeFiles || config.bridgeFiles || {};
    this.env = env || {};
    this.logger = logger;
    this.relaunchAntigravity = relaunchAntigravity;
    this.relaunchPollMs = relaunchPollMs;
    this.relaunchTimeoutMs = relaunchTimeoutMs;
  }

  async runRelaunchScript() {
    if (typeof this.relaunchAntigravity === 'function') {
      return this.relaunchAntigravity();
    }
    const scriptPath = path.join(this.config.rootDir || '.', 'start-antigravity.sh');
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`找不到重启脚本: ${scriptPath}`);
    }
    await execFileAsync('/bin/bash', [scriptPath], { timeout: 15000 });
    return { ok: true };
  }

  hasLsAddress() {
    return Boolean(String(this.env?.ANTIGRAVITY_LS_ADDRESS || '').trim());
  }

  async dispatchMessage(conv, content) {
    if (this.hasLsAddress() && this.client?.sendMessage) {
      const res = await this.client.sendMessage(conv.id, content);
      if (res.ok) return res;
      if (!/ANTIGRAVITY_LS_ADDRESS/i.test(res.error || res.stderr || '') || !this.cdp?.sendMessage) {
        return res;
      }
    }
    if (!this.cdp?.sendMessage) {
      return { ok: false, available: false, error: CDP_SETUP_HINT };
    }
    const res = await this.cdp.sendMessage(conv, content);
    if (!res.ok && res.available === false) {
      return { ...res, error: CDP_SETUP_HINT };
    }
    return res;
  }

  async dispatchNewConversation(prompt, { cwd } = {}) {
    if (this.hasLsAddress() && this.client?.createConversation) {
      const res = await this.client.createConversation(prompt, { cwd });
      if (res.ok) return res;
      if (!/ANTIGRAVITY_LS_ADDRESS/i.test(res.error || res.stderr || '') || !this.cdp?.createConversation) {
        return res;
      }
    }
    if (!this.cdp?.createConversation) {
      return { ok: false, available: false, error: CDP_SETUP_HINT };
    }
    const res = await this.cdp.createConversation(prompt);
    if (!res.ok && res.available === false) {
      return { ...res, error: CDP_SETUP_HINT };
    }
    return res;
  }

  async reply(replyToMsgId, body, conversationId = null) {
    const text = body.startsWith(MARKER) ? body : `${MARKER} ${body}`;
    const routeTarget = conversationId || this.state.getDefaultConversationId() || null;
    try {
      await this.lark.replyMarkdown(replyToMsgId, text, {
        onMessageId: msgId => {
          if (msgId && routeTarget) {
            this.state.recordMessageRoute(msgId, routeTarget);
          }
        },
      });
      return true;
    } catch (err) {
      this.logger.error?.('[飞书回复失败]', err.message);
      return false;
    }
  }

  async listSyncedConversations({ includeSubagents = false } = {}) {
    const list = await this.client.listConversations({ includeSubagents });
    return this.state.syncConversations(list);
  }

  async resolveConversation(ref) {
    const topLevel = await this.listSyncedConversations({ includeSubagents: false });
    const hit = this.state.resolveRef(ref, topLevel);
    if (hit || !String(ref || '').trim()) {
      return hit;
    }
    const all = await this.listSyncedConversations({ includeSubagents: true });
    return this.state.resolveRef(ref, all);
  }

  buildMasterPrefix() {
    const ctlPath = path.join(this.config.rootDir || '.', 'ag-ctl.mjs');
    return `[飞书 → Antigravity 总控]\n（如需查看、读取或调度其他 Antigravity 会话，可直接运行 \`node ${ctlPath} <list|read|send|new|status>\`）\n\n`;
  }

  async handle(event) {
    if (!event || event.sender_type !== 'user' || !event.message_id) return false;
    if (!this.config.feishuOpenId) {
      this.logger.log?.(`[提示] 收到用户消息，请在 .env 配置 FEISHU_OPEN_ID=${event.sender_id}`);
      return false;
    }
    if (event.sender_id !== this.config.feishuOpenId) return false;

    const rawText = String(event.content || '').trim();
    if (!rawText) return false;

    if (OTHER_BRIDGE_PREFIX_RE.test(rawText)) {
      return false;
    }

    const prefixMatch = AG_PREFIX_RE.exec(rawText);
    const quotedId =
      this.state.routeMessage(event.reply_to) ||
      (!isOwnedByOtherBridge(event.reply_to, this.bridgeFiles)
        ? this.state.routeMessage(event.root_id)
        : null);

    if (!prefixMatch && !quotedId) {
      return false;
    }

    if (this.state.hasSeenMessage(event.message_id)) {
      return false;
    }
    this.state.markSeenMessage(event.message_id);

    const content = prefixMatch ? rawText.slice(prefixMatch[0].length).trim() : rawText;

    // 1. Help
    if (!content || /^(?:帮助|\/help|\?)$/i.test(content)) {
      const ctlPath = path.join(this.config.rootDir || '.', 'ag-ctl.mjs');
      await this.reply(event.message_id, `\n\n${formatHelpText(ctlPath).slice(MARKER.length).trim()}`, quotedId);
      return true;
    }

    // 2. Status / List
    if (/^(?:状态|进程|list|ps|\/ps|\/status)$/i.test(content)) {
      const list = await this.listSyncedConversations();
      const defaultId = this.state.getDefaultConversationId();
      const rows = list.map(conv => {
        const badge = conv.isRunning ? '🔄 运行中' : '✅ 空闲';
        const isDef = defaultId ? conv.id === defaultId : list[0]?.id === conv.id;
        const defTag = isDef ? ' 👈 **👑 总控**' : '';
        const ws = shortenWorkspace(conv.workspace || conv.workspaceUris?.[0]);
        const wsTag = ws ? ` · \`${ws}\`` : '';
        return `**#${conv.seq}** ${badge} ${conv.title || conv.id}${wsTag}${defTag}`;
      });
      const pushLabel = formatPushModeLabel(this.state.getPushMode());
      const cdpInfo = this.cdp ? await this.cdp.isAvailable().catch(() => ({ available: false })) : { available: false };
      const cdpLabel = cdpInfo.available ? '🟢 已连接' : '⚪ 未开启';
      await this.reply(
        event.message_id,
        `**会话状态**（推送：${pushLabel} ｜ CDP：${cdpLabel}）\n\n${rows.join('\n') || '暂无桌面会话'}`,
        quotedId,
      );
      return true;
    }

    // 3. Read conversation transcript
    let match = /^(?:读|查看|\/read)\s*[#@]?([a-zA-Z0-9_-]+)$/i.exec(content);
    if (match) {
      const conv = await this.resolveConversation(match[1]);
      if (!conv) {
        await this.reply(event.message_id, `找不到编号或会话 \`${match[1]}\`，请发送 \`#ag 状态\` 查看列表。`);
        return true;
      }
      const tr = await this.client.readTranscript(conv.id, { maxTurns: 6 });
      if (!tr.exists) {
        await this.reply(event.message_id, `**#${conv.seq} ${conv.title || conv.id}** 暂无本地对话记录。`, conv.id);
        return true;
      }
      const turns = (tr.recentTurns || []).slice(-6).map(t => {
        const roleLabel = t.role === 'user' ? '🧑 你' : t.role === 'error' ? '⚠️ 错误' : '🤖 Antigravity';
        return `**${roleLabel}**：\n${String(t.content || '').slice(0, 1000)}`;
      });
      const pendingNote = tr.pendingToolCall
        ? `\n\n⏳ *检测到待处理工具调用：\`${tr.pendingToolCall.name}\`*`
        : '';
      await this.reply(
        event.message_id,
        `**#${conv.seq} ${conv.title || conv.id} 最近内容**\n\n${turns.join('\n\n---\n\n') || '（暂无文字内容）'}${pendingNote}\n\n---\n引用本条回复可继续；发送 \`#ag @${conv.seq} 内容\` 可直达。`,
        conv.id,
      );
      return true;
    }

    // 4. Set / view default conversation
    match = /^(?:默认|\/default)(?:\s*[#@]?([a-zA-Z0-9_-]+))?$/i.exec(content);
    if (match) {
      if (!match[1]) {
        const current = await this.resolveConversation('');
        if (!current) {
          await this.reply(event.message_id, '当前没有可用默认会话，请先发送 `#ag 状态` 或 `#ag 新建`。');
        } else {
          await this.reply(
            event.message_id,
            `当前默认会话：**#${current.seq} ${current.title || current.id}**`,
            current.id,
          );
        }
        return true;
      }
      const conv = await this.resolveConversation(match[1]);
      if (!conv) {
        await this.reply(event.message_id, `找不到会话 \`${match[1]}\`，无法设为默认。`);
        return true;
      }
      this.state.setDefaultConversationId(conv.id);
      this.state.bindConversation(conv.id);
      await this.reply(
        event.message_id,
        `已将 **#${conv.seq} ${conv.title || conv.id}** 设为默认会话；后续 \`#ag 你的任务\` 将直接发往该会话。`,
        conv.id,
      );
      return true;
    }

    // 5. Push mode switch
    match = /^(?:推送|\/push)(?:\s+(全量|all|仅绑定|绑定|bound|关|关闭|off))?$/i.exec(content);
    if (match) {
      if (!match[1]) {
        await this.reply(
          event.message_id,
          `当前推送模式：${formatPushModeLabel(this.state.getPushMode())}\n可选：\`#ag 推送 全量\` / \`#ag 推送 仅绑定\` / \`#ag 推送 关\``,
          quotedId,
        );
        return true;
      }
      const arg = match[1].toLowerCase();
      const targetMode =
        arg === '全量' || arg === 'all' ? 'all'
          : arg === '关' || arg === '关闭' || arg === 'off' ? 'off'
            : 'bound';
      this.state.setPushMode(targetMode);
      await this.reply(event.message_id, `主动推送模式已切换为：${formatPushModeLabel(targetMode)}`, quotedId);
      return true;
    }

    // 6. New conversation
    match = /^(?:新建|新会话|\/new)(?:\s+([\s\S]+))?$/i.exec(content);
    if (match) {
      const rest = (match[1] || '').trim();
      if (!rest) {
        await this.reply(
          event.message_id,
          '请在 `新建` 后附上初始任务，例如：`#ag 新建 帮我检查当前目录` 或 `#ag 新建 /path/to/repo 分析报错`',
        );
        return true;
      }
      let cwd = this.config.workdir;
      let prompt = rest;
      const firstSpace = rest.search(/\s/);
      const firstToken = firstSpace > 0 ? rest.slice(0, firstSpace) : rest;
      if (/^(?:\/|~\/)/.test(firstToken)) {
        cwd = path.resolve(expandHomeDir(firstToken));
        prompt = firstSpace > 0 ? rest.slice(firstSpace).trim() : '';
        if (!prompt) {
          await this.reply(event.message_id, `请在目录 \`${cwd}\` 后附上初始任务内容。`);
          return true;
        }
      }
      const created = await this.dispatchNewConversation(prompt, { cwd });
      if (!created.ok) {
        await this.reply(event.message_id, `⚠️ 创建会话失败：${created.error || created.stderr || '未知错误'}`);
        return true;
      }
      let targetId = created.conversationId;
      let seq = null;
      if (targetId) {
        seq = this.state.assignSeq(targetId);
        this.state.bindConversation(targetId);
      }
      await this.reply(
        event.message_id,
        seq
          ? `已创建会话 **#${seq}**（目录 \`${cwd}\`）并提交首个任务，完成后自动回推。\n\n---\n引用本条回复可继续；发送 \`#ag @${seq} 内容\` 可直达。`
          : `已创建新会话（目录 \`${cwd}\`）并提交首个任务，完成后自动回推。`,
        targetId,
      );
      return true;
    }

    // 7. Stop generation (optional CDP)
    match = /^(?:停止|\/stop)(?:\s*[#@]?([a-zA-Z0-9_-]+))?$/i.exec(content);
    if (match) {
      const target = await this.resolveConversation(match[1] || quotedId);
      if (!this.cdp) {
        await this.reply(event.message_id, '当前未配置 CDP 扩展，请先运行 `./start-antigravity.sh` 开启 `:9223` 后再使用停止功能。', target?.id);
        return true;
      }
      const res = await this.cdp.clickStop();
      if (!res.available) {
        await this.reply(event.message_id, 'Antigravity 未开启 CDP (`:9223`)，无法远程点击停止；请在桌面端手动停止或运行 `./start-antigravity.sh`。', target?.id);
        return true;
      }
      await this.reply(
        event.message_id,
        res.ok ? `🛑 已触发停止当前生成。` : `未能触发停止：${res.message || '当前未检测到停止按钮'}`,
        target?.id,
      );
      return true;
    }

    // 8. Approval action (optional CDP)
    match = /^(允许|批准|同意|\/ok|拒绝|取消)(?:\s*[#@]?([a-zA-Z0-9_-]+))?$/i.exec(content);
    if (match) {
      const approved = /^(允许|批准|同意|\/ok)$/i.test(match[1]);
      const target = await this.resolveConversation(match[2] || quotedId || this.state.data.lastAlertConversationId);
      if (!this.cdp) {
        await this.reply(event.message_id, '当前未配置 CDP 扩展，请在 Antigravity 桌面端操作，或运行 `./start-antigravity.sh` 开启 `:9223`。', target?.id);
        return true;
      }
      const res = await this.cdp.clickApproval(approved ? 'approve' : 'reject');
      if (!res.available) {
        await this.reply(event.message_id, 'Antigravity 未开启 CDP (`:9223`)，无法自动点击审批按钮；请在桌面端操作或运行 `./start-antigravity.sh`。', target?.id);
        return true;
      }
      await this.reply(
        event.message_id,
        res.ok
          ? `✅ 已点击「${approved ? '允许' : '拒绝'}」${res.message ? `（${res.message}）` : ''}。`
          : `未能点击按钮：${res.message || '当前未检测到待审批按钮'}`,
        target?.id,
      );
      return true;
    }

    // 8.5 Relaunch Antigravity with CDP :9223
    if (/^(?:重启\s*cdp|重启\s*antigravity|relaunch|\/relaunch)$/i.test(content)) {
      const currentCdp = this.cdp ? await this.cdp.isAvailable().catch(() => ({ available: false })) : { available: false };
      if (currentCdp.available) {
        await this.reply(event.message_id, '🟢 CDP (`:9223`) 当前已在线，无需重启。', quotedId);
        return true;
      }
      await this.reply(event.message_id, '🔄 正在后台重启 Antigravity 并开启 CDP (`:9223`)，请稍候约 5–15 秒…', quotedId);
      try {
        await this.runRelaunchScript();
      } catch (err) {
        await this.reply(event.message_id, `⚠️ 启动重启脚本失败：${err?.message || err}`, quotedId);
        return true;
      }
      if (!this.cdp?.isAvailable) {
        return true;
      }
      const deadline = Date.now() + this.relaunchTimeoutMs;
      let ready = false;
      while (Date.now() <= deadline) {
        if (this.relaunchPollMs > 0) await sleep(this.relaunchPollMs);
        const probe = await this.cdp.isAvailable().catch(() => ({ available: false }));
        if (probe.available && (!Array.isArray(probe.targets) || probe.targets.length > 0)) {
          ready = true;
          break;
        }
        if (this.relaunchPollMs <= 0) break;
      }
      await this.reply(
        event.message_id,
        ready
          ? '✅ Antigravity 已重启，CDP (`:9223`) 已恢复就绪，现在可以正常在飞书发消息了！'
          : '⚠️ 已触发重启，但暂未检测到 CDP (`:9223`) 就绪，请稍后发 `#ag 状态` 确认或查看 `~/.antigravity-feishu/start-antigravity.log`。',
        quotedId,
      );
      return true;
    }

    // 9. Explicit @N / #N target or default/quoted conversation
    const directMatch = /^[#@]([a-zA-Z0-9_-]+)\s+([\s\S]+)$/.exec(content);
    const promptText = (directMatch ? directMatch[2] : content).trim();
    if (!promptText) return true;

    const targetRef = directMatch ? directMatch[1] : quotedId;
    const conv = await this.resolveConversation(targetRef);
    if (!conv) {
      await this.reply(
        event.message_id,
        targetRef
          ? `找不到编号或会话 \`${targetRef}\`，请先发送 \`#ag 状态\` 或 \`#ag 新建 你的任务\`。`
          : '当前没有可用的 Antigravity 会话，请先发送 `#ag 新建 你的任务`。',
      );
      return true;
    }

    const seq = conv.seq || this.state.assignSeq(conv.id);
    this.state.bindConversation(conv.id);
    const defaultId = this.state.getDefaultConversationId();
    const isMasterTarget = !directMatch && (!quotedId || (defaultId ? quotedId === defaultId : seq === 1));
    const payload = isMasterTarget
      ? `${this.buildMasterPrefix()}${promptText}`
      : promptText;

    const sent = await this.dispatchMessage(conv, payload);
    if (!sent.ok) {
      await this.reply(
        event.message_id,
        `⚠️ 发送至 **#${seq} ${conv.title || conv.id}** 失败：${sent.error || sent.stderr || '未知错误'}`,
        conv.id,
      );
      return true;
    }

    const modeHint = conv.isRunning ? '（会话运行中，消息已投递）' : '';
    const targetLabel = isMasterTarget
      ? `👑 **总控 (#${seq} ${conv.title || conv.id})**`
      : `**#${seq} ${conv.title || conv.id}**`;
    await this.reply(
      event.message_id,
      `📨 已发给 ${targetLabel}${modeHint}，完成后自动回推。\n\n---\n引用本条回复可继续；发送 \`#ag @${seq} 内容\` 可直达。`,
      conv.id,
    );
    return true;
  }
}
