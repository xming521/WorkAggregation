import assert from 'node:assert/strict';

export function preferenceObservation(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value;
  return 'invalid-type';
}

export function assertDevToolsPreference(value, runtimeElectron, proof) {
  if (value !== undefined) {
    assert.equal(value, false, 'reported packaged devTools preference must be explicitly false');
    return;
  }
  // Electron 44.5.1 can omit this constructor-only preference. Missing is not
  // equivalent to false: require the exact version and verified source policy.
  assert.equal(runtimeElectron, '44.5.1', 'missing devTools getter is supported only for exact Electron 44.5.1');
  assert.deepEqual(proof, { lockedElectron: '44.5.1', installedSourcesHashMatched: true,
    ownerPackagedDisabled: true, haruDisabled: true }, 'missing devTools getter requires exact hash-bound packaged constructor policies');
}

export function assertDevToolsProbe(probe) {
  assert.deepEqual(probe, { beforeOpen: false, beforeContents: false, openedEvent: false,
    afterOpen: false, afterContents: false }, 'installed renderer must reject opening DevTools without any event or contents');
}

// Serialized by Playwright into the real Electron main process. This observes
// the existing product window and never patches preferences or closes a probe
// window to convert a security failure into passing evidence.
export async function probeDevToolsDisabled({ BrowserWindow }, windowId) {
  const windows = BrowserWindow.getAllWindows().filter(win => win.id === windowId);
  if (windows.length !== 1) throw new Error('exact-product-window-required');
  const contents = windows[0].webContents;
  const beforeOpen = contents.isDevToolsOpened();
  const beforeContents = Boolean(contents.devToolsWebContents);
  let openedEvent = false;
  const opened = () => { openedEvent = true; };
  contents.on('devtools-opened', opened);
  try {
    if (!beforeOpen && !beforeContents) contents.openDevTools({ mode: 'detach', activate: false });
    await new Promise(resolve => setTimeout(resolve, 1000));
    return { beforeOpen, beforeContents, openedEvent,
      afterOpen: contents.isDevToolsOpened(), afterContents: Boolean(contents.devToolsWebContents) };
  } finally { contents.removeListener('devtools-opened', opened); }
}
