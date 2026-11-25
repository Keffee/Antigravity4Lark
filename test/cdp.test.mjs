import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdpClient } from '../lib/cdp.mjs';

function makeMockCdp({
  targets = [{ id: 'p1', type: 'page', title: 'Antigravity', url: 'http://127.0.0.1:55829/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/p1' }],
  onEvaluate,
} = {}) {
  const cdpCalls = [];

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      queueMicrotask(() => this.onopen?.());
    }
    send(raw) {
      const msg = JSON.parse(raw);
      cdpCalls.push({ method: msg.method, params: msg.params });
      let result = {};
      if (msg.method === 'Runtime.evaluate') {
        result = { result: { value: onEvaluate ? onEvaluate(msg.params.expression, cdpCalls) : null } };
      }
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) });
      });
    }
    close() {
      this.onclose?.();
    }
  }

  const fetchMock = async () => ({
    ok: true,
    status: 200,
    json: async () => targets,
  });

  return { cdpCalls, fetchMock, MockWebSocket };
}

test('createCdpClient degrades gracefully when CDP port is unavailable', async () => {
  const client = createCdpClient({
    cdpUrl: 'http://127.0.0.1:9223',
    _fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  const avail = await client.isAvailable();
  assert.equal(avail.available, false);

  const sendRes = await client.sendMessage({ id: 'c1', title: 'Main' }, 'hello');
  assert.equal(sendRes.ok, false);
  assert.equal(sendRes.available, false);
  assert.match(sendRes.error, /start-antigravity\.sh/);

  const createRes = await client.createConversation('new task');
  assert.equal(createRes.ok, false);
  assert.equal(createRes.available, false);
  assert.match(createRes.error, /start-antigravity\.sh/);

  const domRes = await client.inspectDom();
  assert.equal(domRes.available, false);
  assert.match(domRes.error, /start-antigravity\.sh/);
});

test('createCdpClient sendMessage switches sidebar item, types multiline text, and submits with Enter', async () => {
  let evalCount = 0;
  const { cdpCalls, fetchMock, MockWebSocket } = makeMockCdp({
    onEvaluate: expr => {
      evalCount++;
      if (expr.includes('not_in_sidebar')) {
        return { found: true, score: 100, matchedBy: 'id_attr', active: false, x: 80, y: 120 };
      }
      if (expr.includes('ProseMirror')) {
        // First call returns empty editor; second call (after Enter) confirms cleared
        return evalCount <= 2
          ? { found: true, x: 400, y: 600, tag: 'div', hasText: false }
          : { found: true, x: 400, y: 600, tag: 'div', hasText: false };
      }
      return null;
    },
  });

  const client = createCdpClient({
    _fetch: fetchMock,
    _WebSocket: MockWebSocket,
    _switchWaitMs: 0,
  });

  const res = await client.sendMessage({ id: 'conv-123', title: 'Test Chat' }, 'line 1\nline 2');
  assert.equal(res.ok, true);
  assert.equal(res.available, true);
  assert.equal(res.switched, 'clicked_sidebar');

  const inserted = cdpCalls.filter(c => c.method === 'Input.insertText').map(c => c.params.text);
  assert.deepEqual(inserted, ['line 1', 'line 2']);

  const keyDowns = cdpCalls.filter(c => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'rawKeyDown');
  // 1st rawKeyDown is Shift+Enter (modifiers: 8) between lines, 2nd is plain Enter submit
  assert.equal(keyDowns.length, 2);
  assert.equal(keyDowns[0].params.modifiers, 8);
  assert.equal(keyDowns[1].params.modifiers, undefined);
});

test('createCdpClient createConversation clicks new conversation button and inspectDom returns summary', async () => {
  const { cdpCalls, fetchMock, MockWebSocket } = makeMockCdp({
    onEvaluate: expr => {
      if (expr.includes('开始新对话')) {
        return { found: true, label: 'New Conversation', x: 50, y: 60 };
      }
      if (expr.includes('ProseMirror')) {
        return { found: true, x: 420, y: 620, tag: 'textarea', hasText: false };
      }
      if (expr.includes('sidebarItems')) {
        return {
          title: 'Antigravity',
          url: 'http://127.0.0.1:55829/',
          viewport: { width: 1200, height: 800 },
          sidebarItems: [{ tag: 'button', text: 'Chat 1' }],
          inputCandidates: [{ tag: 'textarea', inSidebar: false }],
          newChatButtons: [{ text: 'New Conversation' }],
        };
      }
      if (expr.includes('STOP_RE')) {
        return { hasStopButton: false, stopButtons: [], approvalButtons: ['Allow'] };
      }
      return null;
    },
  });

  const client = createCdpClient({
    _fetch: fetchMock,
    _WebSocket: MockWebSocket,
    _switchWaitMs: 0,
  });

  const created = await client.createConversation('Build something');
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.buttonLabel, 'New Conversation');
  assert.ok(cdpCalls.some(c => c.method === 'Input.insertText' && c.params.text === 'Build something'));

  const dom = await client.inspectDom();
  assert.equal(dom.available, true);
  assert.equal(dom.pages.length, 1);
  assert.equal(dom.pages[0].sidebarItems[0].text, 'Chat 1');
  assert.equal(dom.pages[0].newChatButtons[0].text, 'New Conversation');
});

test('createCdpClient sendMessage clicks Send button fallback when Enter leaves text in editor', async () => {
  let inputChecks = 0;
  const { cdpCalls, fetchMock, MockWebSocket } = makeMockCdp({
    onEvaluate: expr => {
      if (expr.includes('ProseMirror')) {
        inputChecks++;
        return { found: true, x: 400, y: 600, tag: 'div', hasText: inputChecks >= 2 };
      }
      if (expr.includes('FIND_SEND_BUTTON') || expr.includes("type') === 'submit'")) {
        return { found: true, x: 700, y: 610 };
      }
      return null;
    },
  });

  const client = createCdpClient({
    _fetch: fetchMock,
    _WebSocket: MockWebSocket,
    _switchWaitMs: 0,
  });

  const res = await client.sendMessage(null, 'hello');
  assert.equal(res.ok, true);
  assert.equal(res.switched, 'not_requested');
  const mouseClicks = cdpCalls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  assert.ok(mouseClicks.some(c => c.params.x === 700 && c.params.y === 610));
});

test('createCdpClient ignores external webview tabs and data: pages, targeting only Antigravity UI windows', async () => {
  const connectedUrls = [];
  const targets = [
    { id: 'ext1', type: 'page', title: 'External Dashboard', url: 'https://example.com/dashboard/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/ext1' },
    { id: 'data1', type: 'page', title: '', url: 'data:text/html,<html></html>', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/data1' },
    { id: 'ag1', type: 'page', title: 'Master Hub - Antigravity', url: 'https://127.0.0.1:62010/c/conv-0001', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/ag1' },
  ];

  const { fetchMock, MockWebSocket } = makeMockCdp({
    targets,
    onEvaluate: expr => {
      if (expr.includes('not_in_sidebar')) {
        return { found: true, score: 200, matchedBy: 'url_pathname', active: true, x: 0, y: 0 };
      }
      if (expr.includes('Message input')) {
        return { found: true, x: 750, y: 960, tag: 'div', hasText: false };
      }
      return null;
    },
  });

  class TrackingWs extends MockWebSocket {
    constructor(url) {
      connectedUrls.push(url);
      super(url);
    }
  }

  const client = createCdpClient({
    _fetch: fetchMock,
    _WebSocket: TrackingWs,
    _switchWaitMs: 0,
  });

  const avail = await client.isAvailable();
  assert.equal(avail.available, true);
  assert.equal(avail.targets.length, 1);
  assert.equal(avail.targets[0].id, 'ag1');

  const res = await client.sendMessage({ id: 'conv-0001', title: 'Master Hub' }, 'ping');
  assert.equal(res.ok, true);
  assert.equal(res.switched, 'already_active');
  assert.deepEqual(connectedUrls, ['ws://127.0.0.1:9223/devtools/page/ag1']);
});
