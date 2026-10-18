import { randomUUID } from 'node:crypto';

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'cancel']);
const CONTROL_KEYS = new Set(['type', 'version', 'sessionId', 'source', 'sequence', 'action']);
const SAFE_TEXT = /^[\w./:* -]{0,160}$/u;

export function createAutomationState({ sessionId = randomUUID(), now = Date.now } = {}) {
  return {
    version: 1,
    sessionId,
    status: 'idle',
    currentSkill: null,
    currentRoute: null,
    decision: { reason: '', confidence: null, trigger: '' },
    confirmation: { step: 0, total: 0, command: '', expectedRoom: '', actualRoom: '', confirmed: null },
    modelCalls: 0,
    control: { lastSequence: 0, lastAction: '', updatedAt: now() },
    updatedAt: now(),
  };
}

export function automationSnapshot(state) {
  return { type: 'automation_state', data: structuredClone(state) };
}

export function applyAutomationEvent(state, event, { now = Date.now } = {}) {
  if (!event || typeof event !== 'object') throw new Error('automation event must be an object');
  const next = structuredClone(state);
  if (event.type === 'model_call') {
    next.modelCalls += 1;
    next.decision.trigger = cleanText(event.trigger);
    next.status = 'running';
  } else if (event.type === 'decision') {
    if (event.countCall !== false) next.modelCalls += 1;
    next.currentSkill = cleanOptional(event.skill);
    next.currentRoute = cleanOptional(event.route);
    next.decision = {
      reason: cleanText(event.reason),
      confidence: Number.isFinite(event.confidence) ? Math.max(0, Math.min(1, event.confidence)) : null,
      trigger: cleanText(event.trigger),
    };
    next.status = 'running';
  } else if (event.type === 'step') {
    next.currentSkill = cleanOptional(event.skill) ?? next.currentSkill;
    next.currentRoute = cleanOptional(event.route) ?? next.currentRoute;
    next.confirmation = {
      step: boundedInteger(event.step, 0, 100000),
      total: boundedInteger(event.total, 0, 100000),
      command: cleanText(event.command),
      expectedRoom: cleanText(event.expectedRoom),
      actualRoom: cleanText(event.actualRoom),
      confirmed: typeof event.confirmed === 'boolean' ? event.confirmed : null,
    };
    next.status = 'running';
  } else if (event.type === 'complete') {
    next.status = 'completed';
  } else if (event.type === 'error') {
    next.status = 'error';
    next.decision.reason = cleanText(event.reason);
  } else {
    throw new Error(`unsupported automation event: ${String(event.type)}`);
  }
  next.updatedAt = now();
  return next;
}

export function validateControlEvent(input, context) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('invalid_schema');
  if (Object.keys(input).some((key) => !CONTROL_KEYS.has(key))) return reject('unknown_field');
  if (input.type !== 'automation_control' || input.version !== 1) return reject('invalid_schema');
  if (!CONTROL_ACTIONS.has(input.action)) return reject('invalid_action');
  if (input.sessionId !== context.sessionId) return reject('session_mismatch');
  if (input.source !== 'web-client') return reject('source_mismatch');
  if (!context.isTrustedSource) return reject('untrusted_source');
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= context.lastSequence) return reject('stale_sequence');
  return { ok: true, value: { action: input.action, sequence: input.sequence, source: input.source } };
}

export function applyControlEvent(state, input, context = {}) {
  const checked = validateControlEvent(input, {
    sessionId: state.sessionId,
    lastSequence: state.control.lastSequence,
    isTrustedSource: context.isTrustedSource === true,
  });
  if (!checked.ok) return { state, ...checked };
  const now = context.now || Date.now;
  const next = structuredClone(state);
  next.control = { lastSequence: checked.value.sequence, lastAction: checked.value.action, updatedAt: now() };
  next.status = checked.value.action === 'pause' ? 'paused' : checked.value.action === 'cancel' ? 'cancelled' : 'running';
  next.updatedAt = now();
  return { ok: true, state: next, action: checked.value.action };
}

export function isTrustedWebSocketRequest(request) {
  const address = request?.socket?.remoteAddress || '';
  const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  const origin = request?.headers?.origin;
  if (!local) return false;
  if (!origin || origin === 'null') return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function reject(error) { return { ok: false, error }; }
function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : 0;
}
function cleanOptional(value) { return value == null || value === '' ? null : cleanText(value); }
function cleanText(value) {
  const text = String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 160);
  return SAFE_TEXT.test(text) ? text : text.replace(/[^\w./:* -]/gu, '');
}
