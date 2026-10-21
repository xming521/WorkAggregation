import type { CompanionBid, CompanionMirror, CompanionSignals, CompanionSnapshot } from './contracts';
export function blocksCompanion(signals: CompanionSignals): boolean {
  return !signals.visible || signals.typing || signals.work_running || signals.awaiting_approval || signals.mock_interview || signals.quiet || signals.failure;
}
/** Backend revisions remain monotonic across resets and identity changes. */
export function acceptCompanionSnapshot(current: CompanionSnapshot | null, next: CompanionSnapshot): CompanionSnapshot {
  if (!current) return next;
  if (current.identity !== next.identity) return next.revision > current.revision ? next : current;
  return next.revision >= current.revision ? next : current;
}
export function canPresentBid(bid: CompanionBid, snapshot: CompanionSnapshot | null, signals: CompanionSignals): boolean {
  return Boolean(snapshot && snapshot.settings.enabled && snapshot.settings.proactivity !== 'off'
    && !snapshot.settings.hide_status && !snapshot.presence.blocked && !blocksCompanion(signals)
    && bid.source_identity === snapshot.identity && bid.source_revision === snapshot.revision);
}
export function companionMirror(snapshot: CompanionSnapshot | null, signals: CompanionSignals): CompanionMirror | undefined {
  if (!snapshot?.settings.enabled || snapshot.settings.hide_status || blocksCompanion(signals) || snapshot.presence.blocked) return undefined;
  const activity = snapshot.state.activity;
  return { virtual: true, title: activity?.title ?? 'Haru 的虚拟日常', detail: activity?.step_title ?? '有空时，看看 Haru 在做什么。', status: activity?.status ?? 'idle' };
}
