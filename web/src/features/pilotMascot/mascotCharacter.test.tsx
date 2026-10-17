// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MASCOT_CHARACTER_KEY, readMascotCharacter, setMascotCharacter, useMascotCharacter } from './mascotCharacter';
vi.mock('./live2dRuntime', () => ({ live2dPilotMascotRuntime: { kind: 'legacy' } }));
vi.mock('./riveRuntime', () => ({ rivePilotMascotRuntime: { kind: 'original' } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => localStorage.clear());
it('is opt-in and rejects unrecognized stored values', () => {
  expect(readMascotCharacter()).toBe('legacy');
  for (const value of ['true', 'original', 'https://untrusted.example/character.riv', '{}']) {
    localStorage.setItem(MASCOT_CHARACTER_KEY, value);
    expect(readMascotCharacter()).toBe('legacy');
  }
  setMascotCharacter('original-preview');
  expect(readMascotCharacter()).toBe('original-preview');
  setMascotCharacter('legacy');
  expect(readMascotCharacter()).toBe('legacy');
});
it('notifies mounted consumers on same-window choice and cross-window storage updates', () => {
  const values: string[] = [];
  function Consumer() { const { character } = useMascotCharacter(); values.push(character); return null; }
  const host = document.createElement('div'); const root = createRoot(host);
  act(() => root.render(<Consumer />));
  act(() => setMascotCharacter('original-preview'));
  expect(values[values.length - 1]).toBe('original-preview');
  act(() => {
    localStorage.setItem(MASCOT_CHARACTER_KEY, 'legacy');
    window.dispatchEvent(new StorageEvent('storage', { key: MASCOT_CHARACTER_KEY }));
  });
  expect(values[values.length - 1]).toBe('legacy');
  act(() => root.unmount());
});
