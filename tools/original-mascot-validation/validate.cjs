'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { contentSecurityPolicy } = require('../../desktop/capabilities.cjs');
const { assertSafeArguments, collectSecurityDiagnostics, cleanupAndSave } = require('./security-diagnostics.cjs');
const out = path.join(__dirname, 'evidence'); fs.mkdirSync(out, { recursive: true });
const report = { scope: 'Production-built web components with fake desktop bridge; NOT native executable, OS window, provider, or release validation', commit: process.env.GITHUB_SHA, started: new Date().toISOString(), security: { chromiumSandbox: true, unsafeFallbackAllowed: false }, cases: [], blockedRequests: [], resources: [], versions: { playwright: require('playwright/package.json').version, node: process.version } };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
let server, browserServer, browser, context;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function pixels(buffer) {
  const png = PNG.sync.read(buffer); let visible = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 32) visible++;
  return { png, visible, ratio: visible / (png.width * png.height) };
}
function changed(a, b) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) if ([0,1,2,3].some(c => Math.abs(a.data[i+c] - b.data[i+c]) > 5)) count++;
  return count;
}
async function shot(page, name) { await page.screenshot({ path: path.join(out, `${name}.png`) }); }
async function animated(page) { await page.locator('canvas[data-mascot-renderer="rive"]').waitFor({ state: 'visible', timeout: 22000 }); }
async function fallback(page) {
  const image = page.locator('img[data-mascot-fallback]:visible');
  await image.waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-mascot-fallback]')].some(i => !i.hidden && i.complete && i.naturalWidth > 0));
  assert.equal(await page.locator('canvas[data-mascot-renderer="rive"]').count(), 0);
}
async function metrics(page) {
  return page.evaluate(() => ({ ...window.validationResources(), canvases: document.querySelectorAll('canvas').length, riveCanvases: document.querySelectorAll('canvas[data-mascot-renderer="rive"]').length, fallbackImages: document.querySelectorAll('img[data-mascot-fallback]').length, bridgeSubscriptions: window.fixture.subscriptions(), assetTransfers: performance.getEntriesByType('resource').map(r => ({ name: new URL(r.name).pathname, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize })) }));
}
async function cleanup(page, result) {
  await page.evaluate(() => window.fixture.unmount()); await sleep(350);
  result.afterUnmount = await metrics(page);
  assert.equal(result.afterUnmount.canvases, 0, 'Canvas survives unmount');
  assert.equal(result.afterUnmount.fallbackImages, 0, 'Fallback survives unmount');
  assert.equal(result.afterUnmount.bridgeSubscriptions, 0, 'Bridge listener survives unmount');
  assert.equal(result.afterUnmount.intervals, 0, 'Interval survives unmount');
  assert.equal(result.afterUnmount.animationFrames, 0, 'Animation ticker survives unmount');
}
async function runCase(name, query, fn, options = {}) {
  const result = { name, query }; report.cases.push(result);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); result.pageErrors = errors;
  try {
    if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
    if (options.noGraphics) await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return /^webgl/.test(kind) ? null : original.call(this, kind, ...args); };
    });
    if (options.badRiv) await page.route('**/*.riv', route => { result.invalidRivInjected = true; return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'invalid-rive-test' }); });
    const response = await page.goto(`${report.base}/?${query}`);
    assert.equal(response.headers()['content-security-policy'], contentSecurityPolicy);
    result.csp = contentSecurityPolicy;
    await page.waitForFunction(() => !!window.fixture);
    await fn(page, result);
    result.activeResources = await metrics(page);
    await cleanup(page, result);
    assert.equal(errors.length, 0, 'Uncaught browser errors');
    result.passed = true;
  } catch (error) { result.passed = false; result.error = String(error.stack || error); result.failureResources = await metrics(page).catch(() => null); await shot(page, `${name}-failure`).catch(() => {}); }
  finally { await page.close(); save(); }
}
(async () => {
  const assets = path.resolve(__dirname, '../../web/src/features/pilotMascot/assets');
  report.assets = Object.fromEntries(['character.riv', 'character.png'].map(file => { const data = fs.readFileSync(path.join(assets, file)); return [file, { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }]; }));
  report.versions.rive = require('../../web/node_modules/@rive-app/canvas/package.json').version;
  assert.equal(report.versions.rive, '2.44.2');
  const dist = path.join(__dirname, 'dist');
  server = http.createServer((req, res) => {
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', ({ '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.wasm':'application/wasm', '.json':'application/json' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); report.base = `http://127.0.0.1:${server.address().port}`;
  const options = { host: '127.0.0.1', channel: 'chrome', headless: true, chromiumSandbox: true, ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox', '--unsafely-disable-devtools-self-xss-warnings'] };
  report.security.requestedLaunchOptions = options; save();
  browserServer = await chromium.launchServer(options);
  report.security.actualArguments = assertSafeArguments(browserServer.process().spawnargs);
  browser = await chromium.connect(browserServer.wsEndpoint()); report.versions.browser = browser.version();
  Object.assign(report.security, await collectSecurityDiagnostics(await browser.newBrowserCDPSession(), report.security.actualArguments));
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).origin === report.base && !new URL(url).pathname.startsWith('/api/')) return route.continue();
    report.blockedRequests.push(url); return route.abort();
  });
  await context.addInitScript(() => {
    const frames = new Set(), intervals = new Set(), contexts = new WeakMap(), graphicsContexts = new Map();
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) { const value = getContext.call(this, kind, ...args); if (value) { const types = contexts.get(this) || []; if (!types.includes(kind)) types.push(kind); contexts.set(this, types); if (/webgl/.test(kind)) graphicsContexts.set(value, { canvas: this, kind }); } return value; };
    if (typeof OffscreenCanvas !== 'undefined') {
      const offscreenGetContext = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function(kind, ...args) { const value = offscreenGetContext.call(this, kind, ...args); if (value && /webgl/.test(kind)) graphicsContexts.set(value, { canvas: this, kind }); return value; };
    }
    window.validationLosePrivateGraphics = () => {
      const candidates = [...graphicsContexts].filter(([gl, info]) => info.kind === 'webgl2' && !gl.isContextLost() && !info.canvas.isConnected);
      if (candidates.length !== 1) throw Error(`Expected one private live WebGL2 renderer, found ${candidates.length}`);
      const [gl, info] = candidates[0], extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw Error('WEBGL_lose_context unavailable');
      extension.loseContext();
      window.validationLostGraphics = gl;
      return { livePrivateContexts: candidates.length, canvasType: info.canvas.constructor.name, contextType: info.kind };
    };
    window.validationContextTypes = canvas => contexts.get(canvas) || [];
    const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    const interval = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
    window.requestAnimationFrame = callback => { let id = raf(time => { frames.delete(id); callback(time); }); frames.add(id); return id; };
    window.cancelAnimationFrame = id => { frames.delete(id); cancel(id); };
    window.setInterval = (callback, ms, ...args) => { const id = interval(callback, ms, ...args); intervals.add(id); return id; };
    window.clearInterval = id => { intervals.delete(id); clear(id); };
    window.validationResources = () => ({ animationFrames: frames.size, intervals: intervals.size });
  });
  const probe = await context.newPage();
  report.capabilities = await probe.evaluate(() => {
    const result = {};
    for (const kind of ['webgl', 'webgl2']) {
      const canvas = document.createElement('canvas'), graphics = canvas.getContext(kind);
      result[kind] = graphics ? { available: true, version: graphics.getParameter(graphics.VERSION), renderer: graphics.getParameter(graphics.RENDERER) } : { available: false };
      graphics?.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return result;
  });
  await probe.close(); save();
  for (const theme of ['light', 'dark']) {
    await runCase(`desktop-${theme}`, `surface=desktop&theme=${theme}`, async (page, result) => {
      await page.setViewportSize({ width: 420, height: 740 }); await animated(page);
      const canvas = page.locator('canvas[data-mascot-renderer="rive"]');
      const samples = [];
      for (let i = 0; i < 8; i++) {
        const data = await canvas.evaluate(c => c.toDataURL('image/png'));
        const bytes = Buffer.from(data.split(',')[1], 'base64');
        fs.writeFileSync(path.join(out, `desktop-${theme}-canvas-${i}.png`), bytes);
        samples.push(pixels(bytes)); await sleep(450);
      }
      result.pixels = { visible: samples[0].visible, alphaRatio: samples[0].ratio, changedFromFirst: samples.slice(1).map(s => changed(samples[0].png, s.png)), blink: 'Whole-canvas timeline movement measured; blink semantics require visual review of approved timeline.' };
      assert.ok(samples.every(s => s.ratio > .01), 'Character has no visible canvas pixels');
      assert.ok(result.pixels.changedFromFirst.some(n => n > 10), 'Timeline does not visibly move');
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      const before = (await cdp.send('Performance.getMetrics')).metrics;
      const start = Date.now(); await sleep(4000);
      const after = (await cdp.send('Performance.getMetrics')).metrics;
      const value = (list, name) => list.find(m => m.name === name)?.value;
      result.idlePerformance = { windowMs: Date.now() - start, taskDurationSeconds: value(after, 'TaskDuration') - value(before, 'TaskDuration'), jsHeapBefore: value(before, 'JSHeapUsedSize'), jsHeapAfter: value(after, 'JSHeapUsedSize'), meaning: 'CDP main-thread task duration and heap; not OS CPU, GPU, or native executable performance' };
      await shot(page, `desktop-${theme}-collapsed`);
      result.collapsedResources = await metrics(page);
      await page.getByRole('button', { name: '展开 Haru 对话', exact: true }).click();
      await page.getByRole('region', { name: 'Haru 对话' }).waitFor();
      assert.equal(await page.locator('canvas').count(), 0);
      await page.waitForFunction(() => { const image = document.querySelector('.desktop-haru-static-portrait'); return image?.complete && image.naturalWidth > 0; });
      await shot(page, `desktop-${theme}-expanded-static`);
      result.expandedResources = await metrics(page);
      assert.equal(result.expandedResources.intervals, 0);
      assert.equal(result.expandedResources.animationFrames, 0);
      await page.getByRole('button', { name: '打开 OfferPilot 主窗口', exact: true }).click();
      await page.getByRole('button', { name: '收起 Haru 对话', exact: true }).click(); await animated(page);
      result.actions = await page.evaluate(() => window.fixture.actions);
      assert.ok(['expand', 'collapse', 'show-main'].every(a => result.actions.includes(a)));
      await page.evaluate(() => window.fixture.visible(false)); await sleep(300);
      result.hiddenResources = await metrics(page); assert.equal(result.hiddenResources.canvases, 0); assert.equal(result.hiddenResources.intervals, 0);
      await page.evaluate(() => window.fixture.visible(true)); await animated(page);
    });
    for (const surface of ['pilot', 'calendar']) await runCase(`${surface}-${theme}`, `surface=${surface}&theme=${theme}`, async page => {
      await animated(page); await shot(page, `${surface}-${theme}-character`);
      const trigger = surface === 'pilot' ? page.getByRole('button', { name: '打开 OfferPilot 领航员', exact: true }) : page.getByRole('button', { name: /Haru · 随时待命 · 打开对话/ });
      await trigger.click(); await page.locator('output[data-panel-open="true"]').waitFor({ state: 'attached' });
    });
  }
  for (const surface of ['desktop', 'pilot', 'calendar']) {
    await runCase(`${surface}-default-legacy`, `surface=${surface}&character=unset`, async (page, result) => {
      await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(c => window.validationContextTypes(c).some(kind => /webgl/.test(kind))), null, { timeout: 22000 });
      assert.equal(await page.locator('[data-mascot-fallback]').count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('offerpilot.mascot.characterPreview')), null);
      result.defaultSelection = 'legacy with unset preference/snapshot character';
    });
    await runCase(`${surface}-switch`, `surface=${surface}&character=legacy`, async (page, result) => {
      await page.waitForFunction(() => !!document.querySelector('canvas'));
      assert.equal(await page.locator('[data-mascot-fallback]').count(), 0);
      // This case tests genuine legacy runtime loading as well as context replacement.
      await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(c => window.validationContextTypes(c).some(kind => /webgl/.test(kind))), null, { timeout: 22000 });
      const oldCanvas = await page.locator('canvas').elementHandle();
      await page.evaluate(() => window.fixture.switchCharacter('original-preview')); await animated(page);
      assert.equal(await oldCanvas.evaluate(c => c.isConnected), false, 'Old drawing context not replaced');
      await page.evaluate(() => window.fixture.switchCharacter('legacy'));
      await page.waitForFunction(() => !document.querySelector('[data-mascot-fallback]') && [...document.querySelectorAll('canvas')].some(c => window.validationContextTypes(c).some(kind => /webgl/.test(kind))), null, { timeout: 22000 });
      assert.equal(await page.locator('canvas').count(), 1);
      result.contextReplacement = 'legacy → original-preview → legacy: genuine WebGL context acquisition/replacement and original image removal only; legacy rendered pixels not asserted';
      await shot(page, `${surface}-legacy-return`);
    });
    for (const failure of ['reduced-motion', 'off', 'no-graphics', 'invalid-riv']) await runCase(`${surface}-${failure}`, `surface=${surface}${failure === 'off' ? '&animation=off' : ''}`, async (page, result) => {
      if (failure === 'invalid-riv') { for (let i = 0; i < 100 && !result.invalidRivInjected; i++) await sleep(100); assert.equal(result.invalidRivInjected, true); await sleep(500); }
      await fallback(page); await sleep(250); await shot(page, `${surface}-${failure}`);
      result.fallbackResources = await metrics(page);
      if (['off', 'reduced-motion', 'no-graphics'].includes(failure)) assert.ok(!result.fallbackResources.assetTransfers.some(r => /\.(riv|wasm)$/.test(r.name)), 'Static fallback loaded animation assets');
    }, { reducedMotion: failure === 'reduced-motion', noGraphics: failure === 'no-graphics', badRiv: failure === 'invalid-riv' });
  }
  await runCase('desktop-real-private-webgl-loss', 'surface=desktop', async (page, result) => {
    await animated(page);
    result.contextLoss = await page.evaluate(() => window.validationLosePrivateGraphics());
    await page.waitForFunction(() => window.validationLostGraphics.isContextLost());
    await fallback(page); await shot(page, 'desktop-real-private-webgl-loss');
    result.fallbackResources = await metrics(page); assert.equal(result.fallbackResources.intervals, 0);
  });
  for (const failure of ['contextlost', 'blank-health']) await runCase(`desktop-${failure}`, 'surface=desktop', async (page, result) => {
    await animated(page);
    if (failure === 'contextlost') await page.locator('canvas').evaluate(c => c.dispatchEvent(new Event('contextlost')));
    else await page.locator('canvas').evaluate(c => { const ctx = c.getContext('2d'); ctx.getImageData = (x,y,w,h) => new ImageData(w,h); });
    await fallback(page); await shot(page, `desktop-${failure}`); result.fallbackResources = await metrics(page);
    assert.equal(result.fallbackResources.intervals, 0);
  });
  assert.equal(report.blockedRequests.length, 0, 'Unexpected external/backend request attempted');
  report.outcome = report.cases.every(c => c.passed) ? 'passed' : 'failed';
  if (report.outcome !== 'passed') process.exitCode = 1;
})().catch(error => { report.outcome = 'failed_closed'; report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
  await cleanupAndSave([['context', async () => context?.close()], ['browser', async () => browser?.close()], ['browserServer', async () => browserServer?.close(), () => { const process = browserServer?.process(); if (process && process.exitCode === null) process.kill('SIGKILL'); }], ['httpServer', async () => { if (server) await new Promise(resolve => server.close(resolve)); }]], async errors => { report.cleanupErrors = errors; if (errors.length) process.exitCode = 1; report.finished = new Date().toISOString(); save(); });
  console.log(JSON.stringify({ outcome: report.outcome, cases: report.cases.map(c => ({ name: c.name, passed: c.passed, error: c.error })) }, null, 2));
});
