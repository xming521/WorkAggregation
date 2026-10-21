import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listReminderCandidates } from '@/services/reminders';

export const REMINDER_CANDIDATES_QUERY_KEY = ['reminder-candidates'] as const;
const SOURCE_QUERY_ROOTS = new Set(['applications', 'events', 'calendar', 'offers', 'notes', 'interview-notes', 'interview-preparation']);

/** All surfaces share one read model; callers must distinguish loading/error from []. */
export function useReminderCandidates() {
  const client = useQueryClient();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  useEffect(() => client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && SOURCE_QUERY_ROOTS.has(String(event.query.queryKey[0]))
      && (event.action.type === 'invalidate' || event.action.type === 'success')) {
      void client.invalidateQueries({ queryKey: REMINDER_CANDIDATES_QUERY_KEY }, { cancelRefetch: false });
    }
  }), [client]);
  return useQuery({
    queryKey: [...REMINDER_CANDIDATES_QUERY_KEY, timezone],
    queryFn: () => listReminderCandidates(timezone),
    refetchInterval: 60_000,
    retry: false,
  });
}
