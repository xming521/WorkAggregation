// One exact UI-owned POST response clone. No extra request, request-body/header
// inspection, or CDP-body fallback. Captured JSON remains ephemeral.
import { randomUUID } from 'node:crypto';
const invalidCapture = () => Object.assign(new Error('ADMISSION_CAPTURE_INVALID'), { proofFault: 'ADMISSION_READ_FAILED', captureInvalid: true });

export function rendererAdmissionCapture(args) {
  const key = '__offerpilotAdmissionCapture';
  const fail = () => ({ phase: 'FAILED', fault: 'INVALID_CONTEXT' });
  if (window.offerpilotDesktop?.role !== 'owner' || location.origin !== args.origin
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.nonce)) return fail();
  if (args.operation === 'install') {
    if (Object.hasOwn(window, key) || typeof window.fetch !== 'function') return fail();
    const original = window.fetch;
    const state = { nonce: args.nonce, original, wrapper: null, phase: 'PENDING', fault: null,
      count: 0, status: null, body: null, reader: null, closed: false, timer: null };
    const reject = fault => {
      if (state.closed || state.phase === 'FAILED') return;
      state.phase = 'FAILED'; state.fault = fault; state.body = null;
      try { void state.reader?.cancel().catch(() => {}); } catch { /* Original response is untouched. */ }
    };
    const capture = async response => {
      if (state.closed || state.phase === 'FAILED') return;
      if (response.redirected || response.url !== `${args.origin}/api/pilot/runtime/v1/turns`) { reject('REDIRECT'); return; }
      state.status = response.status;
      state.timer = setTimeout(() => reject('TIMEOUT'), 5000);
      let text = '', bytes = 0;
      try {
        const clone = response.clone();
        if (!clone.body) { reject('BODY_MISSING'); return; }
        state.reader = clone.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (!state.closed && state.phase !== 'FAILED') {
          const part = await state.reader.read();
          if (state.closed || state.phase === 'FAILED') return;
          if (part.done) {
            text += decoder.decode(); state.body = text; state.phase = 'READY'; clearTimeout(state.timer); return;
          }
          bytes += part.value.byteLength;
          if (bytes > 65536) { reject('BODY_TOO_LARGE'); return; }
          text += decoder.decode(part.value, { stream: true });
        }
      } catch { reject('BODY_READ_FAILED'); }
      finally { try { state.reader?.releaseLock(); } catch { /* A timed-out read may still be pending. */ } }
    };
    state.wrapper = function (...parameters) {
      let selected = false;
      try {
        const input = parameters[0], options = parameters[1];
        // PIN uses a string URL. Supporting Request would require inspecting
        // an additional request object; fail closed for that unsupported form.
        if (typeof input === 'string') {
          const url = new URL(input, location.href);
          selected = url.href === `${args.origin}/api/pilot/runtime/v1/turns`
            && String(options?.method || 'GET').toUpperCase() === 'POST';
        }
      } catch { /* Pass application input through unchanged. */ }
      if (selected && !state.closed) {
        state.count += 1;
        if (state.count !== 1) reject('DUPLICATE');
      }
      // Preserve the actual Promise and Response returned to application code.
      const pending = Reflect.apply(original, this, parameters);
      if (selected && state.count === 1 && !state.closed) {
        void Promise.resolve(pending).then(capture, () => reject('FETCH_FAILED')).catch(() => reject('BODY_READ_FAILED'));
      }
      return pending;
    };
    Object.defineProperty(window, key, { value: state, configurable: true });
    try { window.fetch = state.wrapper; } catch { delete window[key]; return fail(); }
    if (window.fetch !== state.wrapper) { delete window[key]; return fail(); }
    return { phase: 'INSTALLED' };
  }
  const state = window[key];
  if (!state || state.nonce !== args.nonce) return fail();
  if (args.operation === 'dispose') {
    state.closed = true; clearTimeout(state.timer);
    try { void state.reader?.cancel().catch(() => {}); } catch { /* Do not cancel the original response. */ }
    state.body = null;
    const owned = window.fetch === state.wrapper;
    if (owned) window.fetch = state.original;
    delete window[key];
    return { phase: owned && window.fetch === state.original && state.phase !== 'FAILED' ? 'DISPOSED' : 'FAILED' };
  }
  if (!['read', 'check'].includes(args.operation) || state.closed || window.fetch !== state.wrapper) return fail();
  return { phase: state.phase, fault: state.fault, count: state.count, status: state.status,
    ...(args.operation === 'read' && state.phase === 'READY' ? { body: state.body } : {}) };
}

export async function installAdmissionCapture(page, origin, within) {
  const nonce = randomUUID(); let disposed = false;
  const call = operation => page.evaluate(rendererAdmissionCapture, { operation, origin, nonce });
  const capture = {
    async assertValid(complete = false) {
      const value = await call('check');
      if (disposed || !['PENDING', 'READY'].includes(value?.phase) || ![0, 1].includes(value.count)
        || (complete && (value.phase !== 'READY' || value.count !== 1))) throw invalidCapture();
    },
    async body(response) {
      const deadline = Date.now() + 5000;
      while (!disposed && Date.now() < deadline) {
        const value = await call('read');
        if (value?.phase === 'READY' && value.count === 1 && value.status === response.status()
          && response.url() === `${origin}/api/pilot/runtime/v1/turns` && typeof value.body === 'string') {
          const bytes = Buffer.from(value.body, 'utf8');
          if (bytes.byteLength > 65536) throw invalidCapture();
          return bytes;
        }
        if (value?.phase !== 'PENDING' || ![0, 1].includes(value.count)) throw invalidCapture();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw invalidCapture();
    },
    async dispose() {
      disposed = true; let timer;
      try {
        const value = await Promise.race([call('dispose'), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ADMISSION_CAPTURE_CLEANUP_FAILED')), 5000);
        })]);
        if (value?.phase !== 'DISPOSED') throw new Error('ADMISSION_CAPTURE_CLEANUP_FAILED');
      } finally { clearTimeout(timer); }
    },
  };
  try {
    const installed = await within(() => call('install'), 'ADMISSION_READ');
    if (installed?.phase !== 'INSTALLED') throw invalidCapture();
    return capture;
  } catch (error) {
    try { await capture.dispose(); } catch { /* Preserve installation failure. */ }
    throw error;
  }
}
