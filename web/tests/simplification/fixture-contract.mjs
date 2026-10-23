/** Plain Node contract check; deliberately not *.test.* so Vitest does not collect node:test. */
import assert from 'node:assert/strict';
import { createFixtureApi } from '../localization/fixture-api.mjs';
import { createSimplificationFixture, knowledgeTitle, referenceTitle, frozenEvidence } from './fixture-api.mjs';
// /knowledge/notes has an envelope even when empty. A bare [] is an error,
// not an empty ExperienceMaterialsView (see the production service parser).
const localization = createFixtureApi();
assert.deepEqual(localization.handle('GET', '/api/knowledge/notes'), { status: 200, data: { items: [] } });
assert.deepEqual(localization.unexpected, []);
const api = createSimplificationFixture({ firstUse: true, materials: true });
const call = (method, pathname, body) => api.handle(method, `http://127.0.0.1${pathname}`, body);
assert.deepEqual((await call('GET', '/api/knowledge/notes')).data, { items: [] });
assert.deepEqual((await call('GET', '/api/knowledge/sources')).data, []);
const defaults = createSimplificationFixture();
assert.deepEqual((await defaults.handle('GET', '/api/knowledge/notes')).data, { items: [] });
assert.deepEqual((await defaults.handle('GET', '/api/knowledge/sources')).data, []);
const populated = createSimplificationFixture({ materials: true });
const captures = (await populated.handle('GET', '/api/knowledge/notes')).data.items;
assert.equal(captures.length, 1);
const capture = captures[0];
assert.equal(capture.title, knowledgeTitle);
assert.equal(capture.origin_kind, 'confirmed_interview_capture');
assert.equal(capture.source_status, 'source_changed');
assert.ok(Number.isSafeInteger(capture.version_id) && capture.version_id > 0);
assert.deepEqual(capture.capture_metadata, {
  source_id: capture.source_id, origin_note_id: 41, application_event_id: 201,
  note_fingerprint: 'synthetic-confirmed-capture', capture_schema_version: 'interview-note-capture-v1',
  captured_at: capture.captured_at,
});
assert.equal(capture.content.blocks[0].evidence_refs[0].excerpt, frozenEvidence);
assert.equal(capture.evidence[0].excerpt, frozenEvidence);
assert.deepEqual((await populated.handle('GET', '/api/knowledge/note-management')).data.items, captures);
const references = (await populated.handle('GET', '/api/knowledge/sources')).data;
assert.equal(references.length, 1);
assert.equal(references[0].title, referenceTitle);
assert.equal(references[0].source_kind, 'markdown');
assert.notEqual(references[0].id, capture.source_id);
assert.deepEqual((await populated.handle('GET', '/api/interview-stories')).data, []);
assert.deepEqual(populated.unexpected, []);
assert.equal((await call('GET', '/api/settings')).data.has_api_key, false);
await call('PATCH', '/api/onboarding', { force_open: false });
await call('PUT', '/api/settings', { model: 'draft', chat_auto_approve_writes: false });
assert.equal((await call('GET', '/api/onboarding')).data.dismissed, true);
const create = { idempotency_key: 'fixture-request', company_name: 'Synthetic', position_name: 'Tester', initial_jd: null };
assert.equal((await call('POST', '/api/applications', create)).data.id, 102);
assert.equal((await call('POST', '/api/applications', create)).data.id, 102);
assert.equal(api.snapshot().applications.length, 1);
const release = api.holdNext('POST', '/api/knowledge/notes/7/lifecycle');
let settled = false;
const pending = call('POST', '/api/knowledge/notes/7/lifecycle', { mutation_id: 'x', confirmed: true, action: 'revise', title: 'new', blocks: [] }).then(value => { settled = true; return value; });
await Promise.resolve(); assert.equal(settled, false);
release({ status: 503, data: { error_code: 'synthetic_uncertain' } });
assert.equal((await pending).status, 503); assert.equal(api.snapshot().note.version_id, 21);
assert.throws(() => api.holdNext('POST', '/api/chat'));
assert.equal((await call('POST', '/api/chat', { message: 'No model allowed' })).status, 501);
assert.equal((await call('GET', '/api/not-defined')).status, 501);
assert.equal(api.unexpected.length, 2);
api.releaseAll();
console.log('PASS strict synthetic fixture contracts; this is not a browser result.');
