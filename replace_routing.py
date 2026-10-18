import re

with open('pi_mud_gateway/mud_gateway.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update RuntimeCheckpoint type
content = re.sub(
    r'(type RuntimeCheckpoint = \{.*?updated_at: number;})',
    r'\1\n  routeState?: any;',
    content,
    flags=re.DOTALL
)

# 2. Generalize the functions (remove old water-specific functions)
# We'll remove waterRouteDeviation, classifyRouteDeviation, routeRecoveryHint, shouldStopRouteForDeviation
# and the isShaolinWaterRoute check in the tool.

# The functions are likely together.
# Let's find the block and replace it.
# We can remove the old ones and let the tool import from route_logic.mjs

# Since we're importing, let's add the import at the top.
if "import { routeDeviation" not in content:
    content = content.replace(
        "import { DIRECTION_ALIASES, KNOWN_ROUTES, normalizeDirection, isInfoCommand, summarizeEvents, routeStepCommand, routeStepNote, commandSequenceWaitMs, chooseProgressSkill, detectStopReason, shouldStopBeforeNextCommand, parseStatusLine, cleanMudText, splitCleanMudLines } from './lib/core.mjs';",
        "import { DIRECTION_ALIASES, KNOWN_ROUTES, normalizeDirection, isInfoCommand, summarizeEvents, routeStepCommand, routeStepNote, commandSequenceWaitMs, chooseProgressSkill, detectStopReason, shouldStopBeforeNextCommand, parseStatusLine, cleanMudText, splitCleanMudLines } from './lib/core.mjs';\nimport { routeDeviation, classifyRouteDeviation, routeRecoveryHint, shouldStopRouteForDeviation } from './lib/route_logic.mjs';"
    )

# Remove old function definitions
content = re.sub(r'function waterRouteDeviation\(.*?\)\s*\{.*?\}', '', content, flags=re.DOTALL)
content = re.sub(r'function classifyRouteDeviation\(.*?\)\s*\{.*?\}', '', content, flags=re.DOTALL)
content = re.sub(r'function routeRecoveryHint\(.*?\)\s*\{.*?\}', '', content, flags=re.DOTALL)
content = re.sub(r'function shouldStopRouteForDeviation\(.*?\)\s*\{.*?\}', '', content, flags=re.DOTALL)

# 3. Update executeRouteSkillTool
# This is a large block. I'll use a regex to find the execute function.

def update_execute(match):
    exec_body = match.group(0)
    
    # Remove isShaolinWaterRoute checks
    exec_body = re.sub(r'if \(isShaolinWaterRoute\(name\)\)\s*\{.*?\}', '', exec_body, flags=re.DOTALL)
    
    # Replace state.waterRoute with state.routeState
    exec_body = exec_body.replace('state.waterRoute', 'state.routeState')
    
    # Implement Breakpoint Recovery at the start of execute:
    recovery_logic = """
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
    """
    
    # Insert recovery logic after initial checks
    # find 'const name = String(params?.name || '').trim();'
    if 'const name = String(params?.name || '').trim();' in exec_body:
        exec_body = exec_body.replace('const name = String(params?.name || '').trim();', f'const name = String(params?.name || '').trim();\n{recovery_logic}')
    
    # Update loop: use startIndex instead of 0
    exec_body = exec_body.replace('route.commands.slice(0, maxSteps).entries()', f'route.commands.slice(startIndex, maxSteps).entries()')
    # Adjust index for the loop: index is now relative to startIndex
    exec_body = exec_body.replace('index + 1', f'(startIndex + index + 1)')
    
    # Generalize deviation and classification
    exec_body = exec_body.replace('waterRouteDeviation', 'routeDeviation')
    exec_body = exec_body.replace('classifyRouteDeviation', 'classifyRouteDeviation')
    exec_body = exec_body.replace('routeRecoveryHint', 'routeRecoveryHint')
    
    # Update the deviation calls to pass KB helpers
    exec_body = exec_body.replace(
        'waterRouteDeviation(expected, preActualRoom, expectedRoomIdHere, preActualRoomId)',
        'routeDeviation(expected, preActualRoom, expectedRoomIdHere, preActualRoomId, kbRoomShort, describeRoomForDeviation)'
    )
    exec_body = exec_body.replace(
        'waterRouteDeviation(expected, actualRoom, expectedRoomIdNext, actualRoomId)',
        'routeDeviation(expected, actualRoom, expectedRoomIdNext, actualRoomId, kbRoomShort, describeRoomForDeviation)'
    )
    
    # Update classifyRouteDeviation call
    exec_body = exec_body.replace(
        'classifyRouteDeviation(name, cmd, expected, actualRoom, events, stop, expectedRoomIdNext, actualRoomId)',
        'classifyRouteDeviation(name, cmd, expected, actualRoom, summarizeEvents(events), stop, expectedRoomIdNext, actualRoomId, routeDeviation, kbRoomShort, describeRoomForDeviation)'
    )
    
    # Update routeRecoveryHint call
    exec_body = exec_body.replace(
        'routeRecoveryHint(name, cmd, deviationKind || stop || \'\', actualRoom, state.world.location.exits || [])',
        'routeRecoveryHint(name, cmd, deviationKind || stop || \'\', actualRoom, state.world.location.exits || [])'
    )
    
    return exec_body

# Find the execute function of executeRouteSkillTool
content = re.sub(
    r'(execute: async \(_id, params\) => \{.*?\}\s*,\s*})',
    lambda m: m.group(1).replace('execute: async', 'execute: async'), # Just a hook to trigger the sub-replacement
    content,
    flags=re.DOTALL
)
# This is tricky. I'll just use a simpler replacement for the whole tool.

# Instead, let's find the block from 'const executeRouteSkillTool' to '};' and replace it.
# I'll use a simpler approach: replace all 'state.waterRoute' with 'state.routeState'
# and then manually fix the tool.
