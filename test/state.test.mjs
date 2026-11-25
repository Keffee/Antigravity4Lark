import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../lib/state.mjs';

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-state-'));
  return path.join(dir, 'state.json');
}

test('assignSeq persists sequential numbers and avoids collisions', () => {
  const file = tempStateFile();
  const s1 = new StateStore(file);
  assert.equal(s1.assignSeq('conv-aaa'), 1);
  assert.equal(s1.assignSeq('conv-bbb'), 2);
  assert.equal(s1.assignSeq('conv-aaa'), 1);

  const s2 = new StateStore(file);
  assert.equal(s2.getSeq('conv-aaa'), 1);
  assert.equal(s2.getSeq('conv-bbb'), 2);
  assert.equal(s2.assignSeq('conv-ccc'), 3);

  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('resolveRef matches #N, @N, N, UUID prefix, title, and default conversation', () => {
  const file = tempStateFile();
  const store = new StateStore(file);
  const convs = [
    { id: '11111111-aaaa-bbbb-cccc-000000000001', title: 'First Task' },
    { id: '22222222-aaaa-bbbb-cccc-000000000002', title: 'Feishu Bridge' },
  ];
  store.syncConversations(convs);
  store.setDefaultConversationId(convs[1].id);

  assert.equal(store.resolveRef('', convs).id, convs[1].id);
  assert.equal(store.resolveRef('#1', convs).id, convs[0].id);
  assert.equal(store.resolveRef('@2', convs).id, convs[1].id);
  assert.equal(store.resolveRef('1', convs).id, convs[0].id);
  assert.equal(store.resolveRef('22222222', convs).id, convs[1].id);
  assert.equal(store.resolveRef('bridge', convs).id, convs[1].id);
  assert.equal(store.resolveRef('99', convs), null);
});

test('resolveRef prefers top-level conversations over subagents when no defaultConversationId is set', () => {
  const file = tempStateFile();
  const store = new StateStore(file);
  const convs = [
    { id: 'subagent-0001', title: 'Swarm Worker', nestingDepth: 1, parentId: 'top-0001' },
    { id: 'top-0001', title: 'Top Session', nestingDepth: 0, parentId: '' },
  ];
  assert.equal(store.resolveRef('', convs).id, 'top-0001');
});

test('default conversation, pushMode, bindings, seenMessages, messageRoutes, and pushedSteps persist', () => {
  const file = tempStateFile();
  const store = new StateStore(file);
  assert.equal(store.getPushMode(), 'all');
  assert.throws(() => store.setPushMode('invalid'));

  store.setPushMode('bound');
  store.bindConversation('conv-1');
  store.recordMessageRoute('om_100', 'conv-1');
  assert.equal(store.markSeenMessage('om_in_1'), true);
  assert.equal(store.markSeenMessage('om_in_1'), false);
  assert.equal(store.markPushedStep('conv-1', 42), true);
  assert.equal(store.markPushedStep('conv-1', 42), false);

  const reloaded = new StateStore(file);
  assert.equal(reloaded.getPushMode(), 'bound');
  assert.equal(reloaded.isBound('conv-1'), true);
  assert.equal(reloaded.routeMessage('om_100'), 'conv-1');
  assert.equal(reloaded.hasSeenMessage('om_in_1'), true);
  assert.equal(reloaded.hasPushedStep('conv-1', 42), true);
  assert.equal(reloaded.hasPushedStep('conv-1', 43), false);
});
