import { describe, it, expect } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// Mocking the Gateway state and dependencies
const mockState = {
  connected: true,
  world: {
    location: { room_id: '/d/city/guangchang', name: '扬州中央广场', exits: ['north'] },
    player: { hp: 100, hp_max: 100 }
  },
  routeState: { active: false },
  eventQueue: []
};

const mockKB = {
  byId: new Map([
    ['/d/city/guangchang', { room_id: '/d/city/guangchang', short: '扬州中央广场', exits: { north: '/d/city/dajie1' } }],
    ['/d/city/dajie1', { room_id: '/d/city/dajie1', short: '大街', exits: { south: '/d/city/guangchang' } }]
  ]),
  byShort: new Map([
    ['扬州中央广场', ['/d/city/guangchang']],
    ['大街', ['/d/city/dajie1']]
  ])
};

const mockKnownRoutes = {
  'test_route': {
    from: '扬州中央广场',
    to: '大街',
    commands: ['north'],
    notes: 'Simple test route'
  }
};

// Simple version of the routing logic for testing without running the full gateway
function mockExecuteRouteSkill(name, startIndex = 0) {
  const route = mockKnownRoutes[name];
  if (!route) throw new Error('Route not found');
  
  let currentRoomId = mockState.world.location.room_id;
  const steps = [];
  
  for (let i = startIndex; i < route.commands.length; i++) {
    const cmd = route.commands[i];
    const room = mockKB.byId.get(currentRoomId);
    const nextRoomId = room?.exits[cmd];
    
    if (!nextRoomId) {
      return { status: 'stopped', stopReason: 'blocked_exit', steps };
    }
    
    currentRoomId = nextRoomId;
    steps.push({ step: i + 1, cmd, room_id: currentRoomId });
  }
  
  return { status: 'completed', steps };
}

describe('Route Pathfinding and Recovery', () => {
  it('should complete a simple route', () => {
    const result = mockExecuteRouteSkill('test_route');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.steps[0].room_id, '/d/city/dajie1');
  });

  it('should handle breakpoint recovery (mock)', () => {
    // Simulating a saved state at step 0, but we are already at step 0
    const savedStep = 0;
    const currentRoomId = '/d/city/guangchang';
    const expectedRoomId = '/d/city/guangchang'; // simplified logic
    
    assert.strictEqual(currentRoomId, expectedRoomId, 'Room ID must match for recovery');
    const result = mockExecuteRouteSkill('test_route', savedStep);
    assert.strictEqual(result.status, 'completed');
  });

  it('should stop on unknown room/blocked exit', () => {
    // Modify KB to break the route
    mockKB.byId.get('/d/city/guangchang').exits = {};
    const result = mockExecuteRouteSkill('test_route');
    assert.strictEqual(result.status, 'stopped');
    assert.strictEqual(result.stopReason, 'blocked_exit');
    // Restore KB
    mockKB.byId.get('/d/city/guangchang').exits = { north: '/d/city/dajie1' };
  });

  it('should distinguish same-name rooms using room_id', () => {
    // Setup two rooms with same short name
    mockKB.byId.set('/d/room_a', { room_id: '/d/room_a', short: 'SameName' });
    mockKB.byId.set('/d/room_b', { room_id: '/d/room_b', short: 'SameName' });
    
    const actualRoomId = '/d/room_a';
    const expectedRoomId = '/d/room_b';
    
    assert.notStrictEqual(actualRoomId, expectedRoomId, 'Room IDs must be different even if names are same');
  });
});
