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
 * 7. 增加 execute_command_sequence：LLM 一次生成 4-5 条命令，Gateway TS 本地按 150ms 间隔执行。
 *
 * Token 模型：
 *   - 每 COMPACT_EVERY_TURNS 轮，session 被销毁重建
 *   - 新 session context = system_prompt + memory_summary + 当前 WorldSummary
 *   - 历史对话不携带，彻底打断累积链
 */

import net from 'node:net';
import fs from 'node:fs/promises';
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
    hp?: number;
    hp_max?: number;
    mp?: number;
    mp_max?: number;
    neili?: number;
    jing?: number;
    jing_max?: number;
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
  };
  runtime: {
    clearInitialNoiseMs: number;
    monitorPort: number;
    manualHoldMs: number;
  };
};

/** pi-coding-agent session 对象（库未导出 type 时用 any） */
type AgentSession = any;

type RouteStep = string | { cmd: string; waitMs?: number };

type KnownRoute = {
  from: string;
  to: string;
  directions?: string[];
  commands?: RouteStep[];
  requirements?: string[];
  notes?: string;
};

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.resolve(ROOT_DIR, 'gateway.config.json');
const SKILLS_DIR = path.resolve(ROOT_DIR, 'skills');

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
  },
  runtime: {
    clearInitialNoiseMs: 1800,
    monitorPort: 8099,
    manualHoldMs: 10_000,
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
  shaolin_chufang_to_riverbank_for_water_job: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '汉水岸边 /d/shaolin/riverbank',
    commands: [
      'south', 'south', 'east',
      'south', 'south', 'southdown', 'south',
      'open gate',
      'south',
      'south', 'southdown', 'southdown', 'southdown', 'westdown',
      'west', 'southdown', 'southdown', 'southdown', 'eastdown', 'southdown', 'southdown',
      'east', 'south', 'south', 'south',
      'west',
    ],
    requirements: ['少林僧人可从正门出寺；若在寺外或门已关，open gate 失败通常不影响后续 south 尝试。'],
    notes: '去河边不要走挑水山路；从正门下山到汉水北岸，再 west 到汉水岸边。',
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
  shaolin_water_return_shanlu_to_chufang_via_up: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'up',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      'knock gate', 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 up', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。',
  },
  shaolin_water_return_shanlu_to_chufang_via_westup: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'westup',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      'knock gate', 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 westup', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。',
  },
  shaolin_water_return_shanlu_to_chufang_via_northwest: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'northwest',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      'knock gate', 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 northwest', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。',
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

function summarizeEvents(events: Array<{ type: string; content: string; timestamp: number }>, limit = 8) {
  return events.slice(-limit).map((e) => e.content).join('\n');
}

function detectStopReason(events: Array<{ type: string; content: string; timestamp: number }>): string | null {
  const qi = state.world.player.hp;
  const qiMax = state.world.player.hp_max;
  if (typeof qi === 'number' && typeof qiMax === 'number' && qiMax > 0 && qi / qiMax < 0.3) {
    return 'low_qi';
  }

  const jing = state.world.player.jing;
  const jingMax = state.world.player.jing_max;
  if (typeof jing === 'number' && typeof jingMax === 'number' && jingMax > 0 && jing / jingMax < 0.3) {
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

// ---------------------------------------------------------------------------
// FluffOS text parser → WorldSummary
// ---------------------------------------------------------------------------

function parseFluffosText(raw: string) {
  const text = raw.replace(/\r/g, '');
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);

  // 房间标题启发
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*[-－]\s*(.+)$/);
    if (m) {
      state.world.location.name = m[1].trim();
      state.world.location.area = m[2].trim();
      break;
    }
  }

  // 出口
  const exitsLine = lines.find((l) => /这里(?:明显的出口|唯一的出口)是|(?:明显的出口|出口)[有是]?[:：]/.test(l));
  if (exitsLine) {
    const m =
      exitsLine.match(/这里(?:明显的出口|唯一的出口)是\s*(.+?)(?:。|$)/) ||
      exitsLine.match(/(?:明显的出口|出口)[有是]?[:：]\s*(.+)$/);
    if (m) {
      const exitText = m[1].replace(/和/g, '、').replace(/[。；;]/g, '');
      state.world.location.exits = Array.from(
        new Set(exitText.split(/[、,，\s]+/).map(normalizeDirection).filter(Boolean))
      );
    }
  }

  // 战斗
  if (/战斗|你对|你被|招架|闪避|躲开|击中/.test(text)) {
    state.world.player.combat = true;
  } else if (/战斗结束|胜利|失败|逃离/.test(text)) {
    state.world.player.combat = false;
  }

  // HP
  const hp = text.match(/(?:气血|HP)[:：]\s*(\d+)\s*\/\s*(\d+)/i);
  if (hp) {
    state.world.player.hp = Number(hp[1]);
    state.world.player.hp_max = Number(hp[2]);
  }

  // MP / 内力
  const mp = text.match(/(?:内力|MP|mana)[:：]\s*(\d+)\s*\/\s*(\d+)/i);
  if (mp) {
    state.world.player.neili = Number(mp[1]);
  }

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
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

async function saveCheckpoint(config: GatewayConfig) {
  const cp: RuntimeCheckpoint = {
    agent_id: 'pi-mud-agent-v2.5',
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
3) 普通局部行动回合才调用 execute_command_sequence()，一次提交 4-5 条命令，让 Gateway 本地循环快速执行。
3) 遇到战斗或低血（HP < 30%），优先保命：恢复/撤离/防御。
4) 关键转折时调用 save_checkpoint()。
5) 小步快跑策略：观察 → execute_route_skill 或 execute_command_sequence(4-5条) → 再观察。
6) 探图时优先调用 get_known_routes()；有 commands 的路线用 execute_route_skill，有 directions 的路线再用 follow_path。
7) 不要在命令序列里反复 look；只在当前位置未知、出口未知、或路线结束后需要校验时使用 look。
8) 不要用 send_command 连续单发代替 execute_command_sequence；除非只需要一条信息命令。
9) 普通观察调用 wait_event() 时不要传 timeoutMs，使用默认短等待；除非刚执行了明确需要长等待的动作，否则不要传 1000ms 这类长等待。
10) 少林挑水任务优先读取 skill shaolin-water-carrying；执行时使用 shaolin_fzlou_accept_water_job / shaolin_chufang_prepare_water_tools / shaolin_chufang_to_riverbank_for_water_job / shaolin_water_fill_bucket_at_riverbank / shaolin_water_return_* / shaolin_chufang_finish_water_job。
11) 长渡船、busy、挑水 yao/dao 等等待必须放进 execute_route_skill 的 per-step waitMs，不要用 wait_event 长等。
`.trim();
}

async function createSession(config: GatewayConfig, tools: Tool[]): Promise<AgentSession> {
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
    if (event.type !== 'message_update') return;
    const asm = event.assistantMessageEvent;
    if (asm?.type === 'text_delta') {
      process.stdout.write(asm.delta);
    }
  });

  return session;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = await loadConfig();

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
        manualUntil: collab.manualUntil,
        steeringPrompt: collab.steeringPrompt,
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
          collab.steeringPrompt = String(m.prompt || '').trim();
          collab.steeringUpdatedAt = Date.now();
          broadcast({ type: 'log', data: `steering: ${collab.steeringPrompt || '(cleared)'}` });
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
        }),
      }],
      details: {},
    }),
  };

  /**
   * execute_command_sequence: LLM 一次生成 4-5 条命令，Gateway 本地快速执行
   */
  const executeCommandSequenceTool: Tool = {
    name: 'execute_command_sequence',
    label: 'execute_command_sequence',
    description: '一次提交4到5条MUD命令，Gateway会按150ms左右间隔本地执行；每步直接返回MUD原文rawText/rawEvents，不调用LLM摘要。',
    parameters: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          items: { type: 'string' },
          minItems: 4,
          maxItems: 5,
          description: '4到5条命令，例如 ["hp", "east", "southeast", "south"] 或 ["east", "southeast", "south", "west", "hp"]',
        },
        stepWaitMs: {
          type: 'number',
          description: '每条命令后等待MUD响应的毫秒数，默认150，范围80-500。',
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
        .slice(0, 5);

      if (commands.length < 4) {
        return {
          content: [{ type: 'text', text: 'Error: commands must contain 4 to 5 non-empty commands.' }],
          details: { commands },
        };
      }

      const stepWaitMs = Math.max(80, Math.min(500, Number(params?.stepWaitMs || 150)));
      const steps: Array<{ step: number; cmd: string; rawEvents: string[]; rawText: string; stopReason?: string }> = [];
      let stopReason = '';

      state.phase = 'ACT';
      console.log(`[Agent] sequence start: ${commands.length} command(s), ${stepWaitMs}ms interval`);
      broadcast({ type: 'log', data: `agent sequence start: ${commands.length} command(s), ${stepWaitMs}ms interval` });

      for (const [index, cmd] of commands.entries()) {
        if (Date.now() < collab.manualUntil) {
          stopReason = 'manual_control_active';
          break;
        }

        mud.write(cmd + '\n');
        state.pendingActions.push(`seq:${cmd}`);
        console.log(`[Agent] sequence ${index + 1}/${commands.length} -> ${cmd}`);
        broadcast({ type: 'log', data: `agent sequence ${index + 1}/${commands.length} → ${cmd}` });
        await sleep(stepWaitMs);

        const events = [...state.eventQueue];
        state.eventQueue.length = 0;
        const stop = detectStopReason(events);
        const rawEvents = events.map((e) => e.content);
        steps.push({
          step: index + 1,
          cmd,
          rawEvents,
          rawText: rawEvents.join('\n'),
          ...(stop ? { stopReason: stop } : {}),
        });

        state.world.events.recent = events.slice(-config.agent.maxRecentEvents).map((e) => ({
          type: e.type,
          text: e.content,
          timestamp: e.timestamp,
        }));

        if (stop && stop !== 'combat_or_damage') {
          stopReason = stop;
          break;
        }
      }

      state.pendingActions = [];
      state.phase = 'OBSERVE';
      console.log(`[Agent] sequence done: ${steps.length}/${commands.length}${stopReason ? `, stopped=${stopReason}` : ''}`);
      broadcast({ type: 'log', data: `agent sequence done: ${steps.length}/${commands.length}${stopReason ? `, stopped=${stopReason}` : ''}` });

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
   * execute_route_skill: 执行预先调查好的长路线，避免 LLM 每 4-5 步重新规划
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
        maxSteps: { type: 'number', description: '最多执行多少步，默认执行完整路线。用于测试时可设为4到5。' },
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
      const steps: Array<{ step: number; cmd: string; waitMs: number; rawEvents: string[]; rawText: string; stopReason?: string }> = [];
      let stopReason = '';

      state.phase = 'ACT';
      console.log(`[Agent] route ${name} start: ${route.from} -> ${route.to}, ${maxSteps}/${route.commands.length} step(s)`);
      broadcast({ type: 'log', data: `route ${name} start: ${route.from} -> ${route.to}, ${maxSteps}/${route.commands.length} step(s)` });

      for (const [index, rawStep] of route.commands.slice(0, maxSteps).entries()) {
        if (Date.now() < collab.manualUntil) {
          stopReason = 'manual_control_active';
          break;
        }

        const step = typeof rawStep === 'string' ? { cmd: rawStep } : rawStep;
        const cmd = step.cmd.trim();
        const waitMs = Math.max(100, Math.min(60_000, Number(step.waitMs || defaultWaitMs)));
        if (!cmd) continue;

        mud.write(cmd + '\n');
        state.pendingActions.push(`route:${name}:${cmd}`);
        console.log(`[Agent] route ${name} ${index + 1}/${route.commands.length} -> ${cmd}; wait ${waitMs}ms`);
        broadcast({ type: 'log', data: `route ${name} ${index + 1}/${route.commands.length} → ${cmd}${waitMs > defaultWaitMs ? `; wait ${waitMs}ms` : ''}` });
        await sleep(waitMs);

        const events = [...state.eventQueue];
        state.eventQueue.length = 0;
        const stop = detectStopReason(events);
        const rawEvents = events.map((e) => e.content);
        steps.push({
          step: index + 1,
          cmd,
          waitMs,
          rawEvents,
          rawText: rawEvents.join('\n'),
          ...(stop ? { stopReason: stop } : {}),
        });

        state.world.events.recent = events.slice(-config.agent.maxRecentEvents).map((e) => ({
          type: e.type,
          text: e.content,
          timestamp: e.timestamp,
        }));

        if (stop && stop !== 'combat_or_damage') {
          stopReason = stop;
          break;
        }
      }

      state.pendingActions = [];
      state.phase = 'OBSERVE';
      console.log(`[Agent] route ${name} done: ${steps.length}/${route.commands.length}${stopReason ? `, stopped=${stopReason}` : ''}`);
      broadcast({ type: 'log', data: `route ${name} done: ${steps.length}/${route.commands.length}${stopReason ? `, stopped=${stopReason}` : ''}` });

      const result = {
        msg: stopReason ? `stopped: ${stopReason}` : 'completed',
        route: { name, from: route.from, to: route.to, notes: route.notes, requirements: route.requirements || [] },
        requestedSteps: maxSteps,
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
   * follow_path: 一次 LLM 决策内连续小步探图，内部每步观察并按安全规则停止
   */
  const followPathTool: Tool = {
    name: 'follow_path',
    label: 'follow_path',
    description: '按方向数组连续探图。最多 10 步，每步等待 MUD 输出并直接返回原文rawText/rawEvents；遇到危险、卡路、低血、人工接管会停止。',
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
          description: '最多执行步数，默认 3，硬上限 10',
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

      const maxSteps = Math.max(1, Math.min(10, Number(params?.maxSteps || 5)));
      const stepWaitMs = Math.max(80, Math.min(300, Number(params?.stepWaitMs || config.agent.followPathStepWaitMs)));
      const steps: Array<{ step: number; direction: string; rawEvents: string[]; rawText: string; stopReason?: string }> = [];
      let stopReason = '';

      state.phase = 'ACT';

      for (const direction of directions.slice(0, maxSteps)) {
        if (Date.now() < collab.manualUntil) {
          stopReason = 'manual_control_active';
          break;
        }

        mud.write(direction + '\n');
        state.pendingActions.push(direction);
        console.log(`[Agent] follow_path -> ${direction}; wait ${stepWaitMs}ms`);
        broadcast({ type: 'log', data: `agent follow_path → ${direction}` });
        await sleep(stepWaitMs);

        const events = [...state.eventQueue];
        state.eventQueue.length = 0;
        const stop = detectStopReason(events);
        const rawEvents = events.map((e) => e.content);
        steps.push({
          step: steps.length + 1,
          direction,
          rawEvents,
          rawText: rawEvents.join('\n'),
          ...(stop ? { stopReason: stop } : {}),
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

  const ALL_TOOLS: Tool[] = [
    sendCommandTool,
    waitEventTool,
    getWorldSummaryTool,
    getRuntimeStateTool,
    executeCommandSequenceTool,
    getKnownRoutesTool,
    executeRouteSkillTool,
    followPathTool,
    saveCheckpointTool,
  ];

  // ---- Wait for MUD connection --------------------------------------------

  await connectPromise;

  // ---- Recovery from checkpoint ------------------------------------------

  const old = await loadCheckpoint(config);
  if (old) {
    state.phase = 'RECOVER';
    state.turn = Math.max(1, old.turn);
    state.world.meta.tick = old.last_tick || 0;
    state.world.player.combat = old.world.combat;
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

  let session = await createSession(config, ALL_TOOLS);

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
      session = await createSession(config, ALL_TOOLS);

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

    if (isFirst) {
      // 第一回合：如果有 memorySummary（来自 checkpoint），注入它
      if (state.memorySummary) {
        prompt = [
          `【恢复运行 - 记忆摘要】`,
          state.memorySummary,
          '',
          '连接已就绪。先调用 wait_event() 确认当前环境，再继续任务。',
        ].join('\n');
      } else {
        prompt = '连接已建立。先调用 wait_event() 观察初始环境；若要去少林/扬州等已知地点，调用 get_known_routes() 后用 execute_route_skill()。局部行动才调用一次 execute_command_sequence()。';
      }
    } else {
      prompt = [
        `第 ${state.turn} 回合：先观察（wait_event/get_world_summary）。`,
        '若目标是少林/扬州往返或其它已知路线，调用 get_known_routes() 后只调用一次 execute_route_skill()。',
        '若只是局部探索，再只调用一次 execute_command_sequence()，一次性提交4到5条命令。',
        '命令序列不要反复 look；只有位置/出口未知或路线结束校验时才 look。不要逐条调用 send_command。',
      ].join('\n');
    }

    // 注入人类 steering prompt
    if (collab.steeringPrompt) {
      prompt += `\n\n【人类临时策略】${collab.steeringPrompt}\n请优先执行，但仍需保证生存安全。`;
    }

    try {
      await session.prompt(prompt);
    } catch (err: any) {
      const msg = String(err?.message || err);
      console.error('[Gateway] agent error:', msg);
      state.phase = 'RECOVER';
      // 如果是认证问题，等待后重试
      if (msg.includes('Authentication') || msg.includes('API key')) {
        console.log('[Gateway] Auth error, waiting 20s...');
        await sleep(20_000);
      }
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
