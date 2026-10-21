import { t } from '@/i18n';
import type { CompanionMirror } from './contracts';
/** Only finite authored life templates, never user/assistant message prose. */
export function companionInvitation(kind: CompanionMirror['invitation'], title: string, step: string) {
  if (kind === 'activity_completed') return t('在虚拟的小世界里，完成了「{activity}」。', { activity: t(title) });
  if (kind === 'activity_started') return t('在虚拟的小世界里，开始「{activity}」。', { activity: t(title) });
  return t('在虚拟的小世界里，正在「{step}」。', { step: t(step) });
}
