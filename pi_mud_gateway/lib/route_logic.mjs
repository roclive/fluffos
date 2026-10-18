import { DIRECTION_ALIASES } from './core.mjs';

/**
 * routeDeviation: Checks if current room matches expected room for a given route step.
 * Uses room_id for exact matching to handle same-name rooms.
 */
export function routeDeviation(
  expected: { label: string; keywords: string[] },
  actualRoom: string,
  expectedRoomId?: string | null,
  actualRoomId?: string | null,
  kbRoomShort?: (rid: string | null | undefined) => string,
  describeRoom?: (rid: string | null | undefined, fallback: string) => string,
) {
  if (expectedRoomId && actualRoomId) {
    if (expectedRoomId === actualRoomId) return '';
    const expectedRoom = describeRoom ? describeRoom(expectedRoomId, expected.label) : \`Expected \${expectedRoomId}\`;
    const actual = describeRoom ? describeRoom(actualRoomId, actualRoom) : \`Actual \${actualRoomId}\`;
    return \`route偏离: 期望房间 \${expectedRoom}，实际 \${actual}\`;
  }

  if (expectedRoomId && !actualRoomId && actualRoom) {
    const expectedShort = kbRoomShort ? kbRoomShort(expectedRoomId) : '';
    if (expectedShort && expectedShort === actualRoom) return '';
    if (expectedShort) {
      const expectedRoom = describeRoom ? describeRoom(expectedRoomId, expected.label) : \`Expected \${expectedRoomId}\`;
      return \`route偏离: 期望房间 \${expectedRoom}，实际 \${actualRoom}\`;
    }
  }

  if (!expected.keywords.length || !actualRoom) return '';
  return expected.keywords.some((k) => actualRoom.includes(k))
    ? ''
    : \`route偏离: 期望 \${expected.label} (\${expected.keywords.join('/')})，实际 \${actualRoom}\`;
}

/**
 * classifyRouteDeviation: Categorizes the type of deviation to determine recovery strategy.
 */
export function classifyRouteDeviation(
  routeName: string,
  cmd: string,
  expected: { label: string; keywords: string[] },
  actualRoom: string,
  eventsText: string,
  stopReason?: string | null,
  expectedRoomId?: string | null,
  actualRoomId?: string | null,
  deviationFn: typeof routeDeviation = routeDeviation,
  kbRoomShort?: (rid: string | null | undefined) => string,
  describeRoom?: (rid: string | null | undefined, fallback: string) => string,
) {
  const c = cmd.trim().toLowerCase();
  if (stopReason === 'manual_control_active') return 'manual_control_active';
  if (stopReason === 'low_qi') return stopReason;
  if (/门|gate/.test(eventsText) && /关|必须先|打不开|不能|没有门|阻|拦|挡/.test(eventsText)) return 'gate_blocked';
  if ((c === 'south' || c === 'north') && stopReason === 'blocked_exit') return 'gate_blocked';
  if (/正忙|busy|现在不能/.test(eventsText) || stopReason === 'blocked_or_busy') return 'busy_or_blocked';
  if (stopReason === 'blocked_exit') return 'blocked_exit';
  
  const deviation = deviationFn(expected, actualRoom, expectedRoomId, actualRoomId, kbRoomShort, describeRoom);
  if (deviation) return 'room_mismatch';
  
  return '';
}

/**
 * routeRecoveryHint: Provides specific command sequences to fix common deviations.
 */
export function routeRecoveryHint(
  routeName: string,
  cmd: string,
  deviationKind: string,
  actualRoom: string,
  actualExits: string[],
) {
  const exits = actualExits.join('/');
  const place = actualRoom || '当前位置未知';
  if (!deviationKind) return '';
  if (deviationKind === 'manual_control_active') return '人类刚输入了命令；等待约1.5秒后先 look/hp 重新定位，再继续最近的 route skill。';
  if (deviationKind === 'low_qi') return '气太低；先 yun recover 或撤到安全地点，恢复后再继续任务。';
  if (deviationKind === 'busy_or_blocked') return '角色 busy 或被阻挡；下一轮先 wait_event/get_world_summary，必要时只用2-3条 execute_command_sequence 纠错。';
  if (deviationKind === 'gate_blocked') {
    if (place.includes('山门殿') || cmd.trim().toLowerCase() === 'south') {
      return \`当前在\${place}，出寺应短序列执行 ["open gate", "south", "look"]。\`;
    }
    if (place.includes('广场') || cmd.trim().toLowerCase() === 'north') {
      return \`当前在\${place}，回寺应短序列执行 ["knock gate", "north", "look"]。\`;
    }
    return \`疑似山门 gate 阻塞，当前房间=\${place} exits=\${exits || '--'}；先 look，再按内侧 open gate/south 或外侧 knock gate/north 恢复。\`;
  }
  if (deviationKind === 'room_mismatch') {
    return \`房间不匹配；请确认当前在 \${place} 是否正确，可用 look 查看详情。若确实偏航，请尝试用 execute_command_sequence 回到预期房间或重新开始 route。\`;
  }
  return \`检测到偏航 (\${deviationKind})；请观察环境并手动纠正。\`;
}

export function shouldStopRouteForDeviation(deviationKind: string) {
  return Boolean(deviationKind);
}
