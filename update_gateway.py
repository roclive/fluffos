import re

with open('pi_mud_gateway/mud_gateway.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add import
if "import { routeDeviation" not in content:
    import_line = "import { routeDeviation, classifyRouteDeviation, routeRecoveryHint, shouldStopRouteForDeviation } from './lib/route_logic.mjs';\n"
    content = content.replace(
        "import { DIRECTION_ALIASES, KNOWN_ROUTES, normalizeDirection, isInfoCommand, summarizeEvents, routeStepCommand, routeStepNote, commandSequenceWaitMs, chooseProgressSkill, detectStopReason, shouldStopBeforeNextCommand, parseStatusLine, cleanMudText, splitCleanMudLines } from './lib/core.mjs';",
        f"import {{ DIRECTION_ALIASES, KNOWN_ROUTES, normalizeDirection, isInfoCommand, summarizeEvents, routeStepCommand, routeStepNote, commandSequenceWaitMs, chooseProgressSkill, detectStopReason, shouldStopBeforeNextCommand, parseStatusLine, cleanMudText, splitCleanMudLines }} from './lib/core.mjs';\n{import_line}"
    )

# 2. Update RuntimeCheckpoint type to include routeState
content = re.sub(
    r'(type RuntimeCheckpoint = \{.*?updated_at: number;\})',
    r'\1\n  routeState?: any;',
    content,
    flags=re.DOTALL
)

# 3. Rewrite executeRouteSkillTool
new_tool = """
  const executeRouteSkillTool: Tool = {
    name: 'execute_route_skill',
    label: 'execute_route_skill',
    description: '按名称执行已知路线skill。支持长路线、渡船等待、丐帮暗道等特殊步骤；每步直接返回MUD原文rawText/rawEvents。支持断点恢复与偏航修复。',
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
          content: [{ type: 'text', text: `Error: route \"${name}\" has no executable commands.` }],
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

      // ---- Breakpoint Recovery ----
      let startIndex = 0;
      if (state.routeState.active && state.routeState.routeName === name) {
        const savedStep = state.routeState.step;
        const expectedId = expectedRoomIdAtStep(name, savedStep);
        const actualId = state.world.location.room_id || null;
        if (expectedId && actualId && expectedId === actualId) {
          console.log(`[Route] Breakpoint recovered: resuming ${name} from step ${savedStep}`);
          startIndex = savedStep;
        } else {
          console.log(`[Route] Breakpoint mismatch or unknown room: restarting ${name}`);
          state.routeState.active = false;
        }
      }

      state.phase = 'ACT';
      console.log(`[Agent] route ${name} start: ${route.from} -> ${route.to}, ${maxSteps}/${route.commands.length} step(s) from step ${startIndex}`);
      broadcast({ type: 'log', data: `route ${name} start: ${route.from} -> ${route.to}, ${maxSteps}/${route.commands.length} step(s) from step ${startIndex}` });
      
      state.routeState = {
        active: true,
        routeName: name,
        from: route.from,
        to: route.to,
        step: startIndex,
        total: maxSteps,
        currentCmd: '',
        expectedStage: `${route.from} -> ${route.to}`,
        expectedCommand: '',
        actualRoom: state.world.location.name || '',
        actualExits: state.world.location.exits || [],
        deviation: '',
        deviationKind: '',
        recoveryHint: '',
        recentActualRooms: [],
        lastLine: '',
        plannedCommands: route.commands.slice(startIndex, maxSteps).map((s, i) => `${startIndex + i + 1}. ${routeStepCommand(s)}${routeStepNote(s) ? ` (${routeStepNote(s)})` : ''}`),
        updatedAt: Date.now(),
      };
      sendStateSnapshot();

      emitTrace({
        phase: 'start',
        kind: 'route',
        name,
        input: {
          from: route.from,
          to: route.to,
          maxSteps,
          totalSteps: route.commands.length,
          startIndex,
          plannedCommands: route.commands.slice(startIndex, maxSteps).map(routeStepCommand),
        },
        keywords: ['skill', 'route', name, route.from, route.to].filter(Boolean),
        resources: [{ type: 'skill', name, query: `${route.from} -> ${route.to}` }],
      });

      for (let i = startIndex; i < maxSteps; i++) {
        const rawStep = route.commands[i];
        if (Date.now() < collab.manualUntil) {
          stopReason = 'manual_control_active';
          const actualRoom = state.world.location.name || '';
          const actualExits = state.world.location.exits || [];
          const recoveryHint = routeRecoveryHint(name, '', stopReason, actualRoom, actualExits);
          state.routeState = {
            ...state.routeState,
            active: false,
            step: i + 1,
            deviation: stopReason,
            deviationKind: stopReason,
            recoveryHint,
            updatedAt: Date.now(),
          };
          sendStateSnapshot();
          emitTrace({
            phase: 'progress',
            kind: 'route',
            name,
            outputSummary: { step: i + 1, stopReason, actualRoom, recoveryHint },
            status: 'blocked',
          });
          break;
        }

        const step = typeof rawStep === 'string' ? { cmd: rawStep } : rawStep;
        const cmd = step.cmd.trim();
        const waitMs = Math.max(100, Math.min(60_000, Number(step.waitMs || defaultWaitMs)));
        if (!cmd) continue;
        
        const expected = expectedWaterStage(name, i + 1, maxSteps, cmd);
        const preActualRoom = state.world.location.name || '';
        const preActualRoomId = state.world.location.room_id || null;
        const expectedRoomIdHere = expectedRoomIdAtStep(name, i);
        const preDeviation = routeDeviation(expected, preActualRoom, expectedRoomIdHere, preActualRoomId, kbRoomShort, describeRoomForDeviation);
        
        state.routeState = {
          ...state.routeState,
          active: true,
          step: i + 1,
          currentCmd: cmd,
          expectedCommand: cmd,
          expectedStage: expected.label || `${route.from} -> ${route.to}`,
          actualRoom: preActualRoom,
          actualExits: state.world.location.exits || [],
          deviation: preDeviation,
          deviationKind: preDeviation ? 'room_mismatch' : '',
          recoveryHint: '',
          updatedAt: Date.now(),
        };
        sendStateSnapshot();

        sendMudCommand(mud, cmd);
        state.pendingActions.push(`route:${name}:${cmd}`);
        console.log(`[Agent] route ${name} ${i + 1}/${route.commands.length} -> ${cmd}; wait ${waitMs}ms`);
        broadcast({ type: 'log', data: `route ${name} ${i + 1}/${route.commands.length} → ${cmd}${waitMs > defaultWaitMs ? `; wait ${waitMs}ms` : ''}` });
        emitTrace({
          phase: 'progress',
          kind: 'route',
          name,
          input: { step: i + 1, total: route.commands.length, cmd, waitMs },
        });
        const events = await collectMudEvents(waitMs, sleep, state.eventQueue);
        const stop = detectStopReason(events, cmd, state.world.player);
        const rawEvents = events.map((e) => e.content);
        const actualRoom = state.world.location.name || '';
        const actualRoomId = state.world.location.room_id || null;
        const expectedRoomIdNext = expectedRoomIdAtStep(name, i + 1);
        const deviation = routeDeviation(expected, actualRoom, expectedRoomIdNext, actualRoomId, kbRoomShort, describeRoomForDeviation);
        const deviationKind = classifyRouteDeviation(name, cmd, expected, actualRoom, summarizeEvents(events), stop, expectedRoomIdNext, actualRoomId, routeDeviation, kbRoomShort, describeRoomForDeviation);
        const routeStopReason = (deviationKind && shouldStopRouteForDeviation(deviationKind)) ? deviationKind : (stop || '');
        const recoveryHint = routeRecoveryHint(name, cmd, deviationKind || stop || '', actualRoom, state.world.location.exits || []);
        const lastLine = rawEvents.length ? rawEvents[rawEvents.length - 1].slice(0, 240) : '';
        steps.push({
          step: i + 1,
          cmd,
          waitMs,
          expectedStage: expected.label || undefined,
          actualRoom,
          deviation: deviation || undefined,
          deviationKind: deviationKind || undefined,
          recoveryHint: recoveryHint || undefined,
          rawEvents,
          rawText: rawEvents.join('\\n'),
          ...(routeStopReason ? { stopReason: routeStopReason } : {}),
        });
        
        state.routeState = {
          ...state.routeState,
          active: true,
          step: i + 1,
          currentCmd: cmd,
          expectedCommand: cmd,
          expectedStage: expected.label || `${route.from} -> ${route.to}`,
          actualRoom,
          actualExits: state.world.location.exits || [],
          deviation,
          deviationKind,
          recoveryHint,
          lastLine,
          updatedAt: Date.now(),
        };
        sendStateSnapshot();
        
        emitTrace({
          phase: 'progress',
          kind: 'route',
          name,
          outputSummary: { step: i + 1, cmd, expectedStage: expected.label || null, actualRoom, deviation: deviation || null, deviationKind: deviationKind || null, recoveryHint: recoveryHint || null, stopReason: routeStopReason || null, ...summarizeEvents(events) },
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
      state.routeState = {
        ...state.routeState,
        active: false,
        step: steps.length || state.routeState.step,
        currentCmd: stopReason ? state.routeState.currentCmd : '',
        expectedCommand: stopReason ? state.routeState.expectedCommand : '',
        expectedStage: stopReason ? `stopped: ${stopReason}` : `completed: ${route.to}`,
        actualRoom: state.world.location.name || state.routeState.actualRoom,
        actualExits: state.world.location.exits || [],
        deviation: stopReason ? (state.routeState.deviation || stopReason) : state.routeState.deviation,
        deviationKind: stopReason ? (state.routeState.deviationKind || stopReason) : state.routeState.deviationKind,
        recoveryHint: stopReason ? (state.routeState.recoveryHint || routeRecoveryHint(name, '', stopReason, state.world.location.name || state.routeState.actualRoom, state.world.location.exits || [])) : state.routeState.recoveryHint,
        updatedAt: Date.now(),
      };
      sendStateSnapshot();
      
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
          deviationKind: state.routeState.deviationKind || null,
          recoveryHint: state.routeState.recoveryHint || null,
        },
        status: stopReason ? 'stopped' : 'ok',
      });

      const result = {
        msg: stopReason ? `stopped: ${stopReason}` : 'completed',
        route: { name, from: route.from, to: route.to, notes: route.notes, requirements: route.requirements || [] },
        requestedSteps: maxSteps,
        completedSteps: steps.length,
        stopReason: stopReason || null,
        deviationKind: state.routeState.deviationKind || null,
        recoveryHint: state.routeState.recoveryHint || null,
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
"""

# Replace the tool
pattern = r'const executeRouteSkillTool: Tool = \{.*?\},'
content = re.sub(pattern, new_tool + ',', content, flags=re.DOTALL)

with open('pi_mud_gateway/mud_gateway.ts', 'w', encoding='utf-8') as f:
    f.write(content)
