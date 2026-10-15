// Shared strict Pilot observation; live and explicitly offline wrappers keep
// separate billing boundaries and evidence labels. No extra POST or retry.
import { POLICY, CASES, Ledger, usageCost } from './broker-core.cjs';
import { readMirrorObservation, isRunningMirrorProven } from './mirror-observer.mjs';
import { sanitizePilotProofDiagnostic, sanitizeRendererDiagnostic } from './ui-diagnostics.mjs';
import { installAdmissionCapture } from './admission-capture.mjs';

const CASE = 'pilot-stream';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positive = n => Number.isSafeInteger(n) && n > 0;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const IDS = ['request_id', 'turn_id', 'conversation_id', 'execution_generation'];
const DENIED = Object.keys(new Ledger().snapshot().denied).sort();
const ROW = ['caseId', 'cap', 'envelope', 'status', 'micro', 'outboundStarted', 'upstreamResponded',
  'clientDisconnectObserved', 'promptTokens', 'completionTokens', 'cacheHitTokens', 'cacheMissTokens'].sort();
const sameKeys = (v, keys) => object(v) && Object.keys(v).sort().join('|') === keys.join('|');
const proofError = (fault = 'UNEXPECTED_FAILURE', faultStage = null) => Object.assign(
  new Error('LIVE_COMPLETION_UNPROVEN'), { code: 'LIVE_COMPLETION_UNPROVEN', proofFault: fault, proofFaultStage: faultStage });
const fail = fault => { throw proofError(fault); };
const requireProof = (v, fault) => { if (!v) fail(fault); };
export const normalizePlainText = text => text.replace(/[\t\n\v\f\r ]+/gu, ' ').replace(/^ | $/gu, '');
// Exact plain-message branch of PIN assistantPresentation.compactMessageText.
// The owner bridge already carries this compact projection, not the full reply.
export function compactPlainMessage(content) {
  const text = content.trim(), characters = Array.from(text);
  return characters.length > 520 ? `${characters.slice(0, 520).join('')}…` : text;
}
function identity(value) {
  requireProof(object(value) && UUID.test(value.request_id) && typeof value.turn_id === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(value.turn_id) && positive(value.conversation_id) && positive(value.execution_generation), 'ADMISSION_INVALID');
  return Object.fromEntries(IDS.map(key => [key, value[key]]));
}
function matches(value, admitted, optionalRequest = false) {
  return object(value) && IDS.every(key => optionalRequest && key === 'request_id' && !(key in value)
    || value[key] === admitted[key]);
}
function unsafe(value, allowNoWrite = false, path = []) {
  if (!object(value) && !Array.isArray(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    // Accept a plain JSON object from another renderer/VM realm, while
    // rejecting custom/inherited payload prototypes.
    if (prototype !== null && (Object.getPrototypeOf(prototype) !== null
      || !Object.hasOwn(prototype, 'constructor') || typeof prototype.constructor !== 'function'
      || prototype.constructor.name !== 'Object' || prototype.constructor.prototype !== prototype)) return true;
  }
  return Object.entries(value).some(([key, child]) => ['operation_id', 'undo', 'write_error', 'pending_action', 'confirmation_token', '__proto__', 'prototype', 'constructor'].includes(key)
    // PIN's ordinary no-tool result explicitly projects write_status="none".
    // This exception applies only to that exact terminal message envelope.
    || (key === 'write_status' && !(allowNoWrite && path.length === 2 && path[0] === 'terminal' && path[1] === 'response'
      && Object.hasOwn(value, 'type') && value.type === 'message' && child === 'none'))
    || (['degraded', 'replayed'].includes(key) && child !== false) || (key === 'type' && ['turn_recovered', 'confirmation_required'].includes(child))
    || unsafe(child, allowNoWrite, [...path, key]));
}
export function projectAdmission(value, status) {
  requireProof(status === 202 && object(value) && value.protocol_version === 'pilot-runtime-v1' && value.replayed === false && !unsafe(value), 'ADMISSION_INVALID');
  const admitted = identity(value);
  requireProof(matches(value.execution, admitted) && value.execution.protocol_version === 'pilot-runtime-v1'
    && ['queued', 'running', 'completed'].includes(value.state) && value.execution.state === value.state, 'ADMISSION_INVALID');
  return Object.freeze(admitted);
}
export function projectTerminal(value, admitted) {
  requireProof(matches(value, admitted) && matches(value.execution, admitted), 'STATUS_IDENTITY_INVALID');
  requireProof(value.protocol_version === 'pilot-runtime-v1' && value.execution.protocol_version === 'pilot-runtime-v1', 'STATUS_PROTOCOL_INVALID');
  requireProof(!unsafe(value, true), 'STATUS_UNSAFE');
  requireProof(value.recovery?.requires_resync === false && value.recovery?.auto_resume === false, 'STATUS_RECOVERY_INVALID');
  if (['queued', 'running'].includes(value.state) && value.execution.state === value.state
    && !value.terminal?.response) return null;
  // Logical completion can precede the manager's finally block. Wait for both
  // envelopes to report the actual worker exit; never infer it from prose.
  if (value.state === 'completed' && value.execution.state === 'completed'
    && [value, value.execution].every(v => v.worker_done === false && v.actual_worker_alive === true)) return null;
  requireProof(value.state === 'completed' && value.execution.state === 'completed'
    && [value, value.execution].every(v => v.worker_done === true && v.actual_worker_alive === false), 'STATUS_STATE_INVALID');
  const response = value.terminal?.response;
  // PIN guarantees three terminal IDs; request_id is mandatory in both outer
  // envelopes and, if present in terminal.response, must also agree.
  requireProof(matches(response, admitted, true) && response.type === 'message'
    && typeof response.message === 'string' && response.message.length <= 12000 && response.message.trim().length > 0, 'STATUS_TERMINAL_INVALID');
  return response.message;
}

// Exact allowlist, fetched by the owner's existing application session. No
// authentication inspection and no expansion of syntheticApi's write routes.
export async function readLivePilotJson({ origin, requestId, deadline, diagnostics = false }) {
  // The optional envelope reports only this already-authorized GET's fixed
  // outcome. Its payload remains ephemeral and never enters an artifact.
  let httpStatus = null;
  const result = (value, readOutcome) => diagnostics ? { value, readOutcome, httpStatus } : value;
  if (window.offerpilotDesktop?.role !== 'owner' || location.origin !== origin) return result(null, 'INVALID_CONTEXT');
  if (Date.now() >= deadline) return result(null, 'DEADLINE');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (requestId !== null && !uuid.test(requestId)) return result(null, 'INVALID_REQUEST');
  const route = requestId === null ? '/api/chat/conversations?include_archived=true' : `/api/pilot/runtime/v1/requests/${requestId}`;
  const limit = requestId === null ? 8192 : 131072;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(5000, deadline - Date.now())));
  let reader, phase = 'TRANSPORT';
  try {
    const response = await fetch(route, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
    httpStatus = response.status;
    if (response.redirected || response.url !== `${origin}${route}`) return result(null, 'ROUTE_MISMATCH');
    if (response.status !== 200) return result(null, 'HTTP_STATUS');
    if (!response.body) return result(null, 'BODY_MISSING');
    reader = response.body.getReader(); let size = 0, text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      phase = 'TRANSPORT';
      const part = await reader.read(); if (Date.now() >= deadline) return result(null, 'DEADLINE');
      if (part.done) break;
      size += part.value.byteLength; if (size > limit) return result(null, 'BODY_TOO_LARGE');
      phase = 'DECODE_OR_JSON'; text += decoder.decode(part.value, { stream: true });
    }
    phase = 'DECODE_OR_JSON'; text += decoder.decode();
    return result(JSON.parse(text), 'OK');
  } catch { return result(null, Date.now() >= deadline ? 'DEADLINE' : controller.signal.aborted ? 'TIMEOUT' : phase); }
  finally { clearTimeout(timer); controller.abort(); try { await reader?.cancel(); } catch { /* No raw errors. */ } }
}

export function projectUiRequest(body) {
  requireProof(typeof body === 'string' && body.length <= 65536 && Buffer.byteLength(body, 'utf8') <= 65536, 'ADMISSION_INVALID');
  let value; try { value = JSON.parse(body); } catch { fail('ADMISSION_INVALID'); }
  requireProof(object(value) && JSON.stringify(value) === body && Object.hasOwn(value, 'request_id')
    && Object.hasOwn(value, 'conversation_id') && typeof value.request_id === 'string' && UUID.test(value.request_id) && value.conversation_id === 0, 'ADMISSION_INVALID');
  return Object.freeze({ request_id: value.request_id });
}

// GET-by-request is PIN's admission recovery authority. The POST may be
// intentionally aborted; its response body is not a completion prerequisite.
export function projectRequestExecution(value, submitted, managerSeen = false) {
  requireProof(object(value) && value.request_id === submitted.request_id && !unsafe(value, true), 'STATUS_IDENTITY_INVALID');
  const target = identity(value);
  requireProof(target.execution_generation === 1 && matches(value.execution, target), 'STATUS_IDENTITY_INVALID');
  requireProof(value.protocol_version === 'pilot-runtime-v1' && value.execution.protocol_version === 'pilot-runtime-v1', 'STATUS_PROTOCOL_INVALID');
  requireProof(value.recovery?.auto_resume === false, 'STATUS_RECOVERY_INVALID');
  if (value.recovery?.requires_resync === true) {
    // PIN commits its initial lease before registering the manager handle.
    // This exact pre-manager shape is waiting evidence only, never a terminal.
    const empty = v => object(v) && Object.keys(v).length === 0;
    requireProof(!managerSeen && empty(value.terminal) && [value, value.execution].every(v =>
      v.state === 'running' && v.worker_done === true && v.actual_worker_alive === false
      && empty(v.budget) && !Object.hasOwn(v, 'accepted_at') && !Object.hasOwn(v, 'deadline_at')),
    'STATUS_RECOVERY_INVALID');
  } else requireProof(value.recovery?.requires_resync === false, 'STATUS_RECOVERY_INVALID');
  return Object.freeze(target);
}

export function observeLiveAdmission(page, origin, within, observe = () => {}, capture = null) {
  let closed = false, count = 0, submitted = null, firstFault = null;
  const note = value => { try { observe(value); } catch { /* Diagnostics cannot alter proof. */ } };
  const invalidate = error => {
    firstFault ??= error; closed = true; submitted = null;
    note({ fault: firstFault, admissionValid: false });
    try { page.off('request', listener); } catch { /* dispose retries. */ }
  };
  const listener = request => {
    if (closed) return;
    let projected;
    try {
      if (request.url() !== `${origin}/api/pilot/runtime/v1/turns` || request.method() !== 'POST'
        || request.frame() !== page.mainFrame()) return;
      note({ admissionObserved: true });
      if (++count !== 1) { invalidate(proofError('ADMISSION_DUPLICATE')); return; }
      if (request.redirectedFrom() !== null) { invalidate(proofError('ADMISSION_REDIRECTED')); return; }
      projected = projectUiRequest(request.postData());
    } catch (error) { invalidate(error?.proofFault ? error : proofError('ADMISSION_METADATA_FAILED')); return; }
    void within(() => capture.request(projected.request_id), 'ADMISSION_READ').then(() => {
      if (!closed && !firstFault && count === 1) submitted = projected;
    }, error => { if (!closed) invalidate(error); });
  };
  page.on('request', listener);
  return { read() { if (firstFault) throw firstFault; requireProof(!closed && count <= 1, 'ADMISSION_INVALID'); return submitted; },
    dispose() { closed = true; submitted = null; page.off('request', listener); } };
}

function healthyMirror(pair) {
  return pair?.owner?.role === 'owner' && pair?.haru?.role === 'haru'
    && [pair.owner, pair.haru].every(v => v.caseId === CASE && v.installed === true && v.baselineReady === true
      && v.baselineEmpty === true && v.baselineControlsValid === true && v.healthy === true && v.connected === true && v.historyClean === true
      && v.identityChanged === false && v.generationChanged === false && v.expired === false && v.readTimedOut === false
      && integer(v.generation) && v.generation === v.baselineGeneration)
    && pair.owner.generation === pair.haru.generation;
}
export function isLiveTerminalMirrorProven(pair, admitted) {
  return healthyMirror(pair) && positive(admitted?.conversation_id) && [pair.owner, pair.haru].every(v =>
    v.conversationId === admitted.conversation_id && v.currentTaskState === 'idle' && v.loading === false && v.hasPending === false);
}

export function liveLedgerFingerprint(value) {
  const reviewedShape = sameKeys(value.denied, DENIED) && Array.isArray(value.requests)
    && value.requests.every(row => sameKeys(row, ROW));
  return JSON.stringify([reviewedShape, value.model, value.budgetMicroCny, value.reserveMicroCny, value.sentRequests,
    value.settledMicroCny, value.retainedMicroCny, value.active, value.closed, value.journalFailed,
    DENIED.map(key => value.denied?.[key]), value.requests?.map(row => ROW.map(key => row[key]))]);
}
export function offlineSnapshot(value) {
  return value?.mode === 'MOCK' && value.mock?.transport === 'IN_PROCESS_SYNTHETIC_HTTPS'
    && value.mock.externalNetwork === 'DENIED' && value.mock.realProviderCalls === 0
    && value.mock.usageIsSynthetic === true && value.mock.fakeRequests === value.sentRequests
    && value.mock.clockScope === 'BROKER_VM_ONLY';
}
const snapshotMode = (mode, value) => mode === 'live'
  ? value?.mode !== 'MOCK' && value?.mock === undefined : mode === 'mock' && offlineSnapshot(value);
export function isLiveLedgerProven(value, before, previousCount) {
  return snapshotMode('live', value) && snapshotMode('live', before) && ledgerProven(value, before, previousCount);
}
function ledgerProven(value, before, previousCount) {
  if (!integer(previousCount)
    || before?.sentRequests !== previousCount || before.requests?.length !== previousCount
    || before.requests.some(row => row.caseId === CASE) || value?.model !== POLICY.model
    || value.active !== false || value.closed !== false || value.journalFailed !== false
    || value.budgetMicroCny !== POLICY.budgetMicroCny || value.reserveMicroCny !== POLICY.reserveMicroCny
    || !Array.isArray(value.requests) || value.sentRequests !== previousCount + 1 || value.requests.length !== value.sentRequests
    || value.sentRequests > POLICY.maxRequests || !sameKeys(value.denied, DENIED) || !sameKeys(before.denied, DENIED)
    || DENIED.some(key => !integer(value.denied[key]) || value.denied[key] !== 0 || before.denied[key] !== 0)
    || value.retainedMicroCny !== 0 || value.requests.filter(row => row.caseId === CASE).length !== 1) return false;
  let total = 0;
  for (const [index, row] of value.requests.entries()) {
    if (!sameKeys(row, ROW) || !Object.hasOwn(CASES, row.caseId) || row.status !== 'SETTLED'
      || row.outboundStarted !== true || row.upstreamResponded !== true || row.clientDisconnectObserved !== false
      || !['INSERTED', 'TIGHTENED', 'UNCHANGED'].includes(row.envelope) || !positive(row.cap)
      || row.cap > CASES[row.caseId].maxTokens || !integer(row.micro)
      || (index < previousCount && JSON.stringify(ROW.map(key => row[key])) !== JSON.stringify(ROW.map(key => before.requests[index][key])))) return false;
    try {
      const cost = usageCost({ prompt_tokens: row.promptTokens, completion_tokens: row.completionTokens,
        prompt_cache_hit_tokens: row.cacheHitTokens, prompt_cache_miss_tokens: row.cacheMissTokens,
        total_tokens: row.promptTokens + row.completionTokens }, row.cap);
      if (cost.micro !== row.micro) return false;
    } catch { return false; }
    total += row.micro;
  }
  return value.requests.at(-1).caseId === CASE && integer(total) && value.settledMicroCny === total
    && total + value.reserveMicroCny <= value.budgetMicroCny;
}

// Raw text and IDs exist only for this short in-memory comparison. The proof
// returned by the orchestrator contains booleans and fixed result codes only.
export async function readLiveTerminalRenderer({ role, deadline, diagnostics = false, expectedGeneration, expectedConversationId }) {
  const detail = { rootCount: null, bodyCount: null, assistantCount: null,
    documentVisible: null, rootVisible: null, bodyVisible: null, generationMatches: null, conversationMatches: null };
  const result = (status, reason, values = {}) => ({ status, ...values,
    ...(diagnostics === true ? { diagnostic: { status, reason, ...detail } } : {}) });
  if (Date.now() >= deadline) return result('NOT_READY', 'DEADLINE');
  const bridge = window.offerpilotDesktop;
  if (bridge?.role !== role || typeof bridge.getState !== 'function') return result('UNSAFE', 'BRIDGE');
  const state = await bridge.getState(), s = state?.snapshot;
  if (diagnostics === true) {
    detail.documentVisible = document.visibilityState === 'visible';
    detail.generationMatches = Number.isSafeInteger(state?.generation) && state.generation >= 0
      && Number.isSafeInteger(expectedGeneration) && expectedGeneration >= 0 ? state.generation === expectedGeneration : null;
    detail.conversationMatches = Number.isSafeInteger(s?.conversationId) && s.conversationId > 0
      && Number.isSafeInteger(expectedConversationId) && expectedConversationId > 0 ? s.conversationId === expectedConversationId : null;
  }
  if (state?.connected !== true) return result('UNSAFE', 'CONNECTION');
  if (!Number.isSafeInteger(state.generation) || state.generation < 0) return result('UNSAFE', 'GENERATION');
  if (!s) return result('UNSAFE', 'SNAPSHOT');
  if (!Number.isSafeInteger(s.conversationId) || s.conversationId <= 0) return result('UNSAFE', 'CONVERSATION');
  if (s.hasPending !== false) return result('UNSAFE', 'PENDING_ACTION');
  if (s.stopping !== false) return result('UNSAFE', 'STOPPING');
  if (s.error !== '') return result('UNSAFE', 'ERROR');
  if (s.stopMessage !== '') return result('UNSAFE', 'STOP_MESSAGE');
  if (!Array.isArray(s.messages)) return result('UNSAFE', 'MESSAGES');
  const identity = { conversationId: s.conversationId, generation: state.generation };
  const pending = reason => result('NOT_READY', reason, identity);
  const controlsPending = Date.now() >= deadline || s.taskState === 'running' || s.loading === true || s.canSend !== true;
  if (!['idle', 'running'].includes(s.taskState)) return result('UNSAFE', 'TASK_STATE');
  if (typeof s.loading !== 'boolean') return result('UNSAFE', 'LOADING');
  if (s.taskState === 'idle' && s.loading === false && s.canStop !== false) return result('UNSAFE', 'STOP_CONTROL');
  let opacityZero = false;
  const visible = node => {
    opacityZero = false;
    if (document.visibilityState !== 'visible' || !node || !node.isConnected
      || ![...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) return false;
    for (let p = node; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (p.hidden || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
        || style.contentVisibility === 'hidden') return false;
      if (Number(style.opacity) === 0) { opacityZero = true; return false; }
    }
    return true;
  };
  const roots = [...document.querySelectorAll(role === 'owner' ? '[data-onboarding-target="pilot"]' : 'main[aria-label="Haru 桌面小窗"]')];
  detail.rootCount = Math.min(2, roots.length);
  if (roots.length !== 1) return result('UNSAFE', 'ROOT_COUNT');
  detail.rootVisible = visible(roots[0]);
  if (!detail.rootVisible) return result('UNSAFE', opacityZero ? 'OPACITY_ZERO' : 'ROOT_VISIBILITY');
  const root = roots[0];
  if (root.querySelectorAll('article[aria-label^="本轮任务："], [role="group"][aria-label="AI 修改提议"]').length) return result('UNSUPPORTED_FORMAT', 'STRUCTURED_CONTENT');
  const nodes = [...root.querySelectorAll(role === 'owner' ? '[class*="bubbleAssistant"]' : '.desktop-haru-messages article[data-role="assistant"] p')];
  const messages = s.messages.filter(v => v?.role === 'assistant');
  detail.bodyCount = Math.min(2, nodes.length); detail.assistantCount = Math.min(2, messages.length);
  if (nodes.length > 1 || messages.length > 1) return result('UNSAFE', 'DUPLICATE_BODY');
  if (nodes.length === 0 || messages.length === 0) return pending('BODY_MISSING');
  detail.bodyVisible = visible(nodes[0]);
  if (!detail.bodyVisible) return result('UNSAFE', opacityZero ? 'OPACITY_ZERO' : 'BODY_VISIBILITY');
  // PIN renders a plain response as Markdown div > p > text/BR in Pilot,
  // and literal p > text in Haru. No HTML stripping or Markdown guessing.
  // textContent preserves CJK soft breaks that CSS innerText may collapse.
  const plain = node => {
    let text = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.textContent;
      else if (role === 'owner' && child.nodeType === 1 && child.tagName === 'BR'
        && child.childNodes.length === 0) text += '\n';
      else return null;
    }
    return text;
  };
  let content;
  if (role === 'owner') {
    const children = [...nodes[0].childNodes];
    if (children.length !== 1 || children[0].nodeType !== 1 || children[0].tagName !== 'DIV'
      || typeof children[0].className !== 'string' || !children[0].className.includes('markdown')) return result('UNSUPPORTED_FORMAT', 'OWNER_SHAPE');
    const markdown = children[0];
    if (!visible(markdown)) return result('UNSAFE', opacityZero ? 'OPACITY_ZERO' : 'MARKDOWN_VISIBILITY');
    const parts = [];
    for (const child of markdown.childNodes) {
      if (child.nodeType === 3 && !child.textContent.trim()) continue;
      if (child.nodeType !== 1 || child.tagName !== 'P') return result('UNSUPPORTED_FORMAT', 'PARAGRAPH_SHAPE');
      if (!visible(child)) return result('UNSAFE', opacityZero ? 'OPACITY_ZERO' : 'PARAGRAPH_VISIBILITY');
      const text = plain(child); if (text === null) return result('UNSUPPORTED_FORMAT', 'INLINE_FORMAT'); parts.push(text);
    }
    if (!parts.length) return pending('PARAGRAPHS_MISSING');
    content = parts.join('\n\n');
  } else content = plain(nodes[0]);
  if (content === null) return result('UNSUPPORTED_FORMAT', 'INLINE_FORMAT');
  const bridgeContent = messages[0].content;
  if (typeof content !== 'string' || content.length > 12000 || typeof bridgeContent !== 'string'
    || bridgeContent.length > 12000) return result('UNSAFE', 'TEXT_SHAPE');
  if (controlsPending) return pending('CONTROLS_PENDING');
  if (!content.trim() || !bridgeContent.trim()) return pending('EMPTY_TEXT');
  return result('READY', 'READY', { content, bridgeContent, ...identity });
}

export async function proveLivePilotCompletion(args) {
  requireProof(args?.mode === 'live' && args?.broker?.mode !== 'MOCK', 'HARNESS_INVALID');
  const outcome = await observePilotCompletion(args);
  return { ...outcome, code: `LIVE_${outcome.code}` };
}

// Shared mechanics only. The offline entrypoint's separate branded wrapper
// is the sole production caller that selects mock; LIVE never accepts an injection.
export async function observePilotCompletion({ mode, page, haru, broker, requestCountBefore, send, deadlineMs, ctx }) {
  requireProof(['live', 'mock'].includes(mode) && (mode === 'live' ? broker?.mode !== 'MOCK' : broker?.mode === 'MOCK')
    && page !== haru && typeof send === 'function' && Number.isFinite(deadlineMs), 'HARNESS_INVALID');
  let alive = true, admission, capture, primaryFailure, admitted = null, managerSeen = false;
  const started = performance.now();
  const diagnostic = { pollCount: 0 };
  const remember = (error, stage = diagnostic.lastReadStage) => {
    try {
      if (diagnostic.fault === undefined) {
        const safe = sanitizePilotProofDiagnostic({ fault: error?.proofFault,
          faultStage: error?.proofFaultStage ?? stage }, mode === 'mock');
        diagnostic.fault = safe.fault; diagnostic.faultStage = safe.faultStage;
      }
    } catch { /* Never replace the original failure. */ }
  };
  const attach = error => {
    try {
      const elapsed = Math.max(0, Math.floor(performance.now() - started));
      error.pilotProofDiagnostic = sanitizePilotProofDiagnostic({ ...diagnostic,
        elapsedMs: Math.min(elapsed, 600000), elapsedCapped: elapsed > 600000 }, mode === 'mock');
    } catch { /* Optional evidence cannot alter cleanup or the original error. */ }
    return error;
  };
  const readback = value => {
    diagnostic.lastReadOutcome = value?.readOutcome;
    diagnostic.lastHttpStatus = value?.httpStatus;
    return value?.value ?? null;
  };
  const isLedger = (value, before, count) => snapshotMode(mode, value) && snapshotMode(mode, before)
    && ledgerProven(value, before, count);
  const within = async (action, stage) => {
    diagnostic.lastReadStage = stage;
    const remaining = deadlineMs - Date.now();
    const left = Math.min(5000, remaining); requireProof(alive && left > 0, 'OBSERVE_DEADLINE');
    let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(proofError(remaining <= 5000 ? 'OBSERVE_DEADLINE' : 'OPERATION_TIMEOUT', stage)), left);
      })]);
      requireProof(alive && Date.now() < deadlineMs, 'OBSERVE_DEADLINE'); return value;
    } catch (error) {
      if (error?.captureInvalid === true) { diagnostic.admissionValid = false; diagnostic.admissionBodyOutcome = 'CAPTURE_INVALID'; }
      remember(error, stage); throw error;
    }
    finally { clearTimeout(timer); }
  };
  try {
    ctx.mark(mode === 'live' ? 'LIVE_FRESH_BASELINE' : 'MOCK_PILOT_PROOF_BASELINE');
    const origin = new URL(page.url()).origin;
    requireProof(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), 'HARNESS_INVALID');
    const before = structuredClone(broker.snapshot());
    requireProof(snapshotMode(mode, before) && before.sentRequests === requestCountBefore
      && before.requests?.length === requestCountBefore && before.active === false && before.closed === false && before.journalFailed === false, 'BASELINE_LEDGER_INVALID');
    const baseline = await within(() => readMirrorObservation(page, haru), 'INITIAL_MIRROR');
    requireProof(healthyMirror(baseline) && [baseline.owner, baseline.haru].every(v => v.conversationId === null
      && v.currentTaskState === 'idle' && v.loading === false && v.hasPending === false), 'FRESH_MIRROR_INVALID');
    const history = readback(await within(() => page.evaluate(readLivePilotJson, { origin, requestId: null, deadline: deadlineMs, diagnostics: true }), 'HISTORY_READ'));
    requireProof(Array.isArray(history) && history.length === 0, 'HISTORY_INVALID');
    capture = await installAdmissionCapture(page, origin, within);
    admission = observeLiveAdmission(page, origin, within, value => {
      if (value.admissionObserved === true) diagnostic.admissionObserved = true;
      if (typeof value.admissionValid === 'boolean') diagnostic.admissionValid = value.admissionValid;
      if (value.admissionHttpStatus !== undefined) diagnostic.admissionHttpStatus = value.admissionHttpStatus;
      if (value.admissionBodyOutcome !== undefined) diagnostic.admissionBodyOutcome = value.admissionBodyOutcome;
      if (value.fault) remember(value.fault, 'ADMISSION_READ');
    }, capture);
    ctx.mark(mode === 'live' ? 'LIVE_SEND_OBSERVE' : 'MOCK_PILOT_PROOF_SEND');
    await within(send, 'SEND');
    ctx.mark(mode === 'live' ? 'LIVE_TERMINAL_OBSERVE' : 'MOCK_PILOT_PROOF_OBSERVE');
    while (Date.now() < deadlineMs) {
      diagnostic.pollCount = Math.min(65535, diagnostic.pollCount + 1);
      const submitted = admission.read();
      const [pair, stream, response] = await within(() => Promise.all([
        readMirrorObservation(page, haru),
        page.evaluate(() => window.__offerpilotBoundedUiObserver?.summary?.() ?? null),
        submitted ? page.evaluate(readLivePilotJson, { origin, requestId: submitted.request_id, deadline: deadlineMs, diagnostics: true }) : null,
        capture.assertValid(),
      ]), 'STATUS_AND_MIRROR_READ');
      requireProof(healthyMirror(pair), 'MIRROR_INVALID');
      admission.read();
      const message = response === null ? null : readback(response);
      // PIN permits 404 only while the original request is being admitted.
      // Once bound, losing that exact execution is never a pending result.
      if (response !== null && message === null) requireProof(!admitted
        && response.readOutcome === 'HTTP_STATUS' && response.httpStatus === 404, 'READ_FAILED');
      if (message !== null) {
        const recovered = projectRequestExecution(message, submitted, managerSeen);
        if (admitted) requireProof(matches(recovered, admitted), 'STATUS_IDENTITY_INVALID');
        else admitted = recovered;
        if (message.recovery.requires_resync === false) { managerSeen = true; diagnostic.admissionValid = true; }
      }
      const content = message === null || message.recovery.requires_resync === true ? null : projectTerminal(message, admitted);
      if (message !== null) {
        diagnostic.lastValidState = message.state;
        diagnostic.workerDone = message.worker_done; diagnostic.actualWorkerAlive = message.actual_worker_alive;
        diagnostic.modelCallsReserved = message.budget?.model_calls;
      }
      if (content !== null && isLiveTerminalMirrorProven(pair, admitted)) {
        const ledger = broker.snapshot();
        if (!isLedger(ledger, before, requestCountBefore)) {
          // Wait only for the one already admitted provider call to settle.
          requireProof(ledger.active === true && ledger.requests?.filter(row => row.caseId === CASE).length === 1
            && ledger.requests.at(-1).status === 'RESERVED', 'LEDGER_INVALID');
        } else {
          ctx.mark(mode === 'live' ? 'LIVE_TERMINAL_COMPARE' : 'MOCK_PILOT_PROOF_COMPARE');
          const fingerprint = liveLedgerFingerprint(ledger);
          const [owner, companion] = await within(() => Promise.all([['owner', page], ['haru', haru]].map(([role, surface]) =>
            surface.evaluate(readLiveTerminalRenderer, { role, deadline: deadlineMs,
              ...(mode === 'mock' ? { diagnostics: true, expectedGeneration: baseline.owner.generation,
                expectedConversationId: admitted.conversation_id } : {}) }))), 'TERMINAL_RENDER_READ');
          // Keep both fixed renderer projections before any assertion can throw.
          // LIVE retains its original evidence schema, even for hostile returns.
          if (mode === 'mock') {
            diagnostic.rendererOwner = sanitizeRendererDiagnostic(owner?.diagnostic);
            diagnostic.rendererHaru = sanitizeRendererDiagnostic(companion?.diagnostic);
          }
          const compact = compactPlainMessage(content);
          requireProof([owner, companion].every(v => v && ['READY', 'NOT_READY', 'UNSUPPORTED_FORMAT', 'UNSAFE'].includes(v.status)), 'RENDERER_UNPROVEN');
          requireProof(![owner, companion].some(v => v.status === 'UNSUPPORTED_FORMAT'), 'RENDERER_FORMAT_UNSUPPORTED');
          requireProof(![owner, companion].some(v => v.status === 'UNSAFE'), 'RENDERER_UNPROVEN');
          requireProof([owner, companion].every(v => v.conversationId === admitted.conversation_id
            && v.generation === baseline.owner.generation), 'RENDERER_UNPROVEN');
          const rendererReady = [owner, companion].every(v => v.status === 'READY');
          const textMatched = rendererReady && normalizePlainText(owner.content) === normalizePlainText(content)
            && companion.content === compact && owner.bridgeContent === compact && companion.bridgeContent === compact;
          diagnostic.rendererReady = rendererReady; diagnostic.rendererTextMatched = textMatched;
          if (!textMatched) {
            // Backend completion precedes asynchronous React/bridge projection.
            // Keep the original overall deadline and never substitute wrong text.
            await within(() => new Promise(resolve => setTimeout(resolve, 50)), 'POLL_WAIT');
            continue;
          }
          const after = await within(() => readMirrorObservation(page, haru), 'FINAL_MIRROR_READ');
          admission.read();
          const afterLedger = broker.snapshot();
          requireProof(isLiveTerminalMirrorProven(after, admitted) && JSON.stringify(pair) === JSON.stringify(after)
            && isLedger(afterLedger, before, requestCountBefore) && liveLedgerFingerprint(afterLedger) === fingerprint, 'FINAL_STABILITY_UNPROVEN');
          const sustained = isRunningMirrorProven(after) && stream?.installed === true && stream.originalTargetConnected === true
            && stream.originalTargetCurrent === true && stream.currentPilotUnique === true && stream.targetReplacementObserved === false
            && stream.readFailed === false && stream.originalGrowthWithStopCount >= 2;
          const running = v => v.bridgeRunningObserved === true && v.domRunningObserved === true && v.runningConversationId === admitted.conversation_id;
          await within(() => capture.assertValid(true), 'ADMISSION_READ');
          return { code: sustained ? 'STREAMING_PROVEN' : 'COMPLETION_ONLY', checks: {
            sustainedStreamingObserved: sustained, incrementalAssistantRendering: sustained,
            ownerRunningTransitionObserved: running(after.owner), haruRunningTransitionObserved: running(after.haru),
            positiveRunningConversationMatched: isRunningMirrorProven(after), finalRunningConversationMatched: isRunningMirrorProven(after),
            haruRunningAndIdleMirrored: isRunningMirrorProven(after), haruVisibleAssistantMatchesSnapshot: true,
            freshConversationProven: true, uiAdmissionProven: true, naturalCompletionProven: true,
            terminalIdentityProven: true, terminalMirrorProven: true, terminalTextProven: true,
            providerRequestSettled: true, ledgerUnchanged: true, admissionObserverCleanupPassed: true } };
        }
      }
      await within(() => new Promise(resolve => setTimeout(resolve, 50)), 'POLL_WAIT');
    }
    fail(diagnostic.rendererTextMatched === false ? 'RENDERER_UNPROVEN' : 'OBSERVE_DEADLINE');
  } catch (error) { remember(error); primaryFailure = attach(proofError(diagnostic.fault, diagnostic.faultStage)); throw primaryFailure; }
  finally {
    alive = false;
    let cleanupFailed = false;
    try { admission?.dispose(); } catch { cleanupFailed = true; }
    try { await capture?.dispose(); } catch { cleanupFailed = true; }
    if (cleanupFailed) {
      if (!primaryFailure) { const error = proofError('ADMISSION_CLEANUP_FAILED', 'CLEANUP'); remember(error); throw attach(error); }
    }
  }
}
