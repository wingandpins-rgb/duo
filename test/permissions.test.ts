import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../src/server/bus.ts';
import { PermissionBroker } from '../src/server/permissions.ts';

test('a permission bridge secret speaks for its own chat and nothing else', () => {
  const perms = new PermissionBroker(new Bus());
  const a = perms.secretFor('chat-a');
  const b = perms.secretFor('chat-b');
  assert.notEqual(a, b);
  assert.equal(perms.secretFor('chat-a'), a, 'one secret per chat');
  assert.equal(perms.chatOf(a), 'chat-a');
  assert.equal(perms.chatOf(b), 'chat-b');
  for (const wrong of [undefined, '', a.slice(1), `${a}x`, 'dev']) assert.equal(perms.chatOf(wrong), undefined);
  perms.forget('chat-a');
  assert.equal(perms.chatOf(a), undefined, 'a deleted chat leaves no working secret');
});
