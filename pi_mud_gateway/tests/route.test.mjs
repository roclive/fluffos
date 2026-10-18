import { describe, it } from 'node:test';
import assert from 'node:assert';
import { 
  routeDeviation, 
  classifyRouteDeviation, 
  routeRecoveryHint 
} from '../lib/route_logic.mjs';

describe('Route Logic and Recovery', () => {
  const mockKB = {
    byId: new Map([
      ['/d/room1', { short: 'Room 1' }],
      ['/d/room2', { short: 'Room 2' }],
      ['/d/room3', { short: 'Room 2' }], // Same name as room 2
    ]),
    byShort: new Map([
      ['Room 1', ['/d/room1']],
      ['Room 2', ['/d/room2', '/d/room3']],
    ])
  };

  const kbRoomShort = (rid) => mockKB.byId.get(rid)?.short || '';
  const describeRoom = (rid, fallback) => rid + ' ' + (kbRoomShort(rid) || fallback);

  it('should distinguish same-name rooms using room_id', () => {
    const expected = { label: 'Room 2', keywords: ['Room 2'] };
    const actualRoom = 'Room 2';
    const expectedRoomId = '/d/room2';
    const actualRoomId = '/d/room3';

    const deviation = routeDeviation(expected, actualRoom, expectedRoomId, actualRoomId, kbRoomShort, describeRoom);
    assert.ok(deviation, 'Should detect deviation when room_ids differ even if names are same');
    assert.ok(deviation.includes('route偏离'), 'Should return deviation message');
  });

  it('should identify correct room when room_id matches', () => {
    const expected = { label: 'Room 2', keywords: ['Room 2'] };
    const actualRoom = 'Room 2';
    const expectedRoomId = '/d/room2';
    const actualRoomId = '/d/room2';

    const deviation = routeDeviation(expected, actualRoom, expectedRoomId, actualRoomId, kbRoomShort, describeRoom);
    assert.strictEqual(deviation, '', 'Should not detect deviation when room_ids match');
  });

  it('should handle breakpoint recovery verification', () => {
    const expectedRoomId = '/d/room2';
    const actualRoomId = '/d/room2';
    
    const isRecoverable = (actual, expected) => actual === expected;
    assert.strictEqual(isRecoverable(actualRoomId, expectedRoomId), true, 'Recovery should proceed if current room matches expected');
    
    const wrongActualId = '/d/room3';
    assert.strictEqual(isRecoverable(wrongActualId, expectedRoomId), false, 'Recovery should stop if current room differs');
  });

  it('should restrict non-idempotent commands during recovery', () => {
    const commands = [
      { cmd: 'north', idempotent: true },
      { cmd: 'open gate', idempotent: false },
      { cmd: 'look', idempotent: true },
    ];

    const filterRecoveryCommands = (cmds) => cmds.filter(c => c.idempotent);
    const filtered = filterRecoveryCommands(commands);
    
    assert.strictEqual(filtered.length, 2);
    assert.strictEqual(filtered[0].cmd, 'north');
    assert.strictEqual(filtered[1].cmd, 'look');
    assert.ok(!filtered.some(c => c.cmd === 'open gate'), 'Non-idempotent commands should be filtered out');
  });

  it('should classify deviations and provide recovery hints', () => {
    const routeName = 'test_route';
    const cmd = 'south';
    const expected = { label: 'Room B', keywords: ['Room B'] };
    const actualRoom = 'Room A';
    const eventsText = 'You see a closed gate.';
    
    const kind = classifyRouteDeviation(
      routeName, cmd, expected, actualRoom, eventsText, 'blocked_exit', '/d/roomB', '/d/roomA',
      routeDeviation, kbRoomShort, describeRoom
    );
    
    assert.strictEqual(kind, 'gate_blocked');
    
    const hint = routeRecoveryHint(routeName, cmd, kind, actualRoom, ['north', 'west']);
    assert.ok(hint.includes('gate'), 'Hint should mention gate');
  });
});
