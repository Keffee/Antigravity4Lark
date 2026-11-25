import fs from 'node:fs';
import path from 'node:path';
import { normalizePushMode } from './config.mjs';

const MAX_MESSAGE_ROUTES = 1000;
const MAX_SEEN_MESSAGES = 1500;
const MAX_PUSHED_STEPS_PER_CONV = 200;

function createEmptyState(defaults = {}) {
  return {
    seqMap: {},
    nextSeq: 1,
    defaultConversationId: String(defaults.defaultConversationId || '').trim(),
    pushMode: normalizePushMode(defaults.pushMode, 'all'),
    boundConversations: [],
    messageRoutes: {},
    seenMessages: [],
    pushedSteps: {},
    lastAlertConversationId: '',
  };
}

/**
 * Persistent state store for Antigravity-Feishu bridge.
 * Handles conversation seq mapping, default target, push mode, quote-reply routes, and step dedup.
 */
export class StateStore {
  constructor(stateFile, defaults = {}) {
    this.file = stateFile;
    this.defaults = defaults;
    this.data = createEmptyState(defaults);
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const seqMap = saved?.seqMap && typeof saved.seqMap === 'object' ? { ...saved.seqMap } : {};
      const maxAssigned = Object.values(seqMap).reduce((m, v) => Math.max(m, Number(v) || 0), 0);
      this.data = {
        ...createEmptyState(this.defaults),
        ...saved,
        seqMap,
        nextSeq: Math.max(Number(saved?.nextSeq) || 1, maxAssigned + 1),
        defaultConversationId:
          String(saved?.defaultConversationId || this.defaults.defaultConversationId || '').trim(),
        pushMode: normalizePushMode(saved?.pushMode || this.defaults.pushMode, 'all'),
        boundConversations: Array.isArray(saved?.boundConversations) ? [...saved.boundConversations] : [],
        messageRoutes:
          saved?.messageRoutes && typeof saved.messageRoutes === 'object' ? { ...saved.messageRoutes } : {},
        seenMessages: Array.isArray(saved?.seenMessages) ? [...saved.seenMessages] : [],
        pushedSteps:
          saved?.pushedSteps && typeof saved.pushedSteps === 'object' ? { ...saved.pushedSteps } : {},
        lastAlertConversationId: String(saved?.lastAlertConversationId || '').trim(),
      };
    } catch {
      this.data = createEmptyState(this.defaults);
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  assignSeq(conversationId) {
    if (!conversationId) return null;
    if (this.data.seqMap[conversationId]) {
      return this.data.seqMap[conversationId];
    }
    const used = new Set(Object.values(this.data.seqMap).map(Number));
    let seq = Math.max(1, Number(this.data.nextSeq) || 1);
    while (used.has(seq)) seq += 1;
    this.data.seqMap[conversationId] = seq;
    this.data.nextSeq = seq + 1;
    this.save();
    return seq;
  }

  syncConversations(conversations = []) {
    let changed = false;
    const used = new Set(Object.values(this.data.seqMap).map(Number));
    for (const conv of conversations) {
      if (!conv?.id || this.data.seqMap[conv.id]) continue;
      let seq = Math.max(1, Number(this.data.nextSeq) || 1);
      while (used.has(seq)) seq += 1;
      this.data.seqMap[conv.id] = seq;
      used.add(seq);
      this.data.nextSeq = seq + 1;
      changed = true;
    }
    if (changed) this.save();
    return conversations.map(conv => ({ ...conv, seq: this.data.seqMap[conv.id] || null }));
  }

  getSeq(conversationId) {
    if (!conversationId) return null;
    return this.data.seqMap[conversationId] || null;
  }

  resolveRef(ref, conversations = []) {
    const raw = String(ref || '').trim().replace(/^[#@]/, '');
    if (!raw) {
      const defId = this.getDefaultConversationId();
      if (defId) {
        const hit = conversations.find(c => c.id === defId);
        if (hit) return { ...hit, seq: this.getSeq(hit.id) };
        return { id: defId, seq: this.getSeq(defId), title: defId };
      }
      if (conversations.length > 0) {
        const topLevel = conversations.find(c => !c.nestingDepth && !c.parentId) || conversations[0];
        const seq = this.assignSeq(topLevel.id);
        return { ...topLevel, seq };
      }
      return null;
    }

    if (/^\d+$/.test(raw)) {
      const num = Number(raw);
      const fromList = conversations.find(c => this.getSeq(c.id) === num || c.seq === num);
      if (fromList) return { ...fromList, seq: num };
      const mappedId = Object.keys(this.data.seqMap).find(id => this.data.seqMap[id] === num);
      if (mappedId) return { id: mappedId, seq: num, title: mappedId };
      if (raw.length < 4) return null;
    }

    const byId =
      conversations.find(c => c.id === raw) ||
      conversations.find(c => c.id.startsWith(raw));
    if (byId) return { ...byId, seq: this.getSeq(byId.id) || this.assignSeq(byId.id) };

    const mappedByPrefix = Object.keys(this.data.seqMap).find(id => id === raw || id.startsWith(raw));
    if (mappedByPrefix) {
      return { id: mappedByPrefix, seq: this.getSeq(mappedByPrefix), title: mappedByPrefix };
    }

    const lower = raw.toLowerCase();
    const byTitle = conversations.find(c => (c.title || '').toLowerCase().includes(lower));
    if (byTitle) return { ...byTitle, seq: this.getSeq(byTitle.id) || this.assignSeq(byTitle.id) };

    return null;
  }

  getDefaultConversationId() {
    return this.data.defaultConversationId || '';
  }

  setDefaultConversationId(id) {
    this.data.defaultConversationId = String(id || '').trim();
    if (this.data.defaultConversationId) {
      this.assignSeq(this.data.defaultConversationId);
    } else {
      this.save();
    }
    return this.data.defaultConversationId;
  }

  getPushMode() {
    return this.data.pushMode || 'bound';
  }

  setPushMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!['bound', 'all', 'off'].includes(normalized)) {
      throw new Error(`无效推送模式: ${mode}（可选 bound / all / off）`);
    }
    this.data.pushMode = normalized;
    this.save();
    return normalized;
  }

  bindConversation(id) {
    if (!id) return false;
    if (!this.data.boundConversations.includes(id)) {
      this.data.boundConversations.push(id);
      this.save();
      return true;
    }
    return false;
  }

  isBound(id) {
    return Boolean(id && this.data.boundConversations.includes(id));
  }

  recordMessageRoute(messageId, conversationId) {
    if (!messageId || !conversationId) return;
    this.data.messageRoutes[messageId] = conversationId;
    const entries = Object.entries(this.data.messageRoutes);
    if (entries.length > MAX_MESSAGE_ROUTES) {
      this.data.messageRoutes = Object.fromEntries(entries.slice(-MAX_MESSAGE_ROUTES));
    }
    this.save();
  }

  routeMessage(messageId) {
    if (!messageId) return null;
    return this.data.messageRoutes[messageId] || null;
  }

  hasSeenMessage(messageId) {
    return Boolean(messageId && this.data.seenMessages.includes(messageId));
  }

  markSeenMessage(messageId) {
    if (!messageId || this.hasSeenMessage(messageId)) return false;
    this.data.seenMessages.push(messageId);
    if (this.data.seenMessages.length > MAX_SEEN_MESSAGES) {
      this.data.seenMessages = this.data.seenMessages.slice(-MAX_SEEN_MESSAGES);
    }
    this.save();
    return true;
  }

  hasPushedStep(conversationId, stepIndex) {
    if (!conversationId || stepIndex === undefined || stepIndex === null) return false;
    const list = this.data.pushedSteps[conversationId];
    return Array.isArray(list) && list.includes(stepIndex);
  }

  markPushedStep(conversationId, stepIndex) {
    if (!conversationId || stepIndex === undefined || stepIndex === null) return false;
    if (!Array.isArray(this.data.pushedSteps[conversationId])) {
      this.data.pushedSteps[conversationId] = [];
    }
    const list = this.data.pushedSteps[conversationId];
    if (list.includes(stepIndex)) return false;
    list.push(stepIndex);
    if (list.length > MAX_PUSHED_STEPS_PER_CONV) {
      this.data.pushedSteps[conversationId] = list.slice(-MAX_PUSHED_STEPS_PER_CONV);
    }
    this.save();
    return true;
  }
}
