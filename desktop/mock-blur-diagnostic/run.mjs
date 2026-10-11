// Synthetic browser diagnostics only. Never launch the product or a provider.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMockScreenshots } from '../real-ai-validation/mock-screenshots.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(repo, 'desktop/mock-blur-diagnostic/evidence');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = Object.freeze({
  'web/src/components/ChatPanel/ChatPanel.module.css': '2a8ff570f2a602523c942d10c2eaa25f78c76d4eeebb0649c9fa0d895a7dd404',
  'web/src/theme/tokens.css': 'e226aeb9bf420fbc4bb47afe48d9b131599af476fe266fc733ed5269e7b6d06e',
  'web/src/components/ChatPanel/MessageBubble.tsx': '814e5353781041332e9f571403ee93441f8270c244ce989cb07c25d22a932436',
  'desktop/real-ai-validation/mock-screenshots.mjs': 'b3b62c08d4c283c4e7dd343331e9a676a1c9b3a768ca0a83246beced36c16531',
  'desktop/installed-ui/package.json': '03e16d81e48c8dd1912d73bbe751d3e611004dc04c36d163f3faef9c27efa702',
  'desktop/installed-ui/package-lock.json': '2e7cf4928f07d0c8c588f41578c241223a5efb6dd6efb91783569715210626b0',
});
const result = {
  schemaVersion: 1, status: 'RUNNING',
  scope: 'MOCK synthetic HTML with exact product CSS; not installed EXE or model evidence',
  productSource: '3edd7976dc21dc3d44ebd6f3a5a33c2e52679ea8',
  helperBase: 'c77bee0d2000a502b9190461a14d92b3d893248b',
  workflowCommit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null, attempt: process.env.GITHUB_RUN_ATTEMPT || null,
  sourceHashes: {}, stages: [], blockedRequests: 0,
};
function cssBlock(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, 'CSS_BLOCK_MISSING');
  let end = css.indexOf('{', start), depth = 1;
  while (depth && end < css.length) { end++; if (css[end] === '{') depth++; if (css[end] === '}') depth--; }
  assert.equal(depth, 0, 'CSS_BLOCK_UNCLOSED');
  return css.slice(start, end + 1);
}
let browser, phase = 'source-verification';
try {
  const sources = {};
  for (const [relative, digest] of Object.entries(expected)) {
    const bytes = await fs.readFile(path.join(repo, relative));
    const canonical = bytes.toString('utf8').replace(/\r\n/g, '\n');
    const lf = Buffer.from(canonical, 'utf8'), crlf = Buffer.from(canonical.replace(/\n/g, '\r\n'), 'utf8');
    // Windows checkout may use a whole-file CRLF representation of Git's LF
    // bytes. Accept exactly those two encodings; mixed endings, BOM, invalid
    // UTF-8, lone CR and all content changes still fail these byte/hash checks.
    assert.equal(sha256(lf), digest, 'SOURCE_HASH_MISMATCH');
    const representation = bytes.equals(lf) ? 'LF' : bytes.equals(crlf) ? 'CRLF' : null;
    assert.ok(representation, 'SOURCE_REPRESENTATION_MISMATCH');
    result.sourceHashes[relative] = { canonicalSha256: digest, rawSha256: sha256(bytes), representation };
    sources[relative] = canonical;
  }
  if (process.argv.includes('--verify-source-only')) {
    console.log('Six exact source and helper hashes verified. No browser was launched.');
  } else {
    assert.equal(process.platform, 'win32', 'WINDOWS_REQUIRED');
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'FIRST_ATTEMPT_REQUIRED');
    await fs.mkdir(output, { recursive: true });
    const css = sources['web/src/components/ChatPanel/ChatPanel.module.css'];
    const easing = sources['web/src/theme/tokens.css'].match(/--op-ease:\s*([^;]+);/)[0];
    const productCss = `${cssBlock(css, '.msg')}\n${cssBlock(css, '@keyframes opRise')}`;
    const require = createRequire(path.join(repo, 'desktop/installed-ui/package.json'));
    const { chromium } = require('playwright-core');
    assert.equal(require('playwright-core/package.json').version, '1.63.0', 'PLAYWRIGHT_VERSION_MISMATCH');
    // Official runner Edge must already be installed. No browser installation,
    // fallback channel, sandbox disable, remote site, or OS settings changes.
    phase = 'sandboxed-edge-launch';
    browser = await chromium.launch({ channel: 'msedge', headless: true, chromiumSandbox: true,
      ignoreDefaultArgs: ['--unsafely-disable-devtools-self-xss-warnings'],
      args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'] });
    result.browser = { channel: 'msedge', version: browser.version(), sandboxRequested: true };
    const context = await browser.newContext({ viewport: { width: 900, height: 600 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => { result.blockedRequests++; await route.abort(); });
    const html = (stage, filter) => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'"><style>:root{${easing}}body{margin:24px;font:18px Arial;background:white;color:#111}.bubbleAssistant{padding:20px;background:#edf2fc;min-width:360px;min-height:64px}textarea{display:block;margin-top:30px;width:400px;height:70px}${filter === undefined ? productCss : `.msg{display:flex;gap:10px;max-width:88%;filter:${filter}}`}</style><main class="op-app-main-pilot"><div class="op-pilot-page-host"><section data-onboarding-target="pilot"><div class="msg"${filter === undefined ? ' style="animation-delay:0.24s"' : ''}><div class="bubbleAssistant">${stage === 'pilot-hitl-reject' ? '已拒绝，未执行。' : 'MOCK response: synthetic browser fixture.'}</div></div><textarea placeholder="问问领航员，或输入 / 唤起能力"></textarea></section></div></main>`;
    for (const stage of ['pilot-stream', 'pilot-hitl-reject']) {
      phase = stage;
      const page = await context.newPage();
      await page.setContent(html(stage));
      // A synthetic fixture of the existing read-only public bridge contract.
      await page.evaluate(() => { window.offerpilotDesktop = { role: 'owner', getState: async () => ({ connected: true, snapshot: { taskState: 'idle', loading: false, hasPending: false, canStop: false, error: '' } }) }; });
      const sample = () => page.evaluate(() => {
        const row = document.querySelector('.msg'), target = row.firstElementChild, style = getComputedStyle(row);
        const rect = target.getBoundingClientRect();
        return { filter: style.filter, opacity: style.opacity, transform: style.transform,
          rect: [rect.x, rect.y, rect.width, rect.height],
          animations: row.getAnimations().map(a => ({ name: a.animationName, playState: a.playState,
            pending: a.pending, duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay })) };
      });
      const initial = await sample();
      await page.waitForFunction(() => {
        const animations = document.querySelector('.msg').getAnimations();
        return animations.length === 1 && animations.every(a => a.playState === 'finished' && !a.pending);
      }, null, { timeout: 5000 });
      const finished = await sample();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const afterTwoFrames = await sample();
      const screenshots = createMockScreenshots({ directory: path.join(output, stage), mode: 'mock' });
      screenshots.registerToken('synthetic-local-fixture-token-0123456789');
      const capture = await screenshots.capture(stage, page, { stage });
      result.stages.push({ stage, initial, finished, afterTwoFrames, capture, afterGuard: await sample(),
        inventory: screenshots.snapshot() });
      await page.screenshot({ path: path.join(output, `${stage}-fixture.png`), animations: 'allow', fullPage: false });
      assert.ok(['SCREEN_CAPTURED', 'SCREEN_VISUAL_UNSETTLED'].includes(capture.code), 'GUARD_EXECUTION_INCOMPLETE');
      await page.close();
    }
    phase = 'static-pixel-controls';
    const comparisons = [];
    result.identityControls = { comparisons, identicalPngBytes: null };
    for (const filter of ['none', 'blur(0px)']) {
      // Separate static control documents; never alter the animated fixture.
      const page = await context.newPage();
      await page.setContent(html('pilot-stream', filter));
      await page.evaluate(() => { window.offerpilotDesktop = { role: 'owner', getState: async () => ({ connected: true, snapshot: { taskState: 'idle', loading: false, hasPending: false, canStop: false, error: '' } }) }; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const png = await page.screenshot({ animations: 'allow', fullPage: false });
      await fs.writeFile(path.join(output, filter === 'none' ? 'static-none.png' : 'static-zero-blur.png'), png);
      const screenshots = createMockScreenshots({ directory: path.join(output, filter === 'none' ? 'control-none' : 'control-zero-blur'), mode: 'mock' });
      screenshots.registerToken('synthetic-local-fixture-token-0123456789');
      const capture = await screenshots.capture('pilot-stream', page, { stage: 'pilot-stream' });
      comparisons.push({ filter, bytes: png.length, sha256: sha256(png), capture, inventory: screenshots.snapshot() });
      assert.ok(['SCREEN_CAPTURED', 'SCREEN_VISUAL_UNSETTLED'].includes(capture.code), 'GUARD_EXECUTION_INCOMPLETE');
      if (filter === 'none') assert.equal(capture.code, 'SCREEN_CAPTURED', 'CONTROL_SURFACE_INVALID');
      await page.close();
    }
    result.identityControls.identicalPngBytes = comparisons[0].sha256 === comparisons[1].sha256;
    assert.equal(result.blockedRequests, 0, 'UNEXPECTED_REQUEST_ATTEMPT');
    result.hypothesis = result.identityControls.identicalPngBytes && comparisons[1].capture.code === 'SCREEN_VISUAL_UNSETTLED' && result.stages.every(entry =>
      entry.finished.filter === 'blur(0px)' && entry.finished.opacity === '1' &&
      JSON.stringify(entry.finished) === JSON.stringify(entry.afterTwoFrames) &&
      JSON.stringify(entry.finished) === JSON.stringify(entry.afterGuard) &&
      entry.capture.code === 'SCREEN_VISUAL_UNSETTLED') ? 'SUPPORTED_IN_THIS_BROWSER' : 'NOT_ESTABLISHED';
    result.status = 'COMPLETE';
  }
} catch {
  result.status = 'FAILED'; result.error = 'DIAGNOSTIC_INCOMPLETE'; result.failedPhase = phase; process.exitCode = 1;
} finally {
  if (browser) {
    try { await browser.close(); }
    catch { result.status = 'FAILED'; result.error = 'BROWSER_CLOSE_FAILED'; process.exitCode = 1; }
  }
  if (!process.argv.includes('--verify-source-only')) {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } else if (process.exitCode) console.error('Source verification failed.');
}
