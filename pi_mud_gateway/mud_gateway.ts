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
    const raw = data.toString('utf-8');
    broadcastMonitor(raw);

    const lines = raw.split('\n');
    for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        eventQueue.push({ type: 'text', content: text, timestamp: Date.now() });
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
            connectMud().catch(() => {});
        }
    }, 5000);
});

// 2. Define minimum tools for Pi
const actionTool: Tool = {
    name: "action",
    description: "Send a command to the MUD and automatically wait to return the real-time server response. If cmd is empty, it acts as a pure wait/look. Use this as your primary way to interact and see what happens.",
    parameters: {
        type: "object",
        properties: {
            cmd: { type: "string", description: "The command to send (e.g., 'look', 'n', 'get sword', 'scout'). Leave empty to just wait and observe." }
        }
    },
    execute: async (toolCallId: string, params: any) => {
        console.log(`\n[Agent Tool] action(${JSON.stringify(params)})`);
        if (!currentState.connected) {
            return { content: [{ type: "text", text: "Failed. Not connected to MUD." }], details: {} };
        }
        
        if (params.cmd) {
            console.log(`[Pi -> MUD]: ${params.cmd}`);
            broadcastMonitor(`\x1b[36m> [Agent] ${params.cmd}\x1b[0m\n`);
            mud.write(params.cmd + '\n');
        }

        // Wait slightly longer to let server respond (MUDs are text based and respond quickly, 500-1000ms is enough)
        await new Promise(r => setTimeout(r, 600));
        
        const events = [...eventQueue];
        eventQueue.length = 0; // drain the queue

        let resultEvents = events;
        let msg = "Action completed. Server output retrieved.";
        if (events.length > 80) {
            msg = "Action completed. Output truncated to latest 80 lines.";
            resultEvents = events.slice(-80);
        }
        
        if (resultEvents.length === 0) {
            return { content: [{ type: "text", text: "No immediate response from server. It might be quiet or taking time." }], details: {} };
        }
        
        const textResp = resultEvents.map(e => e.content).join("\n");
        return { 
            content: [{ type: "text", text: textResp }], 
            details: {} 
        };
    }
};

const mudTools = [actionTool];

// 3. Create Pi Session (Long-running loop)
async function startSession() {
    await connectMud();
    console.log("[Gateway] Initializing Agent Session...");

    const loader = new DefaultResourceLoader({
        systemPromptOverride: () => `You are a fully autonomous agent playing a MUD game. 
Your goal is to survive, explore, and report interesting findings.
Core rules:
1. Use the 'action' tool to interact. It sends your command and hands you back the game's text response.
2. Fast iteration: use 'action' up to 3 times per prompt if you need a sequence (like 'look', then 'north', then 'look').
3. If you see a Chinese login prompt or ask for an account:
   - Account 1: user "scout" / password "kvcdi"
   - Account 2: user "roclive" / password "test1234"
4. DO NOT spam empty responses. If you have nothing to do, just use action({}) to wait.
5. Follow the User's Strategy strictly if one is provided in the prompt.

Execute tools directly and think quickly.`,
        appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session } = await createAgentSession({
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        customTools: mudTools
    });

    session.subscribe((event) => {
        if (event.type === "message_update") {
            const asm = event.assistantMessageEvent;
            if (asm.type === "text_delta") {
                process.stdout.write(asm.delta);
            }
        }
    });

    console.log("[Gateway] Loop Started. Waiting for initial events...");
    await new Promise(r => setTimeout(r, 2000));
    console.log(`[Gateway] Skipped ${eventQueue.length} initial messages.`);
    eventQueue.length = 0;

    try {
        let turn = 1;
        while (true) {
            while (session.isStreaming) {
                await new Promise(r => setTimeout(r, 500));
            }

            console.log(`\n\n========== [Gateway] Turn ${turn} ==========`);
            
            let promptText = "";
            if (turn === 1) {
                promptText = "Game started. Connection is ready. Use 'action' to look around or login.";
            } else {
                promptText = "Turn complete. Use 'action' to make your next move or wait. Remember to follow any active strategy.";
            }

            if (activeStrategy) {
                promptText += `\n\nCURRENT STRATEGY: ${activeStrategy}`;
            }

            try {
                await session.prompt(promptText, { streamingBehavior: 'followUp' });
                turn++;
            } catch (err: any) {
                if (err.message && err.message.includes('already processing')) {
                    // ignore
                } else {
                    console.error("\n[Gateway] Unexpected prompt error:", err);
                }
            }

            await new Promise(r => setTimeout(r, 1000));
        }
    } catch (e) {
        console.error("\n[Gateway] Agent error:", e);
    }
}

startSession().catch(err => {
    console.error("[Gateway] Fatal error:", err);
    process.exit(1);
});
