import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {precomputeFixedRouteRoomIds, resolveGatewayRoute, routeLocationError, routeStartMatches} from '../lib/pathfinder.mjs';
import {loadGatewayConfig} from '../lib/gateway_config.mjs';
import {DIRECTION_ALIASES, KNOWN_ROUTES} from '../lib/core.mjs';

test('production gateway bundles all local code without starting sockets or a model', async()=>{
  const require=createRequire(new URL('../../pi/package.json',import.meta.url));
  const {build}=require('esbuild');
  const r=await build({entryPoints:[fileURLToPath(new URL('../mud_gateway.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  assert.ok(r.outputFiles[0].text.length>1000);
});

test('production gateway guards legacy controls, every multi-step sender and Pi tool chains', async () => {
  const source = await readFile(new URL('../mud_gateway.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(!trustedControlSource\) \{\s*ws\.close\(1008, 'trusted loopback HTTP\(S\) origin required'\);\s*return;/);
  assert.match(source, /validateLegacyControlEvent\(m, \{ isTrustedSource: trustedControlSource \}\)/);
  assert.match(source, /const runFastExploreStep = \(\) => \{[\s\S]*?automationInterruption\(automationState\)/);
  assert.match(source, /for \(const \[index, cmd\] of commands\.entries\(\)\) \{\s*const automationStop = automationInterruption\(automationState\)/);
  assert.match(source, /for \(const \[index, rawStep\][\s\S]*?\{\s*const automationStop = automationInterruption\(automationState\)/);
  assert.match(source, /for \(const direction of directions\.slice\(0, maxSteps\)\) \{\s*const automationStop = automationInterruption\(automationState\)/);
  assert.match(source, /execute: async \(toolCallId, params\) => \{[\s\S]*?const automationStop = automationInterruption\(automationState\)/);
});

test('legacy Pi mode counts Pi turn_start events instead of prompt calls', async () => {
  const source = await readFile(new URL('../mud_gateway.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(isPiModelRequestEvent\(event\)\) onModelCall\?\.\(\)/);
  assert.match(source, /compactMemory\(session, config, countPiModelCall\)/);
  assert.doesNotMatch(source, /updateAutomation\(\{ type: 'model_call', trigger: 'agent_action_series' \}\)/);
});

test('legacy Pi mode publishes skill and decision metadata from tool traces', async () => {
  const source = await readFile(new URL('../mud_gateway.ts', import.meta.url), 'utf8');
  assert.match(source, /const automationDecision = automationDecisionFromTrace\(patch\);\s*if \(automationDecision\) updateAutomation\(automationDecision\);/);
});

test('high-level WAIT distinguishes automation resume from fresh operator intent', async () => {
  const source = await readFile(new URL('../mud_gateway.ts', import.meta.url), 'utf8');
  assert.match(source, /const waitRequirement = decisionWaitRequirement\(automationState\);\s*if \(waitRequirement === 'automation_resume'\) \{\s*await awaitAutomationPermission\(\)/);
  assert.match(source, /if \(waitRequirement === 'automation_cancelled'\)/);
});

test('production config loader preserves configured decision endpoint and model', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mud-gateway-config-'));
  t.after(async () => (await import('node:fs/promises')).rm(directory, {recursive: true, force: true}));
  const configPath = path.join(directory, 'gateway.config.json');
  const defaults = {
    mud: {host: '127.0.0.1', port: 5555},
    auth: {id: ''},
    agent: {turnIntervalMs: 150},
    runtime: {monitorPort: 8099},
    decision: {enabled: false, provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: '', minimumConfidence: 0.7, timeoutMs: 15000},
  };
  await writeFile(configPath, JSON.stringify({
    mud: {port: 6000},
    decision: {enabled: true, provider: 'gateway', endpoint: 'http://127.0.0.1:9000', model: 'configured-local-model'},
  }));

  const config = await loadGatewayConfig(configPath, defaults);

  assert.deepEqual(config.mud, {host: '127.0.0.1', port: 6000});
  assert.deepEqual(config.decision, {
    enabled: true,
    provider: 'gateway',
    endpoint: 'http://127.0.0.1:9000',
    model: 'configured-local-model',
    minimumConfidence: 0.7,
    timeoutMs: 15000,
  });
  assert.equal(config.decision.enabled, true);
});

test('production route resolution uses the graph when no named fixed route exists',()=>{
 const rooms=new Map([['/a',{short:'A',exits:{north:'/b'}}],['/b',{short:'B',exits:{}}]]);
 const route=resolveGatewayRoute('/b','/a',rooms,{});
 assert.deepEqual(route.commands,['north']);assert.deepEqual(route.expectedRoomIds,['/b']);
 assert.equal(resolveGatewayRoute('/missing','/a',rooms,{}),undefined);
 const fixed={commands:['look']};assert.equal(resolveGatewayRoute('fixed','/a',rooms,{fixed}),fixed);
});

test('production route guard refuses an unknown or mismatched room before movement',()=>{
 assert.equal(routeLocationError('/a',''),'unknown_room');
 assert.equal(routeLocationError('/a','/b'),'room_mismatch');
 assert.equal(routeLocationError('/a','/a'),'');
});

test('fixed route room precomputation includes and verifies the final destination',()=>{
 const rooms=new Map([['/d/test/a',{exits:{north:'/d/test/b'}}],['/d/test/b',{exits:{east:'/d/test/c'}}],['/d/test/c',{exits:{}}]]);
 const route={from:'Start /d/test/a',to:'End /d/test/c',commands:['north','east']};
 const expected=precomputeFixedRouteRoomIds(route,rooms,{north:'north',east:'east'});
 assert.deepEqual(expected,['/d/test/a','/d/test/b','/d/test/c']);
 assert.equal(routeLocationError(expected[route.commands.length],'/d/test/wrong'),'room_mismatch');
});

test('fixed route room precomputation advances through compound map exits',()=>{
 const compoundDirections=['northup','southdown','eastup','westup','northdown','eastdown','southup','westdown'];
 for(const direction of compoundDirections){
  const start=`/d/test/${direction}_start`;const end=`/d/test/${direction}_end`;
  const rooms=new Map([[start,{exits:{[direction]:end}}],[end,{exits:{}}]]);
  const expected=precomputeFixedRouteRoomIds({from:`Start ${start}`,commands:[direction]},rooms,DIRECTION_ALIASES);
  assert.deepEqual(expected,[start,end],direction);
 }
});

test('riverbank production route predicts shanlu after northup',async()=>{
 const map=JSON.parse(await readFile(new URL('../skills/xkx2001-knowledge/data/map.json',import.meta.url),'utf8'));
 const rooms=new Map(map.rooms.map(room=>[room.room_id,room]));
 const route=KNOWN_ROUTES.shaolin_water_return_riverbank_to_shanlu_probe;
 assert.deepEqual(precomputeFixedRouteRoomIds(route,rooms,DIRECTION_ALIASES),[
  '/d/shaolin/riverbank','/d/shaolin/shanlu',
 ]);
});

test('reviewed wildcard route start accepts alternate shanlu rooms only',()=>{
 const routeFrom='挑水山路 /d/shaolin/shanlu*';
 assert.equal(routeStartMatches(routeFrom,'/d/shaolin/shanlu'),true);
 assert.equal(routeStartMatches(routeFrom,'/d/shaolin/shanlu1'),true);
 assert.equal(routeStartMatches(routeFrom,'/d/shaolin/riverbank'),false);
 assert.equal(routeStartMatches('汉水岸边 /d/shaolin/riverbank','/d/shaolin/riverbank'),true);
 assert.equal(routeStartMatches('汉水岸边 /d/shaolin/riverbank','/d/shaolin/riverbank1'),false);
});

test('wildcard fixed route precomputation accepts either reviewed start variant',()=>{
 const rooms=new Map([
  ['/d/shaolin/shanlu',{exits:{southdown:'/d/shaolin/riverbank'}}],
  ['/d/shaolin/shanlu1',{exits:{southdown:'/d/shaolin/riverbank'}}],
  ['/d/shaolin/riverbank',{exits:{}}],
 ]);
 const route={from:'挑水山路 /d/shaolin/shanlu*',commands:['southdown']};
 const expected=precomputeFixedRouteRoomIds(route,rooms,DIRECTION_ALIASES);
 assert.deepEqual(expected,['/d/shaolin/shanlu*','/d/shaolin/riverbank']);
 assert.equal(routeLocationError(expected[0],'/d/shaolin/shanlu1'),'');
});
