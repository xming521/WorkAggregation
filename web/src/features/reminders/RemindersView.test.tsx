// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderCandidate } from '@/types/reminders';

const { query, retry } = vi.hoisted(() => ({ query: { current: {} as Record<string, unknown> }, retry: vi.fn() }));
vi.mock('@/lib/useReminderCandidates', () => ({ useReminderCandidates: () => query.current }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [] }) }));
vi.mock('@/features/jobMail/JobMailInbox', () => ({ default: () => <div data-testid="mail" /> }));
vi.mock('@/components/ProactiveInbox', () => ({ default: () => <div data-testid="proactive" /> }));
vi.mock('@/features/pipeline/ActionDetailDrawer', () => ({ default: ({ insight }: { insight: { id: string } }) => <div role="dialog">{insight.id}</div> }));
vi.mock('antd', () => ({ Input: { Search: () => <input /> }, Select: () => <select /> }));
import RemindersView from './RemindersView';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const fact: ReminderCandidate = { id: 'application:1:stale_application', subject_type: 'application',
  subject_id: 1, reason_code: 'stale_application', source_revision: 'v1', application_id: 1,
  event_id: null, offer_id: null, company: 'Acme', position: 'Engineer', due_at: 1,
  display_from: 1, display_until: null, delivery_due_at: 1, delivery_expires_at: 2,
  updated_at: 0, deadline_label: null };
const render = async () => { await act(async () => root.render(<RemindersView onNavigate={vi.fn()} onOpenDetailById={vi.fn()} />)); };
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  query.current = { data: undefined, isPending: true, isError: false, refetch: retry };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('today reminder facts', () => {
  it('distinguishes loading, failure with old cache, and an empty successful response', async () => {
    await render();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).not.toContain('暂无匹配');
    query.current = { data: [fact], isPending: false, isError: true, refetch: retry };
    await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Acme');
    expect(container.textContent).not.toContain('暂无匹配');
    await act(async () => container.querySelector('button')!.click());
    expect(retry).toHaveBeenCalledTimes(1);
    query.current = { data: [], isPending: false, isError: false, refetch: retry };
    await render();
    expect(container.textContent).toContain('暂无匹配');
    expect(container.querySelector('[data-testid="proactive"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mail"]')).not.toBeNull();
  });

  it('closes the selected action when its source is withdrawn', async () => {
    query.current = { data: [fact], isPending: false, isError: false, refetch: retry };
    await render();
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    query.current = { data: [], isPending: false, isError: false, refetch: retry };
    await render();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
