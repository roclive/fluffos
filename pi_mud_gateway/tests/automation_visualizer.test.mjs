import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAutomationEvent,
  applyControlEvent,
  automationSnapshot,
  createAutomationState,
  isTrustedWebSocketRequest,
  validateControlEvent,
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
