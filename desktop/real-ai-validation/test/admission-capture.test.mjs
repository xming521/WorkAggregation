import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { rendererAdmissionCapture, installAdmissionCapture } from '../admission-capture.mjs';
const origin = 'http://127.0.0.1:41000', route = `${origin}/api/pilot/runtime/v1/turns`;
const nonce = '7abca123-1234-4234-8234-123456789abc';
const flush = async () => { for (let n = 0; n < 30; n += 1) await Promise.resolve(); };
function fixture(original, selectedOrigin = origin) {
  const context = vm.createContext({ URL, TextDecoder, Reflect, Promise, setTimeout, clearTimeout,
    location: { origin: selectedOrigin, href: `${selectedOrigin}/` },
    window: { offerpilotDesktop: { role: 'owner' }, fetch: original } });
  const page = { async evaluate(fn, arg) { context.args = structuredClone(arg); return vm.runInContext(`(${fn.toString()})(args)`, context); } };
  const call = (operation, changes = {}) => page.evaluate(rendererAdmissionCapture, { operation, origin: selectedOrigin, nonce, ...changes });
  return { context, page, call };
}
function response(text = '{"synthetic":true}', options = {}) {
  const result = new Response(text, { status: options.status ?? 202 });
  Object.defineProperty(result, 'url', { value: options.url ?? route });
  Object.defineProperty(result, 'redirected', { value: options.redirected ?? false });
  return result;
}

test('clone observes one response without changing original Promise, parameters, body or headers', async () => {
  const originalResponse = response(); const pending = Promise.resolve(originalResponse); let calls = 0, args;
  const original = function (...received) { calls += 1; args = received; return pending; };
  const f = fixture(original); await f.call('install');
  const options = { method: 'POST', body: 'SYNTHETIC_REQUEST_BODY', headers: { synthetic: 'do-not-read' } };
  const returned = f.context.window.fetch('/api/pilot/runtime/v1/turns', options);
  assert.equal(returned, pending); assert.equal(await returned, originalResponse);
  assert.equal(args[1], options); assert.equal(calls, 1);
  assert.equal(await originalResponse.text(), '{"synthetic":true}');
  let value; for (let n = 0; n < 100; n += 1) { value = await f.call('read'); if (value.phase === 'READY') break; await new Promise(r => setTimeout(r, 1)); }
  assert.equal(value.phase, 'READY'); assert.equal(value.body, '{"synthetic":true}');
  assert.doesNotMatch(JSON.stringify(value), /REQUEST_BODY|do-not-read/);
  assert.equal((await f.call('dispose')).phase, 'DISPOSED'); assert.equal(f.context.window.fetch, original);
  assert.equal(Object.hasOwn(f.context.window, '__offerpilotAdmissionCapture'), false);
});

for (const options of [{ url: `${route}?wrong=1` }, { url: 'http://127.0.0.1:41001/api/pilot/runtime/v1/turns' }, { redirected: true }]) {
  test('redirect or different response identity is refused without replay', async () => {
    let calls = 0; const f = fixture(() => { calls += 1; return Promise.resolve(response('synthetic', options)); });
    await f.call('install'); await f.context.window.fetch(route, { method: 'POST' }); await flush();
    assert.equal((await f.call('read')).phase, 'FAILED'); assert.equal(calls, 1); await f.call('dispose');
  });
}

test('wrong nonce cannot read or restore another observation', async () => {
  const original = () => Promise.resolve(response()); const f = fixture(original); await f.call('install');
  assert.equal((await f.call('read', { nonce: '8abca123-1234-4234-8234-123456789abc' })).phase, 'FAILED');
  assert.equal((await f.call('dispose', { nonce: '8abca123-1234-4234-8234-123456789abc' })).phase, 'FAILED');
  assert.notEqual(f.context.window.fetch, original); await f.call('dispose'); assert.equal(f.context.window.fetch, original);
});

test('duplicates fail closed and cleanup never overwrites a third-party replacement', async () => {
  const f = fixture(() => Promise.resolve(response())); await f.call('install');
  await f.context.window.fetch(route, { method: 'POST' }); await f.context.window.fetch(route, { method: 'POST' }); await flush();
  assert.equal((await f.call('read')).fault, 'DUPLICATE');
  const replacement = () => {}; f.context.window.fetch = replacement;
  assert.equal((await f.call('dispose')).phase, 'FAILED'); assert.equal(f.context.window.fetch, replacement);
  assert.equal(Object.hasOwn(f.context.window, '__offerpilotAdmissionCapture'), false);
});

test('real byte cap rejects multibyte oversized data before storing a body', async () => {
  const f = fixture(() => Promise.resolve(response('界'.repeat(23000)))); await f.call('install');
  const original = await f.context.window.fetch(route, { method: 'POST' }); await original.text();
  let value; for (let n = 0; n < 100; n += 1) { value = await f.call('read'); if (value.phase === 'FAILED') break; await new Promise(r => setTimeout(r, 1)); }
  assert.equal(value.fault, 'BODY_TOO_LARGE'); assert.equal(value.body, undefined); await f.call('dispose');
});

test('pending body is cancelled at five seconds, and late completion cannot revive it', async t => {
  let finish, cancelled = 0; const f = fixture(() => Promise.resolve({ status: 202, url: route, redirected: false,
    clone: () => ({ body: { getReader: () => ({ read: () => new Promise(r => { finish = r; }), cancel: async () => { cancelled += 1; }, releaseLock() {} }) } }) }));
  let timer; f.context.setTimeout = (fn, ms) => { assert.equal(ms, 5000); timer = fn; return 1; }; f.context.clearTimeout = () => {};
  await f.call('install'); await f.context.window.fetch(route, { method: 'POST' }); await flush(); timer();
  assert.equal((await f.call('read')).fault, 'TIMEOUT'); assert.equal(cancelled, 1);
  finish({ done: true }); await flush(); assert.equal((await f.call('read')).phase, 'FAILED'); await f.call('dispose');
});

test('factory confirms installation before sending and binds the independent response status', async () => {
  const f = fixture(() => Promise.resolve(response()));
  const capture = await installAdmissionCapture(f.page, origin, action => action());
  const promise = f.context.window.fetch(route, { method: 'POST' }); const original = await promise;
  await original.text();
  const bytes = await capture.body({ status: () => 202, url: () => route }); assert.equal(JSON.parse(bytes).synthetic, true);
  await assert.rejects(capture.body({ status: () => 200, url: () => route }), /ADMISSION_CAPTURE_INVALID/);
  await capture.dispose();
});

test('real synthetic loopback fetch preserves original streaming response while clone captures admission', async () => {
  const server = http.createServer((req, res) => { res.writeHead(202, { 'Content-Type': 'application/json' }); res.write('{"synthetic":'); res.end('true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ownOrigin = `http://127.0.0.1:${server.address().port}`, ownRoute = `${ownOrigin}/api/pilot/runtime/v1/turns`;
  const f = fixture(fetch, ownOrigin); let capture;
  try {
    capture = await installAdmissionCapture(f.page, ownOrigin, action => action());
    const original = await f.context.window.fetch(ownRoute, { method: 'POST', body: '{}' });
    assert.deepEqual(await original.json(), { synthetic: true });
    assert.deepEqual(JSON.parse(await capture.body({ status: () => 202, url: () => ownRoute })), { synthetic: true });
  } finally { await capture?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('wrong method or route is forwarded unchanged and never adopted', async () => {
  let calls = 0; const original = () => { calls += 1; return Promise.resolve(response()); };
  const f = fixture(original); await f.call('install');
  for (const [url, method] of [[route, 'GET'], [`${route}?extra=1`, 'POST'], ['https://example.invalid/api/pilot/runtime/v1/turns', 'POST']]) {
    await f.context.window.fetch(url, { method });
  }
  const value = await f.call('read'); assert.equal(value.count, 0); assert.equal(value.phase, 'PENDING');
  assert.equal(calls, 3); await f.call('dispose');
});

test('late duplicate after body read invalidates proof and still restores fetch on cleanup', async () => {
  const original = () => Promise.resolve(response()); const f = fixture(original);
  const capture = await installAdmissionCapture(f.page, origin, action => action());
  await (await f.context.window.fetch(route, { method: 'POST' })).text();
  await capture.body({ status: () => 202, url: () => route }); await capture.assertValid(true);
  await f.context.window.fetch(route, { method: 'POST' });
  await assert.rejects(capture.assertValid(true), /ADMISSION_CAPTURE_INVALID/);
  await assert.rejects(capture.dispose(), /ADMISSION_CAPTURE_CLEANUP_FAILED/);
  assert.equal(f.context.window.fetch, original); assert.equal(Object.hasOwn(f.context.window, '__offerpilotAdmissionCapture'), false);
});

test('installation failure after renderer installed still cleans up original fetch', async () => {
  const original = () => Promise.resolve(response()); const f = fixture(original);
  await assert.rejects(installAdmissionCapture(f.page, origin, async action => { await action(); throw new Error('synthetic-install-timeout'); }), /synthetic-install-timeout/);
  assert.equal(f.context.window.fetch, original); assert.equal(Object.hasOwn(f.context.window, '__offerpilotAdmissionCapture'), false);
});

test('existing capture cannot be adopted or removed by another nonce', async () => {
  const f = fixture(() => Promise.resolve(response())); await f.call('install');
  const saved = f.context.window.fetch;
  await assert.rejects(installAdmissionCapture(f.page, origin, action => action()), /ADMISSION_CAPTURE_INVALID/);
  assert.equal(f.context.window.fetch, saved); assert.equal((await f.call('read')).phase, 'PENDING'); await f.call('dispose');
});
