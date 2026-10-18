import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay } from './helpers/replay.mjs';
import { KNOWN_ROUTES, chooseProgressSkill, commandSequenceWaitMs, normalizeDirection,
  detectStopReason, executableRouteEntries, shouldStopBeforeNextCommand } from '../lib/core.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/transcripts.json', import.meta.url)));

test('status transcript: ANSI/metadata removed, actual resource fields parsed; low qi allows info then stops movement', async () => {
  const result = await replay(['hp', 'east', 'hp', 'north'], [
    { command: 'hp', raw: fixture.status }, { command: 'east', raw: '广场\n' },
    { command: 'hp', raw: fixture.status }, { command: 'north', raw: '山门殿\n' },
  ]);
  assert.deepEqual(result.player, { hp:29,hp_max:100,hp_injury_pct:80,jing:80,jing_max:100,jing_injury_pct:90,
    mp:70,mp_max:120,neili:40,neili_max:200,food:50,food_max:100,water:60,water_max:100,
    potential:31,potential_max:200,combat_exp:12345 });
  assert.equal(result.stopReason, 'low_qi');
  assert.deepEqual(result.transport.writes, ['hp\n','east\n','hp\n','north\n']);
  assert.doesNotMatch(result.steps[0].rawText, /\x1b|metadata|====/);
  assert.equal(result.transport.queue.length, 0);
});

for (const [key, reason] of [['blocked','blocked_exit'], ['busy','blocked_or_busy'], ['poison','poison_or_poison_damage']]) {
  test(`replay ${key} stops remaining commands and preserves raw response`, async () => {
    const r = await replay(['south','north'], [{ command:'south',raw:fixture[key] }]);
    assert.equal(r.stopReason, reason); assert.equal(r.steps.length,1);
    assert.equal(r.steps[0].rawText,fixture[key].trim());
  });
}

test('combat is observed but retains existing continue behavior', async () => {
  const r = await replay(['east','hp'], [{command:'east',raw:fixture.combat},{command:'hp',raw:'气： 90/ 100 (100%)'}]);
  assert.equal(r.stopReason,''); assert.equal(r.steps.length,2);
});

test('manual takeover prevents any further transport write', async () => {
  const r = await replay(['east','west'], [{command:'east',raw:'广场'}], {manual:i=>i===1});
  assert.equal(r.stopReason,'manual_control_active'); assert.deepEqual(r.transport.writes,['east\n']);
});

test('replays checked-in water route, preserving per-step busy waits and all five fill cycles', async () => {
  const commands = KNOWN_ROUTES.shaolin_water_fill_bucket_at_riverbank.commands;
  const frames = commands.map(step=>({command: typeof step==='string'?step:step.cmd,raw:'动作完成。'}));
  const r = await replay(commands,frames,{route:true});
  assert.equal(r.stopReason,''); assert.equal(r.steps.filter(s=>s.cmd==='yao shui').length,5);
  assert.equal(r.steps.filter(s=>s.cmd==='dao shui to shui tong').length,5);
  assert.deepEqual(r.transport.waits,commands.map(s=>Math.max(100,Math.min(60000,Number(s.waitMs||150)))));
  assert.equal(r.transport.frames.length,0);
});

test('gate routes keep open/knock immediately before crossing', () => {
  const outbound=KNOWN_ROUTES.shaolin_chufang_to_south_gate_for_water_job.commands.map(s=>typeof s==='string'?s:s.cmd);
  assert.equal(outbound[outbound.indexOf('open gate')+1],'south');
  for(const suffix of ['up','westup','northwest']) {
    const commands=KNOWN_ROUTES['shaolin_water_return_shanlu_to_chufang_via_'+suffix].commands.map(s=>typeof s==='string'?s:s.cmd);
    assert.equal(commands[commands.indexOf('knock gate')+1],'north');
  }
});

test('decision route candidates exclude direction hints that the route executor cannot run', () => {
  const candidateNames = executableRouteEntries(KNOWN_ROUTES).map(([name]) => name);
  assert.ok(candidateNames.includes('yangzhou_guangchang_to_shaolin_shanmen_overland'));
  assert.ok(!candidateNames.includes('wizard_guest_room_to_wumiao'));
  assert.ok(!candidateNames.includes('wumiao_to_wizard_guest_room'));
  assert.ok(!candidateNames.includes('probe_from_current_room'));
  assert.equal(executableRouteEntries({empty: {commands: []}, invalid: {commands: 'north'}}).length, 0);
});

test('decision boundaries preserve skill fallback, direction aliases, waits and qi threshold', () => {
  assert.deepEqual(chooseProgressSkill({skillPlan:['a','b'],skillIndex:0,blockedSkills:{a:'blocked'}}),{skill:'b',index:1});
  assert.deepEqual(chooseProgressSkill({skillPlan:['a'],skillIndex:0,blockedSkills:{a:true}}),{skill:'a',index:0});
  assert.equal(normalizeDirection(' NE '),'northeast');
  for(const [cmd,wait] of [['yao shui',4000],['dao shui to shui tong',3500],['dazuo 10',3000],['carry shui tong',1000],['east',150]]) assert.equal(commandSequenceWaitMs(cmd,150),wait);
  assert.equal(detectStopReason([], 'east', {hp:30,hp_max:100}),null);
  assert.equal(shouldStopBeforeNextCommand('low_qi','hp'),false);
  assert.equal(shouldStopBeforeNextCommand('low_qi','east'),true);
});

test('mock rejects an unplanned command rather than falling back to real I/O', async () => {
  await assert.rejects(replay(['east'],[{command:'west',raw:'广场'}]), /Expected values to be strictly equal/);
  await assert.rejects(replay(['east'],[]), /unexpected command/);
});

test('route stops at blocked gate before crossing', async () => {
  const r = await replay([{cmd:'open gate',waitMs:300},'south'],[{command:'open gate',raw:fixture.blocked}],{route:true});
  assert.equal(r.stopReason,'blocked_exit'); assert.deepEqual(r.transport.writes,['open gate\n']);
  assert.deepEqual(r.transport.waits,[300]);
});
