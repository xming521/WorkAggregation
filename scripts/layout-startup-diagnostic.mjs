import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const require = createRequire(path.join(root, 'desktop/installed-ui/package.json'));
const { chromium } = require('playwright-core');
const results = [];
const primeCoverage = process.argv[4] === 'prime-coverage';
const trialCount = primeCoverage ? 1 : 3;
await mkdir(output, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  for (let trial = 1; trial <= trialCount; trial++) {
    const dir = path.join(output, `trial-${trial}`);
    await mkdir(dir, { recursive: true });
    // Remove only this isolated diagnostic checkout's disposable Vite dev cache.
    const cache = path.join(root, 'web/node_modules/.vite');
    for (const entry of await readdir(cache).catch(() => [])) {
      if (entry === 'deps' || entry.startsWith('deps_temp_')) await rm(path.join(cache, entry), { recursive: true, force: true });
    }
    const captureCache = async label => {
      const names = await readdir(cache).catch(() => []);
      const metadata = {};
      for (const entry of names) {
        if (!entry.startsWith('deps')) continue;
        metadata[entry] = await readFile(path.join(cache, entry, '_metadata.json'), 'utf8').catch(() => null);
      }
      await writeFile(path.join(dir, `${label}-cache.json`), JSON.stringify({ names, metadata }, null, 2));
      return { names, metadata };
    };
    await captureCache('before-coverage');
    const temporaryCaches = async () => (await readdir(os.tmpdir())).filter(name => name.startsWith('offerpilot-coverage-vite-')).sort();
    const tempBefore = await temporaryCaches();
    if (primeCoverage) {
      const child = spawn(process.execPath, ['--test', 'test/coverage-model.test.mjs'], { cwd: path.join(root, 'desktop/installed-ui'), stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', data => { log += data; });
      child.stderr.on('data', data => { log += data; });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Coverage predecessor exceeded 120 seconds')); }, 120000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
      }).finally(async () => { await writeFile(path.join(dir, 'coverage-model.log'), log); });
      console.log(log);
      assert.equal(code, 0, 'The real predecessor coverage-model tests must pass');
    }
    const afterCoverage = await captureCache('after-coverage');
    const tempAfter = await temporaryCaches();
    await writeFile(path.join(dir, 'cache-isolation.json'), JSON.stringify({ tempBefore, tempAfter, defaultCacheEntries: Object.keys(afterCoverage.metadata) }, null, 2));
    assert.deepEqual(afterCoverage.metadata, {}, 'Coverage helper must not populate layout deps cache');
    assert.deepEqual(tempAfter, tempBefore, 'Coverage helper must clean its temporary cache');
    const server = spawn(process.execPath, [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { cwd: path.join(root, 'web'), stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    const serverEvents = [];
    for (const [stream, name] of [[server.stdout, 'stdout'], [server.stderr, 'stderr']]) {
      stream.on('data', data => { serverLog += data; serverEvents.push({ at: new Date().toISOString(), stream: name, text: String(data) }); });
    }
    let browser;
    try {
      // The same HTML-only readiness check as the original harness; no warmup.
      for (let i = 0; ; i++) {
        try { if ((await fetch('http://127.0.0.1:5174/tests/desktop-layout/fixture.html')).ok) break; } catch {}
        if (server.exitCode !== null || i >= 100) throw new Error(`Vite did not start: ${serverLog}`);
        await delay(100);
      }
      browser = await chromium.launch({ channel: 'msedge' });
      for (const temperature of ['cold', 'warm']) {
        const name = `trial-${trial}-${temperature}-900x689-0-failure`;
        const context = await browser.newContext({ viewport: { width: 900, height: 689 }, colorScheme: 'dark' });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(15000);
        const events = [];
        const pending = new Set();
        const event = (type, fields = {}) => events.push({ at: new Date().toISOString(), type, ...fields });
        page.on('console', m => event('console', { level: m.type(), text: m.text(), location: m.location() }));
        page.on('pageerror', e => event('pageerror', { message: String(e), stack: e.stack }));
        page.on('request', r => { pending.add(r); event('request', { url: r.url(), resourceType: r.resourceType() }); });
        page.on('response', r => event('response', { url: r.url(), status: r.status(), statusText: r.statusText() }));
        page.on('requestfinished', r => { pending.delete(r); event('requestfinished', { url: r.url(), timing: r.timing() }); });
        page.on('requestfailed', r => { pending.delete(r); event('requestfailed', { url: r.url(), failure: r.failure() }); });
        page.on('framenavigated', f => { if (f === page.mainFrame()) event('navigation', { url: f.url() }); });
        page.on('crash', () => event('crash'));
        page.on('websocket', ws => {
          event('websocket-open', { url: ws.url() });
          ws.on('framereceived', data => event('websocket-frame', { payload: String(data.payload) }));
          ws.on('socketerror', error => event('websocket-error', { error: String(error) }));
          ws.on('close', () => event('websocket-close'));
        });
        await page.addInitScript(() => {
          window.__layoutStartup = { started: Date.now(), samples: [] };
          let last;
          setInterval(() => {
            const mascot = document.querySelector('aside[aria-label="Haru 助手"]');
            const state = { readyState: document.readyState, rootChildren: document.getElementById('root')?.childElementCount ?? null, result: document.querySelector('[data-layout-result]')?.getAttribute('data-layout-result') ?? null, table: Boolean(document.querySelector('.ant-table-content')), mascot: Boolean(mascot), failed: mascot?.dataset.loadFailed ?? null, dock: mascot?.parentElement?.getAttributeNames() ?? null };
            const key = JSON.stringify(state);
            if (key !== last) {
              const sample = { ms: Date.now() - window.__layoutStartup.started, ...state };
              window.__layoutStartup.samples.push(sample);
              console.debug('__layout_startup__', JSON.stringify(sample));
              last = key;
            }
          }, 20);
        });
        const snapshot = async suffix => {
          const state = await page.evaluate(() => ({ startup: window.__layoutStartup, url: location.href, readyState: document.readyState, rootHTML: document.getElementById('root')?.innerHTML, result: document.querySelector('[data-layout-result]')?.getAttribute('data-layout-result'), bodyText: document.body.innerText, htmlDataset: { ...document.documentElement.dataset }, resources: performance.getEntriesByType('resource').map(x => x.toJSON()) }));
          await writeFile(path.join(dir, `${temperature}-${suffix}.json`), JSON.stringify({ ...state, pending: [...pending].map(r => ({ url: r.url(), resourceType: r.resourceType() })) }, null, 2));
          await writeFile(path.join(dir, `${temperature}-${suffix}.html`), await page.content());
          await page.screenshot({ path: path.join(dir, `${temperature}-${suffix}.png`), animations: 'disabled' });
          return state;
        };
        let stage = 'load';
        const start = performance.now();
        const result = { name, browser: browser.version(), node: process.version, platform: process.platform };
        try {
          event('goto-start');
          await page.goto('http://127.0.0.1:5174/tests/desktop-layout/fixture.html?count=0&mascot=failure');
          result.gotoMs = performance.now() - start;
          event('goto-done');
          // Deliberately identical to the original readiness predicate and limit.
          await page.waitForFunction(() => {
            const state = document.querySelector('[data-layout-result]')?.getAttribute('data-layout-result');
            return state && state !== 'pending';
          });
          result.waitMs = performance.now() - start - result.gotoMs;
          result.layoutResult = await page.locator('[data-layout-result]').getAttribute('data-layout-result');
          assert.equal(result.layoutResult, 'passed', name);
          stage = 'normal-layout';
          await snapshot('ready');
          stage = 'fallback-actions';
          const trigger = page.getByRole('button', { name: /打开 OfferPilot 领航员（Haru 模型未加载/ });
          await trigger.click();
          await page.getByRole('dialog').waitFor();
          await page.getByRole('button', { name: 'Close', exact: true }).click();
          await trigger.click({ button: 'right' });
          await page.getByRole('menuitem', { name: '隐藏角色' }).click();
          assert.equal(await page.getByRole('complementary', { name: 'Haru 助手' }).count(), 0);
          result.fullReloads = events.filter(item => item.type === 'websocket-frame' && item.payload.includes('full-reload')).length;
          assert.equal(result.fullReloads, 0, 'The isolated helper must not force layout dependency reload');
          result.status = 'passed';
        } catch (error) {
          result.status = 'failed'; result.stage = stage; result.error = String(error); result.elapsedMs = performance.now() - start;
          event('failure', { stage, error: String(error) });
          try { await snapshot('failure'); } catch (captureError) { result.captureError = String(captureError); }
          // Observation only: this cannot change the original failed result.
          await page.waitForTimeout(3000).catch(() => {});
          try { await snapshot('after-failure-observation'); } catch (captureError) { result.observationError = String(captureError); }
        } finally {
          results.push(result);
          await writeFile(path.join(dir, `${temperature}-events.json`), JSON.stringify(events, null, 2));
          await context.tracing.stop({ path: path.join(dir, `${temperature}-trace.zip`) }).catch(error => { result.traceError = String(error); });
          await context.close();
          await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
          console.log('RESULT', JSON.stringify(result));
        }
      }
    } finally {
      await browser?.close();
      server.kill();
      await Promise.race([new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve)), delay(5000)]);
      if (server.exitCode === null && server.signalCode === null) throw new Error('Vite did not exit; refusing overlapping cold trials');
      await captureCache('after-browser');
      await writeFile(path.join(dir, 'vite.log'), serverLog);
      await writeFile(path.join(dir, 'vite-events.json'), JSON.stringify(serverEvents, null, 2));
    }
  }
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
assert.equal(results.length, trialCount * 2, 'Every requested cold and warm pair must execute');
assert.equal(results.filter(result => result.status !== 'passed').length, 0, JSON.stringify(results.filter(result => result.status !== 'passed')));
