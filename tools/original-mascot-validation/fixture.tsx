import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import PilotMascot from '../../web/src/features/pilotMascot/PilotMascot';
import CalendarHaruPresentation from '../../web/src/features/assistantSurface/CalendarHaruPresentation';
import DesktopHaruWindow from '../../web/src/features/assistantSurface/DesktopHaruWindow';
import { ThemeProvider } from '../../web/src/theme/ThemeContext';
import { setMascotCharacter } from '../../web/src/features/pilotMascot/mascotCharacter';
import type { DesktopHaruState } from '../../web/src/features/assistantSurface/desktopHaru';
import '../../web/src/theme/tokens.css';
import './fixture.css';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const animation = params.get('animation') === 'off' ? 'off' : 'full';
const character = params.get('character') === 'unset' ? undefined : params.get('character') === 'legacy' ? 'legacy' : 'original-preview';
localStorage.setItem('op-theme', theme);
if (character) localStorage.setItem('offerpilot.mascot.characterPreview', character);
else localStorage.removeItem('offerpilot.mascot.characterPreview');
localStorage.setItem('offerpilot.haru.presentationMode', params.get('presentation') === 'compact' ? 'compact' : 'character');
let state: DesktopHaruState = {
  connected: true, generation: 1, visible: true, expanded: false, alwaysOnTop: false,
  snapshot: { version: 1, theme, character, animationLevel: animation, conversationId: null, taskState: 'idle',
    messages: [{ role: 'assistant', content: '这是本地静态验收对话，没有调用后端或模型。' }], contextLabel: '本地预览',
    loading: false, hasPending: false, canSend: false, canStop: false, stopping: false, error: '', stopMessage: '' },
};
const listeners = new Set<(value: DesktopHaruState) => void>();
const actions: string[] = [];
const publish = () => listeners.forEach(listener => listener(state));
window.offerpilotDesktop = {
  role: 'haru', getState: async () => state,
  onState(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async windowAction(action) {
    actions.push(action);
    if (action === 'expand' || action === 'collapse') state = { ...state, expanded: action === 'expand' };
    if (action === 'hide-haru') state = { ...state, visible: false };
    publish(); return true;
  },
  dragWindow: async phase => { actions.push(`drag:${phase}`); return true; },
};
const root = createRoot(document.getElementById('root')!);
function Fixture() {
  const [panelOpen, setPanelOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const surface = params.get('surface') || 'desktop';
  return <ThemeProvider>{surface === 'desktop' ? <DesktopHaruWindow /> : <>
    <div className="fixture-label">Production {surface} component · {theme}</div>
    {surface === 'pilot' ? <PilotMascot activity="idle" panelOpen={panelOpen} animationLevel={animation} onTogglePilot={() => setPanelOpen(v => !v)} onHide={() => root.unmount()} />
      : <CalendarHaruPresentation activity="idle" panelOpen={panelOpen} animationLevel={animation} triggerRef={trigger} onAnchorRectChange={() => {}} onToggle={() => setPanelOpen(v => !v)} />}
    <output data-panel-open={String(panelOpen)} />
  </>}</ThemeProvider>;
}
// Test controls change only public preferences/bridge snapshots, never the runtime.
Object.assign(window, { fixture: {
  actions,
  switchCharacter(next: 'legacy' | 'original-preview') {
    setMascotCharacter(next);
    state = { ...state, snapshot: { ...state.snapshot!, character: next } }; publish();
  },
  visible(visible: boolean) { state = { ...state, visible }; publish(); },
  unmount() { root.unmount(); },
  subscriptions() { return listeners.size; },
} });
root.render(<Fixture />);
