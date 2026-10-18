import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {precomputeFixedRouteRoomIds, resolveGatewayRoute, routeLocationError} from '../lib/pathfinder.mjs';
import {loadGatewayConfig} from '../lib/gateway_config.mjs';

test('production gateway bundles all local code without starting sockets or a model', async()=>{
  const require=createRequire(new URL('../../pi/package.json',import.meta.url));
  const {build}=require('esbuild');
  const r=await build({entryPoints:[fileURLToPath(new URL('../mud_gateway.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  assert.ok(r.outputFiles[0].text.length>1000);
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
