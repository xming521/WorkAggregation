import { useSyncExternalStore } from 'react';
import { live2dPilotMascotRuntime } from './live2dRuntime';
import { rivePilotMascotRuntime } from './riveRuntime';

export type MascotCharacter = 'legacy' | 'original-preview';
export const MASCOT_CHARACTER_KEY = 'offerpilot.mascot.characterPreview';
const CHANGE_EVENT = 'offerpilot-mascot-character-change';
export function readMascotCharacter(): MascotCharacter {
  try { return localStorage.getItem(MASCOT_CHARACTER_KEY) === 'original-preview' ? 'original-preview' : 'legacy'; }
  catch { return 'legacy'; }
}
export function setMascotCharacter(value: MascotCharacter) {
  localStorage.setItem(MASCOT_CHARACTER_KEY, value);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
function subscribe(callback: () => void) {
  const storageChanged = (event: StorageEvent) => { if (event.key === MASCOT_CHARACTER_KEY || event.key === null) callback(); };
  window.addEventListener('storage', storageChanged);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener('storage', storageChanged);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}
export function useMascotCharacter() {
  const character = useSyncExternalStore(subscribe, readMascotCharacter, () => 'legacy' as const);
  return { character, runtime: character === 'original-preview' ? rivePilotMascotRuntime : live2dPilotMascotRuntime };
}
