import assert from 'node:assert/strict';
import { verifyHaruVisual } from './haru-visual.mjs';
import { invokeTrayAction } from './haru-probes.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
export async function readNativeWindow(app, page) {
  const window = await app.browserWindow(page);
  try {
    return await window.evaluate(win => ({ visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(),
      bounds: win.getBounds(), backgroundColorRgb: win.getBackgroundColor() }));
  } finally { await window.dispose(); }
}
async function actWindow(app, page, action) {
  const window = await app.browserWindow(page);
  try {
    await window.evaluate((win, action) => {
      if (action === 'minimize') win.minimize();
      else if (action === 'close') win.close();
      else if (action === 'focus') { win.show(); win.focus(); }
    }, action);
  } finally { await window.dispose(); }
}
export function nativeHandles({ BrowserWindow }, ids) {
  const owner = BrowserWindow.fromId(ids.owner), haru = BrowserWindow.fromId(ids.haru);
  if (!owner || !haru || owner === haru || owner.isDestroyed() || haru.isDestroyed()) throw new Error('Owned surfaces required');
  const handle = win => {
    const bytes = win.getNativeWindowHandle();
    if (![4, 8].includes(bytes.length)) throw new Error('Unsupported native handle');
    return (bytes.length === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE())).toString();
  };
  return { pid: process.pid, owner: handle(owner), haru: handle(haru) };
}
export function assertRestoredWindow(before, after, mode) {
  if (mode === 'minimized') assert.equal(before.minimized, true);
  else if (mode === 'hidden-after-close') assert.equal(before.visible, false);
  else { assert.equal(mode, 'background'); assert.equal(before.visible, true); assert.equal(before.focused, false); }
  assert.equal(after.visible, true); assert.equal(after.minimized, false); assert.equal(after.focused, true);
}

// Installed production main/backend/renderer only. No controller replacement,
// backend fixtures, synthetic history publication or credential configuration.
export async function probeInstalledHaruWindows({ app, page, haru, ids, waitUntil, nativeInput, capture, checkpoint, setStage }) {
  const result = { realInstalledWindows: true, realOsPointer: false, themeChecks: [], restores: [],
    historyAndDrafts: 'deferred-to-same-exe-offline-mock', nativeOsCompositionCaptured: false,
    osAlphaCompositionRequiresHumanReview: true };
  const state = () => haru.evaluate(() => window.offerpilotDesktop.getState());
  const frame = async (label, expanded, theme) => {
    setStage(`haru-frame-${label}`);
    await actWindow(app, haru, 'focus');
    return verifyHaruVisual(haru, async visual => {
      await capture(label, haru, { omitBackground: !expanded, visual });
    }, { requireExpanded: expanded, theme });
  };
  const exitPilot = async () => {
    setStage('haru-exit-pilot');
    await button(page, '退出沉浸模式，返回原页面').click();
    await page.waitForURL(url => url.searchParams.get('view') === 'dashboard');
    await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor();
  };
  const enterPilot = async () => {
    setStage('haru-enter-pilot');
    await button(haru, '打开 OfferPilot 主窗口').click();
    await page.waitForURL(url => url.searchParams.get('view') === 'pilot');
    await page.locator('.op-pilot-page-host').waitFor({ state: 'visible' });
    await waitUntil(async () => { const value = await readNativeWindow(app, page); return value.visible && !value.minimized && value.focused; });
  };
  await frame('collapsed-live2d', false);
  const beforeDrag = await readNativeWindow(app, haru);
  const avatar = await haru.locator('.desktop-haru-avatar').boundingBox();
  assert.ok(avatar);
  const viewport = await haru.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const handles = await app.evaluate(nativeHandles, ids);
  const drag = await nativeInput('Drag', handles, { x: (avatar.x + avatar.width / 2) / viewport.width, y: (avatar.y + avatar.height / 2) / viewport.height });
  assert.equal(drag.ownedNativeDrag, true);
  await waitUntil(async () => { const after = await readNativeWindow(app, haru); return Math.abs(after.bounds.x - beforeDrag.bounds.x) + Math.abs(after.bounds.y - beforeDrag.bounds.y) >= 10; });
  assert.equal((await state()).expanded, false, 'native drag must not expand Haru');
  result.realOsPointer = true; result.drag = { before: beforeDrag.bounds, after: (await readNativeWindow(app, haru)).bounds };
  await frame('after-native-drag', false);
  await checkpoint('haru-native-drag', result.drag);

  await button(haru, '展开 Haru 对话').click();
  await frame('expanded-static', true);
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  assert.ok(['light', 'dark'].includes(originalTheme));
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await button(page, '切换明暗模式').click();
    await haru.waitForFunction(theme => document.querySelector('.desktop-haru')?.getAttribute('data-theme') === theme, theme);
    await frame(`expanded-${theme}`, true, theme);
    await button(haru, '将 Haru 收到托盘').click();
    await waitUntil(async () => !(await readNativeWindow(app, haru)).visible && !(await state()).visible);
    assert.equal(haru.isClosed(), false);
    assert.equal(await haru.locator('.desktop-haru canvas').count(), 0, 'hidden expanded static view must not create a runtime');
    await app.evaluate(invokeTrayAction, 'show');
    await waitUntil(async () => (await readNativeWindow(app, haru)).visible);
    await frame(`reshown-${theme}`, true, theme);
    await button(haru, '收起 Haru 对话').click();
    await frame(`collapsed-${theme}`, false, theme);
    // Hiding the collapsed model must dispose its actual runtime and canvas.
    await app.evaluate(invokeTrayAction, 'hide');
    await waitUntil(async () => !(await readNativeWindow(app, haru)).visible);
    await haru.locator('.desktop-haru-portrait[data-runtime-state="hidden"]').waitFor({ state: 'attached' });
    assert.equal(await haru.locator('.desktop-haru canvas').count(), 0);
    await app.evaluate(invokeTrayAction, 'show');
    await frame(`reshown-collapsed-${theme}`, false, theme);
    await button(haru, '展开 Haru 对话').click();
    await frame(`reopened-${theme}`, true, theme);
    result.themeChecks.push({ theme, expandedStatic: true, collapsedLive2d: true, hiddenRuntimeDisposed: true });
  }
  if (await page.locator('html').getAttribute('data-theme') !== originalTheme) await button(page, '切换明暗模式').click();
  await haru.waitForFunction(theme => document.querySelector('.desktop-haru')?.getAttribute('data-theme') === theme, originalTheme);
  await checkpoint('haru-installed-themes-and-three-states', { themeChecks: result.themeChecks });

  const baseline = await state();
  await enterPilot();
  for (const mode of ['minimized', 'hidden-after-close', 'background']) {
    await exitPilot();
    if (mode === 'minimized') {
      await actWindow(app, page, 'minimize'); await waitUntil(async () => (await readNativeWindow(app, page)).minimized);
    } else if (mode === 'hidden-after-close') {
      await actWindow(app, page, 'close'); await waitUntil(async () => !(await readNativeWindow(app, page)).visible);
    } else {
      await actWindow(app, haru, 'focus'); await waitUntil(async () => !(await readNativeWindow(app, page)).focused);
    }
    const before = await readNativeWindow(app, page);
    await enterPilot();
    const after = await readNativeWindow(app, page);
    assertRestoredWindow(before, after, mode);
    const restored = await state();
    assert.equal(restored.generation, baseline.generation); assert.equal(restored.snapshot.conversationId, baseline.snapshot.conversationId);
    assert.equal(page.isClosed(), false);
    result.restores.push({ mode, before, after, sameGeneration: true, sameConversationId: true });
    await capture(`owner-restored-${mode}`, page);
  }
  for (let index = 0; index < 3; index++) await enterPilot();
  assert.equal((await state()).snapshot.conversationId, baseline.snapshot.conversationId);
  await checkpoint('haru-real-pilot-navigation-and-restores', { restores: result.restores, repeatedHandoffs: 3,
    persistedConversationExercised: false });
  await exitPilot();
  await button(haru, '收起 Haru 对话').click();
  await frame('final-collapsed', false);

  // Last: a native capture failure preserves all earlier functional evidence,
  // but still fails the installed run. Only this process's own window pixels.
  const ownerWindow = await app.browserWindow(page);
  const previous = await ownerWindow.evaluate(win => ({ bounds: win.getBounds(), maximized: win.isMaximized() }));
  try {
    await ownerWindow.evaluate(win => { win.show(); win.maximize(); });
    await waitUntil(() => ownerWindow.evaluate(win => win.isMaximized()));
    await frame('before-os-composition', false);
    const composition = await nativeInput('Capture', handles);
    assert.equal(composition.nativeScreenCapture, true); assert.equal(composition.imageEdited, false);
    assert.equal(composition.ownWindowSamples, 25); assert.ok(composition.haruWindowSamples > 0);
    result.nativeOsCompositionCaptured = true; result.osComposition = composition;
  } finally {
    await ownerWindow.evaluate((win, previous) => { if (!previous.maximized) { win.unmaximize(); win.setBounds(previous.bounds); } }, previous);
    await waitUntil(() => ownerWindow.evaluate((win, previous) => win.isMaximized() === previous.maximized
      && Object.entries(previous.bounds).every(([key, value]) => Math.abs(win.getBounds()[key] - value) <= 1), previous));
    await ownerWindow.dispose();
  }
  await checkpoint('haru-owned-native-composition', result.osComposition);
  return result;
}
