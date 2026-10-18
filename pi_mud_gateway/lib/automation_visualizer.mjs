import { randomUUID } from 'node:crypto';

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'cancel']);
const CONTROL_KEYS = new Set(['type', 'version', 'sessionId', 'source', 'sequence', 'action']);
const LEGACY_CONTROL_SCHEMAS = {
  cmd: { keys: ['type', 'cmd'], check: (input) => safeString(input.cmd, 500) && input.cmd.trim().length > 0 },
  fast_explore: {
    keys: ['type', 'enabled', 'intervalMs'],
    check: (input) => typeof input.enabled === 'boolean'
      && (input.intervalMs === undefined || (Number.isSafeInteger(input.intervalMs) && input.intervalMs >= 50 && input.intervalMs <= 60_000)),
  },
  loop_control: { keys: ['type', 'action'], check: (input) => input.action === 'start' || input.action === 'stop' },
  water_state: {
    keys: ['type', 'state', 'stage', 'action', 'reason'],
    check: (input) => safeString(input.state, 80) && input.state.trim().length > 0
      && optionalString(input.stage, 80) && optionalString(input.action, 120) && optionalString(input.reason, 300),
  },
  prompt: { keys: ['type', 'prompt', 'oneShot'], check: (input) => safeString(input.prompt, 1000) && (input.oneShot === undefined || typeof input.oneShot === 'boolean') },
};
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
    setRunningUnlessControlled(next);
  } else if (event.type === 'decision') {
    if (event.countCall !== false) next.modelCalls += 1;
    next.currentSkill = cleanOptional(event.skill);
    next.currentRoute = cleanOptional(event.route);
    next.decision = {
      reason: cleanText(event.reason),
      confidence: Number.isFinite(event.confidence) ? Math.max(0, Math.min(1, event.confidence)) : null,
      trigger: cleanText(event.trigger),
    };
    setRunningUnlessControlled(next);
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
    setRunningUnlessControlled(next);
  } else if (event.type === 'complete') {
    if (!automationInterruption(next)) next.status = 'completed';
  } else if (event.type === 'error') {
    if (!automationInterruption(next)) next.status = 'error';
    next.decision.reason = cleanText(event.reason);
  } else {
    throw new Error(`unsupported automation event: ${String(event.type)}`);
  }
  next.updatedAt = now();
  return next;
}

export function automationInterruption(state) {
  return state?.status === 'paused' ? 'automation_paused'
    : state?.status === 'cancelled' ? 'automation_cancelled'
      : '';
}

export function automationEventFromTrace(patch, location = {}, previous = {}) {
  if (!patch || (patch.kind !== 'route' && patch.kind !== 'skill') || patch.phase === 'error') return null;
  const input = patch.input || {};
  const output = patch.outputSummary || {};
  const data = { ...input, ...output };
  const ending = patch.phase === 'end';
  const step = firstInteger(
    data.step,
    ending ? data.completedSteps : undefined,
    ending ? data.completedCommands : undefined,
    previous.step,
  );
  const total = firstInteger(
    data.total,
    data.totalSteps,
    data.requestedSteps,
    data.requestedCommands,
    data.maxSteps,
    previous.total,
  );
  const expectedRoom = data.expectedRoomIdNext || data.expectedRoom || data.expectedStage || previous.expectedRoom || '';
  const actualRoom = data.actualRoomId || data.actualRoom || location.room_id || location.name || previous.actualRoom || '';
  return {
    type: 'step',
    skill: patch.kind === 'skill' ? patch.name : undefined,
    route: patch.kind === 'route' ? patch.name : undefined,
    step,
    total,
    command: data.cmd || data.command || data.direction || previous.command || '',
    expectedRoom,
    actualRoom,
    confirmed: patch.status === 'ok' ? true : ['stopped', 'blocked'].includes(patch.status) ? false : previous.confirmed ?? null,
  };
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

export function validateLegacyControlEvent(input, { isTrustedSource = false } = {}) {
  if (!isTrustedSource) return reject('untrusted_source');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('invalid_schema');
  const schema = LEGACY_CONTROL_SCHEMAS[input.type];
  if (!schema) return reject('unsupported_type');
  const allowed = new Set(schema.keys);
  if (Object.keys(input).some((key) => !allowed.has(key))) return reject('unknown_field');
  return schema.check(input) ? { ok: true, value: input } : reject('invalid_schema');
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
function setRunningUnlessControlled(state) {
  if (state.status !== 'paused' && state.status !== 'cancelled') state.status = 'running';
}
function safeString(value, maxLength) { return typeof value === 'string' && value.length <= maxLength; }
function optionalString(value, maxLength) { return value === undefined || safeString(value, maxLength); }
function firstInteger(...values) {
  return values.find((value) => Number.isSafeInteger(value) && value >= 0) ?? 0;
}
function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : 0;
}
function cleanOptional(value) { return value == null || value === '' ? null : cleanText(value); }
function cleanText(value) {
  const text = String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 160);
  return SAFE_TEXT.test(text) ? text : text.replace(/[^\w./:* -]/gu, '');
}
