/**
 * FluffOS MUD Gateway v2.5 (Pi Agent)
 *
 * 改进点（相比 v2）：
 * 1. 修复 model 错误（移除不存在的 openai-codex，用 pi 默认 model）
 * 2. Session 周期性重建（compactMemory），彻底解决历史上下文无限增长问题
 * 3. compactMemory 用一次独立 LLM 调用生成摘要，新 session 只带摘要启动
 * 4. 保留全部 v2 特性：WorldSummary / AgentPhase / Checkpoint / 人类协作
 * 5. CompactMemory 本身的 token 消耗最小化（专用短 system prompt）
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

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.resolve(ROOT_DIR, 'gateway.config.json');

const DEFAULT_CONFIG: GatewayConfig = {
  mud: { host: '127.0.0.1', port: 5555, encoding: 'utf-8' },
  auth: {
    id: 'roclive',
    password: 'test1234',
    autoLogin: true,
    loginDelayMs: 900,
  },
  agent: {
    turnIntervalMs: 1500,
    waitEventDefaultMs: 1200,
    checkpointEveryTurns: 1,
    checkpointPath: './checkpoint.json',
    maxRecentEvents: 60,
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
  const exitsLine = lines.find((l) => /(?:明显的出口|出口)[有是]?[:：]/.test(l));
  if (exitsLine) {
    const m = exitsLine.match(/(?:明显的出口|出口)[有是]?[:：]\s*(.+)$/);
    if (m) {
      state.world.location.exits = Array.from(
        new Set(m[1].split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))
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
      const raw = typeof last.content === 'string'
        ? last.content
        : (last.content?.[0]?.text ?? '');
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
1) 每回合先调用 wait_event() 或 get_world_summary() 观察环境再行动。
2) 只在有依据时 send_command()，禁止盲目连发命令。
3) 遇到战斗或低血（HP < 30%），优先保命：恢复/撤离/防御。
4) 关键转折时调用 save_checkpoint()。
5) 小步快跑策略：观察 → 单个动作 → 再观察。
6) 若 wait_event 返回空，不要连续空调用，先等待。
`.trim();
}

async function createSession(config: GatewayConfig, tools: Tool[]): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
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
    try { mud.removeAllListeners(); mud.destroy(); } catch {}
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

      // 人类手动控制期间，非信息类命令被阻断
      if (Date.now() < collab.manualUntil && !isInfoCommand(cmd)) {
        return { content: [{ type: 'text', text: 'Paused: manual control active.' }], details: {} };
      }

      mud.write(cmd + '\n');
      state.phase = 'ACT';
      state.pendingActions.push(cmd);
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
    description: '等待 MUD 服务器响应并返回事件列表。发送命令后必须调用此工具获取结果。',
    parameters: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', description: '等待时长(ms)，默认使用配置值' },
      },
    },
    execute: async (_id, params) => {
      const timeoutMs = Number(params?.timeoutMs || config.agent.waitEventDefaultMs);
      state.phase = 'WAIT';
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
      await sleep(300);
    }

    // ---- 阶段推进 ----
    if (state.phase === 'RECOVER') {
      state.phase = 'OBSERVE';
    } else if (state.phase !== 'COMPACT') {
      state.phase = 'PLAN';
    }

    console.log(`\n\n========== Turn ${state.turn} [${state.phase}] ==========`);

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
        prompt = '连接已建立。先调用 wait_event() 观察初始环境，再进行第一个动作。';
      }
    } else {
      prompt = `第 ${state.turn} 回合：先观察（wait_event/get_world_summary），再小步行动。`;
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
