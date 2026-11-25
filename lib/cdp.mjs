import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9223';
const START_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'start-antigravity.sh',
);

class CdpSession {
  constructor(wsUrl, WebSocketImpl = WebSocket) {
    this.wsUrl = wsUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.nextId = 0;
    this.pending = new Map();
    this.ws = null;
  }

  connect(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`CDP connect timeout: ${this.wsUrl}`));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${this.wsUrl}`));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error('CDP socket closed'));
        }
        this.pending.clear();
      };
      ws.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
            else res(msg.result);
          }
        } catch {
          // Ignore malformed CDP frames
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'CDP evaluate failed');
    }
    return res?.result?.value;
  }

  async clickPoint(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async pressEnter(modifiers = 0) {
    const ev = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(modifiers ? { modifiers } : { text: '\r' }),
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  }

  async typeMultilineText(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        await this.pressEnter(8); // Shift+Enter for newline without submitting
      }
      if (lines[i]) {
        await this.send('Input.insertText', { text: lines[i] });
      }
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

const INSPECT_UI_SCRIPT = `(() => {
  const vis = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const STOP_RE = /^(stop|stop generating|停止|停止生成|取消生成)$/i;
  const APPROVAL_RE = /^(allow|approve|accept|run(\\s+command)?|continue|confirm|yes|reject|deny|decline|允许|批准|接受|运行|继续|确认|拒绝|取消)[⏎↵\\s]*$/i;

  const stopButtons = [];
  const approvalButtons = [];
  const seen = new Set();

  for (const btn of document.querySelectorAll('button, [role="button"]')) {
    if (!vis(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
    const rect = btn.getBoundingClientRect();
    const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').trim();
    const text = (btn.innerText || btn.textContent || '').trim().replace(/\\s+/g, ' ');
    const label = (text || aria).replace(/[⏎↵]+$/g, '').trim();
    const testId = (btn.dataset?.testid || '').toLowerCase();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const key = label + '@' + x + ',' + y;
    if (seen.has(key)) continue;
    seen.add(key);

    if (STOP_RE.test(aria) || STOP_RE.test(text) || /stop/i.test(testId) || /^stop execution$/i.test(aria) || btn.querySelector('.codicon-debug-stop')) {
      stopButtons.push({ label: label || 'Stop', x, y, inSidebar: rect.left < 260 });
      continue;
    }
    if (APPROVAL_RE.test(label) || /approve|reject|allow|deny/i.test(testId)) {
      approvalButtons.push({ label, x, y });
    }
  }

  stopButtons.sort((a, b) => Number(a.inSidebar) - Number(b.inSidebar));

  return {
    hasStopButton: stopButtons.some(b => !b.inSidebar) || stopButtons.length > 0,
    stopButtons,
    approvalButtons,
  };
})()`;

function buildFindSidebarItemScript(conversation) {
  const id = String(conversation?.id || '');
  const title = String(conversation?.title || '');
  return `(() => {
    const id = ${JSON.stringify(id)}.toLowerCase();
    const title = ${JSON.stringify(title)}.trim().replace(/\\s+/g, ' ').toLowerCase();
    if (!id && !title) return { found: false, reason: 'no_target' };

    if (id && location.pathname.toLowerCase().includes('/c/' + id)) {
      return { found: true, score: 200, matchedBy: 'url_pathname', active: true, x: 0, y: 0, text: document.title || '' };
    }

    const vis = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    };

    // Exact Antigravity 2.0 conversation link in sidebar: <a href="/c/<uuid>">
    if (id) {
      for (const a of document.querySelectorAll('a[href*="/c/"]')) {
        if (!vis(a)) continue;
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (href.includes('/c/' + id)) {
          a.scrollIntoView?.({ block: 'nearest' });
          const rect = a.getBoundingClientRect();
          // Click safely on the left side to avoid hovering Stop/Pin/Kebab buttons on the right
          return {
            found: true,
            score: 150,
            matchedBy: 'href_exact',
            active: false,
            x: Math.round(rect.left + Math.min(36, Math.max(8, rect.width * 0.2))),
            y: Math.round(rect.top + rect.height / 2),
            text: (a.getAttribute('aria-label') || a.innerText || '').trim().slice(0, 80),
          };
        }
      }
    }

    const candidates = [];
    const selector = [
      'a[href*="/c/"]',
      '[data-conversation-id]',
      '[data-session-id]',
      '[data-sidebar-item-key]',
      'aside li',
      'aside button',
      'aside a',
      'aside [role="button"]',
      'nav li',
      'nav button',
      'nav a',
      '[role="navigation"] [role="listitem"]',
      '[role="navigation"] button',
      '[class*="sidebar" i] li',
      '[class*="sidebar" i] button',
      '[class*="sidebar" i] [role="button"]',
      '[class*="conversation" i][role="button"]',
    ].join(', ');

    const seen = new Set();
    for (const el of document.querySelectorAll(selector)) {
      if (seen.has(el) || !vis(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.55) continue;

      const attrs = [
        el.getAttribute('data-conversation-id'),
        el.getAttribute('data-session-id'),
        el.getAttribute('data-sidebar-item-key'),
        el.getAttribute('href'),
        el.id,
      ].filter(Boolean).join(' ').toLowerCase();
      const text = (el.getAttribute('aria-label') || el.innerText || el.textContent || '')
        .trim()
        .replace(/\\s+/g, ' ')
        .toLowerCase();

      let score = 0;
      let matchedBy = '';
      if (id && attrs.includes(id)) {
        score = 100;
        matchedBy = 'id_attr';
      } else if (id && id.length >= 8 && attrs.includes(id.slice(0, 8))) {
        score = 80;
        matchedBy = 'id_prefix';
      } else if (title && text === title) {
        score = 70;
        matchedBy = 'title_exact';
      } else if (title && title.length >= 4 && (text.includes(title) || title.includes(text)) && text.length >= 4) {
        score = 50;
        matchedBy = 'title_partial';
      }

      if (score > 0) {
        const active =
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('aria-current') === 'page' ||
          el.getAttribute('data-active') === 'true';
        candidates.push({
          score,
          matchedBy,
          active,
          x: Math.round(rect.left + Math.min(36, Math.max(8, rect.width * 0.2))),
          y: Math.round(rect.top + rect.height / 2),
          text: text.slice(0, 80),
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length === 0) return { found: false, reason: 'not_in_sidebar' };
    const best = candidates[0];
    const targetEl = document.elementFromPoint(best.x, best.y);
    targetEl?.scrollIntoView?.({ block: 'nearest' });
    return { found: true, ...best };
  })()`;
}

const FIND_CHAT_INPUT_SCRIPT = `(() => {
  const vis = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };

  const focusAndReport = el => {
    const rect = el.getBoundingClientRect();
    el.focus();
    if (el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch {}
    }
    return {
      found: true,
      x: Math.round(rect.left + Math.min(rect.width / 2, 120)),
      y: Math.round(rect.top + rect.height / 2),
      tag: el.tagName.toLowerCase(),
      hasText: Boolean((el.value ?? el.innerText ?? el.textContent ?? '').trim()),
    };
  };

  // Primary Antigravity 2.0 message input selector
  const exact = document.querySelector('[aria-label="Message input"][contenteditable="true"], [aria-label="Message input"]');
  if (exact && vis(exact) && !exact.disabled && exact.getAttribute('aria-disabled') !== 'true') {
    return focusAndReport(exact);
  }

  const candidates = [];
  const els = document.querySelectorAll(
    'textarea, [contenteditable="true"], [role="textbox"], [role="combobox"][contenteditable="true"], .ProseMirror, .tiptap, [data-lexical-editor="true"]'
  );
  for (const el of els) {
    if (!vis(el)) continue;
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('aside, nav, [role="search"], [class*="sidebar" i]')) continue;

    const ph = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
    if (/^(search|filter|find|搜索|查找|过滤)/.test(ph)) continue;

    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    const bottomBias = rect.bottom >= window.innerHeight * 0.35 ? 100000 : 0;
    const chatBias = /ask|chat|message|prompt|输入|提问|发送/.test(ph) ? 50000 : 0;
    candidates.push({
      el,
      score: bottomBias + chatBias + area,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked = candidates[0];
  if (!picked) return { found: false };
  return focusAndReport(picked.el);
})()`;

const FIND_SEND_BUTTON_SCRIPT = `(() => {
  const vis = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  for (const btn of document.querySelectorAll('button, [role="button"]')) {
    if (!vis(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
    const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').trim();
    const text = (btn.innerText || btn.textContent || '').trim();
    const testId = (btn.dataset?.testid || '').toLowerCase();
    if (/voice|record/i.test(aria + ' ' + testId)) continue;
    if (
      /^(send|send message|submit|发送|提交)$/i.test(aria) ||
      /^(send|submit|发送)$/i.test(text) ||
      /send/i.test(testId) ||
      btn.getAttribute('type') === 'submit'
    ) {
      const rect = btn.getBoundingClientRect();
      if (rect.bottom < window.innerHeight * 0.35) continue;
      return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }
  }
  return { found: false };
})()`;

const FIND_NEW_CONVERSATION_BTN_SCRIPT = `(() => {
  const vis = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const EXACT_RE = /^(new\\s*(conversation|chat|thread)|start\\s*new\\s*conversation|新建(对话|会话)|开始新对话)$/i;
  const candidates = [];
  for (const btn of document.querySelectorAll('button, a, [role="button"]')) {
    if (!vis(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
    const rect = btn.getBoundingClientRect();
    const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').trim();
    const text = (btn.innerText || btn.textContent || '').trim().replace(/\\s+/g, ' ');
    const testId = (btn.dataset?.testid || '').toLowerCase();
    let score = 0;
    if (EXACT_RE.test(text) || EXACT_RE.test(aria)) score = 100;
    else if (/new[-_ ]?(conversation|chat)/i.test(testId)) score = 90;
    else if (/new\\s*(conversation|chat)|新建(对话|会话)/i.test(aria + ' ' + text)) score = 70;
    else if ((text === '+' || aria === '+') && rect.left < window.innerWidth * 0.4 && rect.top < 160) score = 40;
    if (score > 0) {
      candidates.push({
        score,
        label: text || aria || testId || '+',
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ? { found: true, ...candidates[0] } : { found: false };
})()`;

const INSPECT_DOM_SCRIPT = `(() => {
  const vis = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const shortRect = el => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const sidebarItems = [];
  for (const el of document.querySelectorAll('aside li, aside button, aside a, nav li, nav button, [data-conversation-id], [data-sidebar-item-key]')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left > window.innerWidth * 0.55) continue;
    sidebarItems.push({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      ariaLabel: el.getAttribute('aria-label') || '',
      testId: el.dataset?.testid || '',
      convId: el.getAttribute('data-conversation-id') || el.getAttribute('data-sidebar-item-key') || '',
      rect: shortRect(el),
    });
    if (sidebarItems.length >= 25) break;
  }

  const inputCandidates = [];
  for (const el of document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]')) {
    if (!vis(el)) continue;
    inputCandidates.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      contentEditable: Boolean(el.isContentEditable),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      className: String(el.className || '').slice(0, 80),
      inSidebar: Boolean(el.closest('aside, nav, [role="search"], [class*="sidebar" i]')),
      rect: shortRect(el),
    });
    if (inputCandidates.length >= 15) break;
  }

  const newChatBtn = (() => {
    const EXACT_RE = /new\\s*(conversation|chat|thread)|新建(对话|会话)/i;
    const out = [];
    for (const btn of document.querySelectorAll('button, a, [role="button"]')) {
      if (!vis(btn)) continue;
      const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').trim();
      const text = (btn.innerText || btn.textContent || '').trim().replace(/\\s+/g, ' ');
      const testId = btn.dataset?.testid || '';
      if (EXACT_RE.test(aria + ' ' + text + ' ' + testId)) {
        out.push({ text: text.slice(0, 40), ariaLabel: aria, testId, rect: shortRect(btn) });
      }
    }
    return out.slice(0, 10);
  })();

  return {
    title: document.title || '',
    url: location.href || '',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    sidebarItems,
    inputCandidates,
    newChatButtons: newChatBtn,
  };
})()`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createCdpClient(config = {}) {
  const cdpUrl = (config.cdpUrl || DEFAULT_CDP_URL).replace(/\/$/, '');
  const fetchImpl = config._fetch || fetch;
  const WebSocketImpl = config._WebSocket || WebSocket;
  const switchWaitMs = config._switchWaitMs !== undefined ? Number(config._switchWaitMs) : 250;

  function unavailableMsg() {
    return `CDP 未开启（${cdpUrl}），请先运行 ${START_SCRIPT_PATH} 开启调试端口`;
  }

  function isAntigravityUiTarget(t) {
    if (!t || t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
    const url = String(t.url || '');
    const title = String(t.title || '');
    if (!url || url.startsWith('devtools://') || url.startsWith('data:')) return false;
    if (/^https?:\/\/(127\.0\.0\.1|localhost):\d+\//i.test(url)) return true;
    if (/\bantigravity\b/i.test(title)) return true;
    return false;
  }

  async function isAvailable() {
    try {
      const res = await fetchImpl(`${cdpUrl}/json/list`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) {
        return { available: false, url: cdpUrl, error: `HTTP ${res.status}` };
      }
      const list = await res.json();
      const allPages = (Array.isArray(list) ? list : [])
        .filter(t => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').startsWith('devtools://') && !String(t.url || '').startsWith('data:'));
      const uiPages = allPages.filter(isAntigravityUiTarget);
      const targets = uiPages.map(t => ({
        id: t.id,
        title: t.title || '',
        url: t.url || '',
        ws: t.webSocketDebuggerUrl,
      }));
      return { available: true, url: cdpUrl, targets };
    } catch (error) {
      return { available: false, url: cdpUrl, error: error?.message || String(error) };
    }
  }

  async function withPrimarySession(fn, { conversationId = '' } = {}) {
    const avail = await isAvailable();
    if (!avail.available) {
      return { ok: false, available: false, error: unavailableMsg() };
    }
    if (!avail.targets || avail.targets.length === 0) {
      return { ok: false, available: true, error: '未找到可用的 Antigravity 主界面窗口' };
    }
    const orderedTargets = [...avail.targets];
    if (conversationId) {
      const needle = `/c/${String(conversationId).toLowerCase()}`;
      orderedTargets.sort((a, b) => {
        const aMatch = String(a.url || '').toLowerCase().includes(needle) ? 1 : 0;
        const bMatch = String(b.url || '').toLowerCase().includes(needle) ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    let lastError = null;
    for (const target of orderedTargets) {
      const cdp = new CdpSession(target.ws, WebSocketImpl);
      try {
        await cdp.connect();
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
        return await fn(cdp, target);
      } catch (err) {
        lastError = err;
      } finally {
        cdp.close();
      }
    }
    return { ok: false, available: true, error: lastError?.message || 'CDP page interaction failed' };
  }

  async function injectAndSubmit(cdp, text) {
    const inputInfo = await cdp.evaluate(FIND_CHAT_INPUT_SCRIPT);
    if (!inputInfo?.found) {
      return { ok: false, error: '未找到可见的 Antigravity 聊天输入框' };
    }
    await cdp.clickPoint(inputInfo.x, inputInfo.y);
    await cdp.typeMultilineText(text);
    await cdp.pressEnter(0);

    // Fallback: if Enter inserted newline instead of submitting and a Send button is visible, click it
    if (switchWaitMs > 0) await sleep(Math.min(120, switchWaitMs));
    const afterState = await cdp.evaluate(FIND_CHAT_INPUT_SCRIPT).catch(() => null);
    if (afterState?.hasText) {
      const sendBtn = await cdp.evaluate(FIND_SEND_BUTTON_SCRIPT).catch(() => null);
      if (sendBtn?.found) {
        await cdp.clickPoint(sendBtn.x, sendBtn.y);
      }
    }
    return { ok: true };
  }

  async function inspectPrimaryPage() {
    const avail = await isAvailable();
    if (!avail.available) {
      return { available: false, error: avail.error };
    }
    if (!avail.targets || avail.targets.length === 0) {
      return { available: true, hasStopButton: false, stopButtons: [], approvalButtons: [], targets: [] };
    }
    for (const target of avail.targets) {
      const cdp = new CdpSession(target.ws, WebSocketImpl);
      try {
        await cdp.connect();
        const ui = await cdp.evaluate(INSPECT_UI_SCRIPT);
        return {
          available: true,
          target,
          hasStopButton: Boolean(ui?.hasStopButton),
          stopButtons: ui?.stopButtons || [],
          approvalButtons: ui?.approvalButtons || [],
        };
      } catch {
        // Try next page target
      } finally {
        cdp.close();
      }
    }
    return { available: true, hasStopButton: false, stopButtons: [], approvalButtons: [] };
  }

  async function getUiState() {
    const state = await inspectPrimaryPage();
    if (!state.available) {
      return { available: false, error: state.error };
    }
    return {
      available: true,
      hasStopButton: state.hasStopButton,
      approvalButtons: state.approvalButtons.map(b => b.label),
    };
  }

  async function clickStop() {
    const state = await inspectPrimaryPage();
    if (!state.available) {
      return {
        ok: false,
        available: false,
        message: unavailableMsg(),
      };
    }
    const targetBtn = state.stopButtons?.[0];
    if (!targetBtn || !state.target?.ws) {
      return { ok: false, available: true, message: '当前未检测到可点击的停止按钮' };
    }
    const cdp = new CdpSession(state.target.ws, WebSocketImpl);
    try {
      await cdp.connect();
      await cdp.clickPoint(targetBtn.x, targetBtn.y);
      return { ok: true, available: true, message: `已点击停止按钮 (${targetBtn.label})` };
    } catch (error) {
      return { ok: false, available: true, message: error?.message || String(error) };
    } finally {
      cdp.close();
    }
  }

  async function clickApproval(choice = 'approve') {
    const state = await inspectPrimaryPage();
    if (!state.available) {
      return {
        ok: false,
        available: false,
        message: unavailableMsg(),
      };
    }
    const buttons = state.approvalButtons || [];
    if (buttons.length === 0 || !state.target?.ws) {
      return { ok: false, available: true, message: '当前未检测到待审批或确认按钮' };
    }

    const raw = String(choice || 'approve').trim();
    let picked = null;
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw) - 1;
      picked = buttons[idx] || null;
    } else if (/^(reject|deny|decline|no|拒绝|取消)$/i.test(raw)) {
      picked = buttons.find(b => /reject|deny|decline|拒绝|取消/i.test(b.label)) || null;
    } else if (/^(approve|allow|accept|ok|yes|允许|批准|接受|同意|继续)$/i.test(raw)) {
      picked =
        buttons.find(b => /^(allow|approve|accept|run|continue|confirm|yes|允许|批准|接受|运行|继续|确认)/i.test(b.label)) ||
        buttons[0];
    } else {
      picked = buttons.find(b => b.label.toLowerCase().includes(raw.toLowerCase())) || null;
    }

    if (!picked) {
      return {
        ok: false,
        available: true,
        message: `未匹配到按钮 "${raw}"，当前可见按钮：${buttons.map(b => b.label).join(' / ')}`,
      };
    }

    const cdp = new CdpSession(state.target.ws, WebSocketImpl);
    try {
      await cdp.connect();
      await cdp.clickPoint(picked.x, picked.y);
      return { ok: true, available: true, message: `已点击按钮：${picked.label}` };
    } catch (error) {
      return { ok: false, available: true, message: error?.message || String(error) };
    } finally {
      cdp.close();
    }
  }

  async function sendMessage(conversation, content) {
    if (!content) {
      return { ok: false, available: true, switched: false, error: '消息内容不能为空' };
    }
    const convObj = typeof conversation === 'string' ? { id: conversation } : conversation || null;

    return withPrimarySession(async (cdp, target) => {
      let switched = 'not_requested';
      if (convObj && (convObj.id || convObj.title)) {
        const hit = await cdp.evaluate(buildFindSidebarItemScript(convObj));
        if (hit?.found) {
          if (hit.active) {
            switched = 'already_active';
          } else {
            await cdp.clickPoint(hit.x, hit.y);
            if (switchWaitMs > 0) {
              const targetId = String(convObj.id || '').toLowerCase();
              const deadline = Date.now() + Math.max(switchWaitMs, 1500);
              while (Date.now() < deadline) {
                await sleep(Math.min(120, switchWaitMs));
                if (!targetId) break;
                const onTarget = await cdp
                  .evaluate(`location.pathname.toLowerCase().includes(${JSON.stringify('/c/' + targetId)})`)
                  .catch(() => false);
                if (onTarget) break;
              }
            }
            switched = 'clicked_sidebar';
          }
        } else {
          switched = 'sidebar_not_found_used_active';
        }
      }

      const sent = await injectAndSubmit(cdp, content);
      if (!sent.ok) {
        return { ok: false, available: true, switched, error: sent.error };
      }
      return {
        ok: true,
        available: true,
        switched,
        targetTitle: target.title || '',
      };
    }, { conversationId: convObj?.id || '' });
  }

  async function createConversation(prompt) {
    if (!prompt) {
      return { ok: false, available: true, error: '新建会话内容不能为空' };
    }
    return withPrimarySession(async (cdp, target) => {
      const btn = await cdp.evaluate(FIND_NEW_CONVERSATION_BTN_SCRIPT);
      if (!btn?.found) {
        return {
          ok: false,
          available: true,
          error: '未找到「新建对话」按钮，请检查桌面端侧边栏或运行 inspect-cdp 排查 DOM',
        };
      }
      await cdp.clickPoint(btn.x, btn.y);
      if (switchWaitMs > 0) await sleep(switchWaitMs);

      const sent = await injectAndSubmit(cdp, prompt);
      if (!sent.ok) {
        return { ok: false, available: true, created: false, error: sent.error };
      }
      return {
        ok: true,
        available: true,
        created: true,
        buttonLabel: btn.label,
        targetTitle: target.title || '',
      };
    });
  }

  async function inspectDom() {
    const avail = await isAvailable();
    if (!avail.available) {
      return { available: false, url: cdpUrl, error: unavailableMsg() };
    }
    const pages = [];
    for (const target of avail.targets || []) {
      const cdp = new CdpSession(target.ws, WebSocketImpl);
      try {
        await cdp.connect();
        const dom = await cdp.evaluate(INSPECT_DOM_SCRIPT);
        const ui = await cdp.evaluate(INSPECT_UI_SCRIPT);
        pages.push({
          id: target.id,
          ...dom,
          hasStopButton: Boolean(ui?.hasStopButton),
          stopButtons: ui?.stopButtons || [],
          approvalButtons: ui?.approvalButtons || [],
        });
      } catch (error) {
        pages.push({
          id: target.id,
          title: target.title,
          url: target.url,
          error: error?.message || String(error),
        });
      } finally {
        cdp.close();
      }
    }
    return { available: true, url: cdpUrl, pages };
  }

  return {
    isAvailable,
    getUiState,
    clickStop,
    clickApproval,
    sendMessage,
    createConversation,
    inspectDom,
  };
}
