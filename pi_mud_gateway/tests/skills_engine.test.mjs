import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillRegistry, SkillExecutor, MockTransport, SkillError } from '../lib/skills_engine.mjs';

class SequenceMockTransport extends MockTransport {
  constructor(responses = []) {
    super();
    this.responses = responses; // Array of events for each write
    this.responseIndex = 0;
  }

  async wait(ms) {
    super.wait(ms);
    if (this.responses[this.responseIndex]) {
      this.responses[this.responseIndex].forEach(content => this.pushEvent(content));
    }
    this.responseIndex++;
  }
}

test('Skill execution: basic success flow', async () => {
  const registry = new SkillRegistry();
  registry.register({
    id: 'test-skill',
    prerequisites: () => true,
    steps: [
      {
        id: 'step1',
        action: () => 'cmd1',
        verify: (events) => events.some(e => e.content === 'res1') || 'failed res1',
      },
      {
        id: 'step2',
        action: () => 'cmd2',
        verify: (events) => events.some(e => e.content === 'res2') || 'failed res2',
      }
    ],
    postcondition: () => true,
    timeoutMs: 1000,
  });

  const transport = new SequenceMockTransport([['res1'], ['res2']]);
  const executor = new SkillExecutor(transport, registry);
  const result = await executor.execute('test-skill');

  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(transport.writes, ['cmd1\n', 'cmd2\n']);
});

test('Skill execution: prerequisite failure', async () => {
  const registry = new SkillRegistry();
  registry.register({
    id: 'test-skill',
    prerequisites: (state) => state.hasItem ? true : 'missing item',
    steps: [],
    postcondition: () => true,
  });

  const transport = new MockTransport();
  const executor = new SkillExecutor(transport, registry);

  await assert.rejects(
    executor.execute('test-skill', { hasItem: false }),
    { name: 'SkillError', code: 'PREREQ_FAILED' }
  );
});

test('Skill execution: step verification failure with retry', async () => {
  const registry = new SkillRegistry();
  registry.register({
    id: 'retry-skill',
    prerequisites: () => true,
    steps: [
      {
        id: 'step1',
        action: () => 'cmd1',
        verify: (events) => events.some(e => e.content === 'res1') || 'failed res1',
        recovery: (err) => err === 'failed res1' ? 'RETRY' : 'ABORT',
      }
    ],
    postcondition: () => true,
  });

  const transport = new SequenceMockTransport([['wrong'], ['res1']]);
  const executor = new SkillExecutor(transport, registry);
  const result = await executor.execute('retry-skill');

  assert.equal(result.status, 'SUCCESS');
  assert.equal(transport.writes.length, 2);
  assert.deepEqual(transport.writes, ['cmd1\n', 'cmd1\n']);
});

test('Skill execution: repeat steps (bucket filling)', async () => {
  const registry = new SkillRegistry();
  registry.register({
    id: 'fill-skill',
    prerequisites: () => true,
    steps: [
      {
        id: 'fill',
        repeat: 3,
        action: (state, i) => `fill-${i}`,
        verify: (events, i) => events.some(e => e.content === `res-${i}`) || `failed ${i}`,
      }
    ],
    postcondition: () => true,
  });

  const transport = new SequenceMockTransport([['res-0'], ['res-1'], ['res-2']]);
  const executor = new SkillExecutor(transport, registry);
  const result = await executor.execute('fill-skill');

  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(transport.writes, ['fill-0\n', 'fill-1\n', 'fill-2\n']);
});

test('Skill execution: timeout', async () => {
  const registry = new SkillRegistry();
  registry.register({
    id: 'timeout-skill',
    prerequisites: () => true,
    steps: [
      {
        id: 'step1',
        action: () => 'cmd1',
        verify: () => 'never success',
      }
    ],
    postcondition: () => true,
    timeoutMs: 10, // Very short timeout
  });

  const transport = new MockTransport();
  const executor = new SkillExecutor(transport, registry);

  // We need to simulate time passing. Since MockTransport.wait is async, we can make it slow.
  transport.wait = async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
  };

  await assert.rejects(
    executor.execute('timeout-skill'),
    { name: 'SkillError', code: 'TIMEOUT' }
  );
});
