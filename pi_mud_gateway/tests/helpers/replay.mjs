import assert from 'node:assert/strict';
import { sendMudCommand, collectMudEvents } from '../../lib/transport.mjs';
import { splitCleanMudLines, parseStatusLine, detectStopReason, shouldStopBeforeNextCommand,
  routeStepCommand, commandSequenceWaitMs } from '../../lib/core.mjs';

// Scripted, strict transport: unexpected commands fail instead of reaching a network.
export class MockTransport {
  constructor(frames, player = {}) {
    this.frames = [...frames]; this.player = player;
    this.queue = []; this.writes = []; this.waits = []; this.pending = null;
  }
  write(wire) {
    assert.equal(this.pending, null, 'previous response must be collected');
    const frame = this.frames.shift();
    assert.ok(frame, `unexpected command: ${wire}`);
    assert.equal(wire, frame.command + '\n');
    this.writes.push(wire); this.pending = frame;
  }
  wait = async (ms) => {
    this.waits.push(ms);
    assert.ok(this.pending);
    for (const content of splitCleanMudLines(this.pending.raw)) {
      parseStatusLine(content, this.player);
      this.queue.push({ type: 'text', content, timestamp: this.waits.length });
    }
    this.pending = null;
  };
}

// Fake runner replaces the agent/provider. It consumes fixed decisions, never creates a session.
export async function replay(commands, frames, { player = {}, route = false, manual = () => false } = {}) {
  const transport = new MockTransport(frames, player);
  const steps = [];
  let stopReason = '';
  for (const [index, step] of commands.entries()) {
    if (manual(index)) { stopReason = 'manual_control_active'; break; }
    const cmd = routeStepCommand(step).trim();
    const waitMs = route
      ? Math.max(100, Math.min(60_000, Number(step.waitMs || 150)))
      : commandSequenceWaitMs(cmd, 150);
    sendMudCommand(transport, cmd);
    const events = await collectMudEvents(waitMs, transport.wait, transport.queue);
    const stop = detectStopReason(events, cmd, player);
    const stopped = route ? Boolean(stop && stop !== 'combat_or_damage')
      : shouldStopBeforeNextCommand(stop, commands[index + 1] || '');
    steps.push({ cmd, waitMs, rawText: events.map(e => e.content).join('\n') });
    if (stopped) { stopReason = stop; break; }
  }
  return { transport, player, steps, stopReason };
}
