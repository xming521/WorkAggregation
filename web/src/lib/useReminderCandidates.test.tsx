// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderCandidate } from '@/types/reminders';
const list = vi.hoisted(() => vi.fn());
vi.mock('@/services/reminders', () => ({ listReminderCandidates: list }));
import { useReminderCandidates } from './useReminderCandidates';
const fact = (id: string) => ({ id } as ReminderCandidate);
let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
function View() {
  const query = useReminderCandidates();
  return <div>{query.isPending ? 'checking' : query.isError ? 'error' : JSON.stringify(query.data)}</div>;
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  list.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
describe('shared reminder source invalidation', () => {
  it.each([false, true])('fences stale response and refetches on source changes, with cache=%s', async (cached) => {
    let resolveOld!: (value: ReminderCandidate[]) => void;
    let resolveNew!: (value: ReminderCandidate[]) => void;
    const old = new Promise<ReminderCandidate[]>((resolve) => { resolveOld = resolve; });
    const next = new Promise<ReminderCandidate[]>((resolve) => { resolveNew = resolve; });
    if (cached) list.mockResolvedValueOnce([fact('cached')]);
    list.mockReturnValueOnce(old).mockReturnValueOnce(next);
    await act(async () => root.render(<QueryClientProvider client={client}><View /></QueryClientProvider>));
    await flush();
    if (cached) {
      expect(host.textContent).toContain('cached');
      await act(async () => { void client.invalidateQueries({ queryKey: ['reminder-candidates'] }); });
      await flush();
    }
    expect(host.textContent).toBe('checking');
    await act(async () => { client.setQueryData(['events'], [{ id: 1, status: 'done' }]); });
    await flush();
    expect(list).toHaveBeenCalledTimes(cached ? 3 : 2);
    await act(async () => { resolveOld([fact('outdated')]); });
    await flush();
    expect(host.textContent).toBe('checking');
    await act(async () => { resolveNew([fact('current')]); });
    await flush();
    expect(host.textContent).toContain('current');
    expect(host.textContent).not.toContain('outdated');
  });
});
