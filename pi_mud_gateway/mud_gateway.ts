/**
 * FluffOS MUD Gateway v2.5 (Pi Agent)
 *
 * 改进点（相比 v2）：
 * 1. 修复 model 错误（用 pi 默认 model）
 * 2. Session 周期性重建（compactMemory），彻底解决历史上下文无限增长问题
 * 3. compactMemory 用一次独立 LLM 调用生成摘要，新 session 只带摘要启动
 * 4. 保留全部 v2 特性：WorldSummary / AgentPhase / Checkpoint / 人类协作
 * 5. CompactMemory 本身的 token 消耗最小化（专用短 system prompt）
 * 6. 增加 fast_explore：LLM 暂停，每 150ms 按既定方向走一步，观察并累计停机原因，解决 LLM 决策间隔过长导致反复“决策-等待-决策”的浪费。
 * 7. 增加 execute_command_sequence：LLM 一次生成 2-5 条命令，Gateway TS 本地按 150ms 间隔执行。
 *
 * Token 模型：
 *   - 每 COMPACT_EVERY_TURNS 轮，session 被销毁重建
 *   - 新 session context = system_prompt + memory_summary + 当前 WorldSummary
 *   - 历史对话不携带，彻底打断累积链
 */

import { DIRECTION_ALIASES, KNOWN_ROUTES, normalizeDirection, isInfoCommand, summarizeEvents, routeStepCommand, routeStepNote, commandSequenceWaitMs, chooseProgressSkill, detectStopReason, shouldStopBeforeNextCommand, parseStatusLine, cleanMudText, splitCleanMudLines } from './lib/core.mjs';
import { routeDeviation, classifyRouteDeviation, routeRecoveryHint, shouldStopRouteForDeviation } from './lib/route_logic.mjs';
import { loadMap, findShortestPath } from './lib/pathfinder.mjs';
import { HighLevelDecisionController } from './lib/high_level_decider.mjs';
import { createLocalModelProvider } from './lib/local_model_provider.mjs';

import { sendMudCommand, collectMudEvents } from './lib/transport.mjs';
import net from 'node:net';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentPhase = 'BOOT' | 'WAIT' | 'OBSERVE' | 'PLAN' | 'ACT' | 'COMPACT' | 'RECOVER';

/** pi-coding-agent Tool 类型（库本身未导出时自行定义） */
type Tool = {
  name: string;
  label: string;
  description: string;
  parameters: any;
  execute: (
    toolCallId: string,
    params?: any
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: any }>;
};

type AgentTraceKind = 'series' | 'tool' | 'kb' | 'ontology' | 'skill' | 'route' | 'command_sequence' | 'command' | 'observation' | 'state_machine';
type AgentTracePhase = 'start' | 'progress' | 'end' | 'error';
type AgentTraceStatus = 'ok' | 'error' | 'stopped' | 'blocked';

type AgentTraceData = {
  id: string;
  turn: number;
  seriesId: number;
  ts: number;
  phase: AgentTracePhase;
  kind: AgentTraceKind;
  name?: string;
  toolCallId?: string;
  input?: any;
  outputSummary?: any;
  keywords?: string[];
  resources?: Array<{ type: 'kb' | 'ontology' | 'skill' | 'memory' | 'tool'; name: string; path?: string; query?: string }>;
  durationMs?: number;
  status?: AgentTraceStatus;
};

type WorldSummary = {
  meta: {
    server: 'fluffos';
    mudlib: string;
    tick: number;
    timestamp: number;
  };
  player: {
    id?: string;
    title?: string;
    hp?: number;        // 气 当前
    hp_max?: number;    // 气 有效上限
    hp_injury_pct?: number; // 气 有效上限/真上限 %，<100 表示内伤
    mp?: number;        // 精力 当前
    mp_max?: number;    // 精力 上限
    neili?: number;     // 内力 当前
    neili_max?: number; // 内力 上限
    jing?: number;      // 精 当前
    jing_max?: number;  // 精 有效上限
    jing_injury_pct?: number;
    food?: number;
    food_max?: number;
    water?: number;
    water_max?: number;
    potential?: number;
    potential_max?: number;
    combat_exp?: number;
    busy: boolean;
    combat: boolean;
  };
  location: {
    room_id?: string;
    name?: string;
    area?: string;
    exits: string[];
    indoors?: boolean;
  };
  entities: {
    npcs: Array<{
      id?: string;
      name: string;
      attitude?: 'friendly' | 'neutral' | 'hostile';
      combat?: boolean;
      important?: boolean;
    }>;
    players: Array<{ id?: string; name: string }>;
    items: Array<{ id?: string; name: string; takeable?: boolean }>;
  };
  inventory: {
    capacity?: number;
    items: Array<{ id?: string; name: string; type?: string; equipped?: boolean }>;
  };
  quests: {
    active: Array<{ id?: string; name: string; stage?: number; hint?: string }>;
    completed: Array<{ id?: string; name: string }>;
  };
  events: {
    recent: Array<{ type: string; text: string; timestamp: number }>;
  };
  capabilities: {
    available_actions: string[];
    cooldowns: Record<string, number>;
  };
};

type RuntimeCheckpoint = {
  agent_id: string;
  phase: AgentPhase;
  turn: number;
  world: {
    room_id?: string;
    hp?: number;
    combat: boolean;
  };
  scheduler: {
    pending_actions: string[];
    cooldown_until?: number;
  };
  memory_summary: string; // v2.5 新增：持久化最新摘要
  last_tick: number;
  updated_at: number;
};

type PersistentMemory = {
  version: 1;
  agent_id: string;
  updated_at: number;
  turn: number;
  summary: string;
  last_world: {
    player: Partial<WorldSummary['player']>;
    location: WorldSummary['location'];
  };
  visited_rooms: Record<string, {
    room_id?: string;
    name: string;
    area?: string;
    exits: string[];
    visits: number;
    last_seen_turn: number;
    last_seen_at: number;
  }>;
  known_npcs: Record<string, {
    id?: string;
    name: string;
    room?: string;
    attitude?: string;
    last_seen_turn: number;
    last_seen_at: number;
  }>;
  active_quests: WorldSummary['quests']['active'];
  progress_loop?: Partial<ProgressLoopState>;
  key_events: Array<{ turn: number; ts: number; text: string; type?: string }>;
  notes: string[];
};

type GatewayConfig = {
  mud: {
    host: string;
    port: number;
    encoding: BufferEncoding;
  };
  auth: {
    id: string;
    password: string;
    autoLogin: boolean;
    loginDelayMs: number;
  };
  agent: {
    turnIntervalMs: number;
    waitEventDefaultMs: number;
    checkpointEveryTurns: number;
    checkpointPath: string;
    maxRecentEvents: number;
    followPathStepWaitMs: number;
    fastExploreIntervalMs: number;
    compactEveryTurns: number; // 每多少 turn 重建一次 session
    compactKeepRecentEvents: number; // COMPACT 后保留的最近事件数
    memoryPath: string; // 跨重启常时记忆
  };
  runtime: {
    clearInitialNoiseMs: number;
    monitorPort: number;
    manualHoldMs: number;
    waterAbandonHoldMs: number;
  };
  decision: {
    enabled: boolean;
    provider: 'ollama' | 'gateway';
    endpoint: string;
    model: string;
    apiKeyEnv?: string;
    minimumConfidence: number;
    timeoutMs: number;
  };
};
type NativeToolTraceHandler = (event: any) => void;

type RouteStep = string | { cmd: string; waitMs?: number; note?: string };

type KnownRoute = {
  from: string;
  to: string;
  directions?: string[];
  commands?: RouteStep[];
  requirements?: string[];
  notes?: string;
};

type ProgressLoopMode = 'idle' | 'learn_then_water';

type ProgressLoopState = {
  active: boolean;
  mode: ProgressLoopMode;
  stage: string;
  targetMaster: string;
  targetSkill: string;
  skillPlan: string[];
  skillIndex: number;
  learnTimes: number;
  minPotential: number;
  lastAction: string;
  lastReason: string;
  lastResult: string;
  waterTaskState: string;
  waterTaskReason: string;
  waterTaskAction: string;
  blockedSkills: Record<string, string>;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.resolve(ROOT_DIR, 'gateway.config.json');
const SKILLS_DIR = path.resolve(ROOT_DIR, 'skills');
const MEMORY_AGENT_ID = 'pi-mud-agent-v2.5';

function createEmptyPersistentMemory(): PersistentMemory {
  return {
    version: 1,
    agent_id: MEMORY_AGENT_ID,
    updated_at: Date.now(),
    turn: 1,
    summary: '',
    last_world: {
      player: {},
      location: { exits: [] },
    },
    visited_rooms: {},
    known_npcs: {},
    active_quests: [],
    key_events: [],
    notes: [],
  };
}

const DEFAULT_CONFIG: GatewayConfig = {
  mud: { host: '127.0.0.1', port: 5555, encoding: 'utf-8' },
  auth: {
    id: 'roclive',
    password: 'test1234',
    autoLogin: true,
    loginDelayMs: 900,
  },
  agent: {
    turnIntervalMs: 150,
    waitEventDefaultMs: 150,
    checkpointEveryTurns: 1,
    checkpointPath: './checkpoint.json',
    maxRecentEvents: 60,
    followPathStepWaitMs: 150,
    fastExploreIntervalMs: 150,
    compactEveryTurns: 10,     // ← 核心：每 10 turn 重建 session
    compactKeepRecentEvents: 15,
    memoryPath: './memory.json',
  },
  runtime: {
    clearInitialNoiseMs: 1800,
    monitorPort: 8099,
    manualHoldMs: 1_500,
    waterAbandonHoldMs: 180_000,
  },
  decision: {
    enabled: false,
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    model: '',
    minimumConfidence: 0.7,
    timeoutMs: 15_000,
  },
};

// ---------------------------------------------------------------------------
// Runtime state（全局单例）
// ---------------------------------------------------------------------------

const state = {
  phase: 'BOOT' as AgentPhase,
  turn: 1,
  connected: false,
  eventQueue: [] as Array<{ type: string; content: string; timestamp: number }>,
  pendingActions: [] as string[],
  memorySummary: '', // 跨 session 持久化的记忆摘要
  agentSeriesId: 0,
  traceSeq: 0,
  recentTraces: [] as AgentTraceData[],
  persistentMemory: createEmptyPersistentMemory(),
  routeState: {
    active: false,
    routeName: '',
    from: '',
    to: '',
    step: 0,
    total: 0,
    currentCmd: '',
    expectedStage: '',
    expectedCommand: '',
    actualRoom: '',
    actualExits: [] as string[],
    deviation: '',
    deviationKind: '',
    recoveryHint: '',
    recentActualRooms: [] as string[],
    lastLine: '',
    plannedCommands: [] as string[],
    updatedAt: 0,
  },
  progressLoop: {
    active: false,
    mode: 'idle',
    stage: 'idle',
    targetMaster: 'qingshan',
    targetSkill: '',
    skillPlan: ['buddhism', 'literate', 'shaolin-shenfa', 'buddhism', 'parry', 'hunyuan-yiqi', 'hunyuan-yiqi', 'shaolin-shenfa'],
    skillIndex: 0,
    learnTimes: 5,
    minPotential: 8,
    lastAction: '',
    lastReason: '',
    lastResult: '',
    waterTaskState: 'idle',
    waterTaskReason: '',
    waterTaskAction: '',
    blockedSkills: {} as Record<string, string>,
    updatedAt: 0,
  } as ProgressLoopState,

  world: {
    meta: { server: 'fluffos', mudlib: 'xkx2001', tick: 0, timestamp: Date.now() },
    player: { busy: false, combat: false },
    location: { exits: [] },
    entities: { npcs: [], players: [], items: [] },
    inventory: { items: [] },
    quests: { active: [], completed: [] },
    events: { recent: [] },
    capabilities: {
      available_actions: [
        'look', 'score', 'inventory', 'help',
        'go <dir>', 'fight <npc>', 'talk <npc>', 'get <item>',
      ],
      cooldowns: {},
    },
  } as WorldSummary,
};

const collab = {
  manualUntil: 0,
  steeringPrompt: '',
  steeringUpdatedAt: 0,
  oneShotPrompt: '',
  oneShotPromptId: 0,
  oneShotUpdatedAt: 0,
  activeOneShotPromptId: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// KB (skills/xkx2001-knowledge/data/map.json) — used to:
//   1) validate parsed room shorts (rejects junk like "<!" from prompt/chat lines),
//   2) resolve location.room_id from (short, exits),
//   3) precompute each fixed-route's expected room_id sequence by BFS-walking the
//      route's command list through the live room graph — so route-deviation
//      checks become exact (room_id == expected) instead of fuzzy keyword match.
// Loaded sync once at startup; if file missing we degrade gracefully.
// ---------------------------------------------------------------------------

type KbRoom = { room_id: string; short?: string; area?: string; exits?: Record<string, string>; npcs?: string[] };
type KbIndex = {
  byId: Map<string, KbRoom>;
  byShort: Map<string, string[]>; // short -> room_ids[]
  knownShorts: Set<string>;
};

function loadKbIndex(): KbIndex | null {
  try {
    const p = path.resolve(SKILLS_DIR, 'xkx2001-knowledge', 'data', 'map.json');
    const raw = fsSync.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw) as { rooms?: KbRoom[] };
    const idx: KbIndex = { byId: new Map(), byShort: new Map(), knownShorts: new Set() };
    for (const r of data.rooms || []) {
      if (!r.room_id) continue;
      idx.byId.set(r.room_id, r);
      if (r.short) {
        idx.knownShorts.add(r.short);
        const arr = idx.byShort.get(r.short) || [];
        arr.push(r.room_id);
        idx.byShort.set(r.short, arr);
      }
    }
    console.log(`[KB] loaded map.json: ${idx.byId.size} rooms, ${idx.byShort.size} distinct shorts`);
    return idx;
  } catch (err) {
    console.warn(`[KB] map.json not loaded; room_id resolution disabled (${(err as Error)?.message})`);
    return null;
  }
}
const KB = loadKbIndex();

// Extract a /d/... room_id embedded in a label string (e.g. "汉水岸边 /d/shaolin/riverbank").
function extractRoomIdFromLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const m = label.match(/(\/d\/[a-z0-9_/\-]+)/i);
  return m ? m[1] : undefined;
}

function kbRoomShort(roomId: string | null | undefined): string {
  if (!roomId || !KB) return '';
  return KB.byId.get(roomId)?.short || '';
}

function describeRoomForDeviation(roomId: string | null | undefined, fallbackShort: string): string {
  if (!roomId) return fallbackShort || '未知房间';
  const short = kbRoomShort(roomId) || fallbackShort;
  return `${roomId}${short ? ' ' + short : ''}`;
}

// Resolve a room_id given a parsed short name and (optionally) parsed exits.
// Returns undefined if KB not loaded, short unknown, or ambiguous (>1 candidate).
function resolveRoomIdByShortExits(short: string | undefined, exits: string[] | undefined): string | undefined {
  if (!KB || !short) return undefined;
  const cands = KB.byShort.get(short);
  if (!cands || cands.length === 0) return undefined;
  if (cands.length === 1) return cands[0];
  // Multiple rooms share this short — disambiguate by exit set.
  if (!exits || exits.length === 0) return undefined;
  const exitSet = new Set(exits);
  const matches = cands.filter((rid) => {
    const r = KB.byId.get(rid);
    if (!r?.exits) return false;
    const kbDirs = Object.keys(r.exits);
    // require parsed exits be a subset of KB exits (parsed exits sometimes miss specials)
    return [...exitSet].every((d) => kbDirs.includes(d));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

// Walk a route's command list through KB.byId; returns the expected room_id at the
// START of each step (i.e. expected[i] is where the agent should be BEFORE issuing
// commands[i]). null entries = unknown (off-map / non-direction / random exit).
function precomputeRouteExpectedRoomIds(routeName: string, route: KnownRoute): (string | null)[] {
  const cmds: RouteStep[] = route.commands || (route.directions || []);
  if (!KB) return cmds.map(() => null);
  const startId = extractRoomIdFromLabel(route.from);
  const seq: (string | null)[] = [];
  let cur: string | null = startId && KB.byId.has(startId) ? startId : null;
  for (const step of cmds) {
    seq.push(cur);
    const cmd = routeStepCommand(step).trim().toLowerCase();
    if (!cur) continue;
    const dir = DIRECTION_ALIASES[cmd];
    if (!dir) continue; // non-direction (knock gate, give, look, etc.) — stay in same room
    const r = KB.byId.get(cur);
    const next = r?.exits?.[dir];
    cur = next && KB.byId.has(next) ? next : null;
  }
  return seq;
}

const ROUTE_EXPECTED_ROOM_IDS: Map<string, (string | null)[]> = (() => {
  const m = new Map<string, (string | null)[]>();
  for (const [name, route] of Object.entries(KNOWN_ROUTES)) {
    m.set(name, precomputeRouteExpectedRoomIds(name, route));
  }
  if (KB) {
    const resolved = [...m.values()].reduce((acc, arr) => acc + arr.filter((x) => x).length, 0);
    const total = [...m.values()].reduce((acc, arr) => acc + arr.length, 0);
    console.log(`[KB] precomputed expected room_ids for ${m.size} routes: ${resolved}/${total} steps resolved`);
  }
  return m;
})();

function expectedRoomIdAtStep(routeName: string, stepIndex: number): string | null {
  const seq = ROUTE_EXPECTED_ROOM_IDS.get(routeName);
  if (!seq) return null;
  return seq[stepIndex] ?? null;
}

function isShaolinWaterRoute(name: string) {
  return [
    'shaolin_fzlou_accept_water_job',
    'shaolin_fzlou_to_chufang',
    'shaolin_chufang_prepare_water_tools',
    'shaolin_fzlou_abandon_water_job',
    'shaolin_chufang_to_riverbank_for_water_job',
    'shaolin_chufang_to_south_gate_for_water_job',
    'shaolin_south_gate_to_riverbank_for_water_job',
    'shaolin_water_fill_bucket_at_riverbank',
    'shaolin_water_return_riverbank_to_shanlu_probe',
    'shaolin_water_shanlu_to_riverbank_for_refill',
    'shaolin_water_return_shanlu_to_chufang_via_up',
    'shaolin_water_return_shanlu_to_chufang_via_westup',
    'shaolin_water_return_shanlu_to_chufang_via_northwest',
    'shaolin_chufang_finish_water_job',
  ].includes(name);
}

function expectedWaterStage(routeName: string, stepNo: number, total: number, cmd: string) {
  const c = cmd.trim().toLowerCase();
  if (routeName === 'shaolin_chufang_to_south_gate_for_water_job') {
    if (c === 'open gate') return { label: '山门殿内开南门', keywords: ['山门殿'] };
    if (stepNo === 9 && c === 'south') return { label: '穿过南门到寺前广场', keywords: ['广场'] };
    if (stepNo <= 3) return { label: '厨房到斋厅段', keywords: ['厨房', '斋厅', '饭厅'] };
    return { label: '寺内到南门段', keywords: [] as string[] };
  }
  if (routeName === 'shaolin_chufang_to_riverbank_for_water_job') {
    if (c === 'open gate') return { label: '山门殿内开南门', keywords: ['山门殿'] };
    if (stepNo === 9 && c === 'south') return { label: '穿过南门到寺前广场', keywords: ['广场'] };
    if (stepNo <= 3) return { label: '厨房到斋厅段', keywords: ['厨房', '斋厅', '饭厅'] };
    if (stepNo >= total - 4) return { label: '汉水岸边方向', keywords: ['汉水', '河边', '少林寺'] };
    return { label: '出寺下山段', keywords: [] as string[] };
  }
  if (routeName === 'shaolin_south_gate_to_riverbank_for_water_job') {
    if (stepNo >= total - 4) return { label: '汉水岸边方向', keywords: ['汉水', '河边', '少林寺'] };
    return { label: '寺前广场下山到汉水段', keywords: [] as string[] };
  }
  if (routeName.startsWith('shaolin_water_return_shanlu_to_chufang')) {
    if (c === 'knock gate') return { label: '寺前广场敲北门', keywords: ['广场'] };
    if (c === 'north' && stepNo >= total - 8) return { label: '穿过北门入山门殿/寺内', keywords: ['山门殿', '台阶', '广场'] };
    if (stepNo <= 3) return { label: '挑水山路随机段', keywords: ['山路', '小径'] };
    if (stepNo >= total - 5) return { label: '寺内返回厨房段', keywords: ['厨房', '斋厅', '饭厅', '勤修场', '精进场'] };
    return { label: '回寺上山段', keywords: [] as string[] };
  }
  if (routeName === 'shaolin_water_return_riverbank_to_shanlu_probe') {
    return { label: '河边进入随机山路', keywords: ['山路'] };
  }
  if (routeName === 'shaolin_water_shanlu_to_riverbank_for_refill') {
    return { label: '山路返回汉水补水', keywords: ['汉水', '河边'] };
  }
  if (routeName === 'shaolin_water_fill_bucket_at_riverbank') {
    return { label: '汉水岸…36267 tokens truncated…now() })));
      const outcome = progressLearnOutcome(events);
      if (outcome === 'skill_blocked' || outcome === 'not_apprentice_or_wrong_master') {
        updateProgressLoop({
          blockedSkills: { ...state.progressLoop.blockedSkills, [skill]: `${master}:${outcome}` },
          lastResult: outcome,
        });
      } else if (outcome === 'potential_low') {
        updateProgressLoop({ stage: 'water_need_job', lastResult: outcome });
      } else if (outcome === 'needs_recovery') {
        updateProgressLoop({ stage: 'recovering', lastResult: outcome });
      } else {
        updateProgressLoop({ lastResult: outcome || 'learn_step_done' });
      }
      sendStateSnapshot();
      return { content: [{ type: 'text', text: JSON.stringify({ progressLoop: state.progressLoop, toolResult: result.details }) }], details: { progressLoop: state.progressLoop, toolResult: result.details } };
    },
  };

  const internalTraceTools = new Set([
    'send_command',
    'wait_event',
    'execute_command_sequence',
    'execute_route_skill',
    'follow_path',
    'execute_progress_loop_step',
  ]);

  const tracedToolKind = (toolName: string): AgentTraceKind => {
    if (toolName === 'get_known_routes') return 'kb';
    if (toolName === 'execute_route_skill' || toolName === 'execute_progress_loop_step') return 'skill';
    return 'tool';
  };

  const tracedToolResources = (toolName: string, params: any, result?: { details?: any }): AgentTraceData['resources'] => {
    if (toolName === 'get_known_routes') {
      const routeNames = Object.keys(result?.details || {});
      return [{ type: 'kb', name: 'known_routes', query: params?.name || routeNames.slice(0, 6).join(', ') }];
    }
    if (toolName === 'execute_route_skill') {
      const name = String(params?.name || result?.details?.route?.name || 'route_skill');
      return [{ type: 'skill', name, query: result?.details?.route ? `${result.details.route.from} -> ${result.details.route.to}` : undefined }];
    }
    if (toolName === 'execute_progress_loop_step') {
      return [{ type: 'skill', name: 'shaolin progress loop', query: params?.action || 'step' }];
    }
    return undefined;
  };

  const tracedToolKeywords = (toolName: string, params: any, result?: { details?: any }) => {
    const words = [toolName];
    if (toolName === 'get_known_routes') words.push('kb', ...(Object.keys(result?.details || {}).slice(0, 8)));
    if (toolName === 'execute_route_skill') words.push('skill', String(params?.name || result?.details?.route?.name || 'route'));
    if (toolName === 'execute_progress_loop_step') words.push('skill', 'progress_loop', String(params?.action || 'step'));
    return words.filter(Boolean);
  };

  const withToolTrace = (tool: Tool): Tool => ({
    ...tool,
    execute: async (toolCallId, params) => {
      const started = Date.now();
      const skipWrapperTrace = internalTraceTools.has(tool.name);
      const kind = tracedToolKind(tool.name);
      if (!skipWrapperTrace) {
        emitTrace({
          phase: 'start',
          kind,
          name: tool.name,
          toolCallId,
          input: params || {},
          keywords: tracedToolKeywords(tool.name, params),
          resources: tracedToolResources(tool.name, params),
        });
      }
      try {
        const result = await tool.execute(toolCallId, params);
        if (!skipWrapperTrace) {
          emitTrace({
            phase: 'end',
            kind,
            name: tool.name,
            toolCallId,
            durationMs: Date.now() - started,
            status: 'ok',
            outputSummary: summarizeToolResult(tool.name, result),
            keywords: tracedToolKeywords(tool.name, params, result),
            resources: tracedToolResources(tool.name, params, result),
          });
        }
        return result;
      } catch (e: any) {
        emitTrace({
          phase: 'error',
          kind,
          name: tool.name,
          toolCallId,
          durationMs: Date.now() - started,
          status: 'error',
          outputSummary: String(e?.message || e),
          keywords: tracedToolKeywords(tool.name, params),
          resources: tracedToolResources(tool.name, params),
        });
        throw e;
      }
    },
  });

  const rawTools: Tool[] = [
    sendCommandTool,
    waitEventTool,
    getWorldSummaryTool,
    getRuntimeStateTool,
    setWaterTaskStateTool,
    executeCommandSequenceTool,
    getKnownRoutesTool,
    executeRouteSkillTool,
    followPathTool,
    saveCheckpointTool,
    executeProgressLoopStepTool,
  ];
  const ALL_TOOLS: Tool[] = rawTools.map(withToolTrace);

  // ---- Wait for MUD connection --------------------------------------------

  await connectPromise;

  // ---- Recovery from checkpoint ------------------------------------------

  const old = await loadCheckpoint(config);
  if (old) {
    state.phase = 'RECOVER';
    state.turn = Math.max(1, old.turn);
    state.world.meta.tick = old.last_tick || 0;
    state.world.player.combat = Boolean(old.world.combat);
    state.world.player.hp = old.world.hp;
    state.world.location.room_id = old.world.room_id;
    state.pendingActions = old.scheduler.pending_actions || [];
    state.memorySummary = old.memory_summary || ''; // ← v2.5 恢复记忆摘要
    state.world.player.combat = false; // Always start from safe non-combat state
    console.log(`[Gateway] Checkpoint restored: phase=${old.phase} turn=${old.turn}`);
    if (state.memorySummary) {
      console.log(`[Gateway] Memory summary restored (${state.memorySummary.length} chars).`);
    }
  }

  // 清掉登录噪音
  console.log('[Gateway] Warming up...');
  await sleep(config.runtime.clearInitialNoiseMs);
  console.log(`[Gateway] Skipped ${state.eventQueue.length} initial events.`);
  state.eventQueue.length = 0;

  // ---- 创建初始 session ---------------------------------------------------

  if (!config.decision.enabled) {
    throw new Error('High-level decision model is disabled; configure an explicit local model before starting');
  }
  const decisionProvider = createLocalModelProvider(config.decision);
  const decisionCandidates = [
    ...Object.entries(KNOWN_ROUTES).map(([name, route]) => ({
      id: `route.${name}`,
      description: `${route.from} -> ${route.to}`,
      paramsSchema: { properties: {}, required: [] },
      execute: () => executeRouteSkillTool.execute(`decision-route-${state.turn}`, { name }),
    })),
    {
      id: 'skill.shaolin_progress',
      description: 'Advance the bounded Shaolin learning/water state machine by one skill boundary',
      paramsSchema: {
        properties: { action: { type: 'string', enum: ['start', 'step'] } },
        required: ['action'],
      },
      execute: (params: { action: string }) => executeProgressLoopStepTool.execute(`decision-skill-${state.turn}`, params),
    },
  ];
  const decisionController = new HighLevelDecisionController({
    provider: decisionProvider,
    candidates: decisionCandidates,
    minimumConfidence: config.decision.minimumConfidence,
  });
  let decisionTrigger: 'task_start' | 'skill_complete' | 'recovery_uncertain' = 'task_start';

  // Deliberately does not return to the legacy agent loop below. A route/skill
  // executes fully in deterministic code; the model is consulted only here at
  // task start, skill completion, or an explicitly uncertain recovery boundary.
  while (true) {
    const decisionState = {
      turn: state.turn,
      player: state.world.player,
      location: state.world.location,
      quests: state.world.quests.active,
      routeRecovery: state.routeState.deviation ? {
        kind: state.routeState.deviationKind,
        hint: state.routeState.recoveryHint,
      } : null,
      progress: state.progressLoop,
      recentEvents: state.world.events.recent.slice(-5).map((event) => ({
        type: event.type,
        text: event.text.slice(0, 500),
      })),
      operatorIntent: [collab.steeringPrompt, collab.oneShotPrompt].filter(Boolean).join('\n').slice(0, 1000),
    };
    try {
      state.phase = decisionTrigger === 'recovery_uncertain' ? 'RECOVER' : 'PLAN';
      const result = await decisionController.run(decisionTrigger, decisionState);
      if (result.status === 'WAIT') {
        state.phase = 'WAIT';
        broadcast({ type: 'log', data: `Decision paused: ${result.reason}` });
        while (!collab.oneShotPrompt && !collab.steeringPrompt) await sleep(1000);
        decisionTrigger = 'recovery_uncertain';
        continue;
      }
      decisionTrigger = 'skill_complete';
    } catch (err: any) {
      const message = String(err?.message || err);
      state.phase = 'WAIT';
      console.error('[Gateway] high-level decision rejected/stopped:', message);
      broadcast({ type: 'log', data: `Decision rejected/stopped: ${message}` });
      while (!collab.oneShotPrompt && !collab.steeringPrompt) await sleep(1000);
      decisionTrigger = 'recovery_uncertain';
    }
    await savePersistentMemory(config);
    if (state.turn % config.agent.checkpointEveryTurns === 0) await saveCheckpoint(config);
    state.turn += 1;
    await sleep(config.agent.turnIntervalMs);
  }

  // Kept temporarily as unreachable migration reference; the code path above
  // is the only production decision loop.
  let session = await createSession(config, ALL_TOOLS, emitNativeKnowledgeTrace);

  // ---------------------------------------------------------------------------
  // Agent 主循环
  //
  // Token 流向：
  //   每 turn → session.prompt() → 1~N 次 LLM 调用（视工具调用次数）
  //   每 compactEveryTurns → compactMemory() → 1次独立摘要调用 → 新 session
  //   新 session 首 prompt 携带：system + memorySummary + worldSummary
  // ---------------------------------------------------------------------------

  while (true) {
    // 等待 session 空闲（流式响应结束）
    while (session.isStreaming) {
      await sleep(100);
    }

    // ---- 阶段推进 ----
    if (state.phase === 'RECOVER') {
      state.phase = 'OBSERVE';
    } else if (state.phase !== 'COMPACT') {
      state.phase = 'PLAN';
    }

    console.log(`\n\n========== Turn ${state.turn} [${state.phase}] ==========`);
    broadcast({ type: 'log', data: `Turn ${state.turn} [${state.phase}] planning next action` });

    if (fastExplore.enabled) {
      broadcast({ type: 'log', data: `LLM loop paused; fast-explore is driving actions every ${config.agent.fastExploreIntervalMs}ms` });
      await sleep(config.agent.turnIntervalMs);
      continue;
    }

    // ---- v2.5 核心：COMPACT（session 重建） ----
    const shouldCompact =
      state.turn > 1 &&
      state.turn % config.agent.compactEveryTurns === 0;

    if (shouldCompact) {
      state.phase = 'COMPACT';
      broadcast({ type: 'log', data: `[COMPACT] turn ${state.turn}: rebuilding session...` });

      // 1. 生成记忆摘要
      state.memorySummary = await compactMemory(session, config);

      // 2. 压缩 world.events.recent
      if (state.world.events.recent.length > config.agent.compactKeepRecentEvents) {
        state.world.events.recent = state.world.events.recent.slice(-config.agent.compactKeepRecentEvents);
      }

      // 3. 保存 checkpoint（带新摘要）
      await saveCheckpoint(config);

      // 4. 销毁旧 session，创建全新 session
      //    旧 session 的所有对话历史在此被完全丢弃
      session = await createSession(config, ALL_TOOLS, emitNativeKnowledgeTrace);

      // 5. 新 session 首 prompt：注入摘要 + 当前 WorldSummary
      //    这是新 session 唯一的"记忆来源"
      const worldNow = JSON.stringify({
        player: state.world.player,
        location: state.world.location,
        quests: state.world.quests,
      });

      const resumePrompt = [
        `【记忆摘要（前 ${state.turn - 1} 回合）】`,
        state.memorySummary,
        '',
        formatPersistentMemoryForPrompt(),
        '',
        `【当前世界状态（Turn ${state.turn}）】`,
        worldNow,
        '',
        '请根据以上信息继续游戏，先调用 wait_event() 确认当前环境。',
      ].join('\n');

      broadcast({ type: 'log', data: '[COMPACT] session rebuilt, resuming...' });
      console.log('[COMPACT] New session started with memory summary.');

      try {
        await session.prompt(resumePrompt);
      } catch (e: any) {
        console.error('[COMPACT] resume prompt error:', e?.message || e);
      }

      state.turn += 1;
      await sleep(config.agent.turnIntervalMs);
      continue; // 跳过本轮的普通 prompt
    }

    // ---- 普通回合 prompt ----
    const isFirst = state.turn === 1;
    let prompt: string;
    state.agentSeriesId += 1;
    const seriesId = state.agentSeriesId;
    const oneShotPrompt = collab.oneShotPrompt;
    const oneShotPromptId = collab.oneShotPromptId;

    if (isFirst) {
      // 第一回合：如果有 memorySummary（来自 checkpoint），注入它
      if (state.memorySummary) {
        prompt = [
          `【恢复运行 - 记忆摘要】`,
          state.memorySummary,
          '',
          formatPersistentMemoryForPrompt(),
          '',
          '连接已就绪。先调用 wait_event() 确认当前环境，再继续任务。',
        ].join('\n');
      } else {
        prompt = [
          formatPersistentMemoryForPrompt(),
          '',
          '连接已建立。先调用 wait_event() 观察初始环境；若要去少林/扬州等已知地点，调用 get_known_routes() 后用 execute_route_skill()。局部行动/探索才调用一次 execute_command_sequence()，只提交2到5条命令。',
        ].join('\n');
      }
    } else {
      prompt = [
        formatPersistentMemoryForPrompt(),
        '',
        `第 ${state.turn} 回合：先观察（wait_event/get_world_summary）。`,
        '若目标是少林/扬州往返或其它已知路线，调用 get_known_routes() 后只调用一次 execute_route_skill()。',
        '若上一轮 route 返回 deviationKind/recoveryHint，按 recoveryHint 用 execute_command_sequence 发送2-3条纠错命令，不要继续硬跑长 route。',
        '若目标是少林新手成长循环：吃喝恢复、只找清善 qingshan 学习、潜能不足挑水、工具/交付异常找知客僧放弃、回来继续学，优先调用 execute_progress_loop_step(action=start/step)。',
        '若只是局部探索，再只调用一次 execute_command_sequence()，一次性提交2到5条命令。',
        '命令序列不要反复 look；只有位置/出口未知或路线结束校验时才 look。不要逐条调用 send_command。',
      ].join('\n');
    }

    // 注入人类 steering prompt
    if (collab.steeringPrompt) {
      prompt += `\n\n【人类临时策略】${collab.steeringPrompt}\n请优先执行，但仍需保证生存安全。`;
    }

    if (oneShotPrompt) {
      collab.activeOneShotPromptId = oneShotPromptId;
      prompt += `\n\n【人类一次性策略，仅本轮 action series 有效】${oneShotPrompt}\n这条指令只影响本次工具调用链；本轮结束后自动忽略。`;
      sendStateSnapshot();
    }

    emitTrace({
      phase: 'start',
      kind: 'series',
      name: 'agent_action_series',
      input: { oneShotPromptId: oneShotPrompt ? oneShotPromptId : null },
    });

    try {
      await session.prompt(prompt);
      emitTrace({
        phase: 'end',
        kind: 'series',
        name: 'agent_action_series',
        outputSummary: { seriesId },
        status: 'ok',
      });
    } catch (err: any) {
      const msg = String(err?.message || err);
      console.error('[Gateway] agent error:', msg);
      emitTrace({
        phase: 'error',
        kind: 'series',
        name: 'agent_action_series',
        outputSummary: msg,
        status: 'error',
      });
      state.phase = 'RECOVER';
      // 如果是认证问题，等待后重试
      if (msg.includes('Authentication') || msg.includes('API key')) {
        console.log('[Gateway] Auth error, waiting 20s...');
        await sleep(20_000);
      }
    } finally {
      if (oneShotPrompt && collab.activeOneShotPromptId === oneShotPromptId) {
        collab.activeOneShotPromptId = 0;
      }
      if (oneShotPrompt && collab.oneShotPromptId === oneShotPromptId) {
        collab.oneShotPrompt = '';
        broadcast({ type: 'prompt_cleared', data: { oneShot: true, id: oneShotPromptId } });
        emitTrace({
          phase: 'end',
          kind: 'series',
          name: 'one_shot_prompt',
          outputSummary: { clearedId: oneShotPromptId },
          status: 'ok',
        });
        sendStateSnapshot();
      }
    }

    try {
      await savePersistentMemory(config);
    } catch (e: any) {
      console.error('[Gateway] persistent memory save error:', e?.message || e);
    }

    // 自动存档
    if (state.turn % config.agent.checkpointEveryTurns === 0) {
      await saveCheckpoint(config);
    }

    state.turn += 1;
    await sleep(config.agent.turnIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('[Gateway] Fatal error:', err);
  process.exit(1);
});
