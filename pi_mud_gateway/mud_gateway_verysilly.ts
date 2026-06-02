/**
 * FluffOS MUD Gateway v3.0 (Pi Agent)
 *
 * 改进点（相比原版 mud_gateway.ts）：
 * 1. Session 周期性重建（compactMemory），彻底解决历史上下文无限增长问题
 * 2. compactMemory 用一次独立 LLM 调用生成摘要，新 session 只带摘要启动
 * 3. 保留 WorldSummary / AgentPhase / Checkpoint / 人类协作
 * 4. CompactMemory 本身的 token 消耗最小化（专用短 system prompt）
 * 5. 保持与 monitor.html 的 WebSocket 接口兼容
 *
 * Token 模型：
 *   - 每 COMPACT_EVERY_TURNS 轮，session 被销毁重建
 *   - 新 session context = system_prompt + memory_summary + 当前 WorldSummary
 *   - 历史对话不携带，彻底打断累积链
 */

import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
    createAgentSession,
    SessionManager,
    DefaultResourceLoader,
    Tool
} from '@mariozechner/pi-coding-agent';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentPhase = 'BOOT' | 'WAIT' | 'OBSERVE' | 'PLAN' | 'ACT' | 'COMPACT' | 'RECOVER';

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
    memory_summary: string;
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
        compactEveryTurns: number;
        compactKeepRecentEvents: number;
    };
    runtime: {
        clearInitialNoiseMs: number;
        monitorPort: number;
        manualHoldMs: number;
    };
};

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
        compactEveryTurns: 10,
        compactKeepRecentEvents: 15,
    },
    runtime: {
        clearInitialNoiseMs: 1800,
        monitorPort: 8081,
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
    memorySummary: '',
    toolCallCount: 0,  // 跟踪本回合工具调用次数

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
// Module-level references (initialized in main())
// ---------------------------------------------------------------------------

let mud: net.Socket;
let config: GatewayConfig;
let broadcast: (payload: any) => void;

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

// 清理 MUD 发送的元数据标记（HTML 注释格式）
function cleanMudMetadata(text: string): string {
    // 移除心跳标记
    let cleaned = text.replace(/<!--MUD_HB-->/g, '');

    // 移除状态标记并更新 state
    const statusMatch = text.match(/<!--MUD_STATUS:(\{.*?\})-->/);
    if (statusMatch) {
        try {
            const st = JSON.parse(statusMatch[1]);
            if (st.qi !== undefined) {
                state.world.player.hp = st.qi;
                state.world.player.hp_max = st.max_qi;
            }
            if (st.jing !== undefined) {
                state.world.player.jing = st.jing;
                state.world.player.jing_max = st.max_jing;
            }
            if (st.neili !== undefined) {
                state.world.player.neili = st.neili;
            }
        } catch (e) { }
        cleaned = cleaned.replace(/<!--MUD_STATUS:\{.*?\}-->/g, '');
    }

    // 移除 HP 标记
    cleaned = cleaned.replace(/<!--MUD_HP:\{.*?\}-->/g, '');

    // 移除敌方 HP 标记
    cleaned = cleaned.replace(/<!--MUD_ENEMY_HP:\{.*?\}-->/g, '');

    // 移除 ANSI 转义码
    cleaned = cleaned.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
    cleaned = cleaned.replace(/\x1B\][^\x07]*\x07/g, '');

    // 清理空行
    cleaned = cleaned.replace(/^\s*\n/gm, '');

    return cleaned;
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
    // 先清理元数据标记
    const text = cleanMudMetadata(raw).replace(/\r/g, '');
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
    // 窗口限制
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
        agent_id: 'pi-mud-agent-v3.0',
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
        memory_summary: state.memorySummary,
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
// compactMemory
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

    const compactLoader = new DefaultResourceLoader({
        systemPromptOverride: () => COMPACT_SYSTEM_PROMPT,
        appendSystemPromptOverride: () => [],
    });
    await compactLoader.reload();

    const { session: compactSession } = await createAgentSession({
        resourceLoader: compactLoader,
        sessionManager: SessionManager.inMemory(),
    });

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
        summary = JSON.stringify({ fallback: true, world: state.world.player, location: state.world.location });
    }

    console.log('[Compact] Summary generated:', summary.slice(0, 120), '...');
    return summary;
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

function buildSystemPrompt(config: GatewayConfig): string {
    return `
你是一个 FluffOS MUD 游戏代理。你必须通过工具与游戏交互。

## 可用工具
- send_command(cmd): 发送命令到 MUD（如 look, score, go north, kill npc 等）
- wait_event(timeoutMs): 等待服务器响应，返回事件列表
- get_world_summary(): 获取当前世界状态（位置、HP、出口等）
- save_checkpoint(): 保存当前进度
- shaolin_fetch_water(): 执行少林挑水任务

## 强制规则
1. 每回合必须先调用 send_command("look") 观察环境
2. 发送命令后必须调用 wait_event() 获取结果
3. 不要只说话不行动，必须调用工具
4. 遇到战斗或低血（HP < 30%），优先保命

## 典型回合流程
1. send_command("look") → wait_event() → 分析结果
2. send_command("score") → wait_event() → 查看状态  
3. 根据情况决定下一步行动（移动/战斗/交互）

登录信息：id=${config.auth.id} password=${config.auth.password}
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

    session.subscribe((event: any) => {
        // 打印所有事件用于调试
        // console.log('[Debug] Session event:', JSON.stringify(event).slice(0, 200));

        if (event.type === 'message_update') {
            const asm = event.assistantMessageEvent;
            if (asm?.type === 'text_delta') {
                process.stdout.write(asm.delta);
            }
        }

        // 监听工具调用开始
        if (event.type === 'tool_call_start') {
            console.log('[Debug] Tool call started:', event.toolCall?.name);
            state.toolCallCount++;
        }

        // 监听工具调用结束
        if (event.type === 'tool_call_end') {
            console.log('[Debug] Tool call ended:', event.toolCall?.name);
        }
    });

    return session;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    config = await loadConfig();

    // ---- MUD TCP 连接 --------------------------------------------------------

    mud = new net.Socket();
    let isConnecting = false;
    let firstConnected = false;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let connectResolve: (() => void) | null = null;
    let connectReject: ((e: any) => void) | null = null;

    // ---- WebSocket 监控 ------------------------------------------------------

    const wss = new WebSocketServer({ host: '127.0.0.1', port: config.runtime.monitorPort });
    console.log(`[Gateway] monitor WebSocket → ws://127.0.0.1:${config.runtime.monitorPort}`);

    broadcast = (payload: any) => {
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
        ws.send(JSON.stringify({ type: 'hello', version: '3.0' }));
        sendStateSnapshot();

        ws.on('message', (raw) => {
            try {
                const msgStr = String(raw);

                // 处理 action: 命令（兼容 monitor.html）
                if (msgStr.startsWith('action:')) {
                    const cmd = msgStr.substring(7).trim();
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

                // 处理 strategy: 策略（兼容 monitor.html）
                if (msgStr.startsWith('strategy:')) {
                    const strategy = msgStr.substring(9).trim();
                    collab.steeringPrompt = strategy;
                    collab.steeringUpdatedAt = Date.now();
                    broadcast({ type: 'log', data: `steering: ${strategy || '(cleared)'}` });
                    sendStateSnapshot();
                    return;
                }

                // 处理 JSON 格式消息
                const m = safeJsonParse<any>(msgStr, null);
                if (!m?.type) return;

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

            // 清理 MUD 元数据标记后再发送给 monitor
            const cleanedRaw = cleanMudMetadata(raw);
            broadcast({ type: 'mud_data', data: cleanedRaw });

            for (const line0 of cleanedRaw.split('\n')) {
                const line = line0.trim();
                if (!line) continue;
                state.eventQueue.push({ type: 'text', content: line, timestamp: Date.now() });
            }

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

    // ---- Tool definitions -----------------------------------------------------

    const sendCommandTool: Tool = {
        name: 'send_command',
        label: 'send_command',
        description: '向 MUD 发送命令（look/score/go north/kill xxx 等）。命令发送后请等待获取响应。',
        parameters: {
            type: 'object',
            properties: { cmd: { type: 'string', description: '要发送的命令字符串' } },
            required: ['cmd'],
        },
        execute: async (_id, params) => {
            const cmd = String(params?.cmd || '').trim();
            console.log(`[Tool] send_command called: "${cmd}"`);
            state.toolCallCount++;
            if (!cmd) return { content: [{ type: 'text', text: 'Error: empty command.' }], details: {} };
            if (!state.connected) {
                console.log(`[Tool] send_command failed: not connected`);
                return { content: [{ type: 'text', text: 'Error: not connected.' }], details: {} };
            }

            if (Date.now() < collab.manualUntil && !isInfoCommand(cmd)) {
                console.log(`[Tool] send_command paused: manual control active`);
                return { content: [{ type: 'text', text: 'Paused: manual control active.' }], details: {} };
            }

            mud.write(cmd + '\n');
            state.phase = 'ACT';
            state.pendingActions.push(cmd);
            broadcast({ type: 'log', data: `agent → ${cmd}` });
            console.log(`[Tool] send_command sent: "${cmd}"`);

            return {
                content: [{ type: 'text', text: `OK: sent "${cmd}"` }],
                details: { cmd },
            };
        },
    };

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
            console.log(`[Tool] wait_event called`);
            state.toolCallCount++;
            const timeoutMs = Number(params?.timeoutMs || config.agent.waitEventDefaultMs);
            state.phase = 'WAIT';
            await sleep(timeoutMs);

            const events = [...state.eventQueue];
            state.eventQueue.length = 0;
            console.log(`[Tool] wait_event got ${events.length} events`);

            let result = events;
            let msg = 'OK';
            if (events.length > config.agent.maxRecentEvents) {
                result = events.slice(-config.agent.maxRecentEvents);
                msg = `Truncated to latest ${config.agent.maxRecentEvents} lines.`;
            }

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

    // ---- Helper: 方向反转 ----
    function reverseDirections(cmd: string): string {
        const map: Record<string, string> = {
            n: 's', s: 'n', e: 'w', w: 'e',
            u: 'd', d: 'u',
            north: 'south', south: 'north',
            east: 'west', west: 'east',
            up: 'down', down: 'up'
        };
        return map[cmd] ?? cmd;
    }

    // ---- Helper: 运行命令批次 ----
    async function runCommandBatch(commands: string[], waitMs: number = 450): Promise<string[]> {
        const outputs: string[] = [];
        for (const cmd of commands) {
            const output = await runMudCommand(cmd, waitMs);
            outputs.push(`$ ${cmd}\n${output}`);
        }
        return outputs;
    }

    // ---- Helper: 运行单个 MUD 命令 ----
    async function runMudCommand(cmd?: string, waitMs: number = 600): Promise<string> {
        if (!state.connected) {
            return "Failed. Not connected to MUD.";
        }

        if (cmd && cmd.trim()) {
            const command = cmd.trim();
            console.log(`[Pi -> MUD]: ${command}`);
            broadcast({ type: 'log', data: `> [Agent] ${command}` });
            mud.write(command + '\n');
        }

        await sleep(waitMs);

        const events = [...state.eventQueue];
        state.eventQueue.length = 0;

        const resultEvents = events.length > 80 ? events.slice(-80) : events;
        if (resultEvents.length === 0) {
            return "No immediate response from server.";
        }

        return resultEvents.map(e => e.content).join("\n");
    }

    // ---- 少林挑水任务工具 ----
    const shaolinFetchWaterTool: Tool = {
        name: 'shaolin_fetch_water',
        description: "Execute the Shaolin water-carry task quickly: get bucket/dipper, fetch water 5 times, pour to bucket, and submit to shaofan.",
        parameters: {
            type: 'object',
            properties: {
                route: {
                    type: 'string',
                    enum: ['hanriver', 'well'],
                    description: "Water source route. hanriver goes south down the mountain; well skips the long travel if the back-hall well is usable."
                },
                southSteps: {
                    type: 'integer',
                    description: "How many south moves to reach Han river. Used only when route=hanriver. Default 6."
                },
                returnSteps: {
                    type: 'integer',
                    description: "How many north moves to return from Han river. Default equals southSteps."
                }
            }
        },
        execute: async (_toolCallId: string, params: any) => {
            console.log(`\n[Agent Tool] shaolin_fetch_water(${JSON.stringify(params)})`);
            if (!state.connected) {
                return { content: [{ type: 'text', text: 'Failed. Not connected to MUD.' }], details: {} };
            }

            const route = params?.route === 'well' ? 'well' : 'hanriver';
            const southSteps = Number.isInteger(params?.southSteps) ? Math.max(1, params.southSteps) : 6;
            const returnSteps = Number.isInteger(params?.returnSteps) ? Math.max(1, params.returnSteps) : southSteps;

            const prelude = [
                'ask zhike about 挑水',
                'ask shaofan about 水桶',
                'ask shaofan about 水瓢'
            ];

            const toWater = route === 'well'
                ? ['look']
                : Array.from({ length: southSteps }, () => 's');

            const fetchAndPour = [
                ...Array.from({ length: 5 }, () => 'yao shui'),
                'putdown tong',
                ...Array.from({ length: 5 }, () => 'dao shui to tong')
            ];

            const backTrack = route === 'well'
                ? []
                : Array.from({ length: returnSteps }, () => reverseDirections('s'));

            const submit = ['give shui tong to shaofan'];

            const allCommands = [...prelude, ...toWater, ...fetchAndPour, ...backTrack, ...submit];
            const outputs = await runCommandBatch(allCommands, 450);

            const summary = [
                `shaolin_fetch_water done. route=${route}, southSteps=${southSteps}, returnSteps=${returnSteps}`,
                'If submit failed, adjust southSteps/returnSteps and retry, or switch route=well.',
                '--- command log ---',
                ...outputs
            ].join('\n\n');

            return { content: [{ type: 'text', text: summary }], details: {} };
        }
    };

    const ALL_TOOLS: Tool[] = [
        sendCommandTool,
        waitEventTool,
        getWorldSummaryTool,
        getRuntimeStateTool,
        saveCheckpointTool,
        shaolinFetchWaterTool,
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
        state.memorySummary = old.memory_summary || '';
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
    // ---------------------------------------------------------------------------

    while (true) {
        // 等待 streaming 完成，最多等待 30 秒
        let streamingWait = 0;
        while (session.isStreaming && streamingWait < 30000) {
            await sleep(300);
            streamingWait += 300;
        }
        if (session.isStreaming) {
            console.warn('[Gateway] Session still streaming after 30s, proceeding anyway');
        }

        // 重置 phase：RECOVER → OBSERVE，其他情况 → PLAN
        if (state.phase === 'RECOVER') {
            state.phase = 'OBSERVE';
        } else {
            state.phase = 'PLAN';
        }

        // 重置工具调用计数
        state.toolCallCount = 0;

        console.log(`\n\n========== Turn ${state.turn} [${state.phase}] ==========`);

        // ---- COMPACT（session 重建）----
        const shouldCompact =
            state.turn > 1 &&
            state.turn % config.agent.compactEveryTurns === 0;

        if (shouldCompact) {
            state.phase = 'COMPACT';
            broadcast({ type: 'log', data: `[COMPACT] turn ${state.turn}: rebuilding session...` });
            console.log(`[COMPACT] Starting compact for turn ${state.turn}`);

            try {
                // 1. 生成记忆摘要
                state.memorySummary = await compactMemory(session, config);

                // 2. 压缩 world.events.recent
                if (state.world.events.recent.length > config.agent.compactKeepRecentEvents) {
                    state.world.events.recent = state.world.events.recent.slice(-config.agent.compactKeepRecentEvents);
                }

                // 3. 保存 checkpoint（带新摘要）
                await saveCheckpoint(config);

                // 4. 销毁旧 session，创建全新 session
                session = await createSession(config, ALL_TOOLS);

                // 5. 新 session 首 prompt：注入摘要 + 当前 WorldSummary
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
                    '请根据以上信息继续游戏，先观察当前环境。',
                ].join('\n');

                broadcast({ type: 'log', data: '[COMPACT] session rebuilt, resuming...' });
                console.log('[COMPACT] New session started with memory summary.');

                await session.prompt(resumePrompt);
            } catch (e: any) {
                console.error('[COMPACT] Error during compact:', e?.message || e);
                // 即使出错也要继续，创建新 session
                try {
                    session = await createSession(config, ALL_TOOLS);
                } catch (e2: any) {
                    console.error('[COMPACT] Failed to create new session:', e2?.message || e2);
                }
            }

            state.turn += 1;
            state.phase = 'PLAN';
            await sleep(config.agent.turnIntervalMs);
            continue;
        }

        // ---- 普通回合 prompt ----
        const isFirst = state.turn === 1;
        let prompt: string;

        // 构建当前状态摘要
        const recentEvents = state.world.events.recent.slice(-5).map(e => e.text);
        console.log(`[Debug] Recent events: ${recentEvents.length} items`);

        const worldContext = JSON.stringify({
            location: state.world.location,
            player: {
                hp: state.world.player.hp,
                hp_max: state.world.player.hp_max,
                neili: state.world.player.neili,
                combat: state.world.player.combat,
                busy: state.world.player.busy,
            },
            recentEvents: recentEvents,
        }, null, 2);

        console.log(`[Debug] World context for prompt:\n${worldContext}`);

        if (isFirst) {
            if (state.memorySummary) {
                prompt = [
                    `【恢复运行 - 记忆摘要】`,
                    state.memorySummary,
                    '',
                    '连接已就绪。',
                    '',
                    '请立即调用工具：',
                    '1. send_command("look") 观察环境',
                    '2. wait_event() 获取结果',
                ].join('\n');
            } else {
                prompt = `连接已建立。

请立即调用工具开始游戏：
1. send_command("look") 观察环境
2. wait_event() 获取结果
3. 不要只输出文字，必须调用工具！`;
            }
        } else {
            prompt = `第 ${state.turn} 回合。

当前状态：
${worldContext}

请立即调用工具行动：
1. 先 send_command("look") 观察环境
2. 然后 wait_event() 获取结果
3. 不要只输出文字，必须调用工具！`;
        }

        // 注入人类 steering prompt
        if (collab.steeringPrompt) {
            prompt += `\n\n【人类临时策略】${collab.steeringPrompt}\n请优先执行，但仍需保证生存安全。`;
        }

        try {
            console.log(`[Gateway] Sending prompt for turn ${state.turn}...`);
            console.log(`[Debug] Event queue length: ${state.eventQueue.length}`);
            console.log(`[Debug] Prompt length: ${prompt.length} chars`);

            // 调用 prompt 并等待工具执行完成
            await session.prompt(prompt);

            // 等待工具执行完成（最多等待 10 秒）
            console.log('[Gateway] Waiting for tool execution...');
            let waitCount = 0;
            while (waitCount < 20) {
                await sleep(500);
                // 检查是否有新事件（说明工具有输出）
                if (state.eventQueue.length > 0) {
                    console.log('[Gateway] Tool executed, events received.');
                    break;
                }
                waitCount++;
            }
            if (waitCount >= 20) {
                console.log('[Gateway] Warning: No events received after tool call.');
            }

            console.log(`[Gateway] Prompt completed for turn ${state.turn}`);

            // 检查是否有工具调用
            console.log(`[Debug] Tool calls this turn: ${state.toolCallCount}`);

            // 打印 agent 响应摘要
            const messages = session.messages ?? [];
            console.log(`[Debug] Session messages count: ${messages.length}`);
            const lastAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant');
            if (lastAssistant) {
                const content = typeof lastAssistant.content === 'string'
                    ? lastAssistant.content
                    : JSON.stringify(lastAssistant.content);
                console.log(`[Debug] Agent response preview: ${content.slice(0, 200)}...`);
            }

            // 如果没有调用工具，强制重试一次
            if (state.toolCallCount === 0) {
                console.log('[Gateway] Agent did not call any tool, retrying with stronger prompt...');
                const retryPrompt = `你没有调用任何工具！必须立即行动！

请现在就调用 send_command("look") 观察环境，然后调用 wait_event() 获取结果。
不要只说话不行动！`;

                await session.prompt(retryPrompt);
                console.log(`[Gateway] Retry prompt completed, tool calls: ${state.toolCallCount}`);
            }
        } catch (err: any) {
            const msg = String(err?.message || err);
            console.error('[Gateway] agent error:', msg);
            state.phase = 'RECOVER';
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
