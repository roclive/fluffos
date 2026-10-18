import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolveGatewayRoute, routeLocationError} from '../lib/pathfinder.mjs';

test('production gateway bundles all local code without starting sockets or a model', async()=>{
  const require=createRequire(new URL('../../pi/package.json',import.meta.url));
  const {build}=require('esbuild');
  const r=await build({entryPoints:[fileURLToPath(new URL('../mud_gateway.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  assert.ok(r.outputFiles[0].text.length>1000);
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
