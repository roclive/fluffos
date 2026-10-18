import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAutomationEvent,
  applyControlEvent,
  automationEventFromTrace,
  automationInterruption,
  automationSnapshot,
  createAutomationState,
  isTrustedWebSocketRequest,
  validateControlEvent,
  validateLegacyControlEvent,
} from '../lib/automation_visualizer.mjs';

test('fake provider decisions and fake runner steps produce a bounded visual snapshot', () => {
  let state = createAutomationState({ sessionId: 'test-session', now: () => 10 });
  state = applyAutomationEvent(state, {
    type: 'decision', skill: 'shaolin_progress', route: 'to_riverbank',
    reason: 'need water', confidence: 0.91, trigger: 'task_start',
  }, { now: () => 20 });
  state = applyAutomationEvent(state, {
    type: 'step', step: 2, total: 4, command: 'north', expectedRoom: '/d/river',
    actualRoom: '/d/river', confirmed: true,
  }, { now: () => 30 });
  const message = automationSnapshot(state);
  assert.equal(message.data.modelCalls, 1);
  assert.equal(message.data.currentSkill, 'shaolin_progress');
  assert.deepEqual(message.data.confirmation, {
    step: 2, total: 4, command: 'north', expectedRoom: '/d/river', actualRoom: '/d/river', confirmed: true,
  });
});

test('model call events count pending provider invocations independently', () => {
  const state = createAutomationState({ sessionId: 'test-session', now: () => 10 });
  const pending = applyAutomationEvent(state, { type: 'model_call', trigger: 'task_start' }, { now: () => 20 });
  assert.equal(pending.modelCalls, 1);
  assert.equal(pending.decision.trigger, 'task_start');
});

test('control schema accepts a trusted, session-bound, monotonic event', () => {
  const state = createAutomationState({ sessionId: 'session-a', now: () => 1 });
  const result = applyControlEvent(state, {
    type: 'automation_control', version: 1, sessionId: 'session-a', source: 'web-client', sequence: 1, action: 'pause',
  }, { isTrustedSource: true, now: () => 2 });
  assert.equal(result.ok, true);
  assert.equal(result.state.status, 'paused');
  assert.equal(result.state.control.lastSequence, 1);
});

test('control schema rejects spoofing, replay, session mismatch and extra fields', () => {
  const base = { type: 'automation_control', version: 1, sessionId: 's', source: 'web-client', sequence: 2, action: 'resume' };
  const context = { sessionId: 's', lastSequence: 1, isTrustedSource: true };
  assert.equal(validateControlEvent({ ...base, source: 'mud-output' }, context).error, 'source_mismatch');
  assert.equal(validateControlEvent({ ...base, sequence: 1 }, context).error, 'stale_sequence');
  assert.equal(validateControlEvent({ ...base, sessionId: 'other' }, context).error, 'session_mismatch');
  assert.equal(validateControlEvent({ ...base, command: 'quit' }, context).error, 'unknown_field');
  assert.equal(validateControlEvent(base, { ...context, isTrustedSource: false }).error, 'untrusted_source');
});

test('trusted source requires loopback peer and loopback or opaque origin', () => {
  const request = (remoteAddress, origin) => ({ socket: { remoteAddress }, headers: { origin } });
  assert.equal(isTrustedWebSocketRequest(request('127.0.0.1', 'http://localhost:8000')), true);
  assert.equal(isTrustedWebSocketRequest(request('::1', 'null')), true);
  assert.equal(isTrustedWebSocketRequest(request('10.0.0.8', 'http://localhost:8000')), false);
  assert.equal(isTrustedWebSocketRequest(request('127.0.0.1', 'https://evil.example')), false);
});

test('provider callbacks cannot overwrite pause or cancel received in flight', () => {
  for (const action of ['pause', 'cancel']) {
    let state = createAutomationState({ sessionId: 's', now: () => 1 });
    state = applyAutomationEvent(state, { type: 'model_call', trigger: 'task_start' });
    state = applyControlEvent(state, {
      type: 'automation_control', version: 1, sessionId: 's', source: 'web-client', sequence: 1, action,
    }, { isTrustedSource: true }).state;
    state = applyAutomationEvent(state, {
      type: 'decision', countCall: false, route: 'safe', reason: 'provider returned', confidence: 1, trigger: 'task_start',
    });
    assert.equal(state.status, action === 'pause' ? 'paused' : 'cancelled');
    assert.equal(automationInterruption(state), `automation_${action === 'pause' ? 'paused' : 'cancelled'}`);
  }
});

test('fake multi-step runner stops before the next write after cancellation', () => {
  let state = createAutomationState({ sessionId: 's' });
  state = applyAutomationEvent(state, { type: 'step', step: 0, total: 3 });
  const writes = [];
  for (const command of ['north', 'east', 'south']) {
    if (automationInterruption(state)) break;
    writes.push(command);
    if (writes.length === 1) {
      state = applyControlEvent(state, {
        type: 'automation_control', version: 1, sessionId: 's', source: 'web-client', sequence: 1, action: 'cancel',
      }, { isTrustedSource: true }).state;
    }
  }
  assert.deepEqual(writes, ['north']);
});

test('legacy controls require trusted source and exact per-type schemas', () => {
  const valid = [
    { type: 'cmd', cmd: 'look' },
    { type: 'fast_explore', enabled: true, intervalMs: 150 },
    { type: 'loop_control', action: 'stop' },
    { type: 'water_state', state: 'bucket_filled', reason: 'observed' },
    { type: 'prompt', prompt: 'observe', oneShot: true },
  ];
  for (const message of valid) {
    assert.equal(validateLegacyControlEvent(message, { isTrustedSource: true }).ok, true, message.type);
    assert.equal(validateLegacyControlEvent(message, { isTrustedSource: false }).error, 'untrusted_source', message.type);
  }
  assert.equal(validateLegacyControlEvent({ type: 'cmd', cmd: 'look', action: 'bypass' }, { isTrustedSource: true }).error, 'unknown_field');
  assert.equal(validateLegacyControlEvent({ type: 'fast_explore', enabled: 'yes' }, { isTrustedSource: true }).error, 'invalid_schema');
  assert.equal(validateLegacyControlEvent({ type: 'fast_explore', enabled: true, intervalMs: 1 }, { isTrustedSource: true }).error, 'invalid_schema');
  assert.equal(validateLegacyControlEvent({ type: 'loop_control', action: 'launch' }, { isTrustedSource: true }).error, 'invalid_schema');
});

test('production route traces map real progress fields without erasing the final step', () => {
  const start = automationEventFromTrace({
    phase: 'start', kind: 'route', name: 'river', input: { totalSteps: 4, maxSteps: 3 },
  }, { room_id: '/d/start' }, {});
  assert.equal(start.total, 4);
  const progress = automationEventFromTrace({
    phase: 'progress', kind: 'route', name: 'river', status: 'ok',
    outputSummary: { step: 2, totalSteps: 4, cmd: 'north', expectedRoomIdNext: '/d/next', actualRoomId: '/d/next' },
  }, {}, start);
  assert.deepEqual({ step: progress.step, total: progress.total, command: progress.command, expected: progress.expectedRoom, confirmed: progress.confirmed },
    { step: 2, total: 4, command: 'north', expected: '/d/next', confirmed: true });
  const end = automationEventFromTrace({
    phase: 'end', kind: 'route', name: 'river', status: 'ok', outputSummary: { completedSteps: 3, requestedSteps: 3 },
  }, { room_id: '/d/final' }, progress);
  assert.deepEqual({ step: end.step, total: end.total, command: end.command, expected: end.expectedRoom },
    { step: 3, total: 3, command: 'north', expected: '/d/next' });
});
