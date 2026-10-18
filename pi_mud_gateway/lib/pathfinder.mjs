import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadMap(mapPath) {
  try {
    const content = await fs.readFile(mapPath, 'utf-8');
    const data = JSON.parse(content);
    const rooms = new Map();
    for (const r of data.rooms || []) {
      if (r.room_id) {
        rooms.set(r.room_id, r);
      }
    }
    return rooms;
  } catch (err) {
    console.error(`[Pathfinder] Error loading map from ${mapPath}:`, err);
    return null;
  }
}

export function resolveRoom(term, rooms) {
  if (!rooms) return null;
  if (term.startsWith('/') && rooms.has(term)) {
    return term;
  }
  // fuzzy match: search for term in short or area
  for (const [rid, r] of rooms.entries()) {
    if ((r.short && term.includes(r.short)) || (r.area && term.includes(r.area))) {
      return rid;
    }
  }
  return null;
}

export function findShortestPath(startTerm, goalTerm, rooms) {
  const start = resolveRoom(startTerm, rooms);
  const goal = resolveRoom(goalTerm, rooms);

  if (!start || !goal) {
    return { error: `Could not resolve rooms: ${start ? 'OK' : startTerm} -> ${goal ? 'OK' : goalTerm}` };
  }

  if (start === goal) {
    return { path: [], from: start, to: goal };
  }

  const queue = [start];
  const prev = new Map();
  prev.set(start, null);

  while (queue.length > 0) {
    const cur = queue.shift();
    const room = rooms.get(cur);
    if (!room || !room.exits) continue;

    for (const [dir, tgt] of Object.entries(room.exits)) {
      if (rooms.has(tgt) && !prev.has(tgt)) {
        prev.set(tgt, { from: cur, dir });
        if (tgt === goal) {
          const path = [];
          let node = goal;
          while (prev.get(node)) {
            const edge = prev.get(node);
            const targetRoom = rooms.get(node);
            path.unshift({
              dir: edge.dir,
              room: targetRoom?.short || node,
              roomId: node
            });
            node = edge.from;
          }
          return { path, from: start, to: goal };
        }
        queue.push(tgt);
      }
    }
  }

  return { error: `No path found between ${start} and ${goal}` };
}


// Resolve only known fixed routes or graph edges, never arbitrary model commands.
export function resolveGatewayRoute(name, currentRoom, rooms, knownRoutes) {
  if (Object.hasOwn(knownRoutes, name)) return knownRoutes[name];
  if (!rooms || !currentRoom || !rooms.has(name)) return undefined;
  const result = findShortestPath(currentRoom, name, rooms);
  if (result.error) return undefined;
  return {from: result.from, to: result.to, notes: 'Map BFS', commands: result.path.map(step => step.dir), expectedRoomIds: result.path.map(step => step.roomId)};
}


export function routeLocationError(expected, actual) {
  if (!actual) return 'unknown_room';
  if (expected && expected !== actual && !routeStartMatches(expected, actual)) return 'room_mismatch';
  return '';
}

// Route labels may explicitly review a terminal `*` room-id prefix, such as
// /d/shaolin/shanlu*. No other glob syntax is accepted.
export function routeStartMatches(routeFrom, actualRoomId) {
  if (typeof routeFrom !== 'string' || typeof actualRoomId !== 'string') return false;
  const match = routeFrom.match(/(\/d\/[a-z0-9_/\-]+)(\*)?/i);
  if (!match) return false;
  return match[2] ? actualRoomId.startsWith(match[1]) : actualRoomId === match[1];
}

// Includes both every step's starting room and the final destination.  Thus a
// route with N commands has N+1 entries and its last movement is verifiable.
export function precomputeFixedRouteRoomIds(route, rooms, directionAliases = {}) {
  const commands = route.commands || route.directions || [];
  const startMatch = typeof route.from === 'string' ? route.from.match(/(\/d\/[a-z0-9_/\-]+)(\*)?/i) : null;
  const start = startMatch?.[1];
  const startPattern = start && startMatch?.[2] ? `${start}*` : start;
  let candidates = start
    ? [...(rooms?.keys() || [])].filter(roomId => startMatch?.[2] ? roomId.startsWith(start) : roomId === start)
    : [];
  let current = candidates.length ? startPattern : null;
  const sequence = [];
  for (const step of commands) {
    sequence.push(current);
    const command = String(typeof step === 'string' ? step : step?.cmd || '').trim().toLowerCase();
    if (!candidates.length) continue;
    const direction = directionAliases[command];
    if (!direction) continue;
    const nextRooms = new Set(candidates.map(roomId => rooms.get(roomId)?.exits?.[direction]).filter(roomId => roomId && rooms.has(roomId)));
    candidates = [...nextRooms];
    current = candidates.length === 1 ? candidates[0] : null;
  }
  sequence.push(current);
  return sequence;
}
