import { describe, expect, it } from 'vitest';
import { acceptCompanionSnapshot, blocksCompanion, canPresentBid, companionMirror } from './model';
import type { CompanionSignals, CompanionSnapshot } from './contracts';
export const signals: CompanionSignals = { visible: true, typing: false, work_running: false, awaiting_approval: false, mock_interview: false, quiet: false, failure: false };
export const snapshot: CompanionSnapshot = { identity: 'one', revision: 4, persona_version: 'companion-v1', settings: { enabled: true, proactivity: 'default', hide_status: false }, state: { interests: [], activity: null, wish: null }, recent_events: [], shared_participation: [], presence: { session_id: 'session', session_quiet: false, active: true, blocked: false, blockers: [] } };
describe('companion life presentation safety', () => {
  it.each(['typing', 'work_running', 'awaiting_approval', 'mock_interview', 'quiet', 'failure'] as const)('suppresses a bid and mirror for %s', key => {
    const blocked = { ...signals, [key]: true };
    expect(blocksCompanion(blocked)).toBe(true);
    expect(companionMirror(snapshot, blocked)).toBeUndefined();
    expect(canPresentBid({ id: 'bid', kind: 'companion_life', result_text: 'hello', source_identity: 'one', source_revision: 4 }, snapshot, blocked)).toBe(false);
  });
  it('rejects stale responses and never restores data from before reset', () => {
    expect(acceptCompanionSnapshot(snapshot, { ...snapshot, revision: 3 })).toBe(snapshot);
    const reset = { ...snapshot, identity: 'two', revision: 5 };
    expect(acceptCompanionSnapshot(snapshot, reset)).toBe(reset);
    expect(acceptCompanionSnapshot(reset, snapshot)).toBe(reset);
  });
  it('checks identity, revision, disabled, hidden and invisible again after transport', () => {
    const bid = { id: 'bid', kind: 'companion_life' as const, result_text: 'hello', source_identity: 'one', source_revision: 4 };
    expect(canPresentBid(bid, snapshot, signals)).toBe(true);
    for (const current of [{ ...snapshot, revision: 5 }, { ...snapshot, identity: 'two' }, { ...snapshot, settings: { ...snapshot.settings, enabled: false } }, { ...snapshot, settings: { ...snapshot.settings, hide_status: true } }, { ...snapshot, settings: { ...snapshot.settings, proactivity: 'off' as const } }]) expect(canPresentBid(bid, current, signals)).toBe(false);
    expect(canPresentBid(bid, snapshot, { ...signals, visible: false })).toBe(false);
  });
});
