/**
 * Agent Gateway for playing FluffOS MUD using pi-coding-agent.
 * Direct TCP connection (Telnet) to the MUD server (bypassing the browser).
 */

import net from 'node:net';
import { WebSocketServer } from 'ws';
import {
    createAgentSession,
    SessionManager,
    DefaultResourceLoader,
    Tool
} from '@mariozechner/pi-coding-agent';

// MUD Configuration
const MUD_HOST = '127.0.0.1';
const MUD_PORT = 5555; // External port for telnet
const WS_PORT = 8081;   // Port for the web client to connect and observe

// State and event queue
const eventQueue: any[] = [];
const currentState = {
    connected: false,
    hp: null,
    max_hp: null,
    room: null,
    combat: false,
    lastUpdate: Date.now()
};

let activeStrategy: string = "";

// Set up WebSocket Monitor Server
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`[Gateway] Monitor WebSocket Server running on ws://127.0.0.1:${WS_PORT}`);
function broadcastMonitor(msg: string) {
    for (const client of wss.clients) {
        if (client.readyState === 1) { // OPEN
            client.send(msg);
        }
    }
}

wss.on('connection', (ws) => {
    console.log('[Gateway] Monitor client connected.');
    ws.on('message', (message) => {
        const msg = message.toString();
        if (msg.startsWith('strategy:')) {
            activeStrategy = msg.substring(9).trim();
            console.log(`[Gateway] New active strategy received: ${activeStrategy}`);
            broadcastMonitor(`\x1b[35m[System] New strategy set by user: ${activeStrategy}\x1b[0m\n`);
        } else if (msg.startsWith('action:')) {
            // Player sends an action manually from the web client
            const act = msg.substring(7);
            if (currentState.connected) {
                console.log(`[Human -> MUD]: ${act}`);
                broadcastMonitor(`\x1b[32m> [Human] ${act}\x1b[0m\n`);
                mud.write(act + '\n');
            } else {
                ws.send('\x1b[31m[System] Error: MUD is not connected.\x1b[0m\n');
            }
        }
    });
});

// 1. Connect to MUD TCP
const mud = new net.Socket();

function connectMud(): Promise<void> {
    return new Promise((resolve) => {
        console.log(`[Gateway] Connecting to MUD at ${MUD_HOST}:${MUD_PORT}...`);
        mud.connect(MUD_PORT, MUD_HOST, () => {
            console.log(`[Gateway] Connected to MUD.`);
            currentState.connected = true;
            resolve();
        });
    });
}

mud.on('error', (err) => {
    console.error(`[Gateway] MUD Connection Error:`, err.message);
});

mud.on('data', (data) => {
    // Attempt basic structural parsing. FluffOS might send custom telnet/webclient sequences.
    // For standard TCP, we just receive plain text (utf-8).
    const raw = data.toString('utf-8');

    // Broadcast to monitor clients
    broadcastMonitor(raw);

    const lines = raw.split('\n');
    for (const line of lines) {
        const text = line.trim();
        if (!text) continue;

        // Push raw structural/text event to queue
        eventQueue.push({ type: 'text', content: text, timestamp: Date.now() });

        // Very basic heuristic state update
        if (text.includes("HP:")) currentState.combat = true;
    }

    currentState.lastUpdate = Date.now();
});

mud.on('close', () => {
    if (currentState.connected) {
        console.log('[Gateway] MUD connection closed. Will attempt reconnect in 5 seconds...');
    }
    currentState.connected = false;
    setTimeout(() => {
        if (!currentState.connected) {
            connectMud().catch(() => { });
        }
    }, 5000);
});

// 2. Define minimum tools for Pi
const sendCommandTool: Tool = {
    name: "send_command",
    description: "Send a command to the MUD server (e.g., 'look', 'l', 'go east', 'get sword', 'kill bandit'). Use this to navigate or fight.",
    parameters: {
        type: "object",
        properties: {
            cmd: { type: "string", description: "The command string to send" }
        },
        required: ["cmd"]
    },
    execute: async (toolCallId: string, params: any) => {
        if (!currentState.connected) {
            return { content: [{ type: "text", text: "Failed. Not connected to MUD." }], details: {} };
        }
        console.log(`[Pi -> MUD]: ${params.cmd}`);

        // Broadcast the agent's command to the monitor with a distinct color (cyan)
        broadcastMonitor(`\x1b[36m> [Agent] ${params.cmd}\x1b[0m\n`);

        mud.write(params.cmd + '\n');
        return { content: [{ type: "text", text: `Command sent: ${params.cmd}` }], details: {} };
    }
};

const waitEventTool: Tool = {
    name: "wait_event",
    description: "Wait for real-time events from the MUD server (e.g., room descriptions, character quotes, combat text). Essential to read what happened after sending a command.",
    parameters: {
        type: "object",
        properties: {
            timeoutMs: { type: "number", description: "Milliseconds to wait for more events (default 1000)" }
        }
    },
    execute: async (toolCallId: string, params: any) => {
        console.log(`\n[Agent Tool] wait_event(${JSON.stringify(params)})`);
        const timeout = params.timeoutMs || 1000;
        await new Promise(r => setTimeout(r, timeout));
        const events = [...eventQueue];
        eventQueue.length = 0; // drain the queue

        let resultEvents = events;
        let msg = "Events retrieved.";
        if (events.length > 50) {
            msg = "Too many events. Returned latest 50.";
            resultEvents = events.slice(-50);
        }
        return {
            content: [{ type: "text", text: JSON.stringify({ msg, events: resultEvents }) }],
            details: {}
        };
    }
};

const getStateTool: Tool = {
    name: "get_state",
    description: "Get the current structured state (health, connection status, etc.).",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (toolCallId: string) => {
        console.log(`\n[Agent Tool] get_state()`);
        return {
            content: [{ type: "text", text: JSON.stringify(currentState) }],
            details: currentState
        };
    }
};

const mudTools = [sendCommandTool, waitEventTool, getStateTool];

// 3. Create Pi Session (Long-running loop)
async function startSession() {
    await connectMud();
    console.log("[Gateway] Initializing Agent Session...");

    const loader = new DefaultResourceLoader({
        systemPromptOverride: () => `You are a fully autonomous agent playing a MUD game. 
Your goal is to survive, explore, and report interesting findings.
Core rules:
1. ALWAYS use wait_event() first to read the game state safely.
2. Use send_command(cmd) to interact. Common cmds: 'look', 'score', 'inventory', 'help'.
3. Don't spam commands without waiting for events.
4. If you get disconnected, ask wait_event() what happened.
5. If you see a login prompt, YOU MUST login using one of these accounts:
   - Account 1: user "scout" / password "kvcdi"
   - Account 2: user "roclive" / password "test1234"
   DO NOT try to register a new character.

Execute tools repeatedly. Think strategically.`,
        appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session } = await createAgentSession({
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        customTools: mudTools // Register custom mud tools
    });

    // Display reasoning when it streams from Pi
    session.subscribe((event) => {
        if (event.type === "message_update") {
            const asm = event.assistantMessageEvent;
            if (asm.type === "text_delta") {
                process.stdout.write(asm.delta);
            } else if (asm.type === "tool_call") {
                // If you want even more verbose output, you can log every tool choice here natively.
                // console.log(`\n[Pi wants to use tool: ${asm.toolCall.name}]`);
            }
        }
    });

    console.log("[Gateway] Loop Started. Waiting for initial events...");
    await new Promise(r => setTimeout(r, 2000));

    // Clear initial MOTD/welcome noise
    console.log(`[Gateway] Skipped ${eventQueue.length} initial messages.`);
    eventQueue.length = 0;

    // Trigger the Agent
    try {
        let turn = 1;
        while (true) {
            // Ensure agent is totally idle before next prompt
            while (session.isStreaming) {
                await new Promise(r => setTimeout(r, 1000));
            }

            console.log(`\n\n========== [Gateway] Turn ${turn} ==========`);
            let promptText = turn === 1
                ? "Game started. Connection is ready. Use 'wait_event' to see your surroundings. If it is a login prompt, use the predefined accounts (like 'scout' or 'roclive') to log in by using 'send_command'."
                : "Evaluate your situation. Use 'wait_event' to check what happened, use 'send_command' to act, or just think about your next step.";

            if (activeStrategy) {
                promptText += `\n\nIMPORTANT: Follow this active strategy/goal provided by the user: ${activeStrategy}`;
            }

            try {
                await session.prompt(promptText, { streamingBehavior: 'followUp' });
                turn++;
            } catch (err: any) {
                if (err.message && err.message.includes('already processing')) {
                    console.log("[Gateway] Agent is busy, will try again later.");
                } else {
                    console.error("\n[Gateway] Unexpected prompt error:", err);
                }
            }

            // Wait a bit before cycling to next turn
            await new Promise(r => setTimeout(r, 3000));
        }
    } catch (e) {
        console.error("\n[Gateway] Agent error:", e);
    }

    // Cleanup
    mud.destroy();
    wss.close();
    process.exit(0);
}

startSession().catch(err => {
    console.error("[Gateway] Fatal error:", err);
    process.exit(1);
});
