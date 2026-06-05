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
 * 7. 增加 execute_command_sequence：LLM 一次生成 2-3 条命令，Gateway TS 本地按 150ms 间隔执行。
 *
 * Token 模型：
 *   - 每 COMPACT_EVERY_TURNS 轮，session 被销毁重建
 *   - 新 session context = system_prompt + memory_summary + 当前 WorldSummary
 *   - 历史对话不携带，彻底打断累积链
 */

import net from 'node:net';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
} from '@mariozechner/pi-coding-agent';
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
  };
};

/** pi-coding-agent session 对象（库未导出 type 时用 any） */
type AgentSession = any;
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
  waterRoute: {
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
    skillPlan: ['buddhism', 'literate', 'shaolinshenfa', 'buddhism', 'parry', 'hunyuan-yiqi', 'hunyuan-yiqi', 'shaolin-shenfa'],
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

function isInfoCommand(cmd: string) {
  const c = cmd.trim().toLowerCase();
  return ['look', 'l', 'score', 'sc', 'inventory', 'i', 'hp', 'help', 'skills', 'who', 'chat'].includes(c);
}

const KNOWN_ROUTES: Record<string, KnownRoute> = {
  wizard_guest_room_to_wumiao: {
    from: '巫师会客室',
    to: '武庙',
    directions: ['southeast'],
    notes: '竹门已在 mudlib 中去掉，southeast 应直接到武庙。',
  },
  wumiao_to_wizard_guest_room: {
    from: '武庙',
    to: '巫师会客室',
    directions: ['northwest'],
  },
  probe_from_current_room: {
    from: '当前房间',
    to: '未知区域试探',
    directions: ['north', 'east', 'south', 'west'],
    notes: '只选择一个方向分支试探；失败后停止观察，不要硬闯。',
  },
  yangzhou_guangchang_to_shaolin_shanmen_overland: {
    from: '扬州中央广场 /d/city/guangchang',
    to: '少林山门 /d/shaolin/shanmen',
    commands: [
      'north', 'north', 'north', 'north', 'northwest',
      'north', 'north', 'north',
      'yell boat',
      { cmd: 'enter', waitMs: 36_000 },
      'out',
      'north', 'north', 'north', 'west',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east',
    ],
    notes: '公开地面路线。汉水南岸需 yell boat 叫船，enter 上船后约35秒到北岸，再 out 下船。',
  },
  shaolin_shanmen_to_yangzhou_guangchang_overland: {
    from: '少林山门 /d/shaolin/shanmen',
    to: '扬州中央广场 /d/city/guangchang',
    commands: [
      'west',
      'southdown', 'southdown', 'southdown', 'eastdown', 'southdown', 'southdown',
      'east', 'south', 'south', 'south',
      'yell boat',
      { cmd: 'enter', waitMs: 36_000 },
      'out',
      'south', 'south', 'south', 'southeast',
      'south', 'south', 'south', 'south',
    ],
    notes: '公开地面返回路线。汉水北岸同样需 yell boat，上船等待到南岸后 out。',
  },
  yangzhou_guangchang_to_shaolin_chufang2_gaibang_shortcut: {
    from: '扬州中央广场 /d/city/guangchang',
    to: '少林厨房 /d/shaolin/chufang2',
    commands: [
      'enter dong',
      'say 天堂有路你不走呀',
      'down',
      '3',
      'northeast',
      'northeast',
      'up',
    ],
    requirements: ['丐帮身份', '可在树洞内用口令打开 down；非丐帮会被梁长老挡住。'],
    notes: '丐帮暗道捷径，不适合普通账号。出口三通往少林，终点是少林厨房而非山门。',
  },
  shaolin_chufang2_to_yangzhou_guangchang_gaibang_shortcut: {
    from: '少林厨房 /d/shaolin/chufang2',
    to: '扬州中央广场 /d/city/guangchang',
    commands: [
      'enter dong',
      'southwest',
      'southwest',
      'southwest',
      'up',
      'out',
    ],
    requirements: ['丐帮身份', '少林厨房 enter dong 需要丐帮缩骨功/身份。'],
    notes: '丐帮暗道返回路线。',
  },
  shaolin_fzlou_accept_water_job: {
    from: '少林方丈楼 /d/shaolin/fzlou',
    to: '已领取少林挑水任务',
    commands: [
      'ask zhike seng about 工作',
    ],
    requirements: ['少林派', 'combat_exp <= 500000', '无 ts_pending 冷却', '未领取其它挑水任务。'],
    notes: '方丈楼有知客僧。也可向玄慈问“挑水/job”，但此路线默认使用知客僧。',
  },
  shaolin_fzlou_to_chufang: {
    from: '少林方丈楼 /d/shaolin/fzlou',
    to: '少林厨房 /d/shaolin/chufang',
    commands: ['south', 'south', 'southdown', 'south', 'west', 'north', 'north'],
    notes: '方丈楼 -> 练武场 -> 后殿 -> 精进场 -> 勤修场 -> 斋厅 -> 厨房。',
  },
  shaolin_chufang_to_fzlou: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '少林方丈楼 /d/shaolin/fzlou',
    commands: ['south', 'south', 'east', 'north', 'northup', 'north', 'north'],
    notes: '厨房 -> 斋厅 -> 勤修场 -> 精进场 -> 后殿 -> 练武场 -> 方丈楼，用于潜能不足时重新接挑水任务。',
  },
  shaolin_chufang_to_qingshan_biqiu: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '清善比丘处 /d/shaolin/guangchang2',
    commands: ['south', 'south', 'east', 'south'],
    notes: '厨房到寺内广场，清善比丘在此。当前角色可用 alias qingshan 向他学习基础技能。',
  },
  shaolin_qingshan_biqiu_to_chufang: {
    from: '清善比丘处 /d/shaolin/guangchang2',
    to: '少林厨房 /d/shaolin/chufang',
    commands: ['north', 'west', 'north', 'north'],
    notes: '清善比丘处返回厨房，用于学完/潜能不足后转挑水。',
  },
  shaolin_fzlou_to_qingshan_biqiu: {
    from: '少林方丈楼 /d/shaolin/fzlou',
    to: '清善比丘处 /d/shaolin/guangchang2',
    commands: ['south', 'south', 'southdown', 'south', 'south'],
    notes: '方丈楼到清善比丘所在广场。',
  },
  shaolin_qingshan_biqiu_to_fzlou: {
    from: '清善比丘处 /d/shaolin/guangchang2',
    to: '少林方丈楼 /d/shaolin/fzlou',
    commands: ['north', 'north', 'northup', 'north', 'north'],
    notes: '清善比丘所在广场到方丈楼。',
  },
  shaolin_chufang_to_qingwu_biqiu: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '清无比丘处 /d/shaolin/guangchang1e',
    commands: [
      'south', 'south', 'east', 'south',
      'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 300, note: 'gate_special: 山门殿内开南门；下一步必须立刻 south。' },
      'south', 'east',
    ],
    notes: '清无比丘在寺前广场东侧，可教 blade/force/dodge/parry/cuff/literate/buddhism 等低阶技能。',
  },
  shaolin_qingwu_biqiu_to_chufang: {
    from: '清无比丘处 /d/shaolin/guangchang1e',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'west',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；下一步必须立刻 north。' },
      'north', 'north', 'northup', 'north',
      'north', 'west', 'north', 'north',
    ],
    notes: '清无比丘处回厨房。',
  },
  shaolin_qingshan_biqiu_to_qingwu_biqiu: {
    from: '清善比丘处 /d/shaolin/guangchang2',
    to: '清无比丘处 /d/shaolin/guangchang1e',
    commands: [
      'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 300, note: 'gate_special: 山门殿内开南门；下一步必须立刻 south。' },
      'south', 'east',
    ],
    notes: '从寺内清善处出山门到清无处，常用于 blade 学习。',
  },
  shaolin_qingwu_biqiu_to_qingshan_biqiu: {
    from: '清无比丘处 /d/shaolin/guangchang1e',
    to: '清善比丘处 /d/shaolin/guangchang2',
    commands: [
      'west',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；下一步必须立刻 north。' },
      'north', 'north', 'northup', 'north',
    ],
    notes: '清无处回寺内清善处。',
  },
  shaolin_chufang_to_qingfa_biqiu: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '清法比丘处 /d/shaolin/guangchang1',
    commands: [
      'south', 'south', 'east', 'south',
      'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 300, note: 'gate_special: 山门殿内开南门；下一步必须立刻 south。' },
      'south',
    ],
    notes: '清法比丘在寺前广场，可作为清善不能教时的低阶学习 fallback。',
  },
  shaolin_qingfa_biqiu_to_chufang: {
    from: '清法比丘处 /d/shaolin/guangchang1',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；下一步必须立刻 north。' },
      'north', 'north', 'northup', 'north',
      'north', 'west', 'north', 'north',
    ],
    notes: '清法比丘处回厨房。',
  },
  shaolin_chufang_prepare_water_tools: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '已领取水桶和水瓢',
    commands: [
      'ask shaofan seng about 水桶',
      'ask shaofan seng about 水瓢',
    ],
    requirements: ['必须先领取挑水任务。'],
    notes: '烧饭僧在厨房。水桶只能领一次；水瓢丢失后可再次问水瓢。',
  },
  shaolin_fzlou_abandon_water_job: {
    from: '少林方丈楼 /d/shaolin/fzlou',
    to: '已放弃少林挑水任务',
    commands: [
      'ask zhike seng about abandon',
    ],
    requirements: ['当前在方丈楼；挑水工具或任务状态不可恢复时使用。'],
    notes: '知客僧会清除 job_asked/tool_assigned/tiaoshui，并进入短暂 pending；之后成长循环重新判断。',
  },
  shaolin_chufang_to_riverbank_for_water_job: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '汉水岸边 /d/shaolin/riverbank',
    commands: [
      'south', 'south', 'east',
      'south', 'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 300, note: 'gate_special: 山门殿内开南门；门10秒后会关，下一步必须立刻 south。' },
      'south',
      'south', 'southdown', 'southdown', 'southdown', 'westdown',
      'west', 'southdown', 'southdown', 'southdown', 'eastdown', 'southdown', 'southdown',
      'east', 'south', 'south', 'south',
      'west',
    ],
    requirements: ['少林僧人可从正门出寺；在山门殿必须 open gate 后迅速 south。'],
    notes: '去河边不要走挑水山路；从正门下山到汉水北岸，再 west 到汉水岸边。gate special: 山门殿 open gate -> south。',
  },
  shaolin_water_fill_bucket_at_riverbank: {
    from: '汉水岸边 /d/shaolin/riverbank',
    to: '水桶已装满并重新挑起',
    commands: [
      { cmd: 'putdown shui tong', waitMs: 1_000 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'carry shui tong', waitMs: 1_000 },
    ],
    requirements: ['身上有水瓢', '水桶属于自己', '已领取挑水任务。'],
    notes: '舀水/倒水会 busy，不能用 150ms 短间隔；此 skill 使用每步 waitMs 覆盖。',
  },
  shaolin_water_return_riverbank_to_shanlu_probe: {
    from: '汉水岸边 /d/shaolin/riverbank',
    to: '挑水山路第一段 /d/shaolin/shanlu',
    commands: ['northup'],
    requirements: ['水桶已满并 carry 在身上。'],
    notes: '进入山路后出口随机为 up / westup / northwest 之一；执行后先观察出口，再选择对应后续 return variant。',
  },
  shaolin_water_shanlu_to_riverbank_for_refill: {
    from: '挑水山路 /d/shaolin/shanlu*',
    to: '汉水岸边 /d/shaolin/riverbank',
    commands: ['southdown'],
    requirements: ['水桶仍在，但水不满；回汉水重新舀水加满。'],
    notes: '桶没碎只是水洒了时，不放弃任务，先回河边 refill。',
  },
  shaolin_water_return_shanlu_to_chufang_via_up: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'up',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；门10秒后会关，下一步必须立刻 north。' }, 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 up', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。gate special: 寺前广场 knock gate -> north。',
  },
  shaolin_water_return_shanlu_to_chufang_via_westup: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'westup',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；门10秒后会关，下一步必须立刻 north。' }, 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 westup', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。gate special: 寺前广场 knock gate -> north。',
  },
  shaolin_water_return_shanlu_to_chufang_via_northwest: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'northwest',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；门10秒后会关，下一步必须立刻 north。' }, 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 northwest', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。gate special: 寺前广场 knock gate -> north。',
  },
  shaolin_chufang_finish_water_job: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '少林挑水任务完成',
    commands: [
      'give shui tong to shaofan seng',
      'give shui piao to shaofan seng',
    ],
    requirements: ['水桶已满', '仍在 tiaoshui 条件时间内。'],
    notes: '烧饭僧只奖励满水桶；水瓢可以顺手归还。',
  },
};

const DIRECTION_ALIASES: Record<string, string> = {
  n: 'north',
  north: 'north',
  s: 'south',
  south: 'south',
  e: 'east',
  east: 'east',
  w: 'west',
  west: 'west',
  ne: 'northeast',
  northeast: 'northeast',
  nw: 'northwest',
  northwest: 'northwest',
  se: 'southeast',
  southeast: 'southeast',
  sw: 'southwest',
  southwest: 'southwest',
  u: 'up',
  up: 'up',
  d: 'down',
  down: 'down',
  enter: 'enter',
  out: 'out',
};

function normalizeDirection(raw: unknown): string {
  const dir = String(raw || '').trim().toLowerCase();
  return DIRECTION_ALIASES[dir] || dir;
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

function summarizeEvents(events: Array<{ type: string; content: string; timestamp: number }>, limit = 8) {
  return events.slice(-limit).map((e) => e.content).join('\n');
}

function routeStepCommand(step: RouteStep) {
  return typeof step === 'string' ? step : step.cmd;
}

function routeStepNote(step: RouteStep) {
  return typeof step === 'string' ? '' : (step.note || '');
}

function commandSequenceWaitMs(cmd: string, defaultWaitMs: number) {
  const c = cmd.trim().toLowerCase();
  if (/^(yao|舀)\s+(shui|water|水)$/.test(c)) return Math.max(defaultWaitMs, 4_000);
  if (/^(dao|倒)\s+(shui|water|水)\s+to\s+/.test(c)) return Math.max(defaultWaitMs, 3_500);
  if (/^(putdown|fang|放)\s+/.test(c)) return Math.max(defaultWaitMs, 1_000);
  if (/^(carry|tiao|挑)\s+/.test(c)) return Math.max(defaultWaitMs, 1_000);
  return defaultWaitMs;
}

function isShaolinWaterRoute(name: string) {
  return [
    'shaolin_fzlou_accept_water_job',
    'shaolin_fzlou_to_chufang',
    'shaolin_chufang_prepare_water_tools',
    'shaolin_fzlou_abandon_water_job',
    'shaolin_chufang_to_riverbank_for_water_job',
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
  if (routeName === 'shaolin_chufang_to_riverbank_for_water_job') {
    if (c === 'open gate') return { label: '山门殿内开南门', keywords: ['山门殿'] };
    if (stepNo === 9 && c === 'south') return { label: '穿过南门到寺前广场', keywords: ['广场'] };
    if (stepNo <= 3) return { label: '厨房到斋厅段', keywords: ['厨房', '斋厅', '饭厅'] };
    if (stepNo >= total - 4) return { label: '汉水岸边方向', keywords: ['汉水', '河边', '少林寺'] };
    return { label: '出寺下山段', keywords: [] as string[] };
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
    return { label: '汉水岸边打水', keywords: ['汉水', '河边'] };
  }
  if (routeName === 'shaolin_chufang_prepare_water_tools' || routeName === 'shaolin_chufang_finish_water_job') {
    return { label: '少林厨房', keywords: ['厨房'] };
  }
  if (routeName === 'shaolin_fzlou_accept_water_job') {
    return { label: '方丈楼接任务', keywords: ['方丈楼'] };
  }
  if (routeName === 'shaolin_fzlou_abandon_water_job') {
    return { label: '方丈楼放弃挑水任务', keywords: ['方丈楼'] };
  }
  if (routeName === 'shaolin_fzlou_to_chufang') {
    return { label: '寺内方丈楼到厨房', keywords: [] as string[] };
  }
  return { label: '', keywords: [] as string[] };
}

// 路线偏离判定（优先 room_id 精确比对，回退到关键字模糊匹配）
// 调用方传入 expectedRoomId（来自 ROUTE_EXPECTED_ROOM_IDS 预计算）和当前 location.room_id。
// 若两个都有：直接比 room_id（最权威）。任一缺失：回退到旧的 keyword∈actualRoom 检查。
function waterRouteDeviation(
  expected: { label: string; keywords: string[] },
  actualRoom: string,
  expectedRoomId?: string | null,
  actualRoomId?: string | null,
) {
  // 优先 room_id 精确比对（KB 已加载且本步有预期 + 当前已解析）
  if (expectedRoomId && actualRoomId) {
    if (expectedRoomId === actualRoomId) return '';
    return `route偏离: 期望房间 ${expectedRoomId} (${expected.label})，实际 ${actualRoomId}${actualRoom ? ' ' + actualRoom : ''}`;
  }
  // 回退：关键字模糊匹配
  if (!expected.keywords.length || !actualRoom) return '';
  return expected.keywords.some((k) => actualRoom.includes(k))
    ? ''
    : `route偏离: 期望 ${expected.label} (${expected.keywords.join('/')})，实际 ${actualRoom}`;
}

function classifyRouteDeviation(
  routeName: string,
  cmd: string,
  expected: { label: string; keywords: string[] },
  actualRoom: string,
  events: Array<{ type: string; content: string; timestamp: number }>,
  stopReason?: string | null,
  expectedRoomId?: string | null,
  actualRoomId?: string | null,
) {
  const c = cmd.trim().toLowerCase();
  const text = summarizeEvents(events, 20);
  if (stopReason === 'manual_control_active') return 'manual_control_active';
  if (stopReason === 'low_qi' || stopReason === 'low_jing') return stopReason;
  if (/门|gate/.test(text) && /关|必须先|打不开|不能|没有门|阻|拦|挡/.test(text)) return 'gate_blocked';
  if ((c === 'south' || c === 'north') && routeName.includes('shaolin') && stopReason === 'blocked_exit') return 'gate_blocked';
  if (/正忙|busy|现在不能/.test(text) || stopReason === 'blocked_or_busy') return 'busy_or_blocked';
  if (stopReason === 'blocked_exit') return 'blocked_exit';
  if (waterRouteDeviation(expected, actualRoom, expectedRoomId, actualRoomId)) return 'room_mismatch';
  return '';
}

function routeRecoveryHint(
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
  if (deviationKind === 'low_qi') return '气太低；先 yun recover 或撤到安全地点，恢复后再继续挑水 route。';
  if (deviationKind === 'low_jing') return '精太低；先 yun regenerate 或等待恢复，恢复后再继续挑水 route。';
  if (deviationKind === 'busy_or_blocked') return '角色 busy 或被阻挡；下一轮先 wait_event/get_world_summary，必要时只用2-3条 execute_command_sequence 纠错。';
  if (deviationKind === 'gate_blocked') {
    if (place.includes('山门殿') || cmd.trim().toLowerCase() === 'south') {
      return `当前在${place}，出寺应短序列执行 ["open gate", "south", "look"]。`;
    }
    if (place.includes('广场') || cmd.trim().toLowerCase() === 'north') {
      return `当前在${place}，回寺应短序列执行 ["knock gate", "north", "look"]。`;
    }
    return `疑似山门 gate 阻塞，当前房间=${place} exits=${exits || '--'}；先 look，再按内侧 open gate/south 或外侧 knock gate/north 恢复。`;
  }
  if (deviationKind === 'room_mismatch') {
    if (routeName === 'shaolin_water_fill_bucket_at_riverbank') {
      return `打水 route 要在汉水岸边执行；当前=${place}，先重新导航到汉水岸边再 fill。`;
    }
    return `当前=${place} exits=${exits || '--'}；停止硬走，先 look 重新定位，再从最近稳定的少林挑水 route skill 接入。`;
  }
  if (deviationKind === 'blocked_exit') return `出口被阻塞，当前=${place} exits=${exits || '--'}；先 look 确认出口，再用短序列纠错。`;
  return `route stopped=${deviationKind}；先 wait_event/get_world_summary 重新定位，再用短序列或最近 route skill 恢复。`;
}

function appendRecentWaterRoom(actualRoom: string) {
  const rooms = state.waterRoute.recentActualRooms || [];
  if (actualRoom && rooms[rooms.length - 1] !== actualRoom) {
    rooms.push(actualRoom);
  }
  return rooms.slice(-8);
}

const PROGRESS_MASTER_BY_SKILL: Record<string, string> = {
  buddhism: 'qingshan',
  literate: 'qingshan',
  force: 'qingshan',
  dodge: 'qingshan',
  parry: 'qingshan',
  cuff: 'qingshan',
  blade: 'qingshan',
  strike: 'qingshan',
  sword: 'qingshan',
};

const PROGRESS_MASTER_ROUTE_SUFFIX: Record<string, string> = {
  qingshan: 'qingshan_biqiu',
};

function progressRoomKey() {
  const exits = new Set((state.world.location.exits || []).map(normalizeDirection));
  const room = state.world.location.name || '';
  if (room.includes('厨房')) return 'chufang';
  if (room.includes('方丈楼')) return 'fzlou';
  if (room.includes('汉水')) return 'riverbank';
  if (room.includes('山路')) return 'shanlu';
  if (room.includes('广场')) {
    if (exits.has('northup') && exits.has('south') && exits.has('east') && exits.has('west')) return 'qingshan_biqiu';
    if (exits.has('southdown') && exits.has('east') && exits.has('west')) return 'qingwu_biqiu';
    if (exits.has('east') && exits.has('south') && exits.has('west')) return 'qingfa_biqiu';
  }
  return '';
}

function progressRouteName(fromKey: string, toKey: string) {
  if (!fromKey || !toKey || fromKey === toKey) return '';
  const direct = `shaolin_${fromKey}_to_${toKey}`;
  return KNOWN_ROUTES[direct]?.commands?.length ? direct : '';
}

function progressLearnOutcome(events: Array<{ type: string; content: string; timestamp: number }>) {
  const text = summarizeEvents(events, 20);
  if (!text) return '';
  if (/潜能不够/.test(text)) return 'potential_low';
  if (/今天太累|过于疲倦|正忙/.test(text)) return 'needs_recovery';
  if (/太客气|这怎么敢当|见笑|雕虫小技|受宠若惊/.test(text)) return 'not_apprentice_or_wrong_master';
  if (/必须找别人学|不愿意教|程度已经不输|没有办法学习/.test(text)) return 'skill_blocked';
  if (/有些心得|有所提高|请教有关/.test(text)) return 'learned';
  return '';
}

function toolResultText(result: any) {
  const details = result?.details || result || {};
  const steps = Array.isArray(details.steps) ? details.steps : [];
  const texts: string[] = [];
  for (const step of steps) {
    if (Array.isArray(step?.rawEvents)) texts.push(...step.rawEvents.map((e: unknown) => String(e || '')));
    if (step?.rawText) texts.push(String(step.rawText));
  }
  if (details.msg) texts.push(String(details.msg));
  if (details.stopReason) texts.push(String(details.stopReason));
  return texts.filter(Boolean).join('\n');
}

function waterTaskOutcome(routeName: string, text: string, intendedStage: string) {
  if (!text) return null;
  const abandon = (stateName: string, reason: string, action = 'abandon_at_fzlou') => ({
    stage: 'water_abandon_needed',
    state: stateName,
    reason,
    action,
  });
  if (/下去好好反思|并没有任务在身/.test(text)) {
    return { stage: 'need_status', state: 'abandoned', reason: 'water job abandoned or already absent', action: 'resume_progress_loop' };
  }
  if (/目前还找不到什么活儿|找不到什么活/.test(text)) {
    return { stage: 'need_status', state: 'pending', reason: 'water job pending cooldown', action: 'recover_or_learn_until_available' };
  }
  if (/你不是已经领到工具了吗/.test(text)) {
    return abandon('tools_assigned_but_bucket_missing', 'shaofan says tools already assigned but bucket was not obtained');
  }
  if (/你现在没有领任务|你要瓢来干什么|你又没有领任务|已经有别人抢先挑好了水|你怎么现在才回来/.test(text)) {
    return abandon('job_missing_or_expired', 'water job missing or expired during tool/fill/turn-in stage');
  }
  if (/水桶不小心.*粉碎|你的水桶呢|身上没有这样东西|这里附近没有这样东西|并没有挑着任何东西/.test(text)) {
    return abandon('bucket_missing', 'water bucket missing or destroyed before turn-in');
  }
  if (/没有水瓢|要用什么倒水|把瓢掉到河里/.test(text)) {
    return abandon('piao_missing', 'water piao missing during fill/turn-in flow');
  }
  if (/这不是你的水桶|不是你的水桶/.test(text)) {
    return abandon('wrong_bucket', 'current bucket does not belong to this job');
  }
  if (/桶还没满|结果桶里的水全部洒|水桶里没有水/.test(text)) {
    return {
      stage: 'water_refill_needed',
      state: 'bucket_not_full',
      reason: 'bucket still exists but is not full; return to riverbank and refill',
      action: 'go_to_riverbank_refill',
    };
  }
  if (routeName === 'shaolin_fzlou_accept_water_job' && /不是问过了吗|怎么还在这里偷懒/.test(text)) {
    return { stage: 'water_job_accepted', state: 'job_already_accepted', reason: 'zhike says water job is already accepted', action: 'go_get_tools' };
  }
  if (routeName === 'shaolin_fzlou_accept_water_job' && /先去找烧饭僧|早去早回|厨房.*缺水|找烧饭僧.*工具/.test(text)) {
    return { stage: 'water_job_accepted', state: 'job_accepted', reason: 'water job accepted', action: 'go_get_tools' };
  }
  if (routeName === 'shaolin_chufang_prepare_water_tools') {
    const bucketOk = /交给.*水桶|身上不是有水桶|地上不是有你的水桶/.test(text);
    const piaoOk = /给.*水瓢|身上不是有水瓢|刚刚要过瓢|记得用完后还回来/.test(text);
    if (bucketOk && piaoOk) {
      return { stage: intendedStage, state: 'tools_ready', reason: 'bucket and piao are available', action: 'go_to_riverbank' };
    }
  }
  if (routeName === 'shaolin_water_fill_bucket_at_riverbank') {
    return { stage: intendedStage, state: 'bucket_filled', reason: 'fill route completed without detected tool failure', action: 'return_to_kitchen' };
  }
  if (routeName.startsWith('shaolin_water_return_')) {
    return { stage: intendedStage, state: 'returning', reason: 'return route completed without detected tool failure', action: 'turn_in_or_continue_return' };
  }
  if (routeName === 'shaolin_chufang_finish_water_job' && /辛苦你了|下去休息一下|奖励/.test(text)) {
    return { stage: 'need_status', state: 'completed', reason: 'water job completed', action: 'refresh_status' };
  }
  return null;
}

function chooseProgressSkill(loop: ProgressLoopState) {
  const plan = loop.skillPlan.length ? loop.skillPlan : ['buddhism', 'literate', 'force', 'dodge', 'parry', 'cuff', 'strike', 'sword'];
  for (let offset = 0; offset < plan.length; offset += 1) {
    const idx = (loop.skillIndex + offset) % plan.length;
    const skill = plan[idx];
    if (!loop.blockedSkills[skill]) return { skill, index: idx };
  }
  return { skill: plan[0] || 'force', index: 0 };
}

function progressRecoveryCommands() {
  const p = state.world.player;
  const commands: string[] = [];
  const foodLow = typeof p.food === 'number' && p.food < 80;
  const waterLow = typeof p.water === 'number' && p.water < 80;
  const jingLow = typeof p.jing === 'number' && typeof p.jing_max === 'number' && p.jing_max > 0 && p.jing / p.jing_max < 0.55;
  const qiLow = typeof p.hp === 'number' && typeof p.hp_max === 'number' && p.hp_max > 0 && p.hp / p.hp_max < 0.7;

  if (foodLow) commands.push('eat biji');
  if (waterLow) commands.push('drink hulu');
  if (jingLow && commands.length < 2) commands.push('yun regenerate');
  if (qiLow && commands.length < 2) commands.push('yun recover');
  if (commands.length < 2) commands.push('hp');
  if (commands.length < 2) commands.push('skills');
  return commands.slice(0, 3);
}

function updateProgressLoop(patch: Partial<ProgressLoopState>) {
  state.progressLoop = {
    ...state.progressLoop,
    ...patch,
    updatedAt: Date.now(),
  };
}

function detectStopReason(
  events: Array<{ type: string; content: string; timestamp: number }>,
  currentCommand = '',
): string | null {
  const currentIsInfo = currentCommand ? isInfoCommand(currentCommand) : false;
  const qi = state.world.player.hp;
  const qiMax = state.world.player.hp_max;
  if (!currentIsInfo && typeof qi === 'number' && typeof qiMax === 'number' && qiMax > 0 && qi / qiMax < 0.3) {
    return 'low_qi';
  }

  const jing = state.world.player.jing;
  const jingMax = state.world.player.jing_max;
  if (!currentIsInfo && typeof jing === 'number' && typeof jingMax === 'number' && jingMax > 0 && jing / jingMax < 0.3) {
    return 'low_jing';
  }

  const text = summarizeEvents(events, 20);
  if (!text) return null;
  if (/蛇毒|中毒|毒发|疼痛|四肢发麻/.test(text)) return 'poison_or_poison_damage';
  if (/战斗|你对|你被|招架|闪避|躲开|击中|杀死|打死/.test(text)) return 'combat_or_damage';
  if (/你必须先把|这个方向没有门|没有这个方向|不能往那个方向|那里没有|无法往|不能这样走/.test(text)) return 'blocked_exit';
  if (/拦住|挡住|不让你|正忙|busy|现在不能/.test(text)) return 'blocked_or_busy';
  return null;
}

function shouldStopBeforeNextCommand(stop: string | null, nextCommand = '') {
  if (!stop || stop === 'combat_or_damage') return false;
  if ((stop === 'low_qi' || stop === 'low_jing') && nextCommand && isInfoCommand(nextCommand)) {
    return false;
  }
  return true;
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function loadConfig(): Promise<GatewayConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const user = safeJsonParse<Partial<GatewayConfig>>(raw, {});
    return {
      mud: { ...DEFAULT_CONFIG.mud, ...(user.mud || {}) },
      auth: { ...DEFAULT_CONFIG.auth, ...(user.auth || {}) },
      agent: { ...DEFAULT_CONFIG.agent, ...(user.agent || {}) },
      runtime: { ...DEFAULT_CONFIG.runtime, ...(user.runtime || {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function memoryFilePath(config: GatewayConfig) {
  return path.resolve(ROOT_DIR, config.agent.memoryPath || DEFAULT_CONFIG.agent.memoryPath);
}

function normalizePersistentMemory(raw: Partial<PersistentMemory> | null | undefined): PersistentMemory {
  const base = createEmptyPersistentMemory();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    version: 1,
    agent_id: raw.agent_id || MEMORY_AGENT_ID,
    last_world: {
      player: raw.last_world?.player || {},
      location: {
        ...(raw.last_world?.location || {}),
        exits: Array.isArray(raw.last_world?.location?.exits) ? raw.last_world.location.exits : [],
      },
    },
    visited_rooms: raw.visited_rooms && typeof raw.visited_rooms === 'object' ? raw.visited_rooms : {},
    known_npcs: raw.known_npcs && typeof raw.known_npcs === 'object' ? raw.known_npcs : {},
    active_quests: Array.isArray(raw.active_quests) ? raw.active_quests : [],
    key_events: Array.isArray(raw.key_events) ? raw.key_events.slice(-80) : [],
    notes: Array.isArray(raw.notes) ? raw.notes.slice(-30) : [],
  };
}

async function loadPersistentMemory(config: GatewayConfig): Promise<PersistentMemory> {
  try {
    const raw = await fs.readFile(memoryFilePath(config), 'utf-8');
    return normalizePersistentMemory(safeJsonParse<Partial<PersistentMemory> | null>(raw, null));
  } catch {
    return createEmptyPersistentMemory();
  }
}

function roomMemoryKey(location: WorldSummary['location']) {
  if (location.room_id) return location.room_id;
  const name = location.name || '';
  const area = location.area || '';
  if (!name && !area) return '';
  return `${area || 'unknown'}:${name || 'unknown'}`;
}

function isImportantMemoryEvent(text: string) {
  return /任务|潜能|经验|学会|学习|拜|师父|师傅|水桶|水瓢|挑水|得到|获得|失去|死亡|昏迷|内伤|中毒|拦住|挡住|不愿意教|没有办法学习|必须找别人学|正忙|busy/i.test(text);
}

function summarizePersistentMemory(memory: PersistentMemory) {
  const location = memory.last_world.location;
  const room = [location.name, location.area].filter(Boolean).join(' / ') || '未知地点';
  const p = memory.last_world.player || {};
  const resources = [
    typeof p.hp === 'number' && typeof p.hp_max === 'number' ? `气 ${p.hp}/${p.hp_max}` : '',
    typeof p.jing === 'number' && typeof p.jing_max === 'number' ? `精 ${p.jing}/${p.jing_max}` : '',
    typeof p.potential === 'number' ? `潜能 ${p.potential}` : '',
    typeof p.combat_exp === 'number' ? `经验 ${p.combat_exp}` : '',
  ].filter(Boolean).join('，');
  const recentEvents = memory.key_events.slice(-5).map((e) => e.text.replace(/\s+/g, ' ').slice(0, 80));
  const progress = memory.progress_loop?.active
    ? `进度循环 ${memory.progress_loop.stage || 'active'}；目标 ${memory.progress_loop.targetSkill || memory.progress_loop.targetMaster || '未定'}`
    : '';
  return [
    `当前位置：${room}${location.exits?.length ? `，出口 ${location.exits.join('/')}` : ''}`,
    resources ? `角色状态：${resources}` : '',
    `已记住房间：${Object.keys(memory.visited_rooms).length}；已记住NPC：${Object.keys(memory.known_npcs).length}`,
    progress,
    memory.active_quests.length ? `进行中任务：${memory.active_quests.map((q) => q.name || q.id || 'unknown').join('，')}` : '',
    recentEvents.length ? `最近关键事件：${recentEvents.join('；')}` : '',
  ].filter(Boolean).join('\n');
}

function mergePersistentMemoryFromWorld(events: Array<{ type?: string; content?: string; text?: string; timestamp?: number }> = []) {
  const memory = state.persistentMemory;
  const now = Date.now();
  memory.updated_at = now;
  memory.turn = state.turn;
  memory.last_world = {
    player: { ...state.world.player },
    location: {
      ...state.world.location,
      exits: [...(state.world.location.exits || [])],
    },
  };
  memory.active_quests = [...state.world.quests.active];
  memory.progress_loop = {
    active: state.progressLoop.active,
    mode: state.progressLoop.mode,
    stage: state.progressLoop.stage,
    targetMaster: state.progressLoop.targetMaster,
    targetSkill: state.progressLoop.targetSkill,
    skillPlan: [...state.progressLoop.skillPlan],
    skillIndex: state.progressLoop.skillIndex,
    learnTimes: state.progressLoop.learnTimes,
    minPotential: state.progressLoop.minPotential,
    lastAction: state.progressLoop.lastAction,
    lastReason: state.progressLoop.lastReason,
    lastResult: state.progressLoop.lastResult,
    waterTaskState: state.progressLoop.waterTaskState,
    waterTaskReason: state.progressLoop.waterTaskReason,
    waterTaskAction: state.progressLoop.waterTaskAction,
    blockedSkills: { ...state.progressLoop.blockedSkills },
    updatedAt: state.progressLoop.updatedAt,
  };

  const key = roomMemoryKey(state.world.location);
  if (key) {
    const prev = memory.visited_rooms[key];
    memory.visited_rooms[key] = {
      room_id: state.world.location.room_id,
      name: state.world.location.name || prev?.name || key,
      area: state.world.location.area || prev?.area,
      exits: [...new Set([...(prev?.exits || []), ...(state.world.location.exits || [])])],
      visits: (prev?.visits || 0) + 1,
      last_seen_turn: state.turn,
      last_seen_at: now,
    };
  }

  for (const npc of state.world.entities.npcs || []) {
    const npcKey = npc.id || npc.name;
    if (!npcKey) continue;
    memory.known_npcs[npcKey] = {
      id: npc.id,
      name: npc.name,
      room: key || state.world.location.name,
      attitude: npc.attitude,
      last_seen_turn: state.turn,
      last_seen_at: now,
    };
  }

  const candidateEvents: Array<{ type?: string; content?: string; text?: string; timestamp?: number }> = events.length
    ? events
    : state.world.events.recent.slice(-6).map((e) => ({ type: e.type, text: e.text, timestamp: e.timestamp }));
  for (const e of candidateEvents) {
    const text = String(e.content ?? e.text ?? '').trim();
    if (!text || !isImportantMemoryEvent(text)) continue;
    const duplicate = memory.key_events.slice(-12).some((prev) => prev.text === text);
    if (duplicate) continue;
    memory.key_events.push({
      turn: state.turn,
      ts: e.timestamp || now,
      text: text.slice(0, 240),
      type: e.type || 'text',
    });
  }
  if (memory.key_events.length > 80) memory.key_events = memory.key_events.slice(-80);
  memory.summary = summarizePersistentMemory(memory);
}

async function savePersistentMemory(config: GatewayConfig) {
  mergePersistentMemoryFromWorld();
  const p = memoryFilePath(config);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(state.persistentMemory, null, 2), 'utf-8');
}

function formatPersistentMemoryForPrompt() {
  mergePersistentMemoryFromWorld();
  const memory = state.persistentMemory;
  const recentRooms = Object.values(memory.visited_rooms)
    .sort((a, b) => b.last_seen_at - a.last_seen_at)
    .slice(0, 6)
    .map((r) => `${r.name}${r.area ? `/${r.area}` : ''}${r.exits.length ? ` exits=${r.exits.join('/')}` : ''}`);
  return [
    '【常时记忆 memory.json】',
    memory.summary || '暂无长期记忆。',
    recentRooms.length ? `最近记住房间：${recentRooms.join('；')}` : '',
    memory.notes.length ? `备注：${memory.notes.slice(-5).join('；')}` : '',
  ].filter(Boolean).join('\n').slice(0, 1800);
}

// ---------------------------------------------------------------------------
// FluffOS text parser → WorldSummary
// ---------------------------------------------------------------------------

// 进战斗信号（任一命中 → 倾向 combat=true）
const COMBAT_ENTER_RE: RegExp[] = [
  /对著?.+?大吼，想杀死/, // combatd.c:42 发起攻击
  /你(对|攻击|杀)/,        // kill/fight 发起
  /(击中|打中|命中|劈中|踢中)/,
  /(招架|挡格|格开)/,
  /(闪避|闪身|躲开|避开)/,
  /受(了|到).{0,6}伤/,
];
// 脱战斗信号（任一命中 → combat=false），优先级高于进战斗
const COMBAT_EXIT_RE: RegExp[] = [
  /.+?被.+?死了。/,            // 对手或自己死亡 → 战斗结束 (combatd.c:937,1061)
  /.+?的尸体/,
  /(你|.+?)(逃出|逃离|逃走|拔腿就跑)/, // 逃离成功
  /(战斗结束|杀死了|不再有敌)/,
];
// 否定信号：逃跑失败 = 仍在战斗，不可清除 combat
const COMBAT_EXIT_NEGATE_RE = /你逃跑失败。/;

/**
 * 战斗状态切换：脱战斗优先于进战斗。
 * - 命中任一脱战斗模式（且非"逃跑失败"）→ combat=false
 * - 否则命中任一进战斗模式，或"逃跑失败"（逃跑没成功，仍在打）→ combat=true
 * - 都没命中 → 保持原状态（不会无故清除/置位）
 */
function updateCombatState(text: string) {
  const exited = COMBAT_EXIT_RE.some((re) => re.test(text));
  if (exited) {
    state.world.player.combat = false;
    return;
  }
  const failedFlee = COMBAT_EXIT_NEGATE_RE.test(text);
  const entered = COMBAT_ENTER_RE.some((re) => re.test(text));
  if (entered || failedFlee) {
    state.world.player.combat = true;
  }
  // 否则维持现状
}

// hp 状态行解析（来源已对源码核对：run/cmds/usr/hp.c:29-49）
// 真实布局：精/气 是 "当前/ 有效上限 (有效上限折损%)"；精力/内力 是 "当前 / 上限 (+加成)"。
// 旧 gateway 用 "气血:N/N" 完全不匹配本服务器输出，导致感知失真——这里替换为 KB 校验过的正则。
// 同步定义见 skills/xkx2001-knowledge/references/status-patterns.json
const STATUS_RE = {
  jing: /精[:：]\s*(\d+)\s*\/\s*(\d+)\s*\((\d+)%\)/,
  jingli: /精力[:：]\s*(\d+)\s*\/\s*(\d+)\s*\(\+?\d+\)/,
  qi: /气[:：]\s*(\d+)\s*\/\s*(\d+)\s*\((\d+)%\)/,
  neili: /内力[:：]\s*(\d+)\s*\/\s*(\d+)\s*\(\+?\d+\)/,
  food: /食物[:：]\s*(\d+)\s*\/\s*(\d+)/,
  water: /饮水[:：]\s*(\d+)\s*\/\s*(\d+)/,
  potential: /潜能[:：]\s*(\d+)\s*\/\s*(\d+)/,
  combat_exp: /经验[:：]\s*(\d+)/,
};

function parseStatusLine(text: string) {
  const p = state.world.player;
  let m: RegExpMatchArray | null;
  // 气 → hp（当前/有效上限），第三组=内伤%
  if ((m = text.match(STATUS_RE.qi))) {
    p.hp = Number(m[1]); p.hp_max = Number(m[2]); p.hp_injury_pct = Number(m[3]);
  }
  // 精 → jing，第三组=内伤%
  if ((m = text.match(STATUS_RE.jing))) {
    p.jing = Number(m[1]); p.jing_max = Number(m[2]); p.jing_injury_pct = Number(m[3]);
  }
  // 精力 → mp（行动耐力）
  if ((m = text.match(STATUS_RE.jingli))) {
    p.mp = Number(m[1]); p.mp_max = Number(m[2]);
  }
  // 内力
  if ((m = text.match(STATUS_RE.neili))) {
    p.neili = Number(m[1]); p.neili_max = Number(m[2]);
  }
  if ((m = text.match(STATUS_RE.food))) {
    p.food = Number(m[1]); p.food_max = Number(m[2]);
  }
  if ((m = text.match(STATUS_RE.water))) {
    p.water = Number(m[1]); p.water_max = Number(m[2]);
  }
  if ((m = text.match(STATUS_RE.potential))) {
    p.potential = Number(m[1]); p.potential_max = Number(m[2]);
  }
  if ((m = text.match(STATUS_RE.combat_exp))) p.combat_exp = Number(m[1]);
}

function parseFluffosText(raw: string) {
  // 先剥离 ANSI 颜色码（hp/score 数值外包 HIC/HIG/HIY… 颜色，不剥离会破坏数字正则）
  const text = raw.replace(/\r/g, '').replace(/\[[0-9;]*m/g, '');
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);

  // 出口（先定出口行，标题行就在出口行所属 look 块的最上方）
  const exitsLineIdx = lines.findIndex((l) =>
    /这里(?:明显的出口|唯一的出口)是|这里没有任何明显的出路|(?:明显的出口|出口)[有是]?[:：]/.test(l)
  );
  let parsedExits: string[] | undefined;
  if (exitsLineIdx >= 0) {
    const exitsLine = lines[exitsLineIdx];
    if (/这里没有任何明显的出路/.test(exitsLine)) {
      parsedExits = [];
    } else {
      const m =
        exitsLine.match(/这里(?:明显的出口|唯一的出口)是\s*(.+?)(?:。|$)/) ||
        exitsLine.match(/(?:明显的出口|出口)[有是]?[:：]\s*(.+)$/);
      if (m) {
        const exitText = m[1].replace(/和/g, '、').replace(/[。；;]/g, '');
        parsedExits = Array.from(
          new Set(exitText.split(/[、,，\s]+/).map(normalizeDirection).filter(Boolean))
        );
      }
    }
    if (parsedExits) state.world.location.exits = parsedExits;
  }

  // 房间标题：用 KB 校验过的格式 "短名 - filename"（非巫师 filename 常为空 → 破折号后允许为空），
  // 并以 KB 已知房间短名 (KB.knownShorts) 作白名单——避免把 prompt/聊天/旁白行误判成房间标题
  // （此前导致 location.name 被覆盖为 "<!" 之类垃圾值的 bug）。
  // 搜索范围：仅在出口行**之前**的若干行里找；若 KB 未加载，则只用更严格的正则形态守门。
  const titleSearchEnd = exitsLineIdx >= 0 ? exitsLineIdx : Math.min(lines.length, 8);
  const TITLE_RE = /^(.+?)\s*[-－]\s*(\S*)\s*$/;
  // 一些应当过滤的行特征：以 < / > / 【 / 】 / : / ： / 》 / 《 等"非房间字"开头，
  // 或包含明显的对话/系统/计时/聊天/prompt 标记。
  const looksLikeNonTitle = (s: string): boolean => {
    if (!s) return true;
    if (/^[<>【】「」《》（）()\[\]]/.test(s)) return true; // prompt/chat brackets
    if (/[:：][^-]*$/.test(s) && !/[一-鿿]\s*[-－]/.test(s)) return true; // "xxx: ..." 对话行（无破折号配对）
    if (/^(对|你说|你对|你大喊|你嘟囔|说道|笑道|喊道)/.test(s)) return true;
    if (s.length > 30) return true; // 房间名通常 ≤ 10 汉字
    return false;
  };
  const tryAcceptTitle = (raw: string): { name: string; area: string } | null => {
    const m = raw.match(TITLE_RE);
    if (m) {
      const name = m[1].trim();
      const area = m[2].trim();
      if (!name || looksLikeNonTitle(name)) return null;
      // KB 已加载 → 必须是已知房间短名才接受
      if (KB && !KB.knownShorts.has(name)) return null;
      return { name, area };
    }
    // 简洁模式：单行就是房间短名，没有破折号
    if (KB && KB.knownShorts.has(raw.trim()) && !looksLikeNonTitle(raw.trim())) {
      return { name: raw.trim(), area: '' };
    }
    return null;
  };

  let titleFound: { name: string; area: string } | null = null;
  // 优先从上往下找，命中第一个有效标题即可；典型 look 输出标题就在最上。
  for (let i = 0; i < titleSearchEnd; i++) {
    const cand = tryAcceptTitle(lines[i]);
    if (cand) { titleFound = cand; break; }
  }
  if (titleFound) {
    state.world.location.name = titleFound.name;
    if (titleFound.area) state.world.location.area = titleFound.area;
    // 解析 room_id（短名 + 出口集合 → KB 唯一房间），用于精确路线偏离判定
    const rid = resolveRoomIdByShortExits(titleFound.name, state.world.location.exits);
    if (rid) state.world.location.room_id = rid;
  }
  // 若 titleFound===null，**保留**上一次的 location.name（不要被无关文本覆盖）。

  // 战斗状态机（combat 默认 false；进战斗/脱战斗都靠文案切换）
  // 模式来源：skills/xkx2001-knowledge/references/status-patterns.json（已对 mudlib 源码核对）。
  // 关键：脱战斗(死亡/逃离/结束)优先于进战斗——同一段文本里"你击中…对方被你打死了"应判定为脱战。
  updateCombatState(text);

  // 状态资源（精/气/精力/内力/食物/饮水/潜能/经验）——查 KB 校验过的正则
  parseStatusLine(text);

  state.world.meta.tick += 1;
  state.world.meta.timestamp = Date.now();

  for (const line of lines) {
    state.world.events.recent.push({ type: 'text', text: line, timestamp: Date.now() });
  }
  // 窗口限制（避免 WorldSummary 本身过大）
  const MAX_EVENTS_IN_WORLD = 40;
  if (state.world.events.recent.length > MAX_EVENTS_IN_WORLD) {
    state.world.events.recent = state.world.events.recent.slice(-MAX_EVENTS_IN_WORLD);
  }
  mergePersistentMemoryFromWorld(lines.map((line) => ({ type: 'text', text: line, timestamp: Date.now() })));
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

async function saveCheckpoint(config: GatewayConfig) {
  await savePersistentMemory(config);
  const cp: RuntimeCheckpoint = {
    agent_id: MEMORY_AGENT_ID,
    phase: state.phase,
    turn: state.turn,
    world: {
      room_id: state.world.location.room_id,
      hp: state.world.player.hp,
      combat: state.world.player.combat,
    },
    scheduler: {
      pending_actions: [...state.pendingActions],
      cooldown_until: state.world.capabilities.cooldowns.global,
    },
    memory_summary: state.memorySummary, // ← v2.5 新增
    last_tick: state.world.meta.tick,
    updated_at: Date.now(),
  };
  const p = path.resolve(ROOT_DIR, config.agent.checkpointPath);
  await fs.writeFile(p, JSON.stringify(cp, null, 2), 'utf-8');
}

async function loadCheckpoint(config: GatewayConfig): Promise<RuntimeCheckpoint | null> {
  try {
    const p = path.resolve(ROOT_DIR, config.agent.checkpointPath);
    const raw = await fs.readFile(p, 'utf-8');
    return safeJsonParse<RuntimeCheckpoint | null>(raw, null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// v2.5 核心：compactMemory
//
// 原理：
//   1. 用当前 session 发一次特殊 prompt，让 LLM 生成结构化摘要
//   2. 摘要写入 state.memorySummary（也会存 checkpoint）
//   3. 调用方销毁旧 session，用 createSession() 建全新 session
//   4. 新 session 第一个 prompt 只携带：system + summary + 当前 WorldSummary
//
// Token 节省原理：
//   旧 session 100 turn × N messages → 全部丢弃
//   新 session context ≈ system(400) + summary(500) + worldSummary(800) = ~1700 tokens
// ---------------------------------------------------------------------------

const COMPACT_SYSTEM_PROMPT = `
你是一个 MUD 游戏记忆压缩器。
根据以下对话历史，生成一份结构化的中文游戏状态摘要。
格式要求（JSON）：
{
  "location": "当前所在地点名称和区域",
  "player_status": "HP/MP/战斗状态一句话",
  "recent_actions": ["最近做的3-5件重要事"],
  "known_npcs": ["重要 NPC 名字和简要态度"],
  "active_quests": ["任务名和当前阶段"],
  "notes": "其他需要记住的重要信息（不超过3条）"
}
只输出 JSON，不加任何解释。
`.trim();

async function compactMemory(
  oldSession: AgentSession,
  config: GatewayConfig
): Promise<string> {
  console.log('[Compact] Generating memory summary from current session...');

  // 单独建一个只用于压缩的 loader，system prompt 极短
  const compactLoader = new DefaultResourceLoader({
    systemPromptOverride: () => COMPACT_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await compactLoader.reload();

  // 用一个全新的一次性 session 来做摘要（避免污染主 session）
  const { session: compactSession } = await createAgentSession({
    resourceLoader: compactLoader,
    sessionManager: SessionManager.inMemory(),
  });

  // 把旧 session 的关键信息浓缩送给摘要 session
  const worldJson = JSON.stringify({
    player: state.world.player,
    location: state.world.location,
    quests: state.world.quests,
    recentEvents: state.world.events.recent.slice(-10),
    persistentMemory: {
      summary: state.persistentMemory.summary,
      keyEvents: state.persistentMemory.key_events.slice(-10),
      progressLoop: state.persistentMemory.progress_loop,
    },
  }, null, 2);

  let summary = '';
  try {
    await compactSession.prompt(
      `这是当前游戏世界状态（JSON）：\n${worldJson}\n\n请生成摘要。`
    );
    // 从 session 最后一条 assistant 消息拿文本
    const messages = compactSession.messages ?? [];
    const last = [...messages].reverse().find((m: any) => m.role === 'assistant');
    if (last) {
      const lastAny = last as any;
      const raw = typeof lastAny.content === 'string'
        ? lastAny.content
        : (lastAny.content?.[0]?.text ?? '');
      summary = raw.trim();
    }
  } catch (e: any) {
    console.error('[Compact] summary error:', e?.message || e);
    // fallback：把 WorldSummary 直接序列化当摘要
    summary = JSON.stringify({ fallback: true, world: state.world.player, location: state.world.location });
  }

  console.log('[Compact] Summary generated:', summary.slice(0, 120), '...');
  return summary;
}

// ---------------------------------------------------------------------------
// Session factory：创建主 agent session
// ---------------------------------------------------------------------------

function buildSystemPrompt(config: GatewayConfig): string {
  return `
你是一个长期运行的 FluffOS MUD 自治代理（v2.5）。你的目标：生存、探索、完成任务。
登录信息：id=${config.auth.id} password=${config.auth.password}（仅在需要重新登录时使用）。

强制策略：
1) 每回合先调用 wait_event() 或 get_world_summary() 观察环境。
2) 若目标是跨区域移动或已知路线，先调用 get_known_routes()，再优先调用 execute_route_skill()，不要自己逐步推路。
3) 普通局部行动或探索回合才调用 execute_command_sequence()，一次提交 2-5 条命令，让 Gateway 本地循环快速执行。
3) 遇到战斗或低血（HP < 30%），优先保命：恢复/撤离/防御。
4) 关键转折时调用 save_checkpoint()。s
5) 小步快跑策略：观察 → 稳定 route 用 execute_route_skill；普通探索/局部行动用 execute_command_sequence(2-3条);快速探索用 execute_command_sequence(3-5条) → 再观察。
6) 探图时优先调用 get_known_routes()；有 commands 的路线用 execute_route_skill，有 directions 的路线再用 follow_path。
7) 不要在命令序列里反复 look；只在当前位置未知、出口未知、或路线结束后需要校验时使用 look。
8) 不要用 send_command 连续单发代替 execute_command_sequence；除非只需要一条信息命令。
9) 普通观察调用 wait_event() 时不要传 timeoutMs，使用默认短等待；除非刚执行了明确需要长等待的动作，否则不要传 1000ms 这类长等待。
10) 少林挑水任务优先读取 skill shaolin-water-carrying；执行时使用 shaolin_fzlou_accept_water_job / shaolin_chufang_prepare_water_tools / shaolin_chufang_to_riverbank_for_water_job / shaolin_water_fill_bucket_at_riverbank / shaolin_water_return_* / shaolin_chufang_finish_water_job。若知客僧说“不是问过了吗”，视为任务已接并继续领工具；若桶还在但水不满或水洒了，切到 water_refill_* 回汉水 yao/dao 加满再回厨房交任务；若烧饭僧说“不是已经领到工具了吗”但没有水桶、或桶/瓢丢失、任务过期，切到 water_abandon_* 并用 shaolin_fzlou_abandon_water_job 放弃后重启判断。
11) 长渡船、busy、挑水 yao/dao 等等待必须放进 execute_route_skill 的 per-step waitMs，不要用 wait_event 长等。
12) 若 execute_route_skill 返回 deviationKind/recoveryHint，立刻停止长路线；下一轮只允许用 execute_command_sequence 发送2-3条纠错命令，或重新进入最近的稳定 route skill。
13) 山门特殊规则：寺内山门殿出寺使用 ["open gate","south","look"]；寺外广场回寺使用 ["knock gate","north","look"]。
14) 若短纠错序列必须包含 yao shui / dao shui to shui tong，Gateway 会自动加长这些命令的等待；不要把五轮打水压成一条人工长字符串。
15) 少林新手成长循环（吃喝恢复 -> 只找清善 qingshan 学习 -> 潜能不足挑水 -> 工具/交付异常找知客僧放弃 -> 回来继续学）优先调用 execute_progress_loop_step；不要让 LLM 自己长篇拼接 learn/tiaoshui 路线。
`.trim();
}

function classifyNativeKnowledgeTool(toolName: string, args: any): {
  kind: AgentTraceKind;
  name: string;
  keywords: string[];
  resources: AgentTraceData['resources'];
} | null {
  const text = `${toolName}\n${JSON.stringify(args || {})}`;
  const lower = text.toLowerCase();
  const pathMatch = text.match(/(?:file|path|cwd|cmd|command|args)["'\s:=[\],]+([^"'\]\n]+(?:ONTOLOGY\.md|SKILL\.md|status-patterns\.json|route\.py|find_master\.py|build_kb\.py|skills\/xkx2001-knowledge\/data)[^"'\]\n]*)/i);
  const matchedPath = pathMatch?.[1]?.trim();

  if (lower.includes('ontology.md')) {
    return {
      kind: 'ontology',
      name: 'ontology_lookup',
      keywords: ['ontology', 'xkx2001'],
      resources: [{ type: 'ontology', name: 'xkx2001 ontology', path: matchedPath || 'skills/xkx2001-knowledge/ONTOLOGY.md' }],
    };
  }
  if (lower.includes('skills/xkx2001-knowledge/data') || lower.includes('status-patterns.json') || lower.includes('route.py') || lower.includes('find_master.py') || lower.includes('build_kb.py')) {
    return {
      kind: 'kb',
      name: 'kb_lookup',
      keywords: ['kb', 'xkx2001'],
      resources: [{ type: 'kb', name: 'xkx2001 knowledge base', path: matchedPath }],
    };
  }
  if (lower.includes('skill.md')) {
    const skillName = matchedPath?.split('/skills/')[1]?.split('/')[0] || 'skill';
    return {
      kind: 'skill',
      name: 'skill_lookup',
      keywords: ['skill', skillName],
      resources: [{ type: 'skill', name: skillName, path: matchedPath }],
    };
  }
  return null;
}

async function createSession(config: GatewayConfig, tools: Tool[], onNativeToolTrace?: NativeToolTraceHandler): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
    cwd: ROOT_DIR,
    additionalSkillPaths: [SKILLS_DIR],
    systemPromptOverride: () => buildSystemPrompt(config),
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    customTools: tools as any,
  });

  // 订阅事件，输出到 stdout
  session.subscribe((event: any) => {
    if (event.type === 'message_update') {
      const asm = event.assistantMessageEvent;
      if (asm?.type === 'text_delta') {
        process.stdout.write(asm.delta);
      }
      return;
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      onNativeToolTrace?.(event);
    }
  });

  return session;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = await loadConfig();
  state.persistentMemory = await loadPersistentMemory(config);
  console.log(`[Gateway] Persistent memory loaded (${Object.keys(state.persistentMemory.visited_rooms).length} rooms, ${Object.keys(state.persistentMemory.known_npcs).length} NPCs).`);

  // ---- MUD TCP 连接 --------------------------------------------------------

  let mud = new net.Socket();
  let isConnecting = false;
  let firstConnected = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let connectResolve: (() => void) | null = null;
  let connectReject: ((e: any) => void) | null = null;

  // ---- WebSocket 监控 ------------------------------------------------------

  const wss = new WebSocketServer({ host: '127.0.0.1', port: config.runtime.monitorPort });
  console.log(`[Gateway] monitor WebSocket → ws://127.0.0.1:${config.runtime.monitorPort}`);

  const broadcast = (payload: any) => {
    const msg = JSON.stringify(payload);
    for (const client of wss.clients) {
      if ((client as any).readyState === 1) (client as any).send(msg);
    }
  };

  const emitTrace = (patch: Omit<AgentTraceData, 'id' | 'turn' | 'seriesId' | 'ts'>) => {
    const data: AgentTraceData = {
      id: `${state.turn}.${state.traceSeq++}`,
      turn: state.turn,
      seriesId: state.agentSeriesId,
      ts: Date.now(),
      ...patch,
    };
    state.recentTraces.push(data);
    if (state.recentTraces.length > 200) {
      state.recentTraces.splice(0, state.recentTraces.length - 200);
    }
    broadcast({ type: 'agent_trace', data });
  };

  const summarizeEvents = (events: Array<{ content: string }>) => ({
    count: events.length,
    lastLine: events.length ? events[events.length - 1].content.slice(0, 240) : '',
  });

  const summarizeToolResult = (toolName: string, result: { details?: any }) => {
    const d = result?.details || {};
    if (toolName === 'wait_event') return { count: d.count };
    if (toolName === 'get_known_routes') return { routes: Object.keys(d).slice(0, 20), count: Object.keys(d).length };
    if (toolName === 'execute_command_sequence' || toolName === 'execute_route_skill' || toolName === 'follow_path') {
      return {
        msg: d.msg,
        completedSteps: d.completedSteps,
        requestedSteps: d.requestedSteps,
        completedCommands: d.completedCommands,
        requestedCommands: d.requestedCommands,
        stopReason: d.stopReason || null,
        deviationKind: d.deviationKind || null,
        recoveryHint: d.recoveryHint || null,
      };
    }
    if (toolName === 'get_runtime_state') return d;
    if (toolName === 'execute_progress_loop_step') return d.progressLoop || d;
    if (toolName === 'get_world_summary') {
      return {
        location: d.location?.name || '',
        exits: d.location?.exits || [],
        busy: Boolean(d.player?.busy),
        combat: Boolean(d.player?.combat),
      };
    }
    return d && typeof d === 'object' ? Object.fromEntries(Object.entries(d).slice(0, 8)) : d;
  };

  const emitNativeKnowledgeTrace: NativeToolTraceHandler = (event: any) => {
    const classified = classifyNativeKnowledgeTool(event.toolName || '', event.args || {});
    if (!classified) return;
    emitTrace({
      phase: event.type === 'tool_execution_end'
        ? (event.isError ? 'error' : 'end')
        : 'start',
      kind: classified.kind,
      name: classified.name,
      toolCallId: event.toolCallId,
      input: event.type === 'tool_execution_start' ? event.args || {} : undefined,
      outputSummary: event.type === 'tool_execution_end'
        ? { toolName: event.toolName, isError: Boolean(event.isError) }
        : undefined,
      keywords: classified.keywords,
      resources: classified.resources,
      status: event.type === 'tool_execution_end' ? (event.isError ? 'error' : 'ok') : undefined,
    });
  };

  const fastExplore = {
    enabled: false,
    busy: false,
    timer: null as ReturnType<typeof setTimeout> | null,
    step: 0,
    orderIndex: 0,
    lastDirection: '',
  };

  const fastExploreOrder = [
    'east', 'southeast', 'south', 'north', 'northeast', 'northwest',
    'southwest', 'west', 'up', 'down', 'enter', 'out',
  ];

  const fastLog = (msg: string) => {
    broadcast({ type: 'log', data: `[fast-explore] ${msg}` });
  };

  const scheduleFastExplore = (delayMs = config.agent.fastExploreIntervalMs) => {
    if (!fastExplore.enabled) return;
    if (fastExplore.timer) clearTimeout(fastExplore.timer);
    fastExplore.timer = setTimeout(runFastExploreStep, Math.max(50, delayMs));
  };

  const stopFastExplore = (reason: string) => {
    fastExplore.enabled = false;
    fastExplore.busy = false;
    if (fastExplore.timer) {
      clearTimeout(fastExplore.timer);
      fastExplore.timer = null;
    }
    fastLog(`stopped: ${reason}`);
    sendStateSnapshot();
  };

  const chooseFastExploreDirection = () => {
    const exits = Array.from(new Set((state.world.location.exits || []).map(normalizeDirection).filter(Boolean)));
    const candidates = exits.length > 0
      ? fastExploreOrder.filter((dir) => exits.includes(dir)).concat(exits.filter((dir) => !fastExploreOrder.includes(dir)))
      : [];

    if (candidates.length === 0) return 'look';

    const direction = candidates[fastExplore.orderIndex % candidates.length];
    fastExplore.orderIndex += 1;
    return direction;
  };

  const runFastExploreStep = () => {
    if (!fastExplore.enabled) return;
    if (fastExplore.busy) {
      scheduleFastExplore(config.agent.fastExploreIntervalMs);
      return;
    }
    if (!state.connected) {
      stopFastExplore('MUD not connected');
      return;
    }
    if (Date.now() < collab.manualUntil) {
      fastLog('paused: manual control active');
      scheduleFastExplore(config.agent.fastExploreIntervalMs);
      return;
    }

    fastExplore.busy = true;
    const cmd = chooseFastExploreDirection();
    fastExplore.step += 1;
    fastExplore.lastDirection = cmd;
    state.phase = 'ACT';
    state.pendingActions.push(`fast:${cmd}`);

    const room = state.world.location.name || 'unknown room';
    const exits = (state.world.location.exits || []).join('/') || 'unknown exits';
    mud.write(cmd + '\n');
    fastLog(`#${fastExplore.step} ${room} [${exits}] -> ${cmd}`);
    sendStateSnapshot();

    fastExplore.busy = false;
    scheduleFastExplore(config.agent.fastExploreIntervalMs);
  };

  const sendStateSnapshot = () => {
    broadcast({
      type: 'state',
      data: {
        connected: state.connected,
        phase: state.phase,
        turn: state.turn,
        world: state.world,
        memorySummaryLen: state.memorySummary.length,
        persistentMemory: {
          summaryLen: state.persistentMemory.summary.length,
          rooms: Object.keys(state.persistentMemory.visited_rooms).length,
          npcs: Object.keys(state.persistentMemory.known_npcs).length,
          keyEvents: state.persistentMemory.key_events.length,
          updatedAt: state.persistentMemory.updated_at,
        },
        manualUntil: collab.manualUntil,
        steeringPrompt: collab.steeringPrompt,
        oneShotPromptQueued: Boolean(collab.oneShotPrompt),
        oneShotPromptId: collab.oneShotPromptId,
        activeOneShotPromptId: collab.activeOneShotPromptId,
        recentTraces: state.recentTraces.slice(-50),
        waterRoute: state.waterRoute,
        progressLoop: state.progressLoop,
        fastExplore: {
          enabled: fastExplore.enabled,
          intervalMs: config.agent.fastExploreIntervalMs,
          step: fastExplore.step,
          lastDirection: fastExplore.lastDirection,
        },
        now: Date.now(),
      },
    });
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', version: '2.5' }));
    sendStateSnapshot();

    ws.on('message', (raw) => {
      try {
        const m = safeJsonParse<any>(String(raw), null);
        if (!m?.type) return;

        // 人类发命令
        if (m.type === 'cmd') {
          const cmd = String(m.cmd || '').trim();
          if (!cmd || !state.connected) return;
          if (!isInfoCommand(cmd)) {
            collab.manualUntil = Date.now() + config.runtime.manualHoldMs;
            broadcast({ type: 'log', data: `manual priority for ${config.runtime.manualHoldMs / 1000}s` });
          }
          mud.write(cmd + '\n');
          state.pendingActions.push(`human:${cmd}`);
          broadcast({ type: 'log', data: `human → ${cmd}` });
          sendStateSnapshot();
          return;
        }

        if (m.type === 'fast_explore') {
          const enabled = Boolean(m.enabled);
          if (enabled) {
            fastExplore.enabled = true;
            fastExplore.step = 0;
            fastExplore.orderIndex = 0;
            fastExplore.lastDirection = '';
            fastLog(`started: ${config.agent.fastExploreIntervalMs}ms interval, LLM loop paused`);
            scheduleFastExplore(0);
          } else {
            stopFastExplore('user requested');
          }
          sendStateSnapshot();
          return;
        }

        // 人类设置 steering prompt
        if (m.type === 'prompt') {
          const prompt = String(m.prompt || '').trim();
          if (m.oneShot) {
            collab.oneShotPrompt = prompt;
            collab.oneShotPromptId += 1;
            collab.oneShotUpdatedAt = Date.now();
            broadcast({ type: 'log', data: `one-shot steering queued: ${prompt || '(cleared)'}` });
            emitTrace({
              phase: 'progress',
              kind: 'series',
              name: 'one_shot_prompt',
              input: { id: collab.oneShotPromptId, length: prompt.length },
              status: prompt ? 'ok' : 'stopped',
            });
          } else {
            collab.steeringPrompt = prompt;
            collab.steeringUpdatedAt = Date.now();
            broadcast({ type: 'log', data: `steering: ${collab.steeringPrompt || '(cleared)'}` });
          }
          sendStateSnapshot();
          return;
        }
      } catch {
        // ignore
      }
    });
  });

  // ---- MUD socket handlers -------------------------------------------------

  const bindMudHandlers = (sock: net.Socket) => {
    sock.on('connect', async () => {
      isConnecting = false;
      state.connected = true;
      console.log('[Gateway] Connected to MUD.');
      broadcast({ type: 'log', data: 'MUD connected' });
      sendStateSnapshot();

      if (config.auth.autoLogin) {
        await sleep(config.auth.loginDelayMs);
        if (state.connected) {
          mud.write(config.auth.id + '\n');
          await sleep(350);
          if (state.connected) mud.write(config.auth.password + '\n');
        }
      }

      if (!firstConnected) {
        firstConnected = true;
        connectResolve?.();
      }
    });

    sock.on('data', (buf) => {
      const raw = buf.toString(config.mud.encoding);
      parseFluffosText(raw);
      broadcast({ type: 'mud_data', data: raw });

      for (const line0 of raw.split('\n')) {
        const line = line0.trim();
        if (!line) continue;
        state.eventQueue.push({ type: 'text', content: line, timestamp: Date.now() });
      }

      // 队列上限防溢出
      if (state.eventQueue.length > 400) {
        state.eventQueue.splice(0, state.eventQueue.length - 400);
      }
      sendStateSnapshot();
    });

    sock.on('error', (err) => {
      isConnecting = false;
      console.error('[Gateway] MUD error:', err.message);
      broadcast({ type: 'log', data: `MUD error: ${err.message}` });
      if (!firstConnected) connectReject?.(err);
    });

    sock.on('close', () => {
      isConnecting = false;
      state.connected = false;
      console.log('[Gateway] MUD closed, retry in 3s...');
      broadcast({ type: 'log', data: 'MUD closed, retrying in 3s' });
      sendStateSnapshot();
      scheduleReconnect(3000);
    });
  };

  const scheduleReconnect = (delayMs: number) => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectMud();
    }, delayMs);
  };

  const connectMud = () => {
    if (state.connected || isConnecting) return;
    isConnecting = true;
    try { mud.removeAllListeners(); mud.destroy(); } catch { }
    mud = new net.Socket();
    bindMudHandlers(mud);
    console.log(`[Gateway] Connecting → ${config.mud.host}:${config.mud.port}`);
    try {
      mud.connect(config.mud.port, config.mud.host);
    } catch (e: any) {
      isConnecting = false;
      console.error('[Gateway] connect() threw:', e?.message || e);
      scheduleReconnect(3000);
    }
  };

  const connectPromise = new Promise<void>((resolve, reject) => {
    connectResolve = resolve;
    connectReject = reject;
    connectMud();
  });

  // ---- Tool definitions ---------------------------------------------------

  /**
   * send_command: 向 MUD 发命令
   * token：返回字符串极短（仅确认），不携带 MUD 输出
   */
  const sendCommandTool: Tool = {
    name: 'send_command',
    label: 'send_command',
    description: '向 MUD 发送命令（look/score/go north/kill xxx 等）。命令发送后请调用 wait_event 获取响应。',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string', description: '要发送的命令字符串' } },
      required: ['cmd'],
    },
    execute: async (_id, params) => {
      const cmd = String(params?.cmd || '').trim();
      if (!cmd) return { content: [{ type: 'text', text: 'Error: empty command.' }], details: {} };
      if (!state.connected) return { content: [{ type: 'text', text: 'Error: not connected.' }], details: {} };

      if (fastExplore.enabled && !isInfoCommand(cmd)) {
        return { content: [{ type: 'text', text: 'Paused: fast_explore is active.' }], details: {} };
      }

      // 人类手动控制期间，非信息类命令被阻断
      if (Date.now() < collab.manualUntil && !isInfoCommand(cmd)) {
        return { content: [{ type: 'text', text: 'Paused: manual control active.' }], details: {} };
      }

      mud.write(cmd + '\n');
      state.phase = 'ACT';
      state.pendingActions.push(cmd);
      console.log(`[Agent] send_command -> ${cmd}`);
      broadcast({ type: 'log', data: `agent → ${cmd}` });
      emitTrace({
        phase: 'progress',
        kind: 'command',
        name: 'send_command',
        input: { cmd },
        status: 'ok',
      });

      // 返回极简确认，不把 MUD 响应塞进这里（等 wait_event 拿）
      return {
        content: [{ type: 'text', text: `OK: sent "${cmd}"` }],
        details: { cmd },
      };
    },
  };

  /**
   * wait_event: 等待并获取 MUD 事件
   * token：返回 JSON 事件列表，上限 maxRecentEvents 行
   */
  const waitEventTool: Tool = {
    name: 'wait_event',
    label: 'wait_event',
    description: '短等待 MUD 服务器响应并返回事件列表。普通观察不要传 timeoutMs；如传入也会被限制在50-250ms。长等待应交给execute_route_skill的per-step waitMs。',
    parameters: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', description: '短等待时长(ms)，默认150，实际范围50-250；普通观察不要传。' },
      },
    },
    execute: async (_id, params) => {
      const requestedTimeoutMs = Number(params?.timeoutMs || config.agent.waitEventDefaultMs);
      const timeoutMs = Math.max(50, Math.min(250, Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : config.agent.waitEventDefaultMs));
      state.phase = 'WAIT';
      const clampedNote = requestedTimeoutMs !== timeoutMs ? ` (requested ${requestedTimeoutMs}ms clamped)` : '';
      console.log(`[Agent] wait_event ${timeoutMs}ms${clampedNote}`);
      broadcast({ type: 'log', data: `agent waiting ${timeoutMs}ms for MUD events${clampedNote}` });
      await sleep(timeoutMs);

      const events = [...state.eventQueue];
      state.eventQueue.length = 0;

      let result = events;
      let msg = 'OK';
      if (events.length > config.agent.maxRecentEvents) {
        result = events.slice(-config.agent.maxRecentEvents);
        msg = `Truncated to latest ${config.agent.maxRecentEvents} lines.`;
      }

      // 同步 WorldSummary.events
      state.world.events.recent = result.map((e) => ({
        type: e.type,
        text: e.content,
        timestamp: e.timestamp,
      }));
      state.pendingActions = [];
      state.phase = 'OBSERVE';
      console.log(`[Agent] observed ${result.length} event(s)`);
      broadcast({ type: 'log', data: `agent observed ${result.length} event(s)` });
      emitTrace({
        phase: 'end',
        kind: 'observation',
        name: 'wait_event',
        outputSummary: summarizeEvents(result),
        status: 'ok',
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({ msg, count: result.length, events: result }) }],
        details: { count: result.length },
      };
    },
  };

  /**
   * get_world_summary: 获取结构化 WorldSummary
   * token：~500-800 tokens，比原始 MUD 日志小得多
   */
  const getWorldSummaryTool: Tool = {
    name: 'get_world_summary',
    label: 'get_world_summary',
    description: '获取结构化 WorldSummary（比原始 MUD 文本更适合决策，优先使用）。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({
      content: [{ type: 'text', text: JSON.stringify(state.world) }],
      details: state.world,
    }),
  };

  /**
   * get_runtime_state: 获取运行时元信息
   */
  const getRuntimeStateTool: Tool = {
    name: 'get_runtime_state',
    label: 'get_runtime_state',
    description: '获取 agent 运行时状态（连接/phase/turn）。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          connected: state.connected,
          phase: state.phase,
          turn: state.turn,
          queueLen: state.eventQueue.length,
          memorySummaryLen: state.memorySummary.length,
          persistentMemory: {
            summaryLen: state.persistentMemory.summary.length,
            rooms: Object.keys(state.persistentMemory.visited_rooms).length,
            npcs: Object.keys(state.persistentMemory.known_npcs).length,
            keyEvents: state.persistentMemory.key_events.length,
            updatedAt: state.persistentMemory.updated_at,
          },
          manualHoldRemainingMs: Math.max(0, collab.manualUntil - Date.now()),
          waterRoute: state.waterRoute,
          progressLoop: state.progressLoop,
        }),
      }],
      details: {
        connected: state.connected,
        phase: state.phase,
        turn: state.turn,
        queueLen: state.eventQueue.length,
        memorySummaryLen: state.memorySummary.length,
        persistentMemory: {
          summaryLen: state.persistentMemory.summary.length,
          rooms: Object.keys(state.persistentMemory.visited_rooms).length,
          npcs: Object.keys(state.persistentMemory.known_npcs).length,
          keyEvents: state.persistentMemory.key_events.length,
          updatedAt: state.persistentMemory.updated_at,
        },
        manualHoldRemainingMs: Math.max(0, collab.manualUntil - Date.now()),
        waterRoute: state.waterRoute,
        progressLoop: state.progressLoop,
      },
    }),
  };

  /**
   * execute_command_sequence: LLM 一次生成 2-3 条命令，Gateway 本地快速执行
   */
  const executeCommandSequenceTool: Tool = {
    name: 'execute_command_sequence',
    label: 'execute_command_sequence',
    description: '一次提交2到3条MUD命令，Gateway会按150ms左右间隔本地执行；yao/dao/fang/tiao等busy命令会自动使用更长等待；每步直接返回MUD原文rawText/rawEvents。稳定长路线必须改用execute_route_skill。',
    parameters: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 3,
          description: '2到3条命令，例如 ["hp", "east"] 或 ["east", "southeast", "hp"]。除稳定route skill外，探索均用2-3步。',
        },
        stepWaitMs: {
          type: 'number',
          description: '普通命令后的等待毫秒数，默认150，范围80-500；busy命令会自动覆盖为更长等待。',
        },
      },
      required: ['commands'],
    },
    execute: async (_id, params) => {
      if (!state.connected) {
        return { content: [{ type: 'text', text: 'Error: not connected.' }], details: {} };
      }
      if (fastExplore.enabled) {
        return { content: [{ type: 'text', text: 'Paused: fast_explore is active.' }], details: {} };
      }

      const commands = (Array.isArray(params?.commands) ? params.commands : [])
        .map((cmd: unknown) => String(cmd || '').trim())
        .filter(Boolean)
        .slice(0, 3);

      if (commands.length < 2) {
        return {
          content: [{ type: 'text', text: 'Error: commands must contain 2 to 3 non-empty commands. Use execute_route_skill for stable long routes.' }],
          details: { commands },
        };
      }

      const stepWaitMs = Math.max(80, Math.min(500, Number(params?.stepWaitMs || 150)));
      const steps: Array<{ step: number; cmd: string; waitMs: number; rawEvents: string[]; rawText: string; stopReason?: string }> = [];
      let stopReason = '';

      state.phase = 'ACT';
      console.log(`[Agent] sequence start: ${commands.length} command(s), ${stepWaitMs}ms interval`);
      broadcast({ type: 'log', data: `agent sequence start: ${commands.length} command(s), ${stepWaitMs}ms interval` });
      emitTrace({
        phase: 'start',
        kind: 'command_sequence',
        name: 'execute_command_sequence',
        input: { commands, stepWaitMs },
      });

      for (const [index, cmd] of commands.entries()) {
        if (Date.now() < collab.manualUntil) {
          stopReason = 'manual_control_active';
          emitTrace({
            phase: 'progress',
            kind: 'command_sequence',
            name: 'execute_command_sequence',
            outputSummary: { step: index + 1, stopReason },
            status: 'blocked',
          });
          break;
        }

        const actualStepWaitMs = commandSequenceWaitMs(cmd, stepWaitMs);
        mud.write(cmd + '\n');
        state.pendingActions.push(`seq:${cmd}`);
        console.log(`[Agent] sequence ${index + 1}/${commands.length} -> ${cmd}; wait ${actualStepWaitMs}ms`);
        broadcast({ type: 'log', data: `agent sequence ${index + 1}/${commands.length} → ${cmd}${actualStepWaitMs !== stepWaitMs ? `; wait ${actualStepWaitMs}ms` : ''}` });
        emitTrace({
          phase: 'progress',
          kind: 'command',
          name: 'sequence_step',
          input: { step: index + 1, total: commands.length, cmd, waitMs: actualStepWaitMs },
        });
        await sleep(actualStepWaitMs);

        const events = [...state.eventQueue];
        state.eventQueue.length = 0;
        const stop = detectStopReason(events, cmd);
        const stopAfterStep = shouldStopBeforeNextCommand(stop, commands[index + 1] || '');
        const rawEvents = events.map((e) => e.content);
        steps.push({
          step: index + 1,
          cmd,
          waitMs: actualStepWaitMs,
          rawEvents,
          rawText: rawEvents.join('\n'),
          ...(stopAfterStep ? { stopReason: stop || undefined } : {}),
        });
        emitTrace({
          phase: 'progress',
          kind: 'command_sequence',
          name: 'execute_command_sequence',
          outputSummary: { step: index + 1, cmd, waitMs: actualStepWaitMs, stopReason: stopAfterStep ? stop || null : null, resourceWarning: stop && !stopAfterStep ? stop : null, ...summarizeEvents(events) },
          status: stopAfterStep ? 'stopped' : 'ok',
        });

        state.world.events.recent = events.slice(-config.agent.maxRecentEvents).map((e) => ({
          type: e.type,
          text: e.content,
          timestamp: e.timestamp,
        }));

        if (stopAfterStep) {
          stopReason = stop || '';
          break;
        }
      }

      state.pendingActions = [];
      state.phase = 'OBSERVE';
      console.log(`[Agent] sequence done: ${steps.length}/${commands.length}${stopReason ? `, stopped=${stopReason}` : ''}`);
      broadcast({ type: 'log', data: `agent sequence done: ${steps.length}/${commands.length}${stopReason ? `, stopped=${stopReason}` : ''}` });
      emitTrace({
        phase: 'end',
        kind: 'command_sequence',
        name: 'execute_command_sequence',
        outputSummary: { completedCommands: steps.length, requestedCommands: commands.length, stopReason: stopReason || null },
        status: stopReason ? 'stopped' : 'ok',
      });

      const result = {
        msg: stopReason ? `stopped: ${stopReason}` : 'completed',
        requestedCommands: commands.length,
        completedCommands: steps.length,
        stopReason: stopReason || null,
        finalLocation: state.world.location,
        player: state.world.player,
        steps,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  };

  /**
   * get_known_routes: 返回 MUD 探图 skill 中维护的常用路线
   */
  const getKnownRoutesTool: Tool = {
    name: 'get_known_routes',
    label: 'get_known_routes',
    description: '获取已知 MUD 路线。若路线有commands，优先交给execute_route_skill本地执行；若只有directions，再传给follow_path。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '可选路线名；不传则返回全部路线' },
      },
      required: [],
    },
    execute: async (_id, params) => {
      const name = String(params?.name || '').trim();
      const routes = name ? { [name]: KNOWN_ROUTES[name] } : KNOWN_ROUTES;
      const cleanRoutes = Object.fromEntries(Object.entries(routes).filter(([, v]) => Boolean(v)));
      return {
        content: [{ type: 'text', text: JSON.stringify(cleanRoutes) }],
        details: cleanRoutes,
      };
    },
  };

  /**
   * execute_route_skill: 执行预先调查好的长路线，避免 LLM 用普通探索序列分段规划
   */
  const executeRouteSkillTool: Tool = {
    name: 'execute_route_skill',
    label: 'execute_route_skill',
    description: '按名称执行已知路线skill。支持长路线、渡船等待、丐帮暗道等特殊步骤；每步直接返回MUD原文rawText/rawEvents。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '路线名，例如 yangzhou_guangchang_to_shaolin_shanmen_overland' },
        stepWaitMs: { type: 'number', description: '普通步骤后的等待毫秒数，默认150，范围80-1000。特殊步骤可覆盖。' },
        maxSteps: { type: 'number', description: '最多执行多少步，默认执行完整稳定路线。用于测试时可设为2到3。' },
      },
      required: ['name'],
    },
    execute: async (_id, params) => {
      if (!state.connected) {
        return { content: [{ type: 'text', text: 'Error: not connected.' }], details: {} };
      }
      if (fastExplore.enabled) {
        return { content: [{ type: 'text', text: 'Paused: fast_explore is active.' }], details: {} };
      }

      const name = String(params?.name || '').trim();
      const route = KNOWN_ROUTES[name];
      if (!route?.commands?.length) {
        return {
          content: [{ type: 'text', text: `Error: route "${name}" has no executable commands.` }],
          details: { name, availableRoutes: Object.keys(KNOWN_ROUTES) },
        };
      }

      const defaultWaitMs = Math.max(80, Math.min(1000, Number(params?.stepWaitMs || 150)));
      const maxStepsRaw = Number(params?.maxSteps || route.commands.length);
      const maxSteps = Math.max(1, Math.min(route.commands.length, Number.isFinite(maxStepsRaw) ? maxStepsRaw : route.commands.length));
      const steps: Array<{
        step: number;
        cmd: string;
        waitMs: number;
        expectedStage?: string;
        actualRoom?: string;
        deviation?: string;
        deviationKind?: string;
        recoveryHint?: string;
        rawEvents: string[];
        rawText: string;
        stopReason?: string;
      }> = [];
      let stopReason = '';

      state.phase = 'ACT';
      console.log(`[Agent] route ${name} start: ${route.from} -> ${route.to}, ${maxSteps}/${route.commands.length} step(s)`);
      broadcast({ type: 'log', data: `route ${name} start: ${route.from} -> ${route.to}, ${maxSteps}/${route.commands.length} step(s)` });
      if (isShaolinWaterRoute(name)) {
        state.waterRoute = {
          active: true,
          routeName: name,
          from: route.from,
          to: route.to,
          step: 0,
          total: maxSteps,
          currentCmd: '',
          expectedStage: `${route.from} -> ${route.to}`,
          expectedCommand: '',
          actualRoom: state.world.location.name || '',
          actualExits: state.world.location.exits || [],
          deviation: '',
          deviationKind: '',
          recoveryHint: '',
          recentActualRooms: appendRecentWaterRoom(state.world.location.name || ''),
          lastLine: '',
          plannedCommands: route.commands.slice(0, maxSteps).map((s, i) => `${i + 1}. ${routeStepCommand(s)}${routeStepNote(s) ? ` (${routeStepNote(s)})` : ''}`),
          updatedAt: Date.now(),
        };
        sendStateSnapshot();
      }
      emitTrace({
        phase: 'start',
        kind: 'route',
        name,
        input: {
          from: route.from,
          to: route.to,
          maxSteps,
          totalSteps: route.commands.length,
          plannedCommands: isShaolinWaterRoute(name) ? route.commands.slice(0, maxSteps).map(routeStepCommand) : undefined,
        },
        keywords: ['skill', 'route', name, route.from, route.to].filter(Boolean),
        resources: [{ type: 'skill', name, query: `${route.from} -> ${route.to}` }],
      });

      for (const [index, rawStep] of route.commands.slice(0, maxSteps).entries()) {
        if (Date.now() < collab.manualUntil) {
          stopReason = 'manual_control_active';
          const actualRoom = state.world.location.name || '';
          const actualExits = state.world.location.exits || [];
          const recoveryHint = routeRecoveryHint(name, '', stopReason, actualRoom, actualExits);
          if (isShaolinWaterRoute(name)) {
            state.waterRoute = {
              ...state.waterRoute,
              active: false,
              routeName: name,
              step: index + 1,
              total: maxSteps,
              currentCmd: '',
              expectedCommand: '',
              actualRoom,
              actualExits,
              deviation: stopReason,
              deviationKind: stopReason,
              recoveryHint,
              recentActualRooms: appendRecentWaterRoom(actualRoom),
              updatedAt: Date.now(),
            };
            sendStateSnapshot();
          }
          emitTrace({
            phase: 'progress',
            kind: 'route',
            name,
            outputSummary: { step: index + 1, stopReason, actualRoom, recoveryHint },
            status: 'blocked',
          });
          break;
        }

        const step = typeof rawStep === 'string' ? { cmd: rawStep } : rawStep;
        const cmd = step.cmd.trim();
        const waitMs = Math.max(100, Math.min(60_000, Number(step.waitMs || defaultWaitMs)));
        if (!cmd) continue;
        const expected = expectedWaterStage(name, index + 1, maxSteps, cmd);
        const preActualRoom = state.world.location.name || '';
        const preActualExits = state.world.location.exits || [];
        const preActualRoomId = state.world.location.room_id || null;
        // 本步开始前 agent 应在的 KB room_id（来自预计算的路线序列）
        const expectedRoomIdHere = expectedRoomIdAtStep(name, index);
        const preDeviation = waterRouteDeviation(expected, preActualRoom, expectedRoomIdHere, preActualRoomId);
        if (isShaolinWaterRoute(name) && preDeviation) {
          stopReason = 'room_mismatch';
          const recoveryHint = routeRecoveryHint(name, cmd, stopReason, preActualRoom, preActualExits);
          state.waterRoute = {
            ...state.waterRoute,
            active: false,
            routeName: name,
            step: index + 1,
            total: maxSteps,
            currentCmd: cmd,
            expectedStage: expected.label || `${route.from} -> ${route.to}`,
            expectedCommand: cmd,
            actualRoom: preActualRoom,
            actualExits: preActualExits,
            deviation: preDeviation,
            deviationKind: stopReason,
            recoveryHint,
            recentActualRooms: appendRecentWaterRoom(preActualRoom),
            updatedAt: Date.now(),
          };
          sendStateSnapshot();
          emitTrace({
            phase: 'progress',
            kind: 'route',
            name,
            outputSummary: { step: index + 1, cmd, expectedStage: expected.label || null, actualRoom: preActualRoom, deviation: preDeviation, deviationKind: stopReason, recoveryHint, stopReason },
            status: 'stopped',
          });
          break;
        }
        if (isShaolinWaterRoute(name)) {
          state.waterRoute = {
            ...state.waterRoute,
            active: true,
            routeName: name,
            step: index + 1,
            total: maxSteps,
            currentCmd: cmd,
            expectedCommand: cmd,
            expectedStage: expected.label || `${route.from} -> ${route.to}`,
            actualRoom: preActualRoom,
            actualExits: preActualExits,
            deviation: '',
            deviationKind: '',
            recoveryHint: '',
            recentActualRooms: appendRecentWaterRoom(preActualRoom),
            updatedAt: Date.now(),
          };
          sendStateSnapshot();
        }

        mud.write(cmd + '\n');
        state.pendingActions.push(`route:${name}:${cmd}`);
        console.log(`[Agent] route ${name} ${index + 1}/${route.commands.length} -> ${cmd}; wait ${waitMs}ms`);
        broadcast({ type: 'log', data: `route ${name} ${index + 1}/${route.commands.length} → ${cmd}${waitMs > defaultWaitMs ? `; wait ${waitMs}ms` : ''}` });
        emitTrace({
          phase: 'progress',
          kind: 'route',
          name,
          input: { step: index + 1, total: route.commands.length, cmd, waitMs },
        });
        await sleep(waitMs);

        const events = [...state.eventQueue];
        state.eventQueue.length = 0;
        const stop = detectStopReason(events, cmd);
        const rawEvents = events.map((e) => e.content);
        const actualRoom = state.world.location.name || '';
        const actualRoomId = state.world.location.room_id || null;
        // 本步执行后 agent 应到达的 KB room_id（= 下一步开始时的预期房间）
        const expectedRoomIdNext = expectedRoomIdAtStep(name, index + 1);
        const deviation = waterRouteDeviation(expected, actualRoom, expectedRoomIdNext, actualRoomId);
        const deviationKind = isShaolinWaterRoute(name)
          ? classifyRouteDeviation(name, cmd, expected, actualRoom, events, stop, expectedRoomIdNext, actualRoomId)
          : '';
        const routeStopReason = deviationKind || stop || '';
        const recoveryHint = isShaolinWaterRoute(name)
          ? routeRecoveryHint(name, cmd, deviationKind || stop || '', actualRoom, state.world.location.exits || [])
          : '';
        const lastLine = rawEvents.length ? rawEvents[rawEvents.length - 1].slice(0, 240) : '';
        steps.push({
          step: index + 1,
          cmd,
          waitMs,
          expectedStage: expected.label || undefined,
          actualRoom,
          deviation: deviation || undefined,
          deviationKind: deviationKind || undefined,
          recoveryHint: recoveryHint || undefined,
          rawEvents,
          rawText: rawEvents.join('\n'),
          ...(routeStopReason ? { stopReason: routeStopReason } : {}),
        });
        if (isShaolinWaterRoute(name)) {
          state.waterRoute = {
            ...state.waterRoute,
            active: true,
            routeName: name,
            step: index + 1,
            total: maxSteps,
            currentCmd: cmd,
            expectedCommand: cmd,
            expectedStage: expected.label || `${route.from} -> ${route.to}`,
            actualRoom,
            actualExits: state.world.location.exits || [],
            deviation,
            deviationKind,
            recoveryHint,
            recentActualRooms: appendRecentWaterRoom(actualRoom),
            lastLine,
            updatedAt: Date.now(),
          };
          sendStateSnapshot();
        }
        emitTrace({
          phase: 'progress',
          kind: 'route',
          name,
          outputSummary: { step: index + 1, cmd, expectedStage: expected.label || null, actualRoom, deviation: deviation || null, deviationKind: deviationKind || null, recoveryHint: recoveryHint || null, stopReason: routeStopReason || null, ...summarizeEvents(events) },
          status: routeStopReason && routeStopReason !== 'combat_or_damage' ? 'stopped' : 'ok',
        });

        state.world.events.recent = events.slice(-config.agent.maxRecentEvents).map((e) => ({
          type: e.type,
          text: e.content,
          timestamp: e.timestamp,
        }));

        if (routeStopReason && routeStopReason !== 'combat_or_damage') {
          stopReason = routeStopReason;
          break;
        }
      }

      state.pendingActions = [];
      state.phase = 'OBSERVE';
      if (isShaolinWaterRoute(name)) {
        state.waterRoute = {
          ...state.waterRoute,
          active: false,
          routeName: name,
          step: steps.length || state.waterRoute.step,
          total: maxSteps,
          currentCmd: stopReason ? state.waterRoute.currentCmd : '',
          expectedCommand: stopReason ? state.waterRoute.expectedCommand : '',
          expectedStage: stopReason ? `stopped: ${stopReason}` : `completed: ${route.to}`,
          actualRoom: state.world.location.name || state.waterRoute.actualRoom,
          actualExits: state.world.location.exits || [],
          deviation: stopReason ? (state.waterRoute.deviation || stopReason) : state.waterRoute.deviation,
          deviationKind: stopReason ? (state.waterRoute.deviationKind || stopReason) : state.waterRoute.deviationKind,
          recoveryHint: stopReason ? (state.waterRoute.recoveryHint || routeRecoveryHint(name, '', stopReason, state.world.location.name || state.waterRoute.actualRoom, state.world.location.exits || [])) : state.waterRoute.recoveryHint,
          recentActualRooms: appendRecentWaterRoom(state.world.location.name || state.waterRoute.actualRoom),
          updatedAt: Date.now(),
        };
        sendStateSnapshot();
      }
      console.log(`[Agent] route ${name} done: ${steps.length}/${route.commands.length}${stopReason ? `, stopped=${stopReason}` : ''}`);
      broadcast({ type: 'log', data: `route ${name} done: ${steps.length}/${route.commands.length}${stopReason ? `, stopped=${stopReason}` : ''}` });
      emitTrace({
        phase: 'end',
        kind: 'route',
        name,
        outputSummary: {
          completedSteps: steps.length,
          requestedSteps: maxSteps,
          stopReason: stopReason || null,
          deviationKind: isShaolinWaterRoute(name) ? state.waterRoute.deviationKind || null : null,
          recoveryHint: isShaolinWaterRoute(name) ? state.waterRoute.recoveryHint || null : null,
        },
        status: stopReason ? 'stopped' : 'ok',
      });

      const result = {
        msg: stopReason ? `stopped: ${stopReason}` : 'completed',
        route: { name, from: route.from, to: route.to, notes: route.notes, requirements: route.requirements || [] },
        requestedSteps: maxSteps,
        completedSteps: steps.length,
        stopReason: stopReason || null,
        deviationKind: isShaolinWaterRoute(name) ? state.waterRoute.deviationKind || null : null,
        recoveryHint: isShaolinWaterRoute(name) ? state.waterRoute.recoveryHint || null : null,
        finalLocation: state.world.location,
        player: state.world.player,
        steps,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  };

  /**
   * follow_path: 一次 LLM 决策内连续小步探图，内部每步观察并按安全规则停止
   */
  const followPathTool: Tool = {
    name: 'follow_path',
    label: 'follow_path',
    description: '按方向数组连续探图。普通探索最多 3 步，每步等待 MUD 输出并直接返回原文rawText/rawEvents；稳定长路线请用execute_route_skill。',
    parameters: {
      type: 'object',
      properties: {
        directions: {
          type: 'array',
          items: { type: 'string' },
          description: '方向数组，如 ["southeast", "east", "north"]',
        },
        maxSteps: {
          type: 'number',
          description: '最多执行步数，默认 3，硬上限 3；稳定route不走此工具。',
        },
        stepWaitMs: {
          type: 'number',
          description: '每步后等待 MUD 响应的毫秒数，默认使用 gateway 配置',
        },
      },
      required: ['directions'],
    },
    execute: async (_id, params) => {
      if (!state.connected) {
        return { content: [{ type: 'text', text: 'Error: not connected.' }], details: {} };
      }
      if (fastExplore.enabled) {
        return { content: [{ type: 'text', text: 'Paused: fast_explore is active.' }], details: {} };
      }

      const rawDirections = Array.isArray(params?.directions) ? params.directions : [];
      const directions = rawDirections.map(normalizeDirection).filter(Boolean);
      if (directions.length === 0) {
        return { content: [{ type: 'text', text: 'Error: directions must be a non-empty array.' }], details: {} };
      }

      const maxSteps = Math.max(1, Math.min(3, Number(params?.maxSteps || 3)));
      const stepWaitMs = Math.max(80, Math.min(300, Number(params?.stepWaitMs || config.agent.followPathStepWaitMs)));
      const steps: Array<{ step: number; direction: string; rawEvents: string[]; rawText: string; stopReason?: string }> = [];
      let stopReason = '';

      state.phase = 'ACT';
      emitTrace({
        phase: 'start',
        kind: 'route',
        name: 'follow_path',
        input: { directions: directions.slice(0, maxSteps), maxSteps, stepWaitMs },
      });

      for (const direction of directions.slice(0, maxSteps)) {
        if (Date.now() < collab.manualUntil) {
          stopReason = 'manual_control_active';
          emitTrace({
            phase: 'progress',
            kind: 'route',
            name: 'follow_path',
            outputSummary: { stopReason },
            status: 'blocked',
          });
          break;
        }

        mud.write(direction + '\n');
        state.pendingActions.push(direction);
        console.log(`[Agent] follow_path -> ${direction}; wait ${stepWaitMs}ms`);
        broadcast({ type: 'log', data: `agent follow_path → ${direction}` });
        emitTrace({
          phase: 'progress',
          kind: 'command',
          name: 'follow_path_step',
          input: { step: steps.length + 1, direction, waitMs: stepWaitMs },
        });
        await sleep(stepWaitMs);

        const events = [...state.eventQueue];
        state.eventQueue.length = 0;
        const stop = detectStopReason(events, direction);
        const rawEvents = events.map((e) => e.content);
        steps.push({
          step: steps.length + 1,
          direction,
          rawEvents,
          rawText: rawEvents.join('\n'),
          ...(stop ? { stopReason: stop } : {}),
        });
        emitTrace({
          phase: 'progress',
          kind: 'route',
          name: 'follow_path',
          outputSummary: { step: steps.length, direction, stopReason: stop || null, ...summarizeEvents(events) },
          status: stop ? 'stopped' : 'ok',
        });

        state.world.events.recent = events.slice(-config.agent.maxRecentEvents).map((e) => ({
          type: e.type,
          text: e.content,
          timestamp: e.timestamp,
        }));

        if (stop) {
          stopReason = stop;
          break;
        }
      }

      state.pendingActions = [];
      state.phase = 'OBSERVE';
      emitTrace({
        phase: 'end',
        kind: 'route',
        name: 'follow_path',
        outputSummary: { completedSteps: steps.length, requestedSteps: Math.min(directions.length, maxSteps), stopReason: stopReason || null },
        status: stopReason ? 'stopped' : 'ok',
      });

      const result = {
        msg: stopReason ? `stopped: ${stopReason}` : 'completed',
        requestedSteps: Math.min(directions.length, maxSteps),
        completedSteps: steps.length,
        stopReason: stopReason || null,
        finalLocation: state.world.location,
        player: state.world.player,
        steps,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  };

  /**
   * save_checkpoint: 手动存档
   */
  const saveCheckpointTool: Tool = {
    name: 'save_checkpoint',
    label: 'save_checkpoint',
    description: '立即保存运行时 checkpoint（关键转折点时调用）。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      await saveCheckpoint(config);
      return { content: [{ type: 'text', text: 'Checkpoint saved.' }], details: {} };
    },
  };

  const executeProgressLoopStepTool: Tool = {
    name: 'execute_progress_loop_step',
    label: 'execute_progress_loop_step',
    description: '推进少林新手“恢复吃喝 -> 只找清善 qingshan 学技能 -> 潜能不足挑水 -> 工具/交付异常则找知客僧放弃 -> 回来继续学”的确定性状态机。在每一个turn里多次调用工具。但偏差时停止并交给Pi用短序列恢复。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'start|step|stop，默认step。start会启用状态机。' },
        skillPlan: {
          type: 'array',
          items: { type: 'string' },
          description: '可选技能顺序，默认 buddhism,literate,buddhism,shaolinshenfa,hunyuan-yiqi,shaolin-shenfa,parry,hunyuan-yiqi,shaolin-shenfa；成长循环只向 qingshan 学习。',
        },
        learnTimes: { type: 'number', description: '每次 learn 的次数，默认5，会被当前潜能限制。' },
        minPotential: { type: 'number', description: '低于该潜能就转挑水，默认8。' },
      },
      required: [],
    },
    execute: async (_id, params) => {
      const action = String(params?.action || 'step').trim().toLowerCase();
      if (action === 'stop') {
        updateProgressLoop({ active: false, mode: 'idle', stage: 'idle', lastAction: 'stop', lastReason: 'user_or_pi_requested_stop' });
        sendStateSnapshot();
        return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
      }

      if (action === 'start' || !state.progressLoop.active) {
        updateProgressLoop({
          active: true,
          mode: 'learn_then_water',
          stage: 'need_status',
          skillPlan: Array.isArray(params?.skillPlan) && params.skillPlan.length
            ? params.skillPlan.map((s: unknown) => String(s || '').trim()).filter(Boolean)
            : state.progressLoop.skillPlan,
          learnTimes: Math.max(1, Math.min(30, Number(params?.learnTimes || state.progressLoop.learnTimes || 10))),
          minPotential: Math.max(1, Math.min(50, Number(params?.minPotential || state.progressLoop.minPotential || 8))),
          lastAction: 'start',
          lastReason: 'progress loop enabled',
          lastResult: '',
          waterTaskState: 'idle',
          waterTaskReason: '',
          waterTaskAction: '',
        });
      }

      const loop = state.progressLoop;
      if (!state.connected) {
        updateProgressLoop({ lastAction: 'pause', lastReason: 'MUD not connected' });
        return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
      }
      if (fastExplore.enabled) {
        updateProgressLoop({ lastAction: 'pause', lastReason: 'fast_explore active' });
        return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
      }
      if (Date.now() < collab.manualUntil) {
        updateProgressLoop({ lastAction: 'pause', lastReason: 'manual_control_active' });
        sendStateSnapshot();
        return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
      }

      const runSeq = async (commands: string[], reason: string, stage: string) => {
        updateProgressLoop({ stage, lastAction: `sequence:${commands.join(',')}`, lastReason: reason });
        emitTrace({ phase: 'progress', kind: 'state_machine', name: 'progress_loop', input: { stage, commands, reason }, keywords: ['skill', 'progress_loop', stage], resources: [{ type: 'skill', name: 'shaolin progress loop', query: stage }], status: 'ok' });
        const result = await executeCommandSequenceTool.execute('progress_loop_sequence', { commands, stepWaitMs: 350 });
        const steps = result.details?.steps || [];
        const events = steps.flatMap((s: any) => (Array.isArray(s.rawEvents) ? s.rawEvents : []).map((content: string) => ({ type: 'text', content, timestamp: Date.now() })));
        const outcome = progressLearnOutcome(events);
        updateProgressLoop({ lastResult: outcome || result.details?.msg || 'sequence_done' });
        sendStateSnapshot();
        return result;
      };

      const runRoute = async (name: string, reason: string, stage: string) => {
        updateProgressLoop({ stage, lastAction: `route:${name}`, lastReason: reason });
        emitTrace({ phase: 'progress', kind: 'state_machine', name: 'progress_loop', input: { stage, route: name, reason }, keywords: ['skill', 'progress_loop', name], resources: [{ type: 'skill', name, query: reason }], status: 'ok' });
        const result = await executeRouteSkillTool.execute('progress_loop_route', { name });
        updateProgressLoop({ lastResult: result.details?.msg || 'route_done' });
        sendStateSnapshot();
        return result;
      };

      const runWaterRoute = async (name: string, reason: string, stage: string) => {
        const result = await runRoute(name, reason, stage);
        const outcome = waterTaskOutcome(name, toolResultText(result), stage);
        if (outcome) {
          updateProgressLoop({
            stage: outcome.stage,
            waterTaskState: outcome.state,
            waterTaskReason: outcome.reason,
            waterTaskAction: outcome.action,
            lastResult: outcome.reason,
          });
          sendStateSnapshot();
        }
        return result;
      };

      const setWaterTask = (stage: string, stateName: string, reason: string, actionName: string) => {
        updateProgressLoop({
          stage,
          waterTaskState: stateName,
          waterTaskReason: reason,
          waterTaskAction: actionName,
          lastResult: reason,
        });
      };

      const p = state.world.player;
      const potential = typeof p.potential === 'number' ? p.potential : 0;
      const foodLow = typeof p.food === 'number' && p.food < 80;
      const waterLow = typeof p.water === 'number' && p.water < 80;
      const jingLow = typeof p.jing === 'number' && typeof p.jing_max === 'number' && p.jing_max > 0 && p.jing / p.jing_max < 0.55;
      const qiLow = typeof p.hp === 'number' && typeof p.hp_max === 'number' && p.hp_max > 0 && p.hp / p.hp_max < 0.7;
      const roomKey = progressRoomKey();

      if (loop.stage === 'need_status') {
        return runSeq(['hp', 'skills'], 'refresh hp/skills before deciding learn vs water', 'observing_status');
      }

      if (foodLow || waterLow || jingLow || qiLow) {
        return runSeq(progressRecoveryCommands(), 'food/water/jing/qi below progress thresholds', 'recovering');
      }

      if (potential < loop.minPotential || loop.stage.startsWith('water_')) {
        if (loop.stage.startsWith('water_abandon')) {
          if (roomKey === 'fzlou') {
            return runWaterRoute('shaolin_fzlou_abandon_water_job', 'abandon inconsistent Shaolin water job before restarting loop', 'water_abandoning');
          }
          if (roomKey === 'chufang') {
            return runWaterRoute('shaolin_chufang_to_fzlou', 'go to zhike to abandon inconsistent water job', 'water_abandon_at_fzlou');
          }
          if (roomKey === 'riverbank') {
            return runWaterRoute('shaolin_water_return_riverbank_to_shanlu_probe', 'leave riverbank before abandoning inconsistent water job', 'water_abandon_on_shanlu');
          }
          if (roomKey === 'shanlu') {
            const exits = new Set((state.world.location.exits || []).map(normalizeDirection));
            const variant = exits.has('up')
              ? 'shaolin_water_return_shanlu_to_chufang_via_up'
              : exits.has('westup')
                ? 'shaolin_water_return_shanlu_to_chufang_via_westup'
                : exits.has('northwest')
                  ? 'shaolin_water_return_shanlu_to_chufang_via_northwest'
                  : '';
            if (variant) return runWaterRoute(variant, 'return from mountain path before abandoning inconsistent water job', 'water_abandon_to_chufang');
          }
          const toKitchenForAbandon = progressRouteName(roomKey, 'chufang');
          if (toKitchenForAbandon) {
            return runWaterRoute(toKitchenForAbandon, 'return to kitchen/fzlou path before abandoning inconsistent water job', 'water_abandon_to_chufang');
          }
          setWaterTask('water_abandon_needed', 'abandon_blocked', `need abandon but no route from ${roomKey || 'unknown'} to fzlou`, 'manual_relocate_to_fzlou');
          sendStateSnapshot();
          return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
        }
        if (loop.stage === 'water_refill_needed' || loop.stage === 'water_refill_to_riverbank' || loop.stage === 'water_refill_to_chufang') {
          if (roomKey === 'riverbank') {
            return runWaterRoute('shaolin_water_fill_bucket_at_riverbank', 'refill not-full bucket at riverbank', 'water_filled');
          }
          if (roomKey === 'shanlu') {
            return runWaterRoute('shaolin_water_shanlu_to_riverbank_for_refill', 'bucket not full: go back down to riverbank', 'water_refill_to_riverbank');
          }
          if (roomKey === 'chufang') {
            setWaterTask('water_refill_to_riverbank', 'returning_to_refill', 'bucket not full; returning to riverbank before turn-in', 'go_to_riverbank_refill');
            return runWaterRoute('shaolin_chufang_to_riverbank_for_water_job', 'bucket not full: return to riverbank to refill', 'water_refill_to_riverbank');
          }
          if (roomKey === 'fzlou') {
            return runWaterRoute('shaolin_fzlou_to_chufang', 'bucket not full: go through kitchen before returning to riverbank', 'water_refill_to_chufang');
          }
          const toKitchenForRefill = progressRouteName(roomKey, 'chufang');
          if (toKitchenForRefill) {
            return runWaterRoute(toKitchenForRefill, 'bucket not full: return to kitchen before riverbank refill', 'water_refill_to_chufang');
          }
          setWaterTask('water_refill_needed', 'refill_blocked', `need refill but no route from ${roomKey || 'unknown'} to riverbank`, 'manual_relocate_to_riverbank');
          sendStateSnapshot();
          return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
        }
        if (roomKey === 'riverbank') {
          if (loop.stage === 'water_filled') {
            return runWaterRoute('shaolin_water_return_riverbank_to_shanlu_probe', 'full bucket: enter random water-carrying mountain path', 'water_on_shanlu');
          }
          return runWaterRoute('shaolin_water_fill_bucket_at_riverbank', 'fill bucket because potential is low', 'water_filled');
        }
        if (roomKey === 'shanlu') {
          const exits = new Set((state.world.location.exits || []).map(normalizeDirection));
          const variant = exits.has('up')
            ? 'shaolin_water_return_shanlu_to_chufang_via_up'
            : exits.has('westup')
              ? 'shaolin_water_return_shanlu_to_chufang_via_westup'
              : exits.has('northwest')
                ? 'shaolin_water_return_shanlu_to_chufang_via_northwest'
                : '';
          if (variant) return runWaterRoute(variant, 'return from random mountain path to kitchen', 'water_returning');
          updateProgressLoop({ lastAction: 'pause', lastReason: 'shanlu branch unknown; need Pi short recovery/look' });
          sendStateSnapshot();
          return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
        }
        if (roomKey === 'fzlou') {
          if (loop.stage === 'water_need_job' || loop.stage === 'water_at_fzlou') {
            return runWaterRoute('shaolin_fzlou_accept_water_job', 'accept Shaolin water job for potential', 'water_job_accepted');
          }
          return runWaterRoute('shaolin_fzlou_to_chufang', 'go to kitchen after accepting water job', 'water_at_chufang');
        }
        if (roomKey === 'chufang') {
          if (loop.stage === 'water_returning') {
            return runWaterRoute('shaolin_chufang_finish_water_job', 'turn in full bucket for reward/potential', 'need_status');
          }
          if (loop.stage === 'water_job_accepted' || loop.stage === 'water_at_chufang') {
            return runWaterRoute('shaolin_chufang_prepare_water_tools', 'get bucket and piao before water run', 'water_tools_done');
          }
          if (loop.stage === 'water_tools_done') {
            setWaterTask('water_at_river', 'traveling_to_riverbank', 'tools prepared; going to riverbank', 'go_to_riverbank');
            return runWaterRoute('shaolin_chufang_to_riverbank_for_water_job', 'go to riverbank for water job', 'water_at_river');
          }
          return runWaterRoute('shaolin_chufang_to_fzlou', 'potential low: go to fzlou to accept water job', 'water_at_fzlou');
        }

        const toKitchen = progressRouteName(roomKey, 'chufang');
        if (toKitchen) return runWaterRoute(toKitchen, 'potential low: return to kitchen before water loop', 'water_need_job');
        updateProgressLoop({ lastAction: 'pause', lastReason: `potential low but no route from ${roomKey || 'unknown'} to kitchen` });
        sendStateSnapshot();
        return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
      }

      const chosen = chooseProgressSkill(loop);
      const skill = chosen.skill;
      const master = PROGRESS_MASTER_BY_SKILL[skill] || loop.targetMaster || 'qingshan';
      const targetKey = PROGRESS_MASTER_ROUTE_SUFFIX[master] || 'qingshan_biqiu';
      if (roomKey !== targetKey) {
        let routeName = progressRouteName(roomKey, targetKey);
        if (!routeName && roomKey === 'fzlou') routeName = 'shaolin_fzlou_to_qingshan_biqiu';
        if (!routeName && roomKey === 'chufang' && targetKey === 'qingshan_biqiu') routeName = 'shaolin_chufang_to_qingshan_biqiu';
        if (!routeName && roomKey === 'qingshan_biqiu' && targetKey === 'qingwu_biqiu') routeName = 'shaolin_qingshan_biqiu_to_qingwu_biqiu';
        if (routeName) return runRoute(routeName, `go to ${master} to learn ${skill}`, 'learn_travel');
        updateProgressLoop({ lastAction: 'pause', lastReason: `no route from ${roomKey || 'unknown'} to ${targetKey}` });
        sendStateSnapshot();
        return { content: [{ type: 'text', text: JSON.stringify(state.progressLoop) }], details: state.progressLoop };
      }

      const times = Math.max(1, Math.min(loop.learnTimes, potential));
      updateProgressLoop({
        stage: 'learning',
        targetMaster: master,
        targetSkill: skill,
        skillIndex: (chosen.index + 1) % loop.skillPlan.length,
      });
      const result = await runSeq([`learn ${master} ${skill} ${times}`, 'hp'], `learn ${skill} from ${master}; potential=${potential}`, 'learning');
      const steps = result.details?.steps || [];
      const events = steps.flatMap((s: any) => (Array.isArray(s.rawEvents) ? s.rawEvents : []).map((content: string) => ({ type: 'text', content, timestamp: Date.now() })));
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
          '连接已建立。先调用 wait_event() 观察初始环境；若要去少林/扬州等已知地点，调用 get_known_routes() 后用 execute_route_skill()。局部行动/探索才调用一次 execute_command_sequence()，只提交2到3条命令。',
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
        '若只是局部探索，再只调用一次 execute_command_sequence()，一次性提交2到3条命令。',
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
