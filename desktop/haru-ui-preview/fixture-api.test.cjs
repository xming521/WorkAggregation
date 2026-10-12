'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureResponse, allowedApiPaths } = require('./fixture-api.cjs');

test('fixture denies every write and unknown API instead of returning fake success', () => {
  for (const endpoint of allowedApiPaths) for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(fixtureResponse(method, endpoint), null);
  for (const endpoint of ['/api/chat', '/api/chat/conversations/102', '/api/settings/providers/test', '/api/chat/conversations/101/confirm', '/api/anything', '/api/settings?unexpected=1']) assert.equal(fixtureResponse('GET', endpoint), null);
});
test('fixture supports bounded product reads without sharing mutable objects or credentials', () => {
  const result = fixtureResponse('GET', '/api/chat/conversations?include_archived=true');
  assert.equal(result[0].id, 101); result[0].title = 'mutated';
  assert.notEqual(fixtureResponse('GET', '/api/chat/conversations')[0].title, 'mutated');
  const settings = fixtureResponse('GET', '/api/settings');
  assert.equal(settings.chat_auto_approve_writes, false); assert.deepEqual(settings.providers, []); assert.equal(settings.base_url, ''); assert.equal('api_key' in settings, false);
});
test('synthetic timeline obeys the real display identity contract', () => {
  const page = fixtureResponse('GET', '/api/chat/conversations/101/timeline?limit=200&cursor=fixture-end');
  assert.equal(page.conversation_id, 101); assert.equal(page.next_cursor, null);
  for (const item of page.items) assert.equal(item.item_id, `turn:${item.turn_id}:${item.payload.item_id}`);
});
