import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiDiagnostic, sanitizeUiDiagnostic } from '../ui-diagnostics.mjs';
import { safeResults } from '../safe-evidence.mjs';
import { CASES } from '../contract.mjs';

test('fixed UI stage captures only target existence uniqueness and visibility', async () => {
  const diagnostic = createUiDiagnostic();
  diagnostic.mark('PROVIDER_ENDPOINT', { count: async () => 0, isVisible: async () => { throw new Error('must not read absent target'); } });
  assert.deepEqual(await diagnostic.snapshot(), { stage: 'PROVIDER_ENDPOINT', targetProbed: true,
    targetFound: false, targetUnique: false, targetVisible: false });
  diagnostic.mark('PROVIDER_CONTEXT', { count: async () => 1, isVisible: async () => true });
  assert.deepEqual(await diagnostic.snapshot(), { stage: 'PROVIDER_CONTEXT', targetProbed: true,
    targetFound: true, targetUnique: true, targetVisible: true });
});
test('untrusted stage and locator errors never disclose text or obscure primary failure', async () => {
  const diagnostic = createUiDiagnostic();
  diagnostic.mark('private-secret-stage', { count: async () => { throw new Error('private-key'); } });
  const result = await diagnostic.snapshot();
  assert.equal(result.stage, 'UNSPECIFIED'); assert.equal(result.targetProbed, false);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.deepEqual(sanitizeUiDiagnostic({ stage: 'PROVIDER_KEY', raw: 'private-secret', targetVisible: 'yes' }),
    { stage: 'PROVIDER_KEY', targetProbed: false, targetFound: false, targetUnique: false, targetVisible: false });
});
test('ambiguous target is never treated as actionable and evidence drops extra data', async () => {
  const diagnostic = createUiDiagnostic();
  diagnostic.mark('CONNECTION_CLICK', { count: async () => 2, isVisible: async () => { throw new Error('must not inspect ambiguous target'); } });
  const d = await diagnostic.snapshot(); assert.equal(d.targetUnique, false); assert.equal(d.targetVisible, false);
  const result = safeResults(CASES.map(id => ({ id, status: 'FAIL', code: 'UI_TIMEOUT', checks: {},
    diagnostic: { ...d, rawError: 'private-key', inputValue: 'private-key' } })));
  assert.equal(result[0].diagnostic.stage, 'CONNECTION_CLICK');
  assert.doesNotMatch(JSON.stringify(result), /private-key|inputValue|rawError/);
});

test('stalled diagnostic locator returns after fixed short bound without replacing the stage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const diagnostic = createUiDiagnostic();
  diagnostic.mark('PROVIDER_JSON_SCHEMA', { count: () => new Promise(() => {}), isVisible: async () => true });
  const pending = diagnostic.snapshot();
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, { stage: 'PROVIDER_JSON_SCHEMA', targetProbed: false,
    targetFound: false, targetUnique: false, targetVisible: false });
});

test('mirror diagnosis contains only fixed booleans, never identifiers or prose', async () => {
  const diagnostic = createUiDiagnostic();
  diagnostic.mark('PILOT_RUNNING');
  diagnostic.mirror({ ownerConnected: true, ownerRunningPositiveSeen: true, ownerRunningNullSeen: false,
    haruRunningDomSeen: 'true', conversationId: 123, rawMessage: 'private response', token: 'private-key' });
  const value = await diagnostic.snapshot();
  assert.equal(value.mirror.ownerConnected, true);
  assert.equal(value.mirror.ownerRunningPositiveSeen, true);
  assert.equal(value.mirror.haruRunningDomSeen, false);
  assert.doesNotMatch(JSON.stringify(value), /123|private|conversationId|rawMessage|token/);
  diagnostic.mark('CASE_START');
  assert.equal((await diagnostic.snapshot()).mirror, undefined);
});

test('LIVE evidence allowlist preserves null observations and drops arbitrary source values', async () => {
  const diagnostic = createUiDiagnostic();
  diagnostic.pilotProof({ fault: 'STATUS_IDENTITY_INVALID', faultStage: 'STATUS_AND_MIRROR_READ',
    lastReadStage: 'STATUS_AND_MIRROR_READ', elapsedMs: 42, elapsedCapped: false, pollCount: 1,
    admissionObserved: true, admissionValid: true, lastValidState: null,
    workerDone: null, actualWorkerAlive: null, lastReadOutcome: 'OK', lastHttpStatus: 200,
    request_id: 'private-id', text: 'private-text', url: 'https://private', rawError: 'private-error' });
  const value = await diagnostic.snapshot();
  assert.equal(value.pilotProof.fault, 'STATUS_IDENTITY_INVALID');
  assert.equal(value.pilotProof.lastValidState, null); assert.equal(value.pilotProof.workerDone, null);
  assert.doesNotMatch(JSON.stringify(value), /private|request_id|rawError|url/);
  const safe = safeResults(CASES.map(id => ({ id, status: 'BLOCKED', code: 'LIVE_COMPLETION_UNPROVEN', checks: {}, diagnostic: value })));
  assert.deepEqual(safe[1].diagnostic.pilotProof, value.pilotProof);
  diagnostic.mark('CASE_START'); assert.equal((await diagnostic.snapshot()).pilotProof, undefined);
  const unknown = sanitizeUiDiagnostic({ pilotProof: { fault: 'private', elapsedMs: Infinity, pollCount: -1,
    lastValidState: 'private', admissionObserved: 'true', workerDone: 'false' } }).pilotProof;
  assert.equal(unknown.fault, 'UNEXPECTED_FAILURE'); assert.equal(unknown.elapsedMs, null);
  assert.equal(unknown.admissionObserved, null); assert.equal(unknown.workerDone, null);
  assert.doesNotMatch(JSON.stringify(unknown), /private/);
});
