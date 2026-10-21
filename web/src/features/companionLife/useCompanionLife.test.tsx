// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompanion, sendCompanionCommand, reportCompanionPresence, claimCompanionBid } from '@/services/companion';
import { useCompanionLifeController, type CompanionLifeController } from './useCompanionLife';
import type { CompanionSnapshot } from './contracts';
import type { DesktopHaruState } from '@/features/assistantSurface/desktopHaru';
import type { PilotConversationController } from '@/features/assistantSurface/usePilotConversationController';
vi.mock('@/services/companion', () => ({ getCompanion: vi.fn(), sendCompanionCommand: vi.fn(), reportCompanionPresence: vi.fn(), claimCompanionBid: vi.fn() }));
const state: CompanionSnapshot = { identity: 'one', revision: 4, persona_version: 'companion-v1', settings: { enabled: true, proactivity: 'default', hide_status: false }, state: { interests: [], activity: { id: 'activity', template_id: 'paper_boat', title: '折一只纸小船', status: 'active', step_index: 0, step_count: 3, step_title: '挑一张想象中的彩纸', participants: ['companion'], promise: null, started_at: 1, updated_at: 1 }, wish: null }, recent_events: [], shared_participation: [], presence: { session_id: 'session', session_quiet: false, active: true, blocked: false, blockers: [] } };
let root: Root; let host: HTMLDivElement; let life: CompanionLifeController; let controller: PilotConversationController;
function Harness() { life = useCompanionLifeController(controller); return null; }
const render = async () => { await act(async () => { root.render(<Harness />); }); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.clearAllMocks();
  controller = { composerDraft: '', loading: false, pending: null, activePendingRef: { current: null }, executionControl: { execution: null }, taskState: 'idle', lastError: '', confirmError: '' } as unknown as PilotConversationController;
  vi.mocked(getCompanion).mockResolvedValue(structuredClone(state));
  vi.mocked(sendCompanionCommand).mockImplementation(async () => structuredClone(state));
  vi.mocked(reportCompanionPresence).mockResolvedValue(state.presence);
  vi.mocked(claimCompanionBid).mockResolvedValue(null);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); delete window.offerpilotDesktop; });
describe('single companion life controller', () => {
  it('uses one app-open event and locks repeat clicks until completion', async () => {
    await render(); expect(sendCompanionCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendCompanionCommand).mock.calls[0][0]).toMatchObject({ body: { event: 'app_open' } });
    const pending = deferred<CompanionSnapshot>(); vi.mocked(sendCompanionCommand).mockReturnValue(pending.promise);
    act(() => { void life.event('pause', true); void life.event('pause', true); });
    expect(sendCompanionCommand).toHaveBeenCalledTimes(2);
    expect(life.busy).toBe(true);
    await act(async () => pending.resolve({ ...state, revision: 5 }));
    expect(life.busy).toBe(false); expect(life.snapshot?.revision).toBe(5);
  });
  it('retries an uncertain operation with exactly the original receipt, not a second command', async () => {
    await render(); vi.mocked(sendCompanionCommand).mockRejectedValueOnce(new Error('lost reply'));
    await act(async () => { await life.event('join', true); });
    const original = vi.mocked(sendCompanionCommand).mock.calls.slice(-1)[0][0];
    expect(life.uncertain).toBe(true);
    act(() => { void life.event('join', true); }); expect(sendCompanionCommand).toHaveBeenCalledTimes(2);
    await act(async () => { await life.retry(); });
    expect(vi.mocked(sendCompanionCommand).mock.calls.slice(-1)[0][0]).toEqual(original);
    expect(life.uncertain).toBe(false);
  });
  it('drops an in-flight bid if typing begins and does not send heartbeat advancement events', async () => {
    await render(); const pending = deferred<Awaited<ReturnType<typeof claimCompanionBid>>>(); vi.mocked(claimCompanionBid).mockReturnValue(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    controller = { ...controller, composerDraft: 'draft' }; await render();
    await act(async () => pending.resolve({ id: 'bid', kind: 'companion_life', result_text: 'hello', source_revision: 4, source_identity: 'one' }));
    expect(life.bid).toBeNull(); expect(life.mirror).toBeUndefined();
    const sequences = vi.mocked(reportCompanionPresence).mock.calls.map(call => call[2]);
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(true);
    expect(sendCompanionCommand).toHaveBeenCalledTimes(1);
    expect(reportCompanionPresence).toHaveBeenLastCalledWith('one', expect.any(String), expect.any(Number), expect.objectContaining({ typing: true }));
  });
  it('a stale command refreshes current state without replay and reset rejects old reads', async () => {
    await render(); vi.mocked(sendCompanionCommand).mockRejectedValueOnce({ response: { status: 409 } });
    vi.mocked(getCompanion).mockResolvedValueOnce({ ...state, revision: 6 });
    await act(async () => { await life.event('pause', true); });
    expect(life.snapshot?.revision).toBe(6); expect(life.uncertain).toBe(false); expect(sendCompanionCommand).toHaveBeenCalledTimes(2);
    vi.mocked(sendCompanionCommand).mockResolvedValueOnce({ ...state, identity: 'reset', revision: 7 });
    await act(async () => { await life.reset(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(life.snapshot?.identity).toBe('reset');
  });
  it('uses the existing desktop state as a conservative expanded-chat interruption guard', async () => {
    let listener!: (value: DesktopHaruState) => void;
    const desktop = { connected: true, generation: 1, snapshot: null, visible: true, expanded: true, alwaysOnTop: true };
    window.offerpilotDesktop = { role: 'owner', getState: async () => desktop, onState: callback => { listener = callback; return () => {}; }, windowAction: async () => true };
    await render();
    expect(life.signals.typing).toBe(true); expect(life.mirror).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(claimCompanionBid).not.toHaveBeenCalled();
    await act(async () => { listener({ ...desktop, expanded: false }); });
    expect(life.signals.typing).toBe(false);
  });
  it('converges after another window resets and then disables life, rejecting older reads', async () => {
    await render();
    vi.mocked(getCompanion).mockResolvedValueOnce({ ...state, identity: 'other-window-reset', revision: 5 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(life.snapshot?.identity).toBe('other-window-reset');
    expect(reportCompanionPresence).toHaveBeenLastCalledWith('other-window-reset', expect.any(String), expect.any(Number), expect.anything());
    vi.mocked(getCompanion).mockResolvedValueOnce({ ...state, identity: 'other-window-reset', revision: 6, settings: { ...state.settings, enabled: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(life.mirror).toBeUndefined(); expect(life.snapshot?.settings.enabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(life.snapshot?.identity).toBe('other-window-reset'); expect(life.snapshot?.revision).toBe(6);
  });
  it('restores server-session quiet after reload and waits for a receipt before resuming', async () => {
    const quietState = { ...state, presence: { ...state.presence, session_quiet: true, blocked: true, blockers: ['quiet'] } };
    vi.mocked(getCompanion).mockResolvedValue(quietState);
    vi.mocked(sendCompanionCommand).mockResolvedValue(quietState);
    vi.mocked(reportCompanionPresence).mockResolvedValue(quietState.presence);
    await render(); expect(life.quiet).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(40000); });
    expect(claimCompanionBid).not.toHaveBeenCalled();
    const pending = deferred<CompanionSnapshot>(); vi.mocked(sendCompanionCommand).mockReturnValueOnce(pending.promise);
    act(() => { void life.setQuiet(false); });
    expect(life.quiet).toBe(true);
    expect(vi.mocked(sendCompanionCommand).mock.calls.slice(-1)[0][0]).toMatchObject({ body: { event: 'resume_session' } });
    vi.mocked(reportCompanionPresence).mockResolvedValue(state.presence);
    await act(async () => pending.resolve({ ...state, revision: 5 }));
    expect(life.quiet).toBe(false);
  });
  it('does not overwrite newer server quiet with a presence reply captured at an older revision', async () => {
    await render(); const pending = deferred<Awaited<ReturnType<typeof reportCompanionPresence>>>();
    const quietState = { ...state, revision: 5, presence: { ...state.presence, session_quiet: true, blocked: true, blockers: ['quiet'] } };
    vi.mocked(reportCompanionPresence).mockReturnValueOnce(pending.promise).mockResolvedValue(quietState.presence);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    vi.mocked(getCompanion).mockResolvedValueOnce(quietState);
    await act(async () => { await life.retry(); pending.resolve(state.presence); });
    expect(life.quiet).toBe(true); expect(life.snapshot?.presence.session_quiet).toBe(true);
  });
  it('clears only uncommitted optimistic quiet when another window resets identity', async () => {
    await render(); vi.mocked(sendCompanionCommand).mockRejectedValueOnce(new Error('lost'));
    await act(async () => { await life.setQuiet(true); });
    expect(life.quiet).toBe(true);
    vi.mocked(getCompanion).mockResolvedValueOnce({ ...state, identity: 'reset-elsewhere', revision: 5 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(life.quiet).toBe(false); expect(life.uncertain).toBe(false);
  });
  it('never revives presence after a delayed read completes following unmount', async () => {
    await render(); const pending = deferred<CompanionSnapshot>(); vi.mocked(getCompanion).mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    act(() => root.unmount());
    const afterClose = vi.mocked(reportCompanionPresence).mock.calls.length;
    await act(async () => pending.resolve(state));
    expect(reportCompanionPresence).toHaveBeenCalledTimes(afterClose);
    expect(vi.mocked(reportCompanionPresence).mock.calls.slice(-1)[0][3].visible).toBe(false);
  });
  it('clears optimistic quiet on confirmed rejection and uses the refreshed server choice', async () => {
    await render(); vi.mocked(sendCompanionCommand).mockRejectedValueOnce({ response: { status: 409 } });
    vi.mocked(getCompanion).mockResolvedValueOnce({ ...state, revision: 5 });
    await act(async () => { await life.setQuiet(true); });
    expect(life.quiet).toBe(false); expect(life.uncertain).toBe(false); expect(life.snapshot?.revision).toBe(5);
  });
  it('does not claim bids when the mascot presentation is hidden or replaced by a work surface', async () => {
    await render(); await act(async () => { life.setPresentationAvailable(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(claimCompanionBid).not.toHaveBeenCalled(); expect(life.bid).toBeNull();
  });
  it('suppresses immediately on quiet request and keeps quiet if its result is uncertain', async () => {
    await render(); vi.mocked(sendCompanionCommand).mockRejectedValueOnce(new Error('lost'));
    await act(async () => { await life.setQuiet(true); });
    expect(life.quiet).toBe(true); expect(life.uncertain).toBe(true);
    expect(vi.mocked(sendCompanionCommand).mock.calls.slice(-1)[0][0]).toMatchObject({ body: { event: 'quiet_session' } });
  });
  it('does not claim invitations when disabled, quiet, or work is pending', async () => {
    vi.mocked(getCompanion).mockResolvedValue({ ...state, settings: { ...state.settings, enabled: false } });
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    controller = { ...controller, pending: {} as PilotConversationController['pending'] }; await render();
    expect(claimCompanionBid).not.toHaveBeenCalled(); expect(life.mirror).toBeUndefined();
    expect(reportCompanionPresence).toHaveBeenCalled();
    expect(sendCompanionCommand).not.toHaveBeenCalled();
  });
});
