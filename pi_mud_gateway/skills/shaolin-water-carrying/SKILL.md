---
name: shaolin-water-carrying
description: Use when the MUD gateway agent needs to run or reason about the Shaolin water carrying task, including accepting the job, getting tools, filling the bucket, returning through the random mountain path, and turning in the bucket.
---

# Shaolin Water Carrying

This skill is for the FluffOS xkx2001 Shaolin water carrying job.

Use gateway route tools instead of manually emitting long command chains:

- `shaolin_fzlou_accept_water_job`: at `/d/shaolin/fzlou`, ask the zhike seng for work.
- `shaolin_fzlou_to_chufang`: move from fangzhang lou to `/d/shaolin/chufang`.
- `shaolin_chufang_prepare_water_tools`: ask shaofan seng for `shui tong` and `shui piao`.
- `shaolin_chufang_to_south_gate_for_water_job`: after getting tools from shaofan seng, move from kitchen to the south gate/front square. This route runs `open gate`, waits long enough for gate state sync, then immediately runs `south` before the gate auto-closes.
- `shaolin_south_gate_to_riverbank_for_water_job`: continue from the front square to `/d/shaolin/riverbank`.
- `shaolin_chufang_to_riverbank_for_water_job`: legacy full route from kitchen to `/d/shaolin/riverbank`; prefer the two south-gate routes above after tools are ready.
- `shaolin_water_fill_bucket_at_riverbank`: put down the bucket, fill it with five `yao shui` / `dao shui to shui tong` cycles, then `carry shui tong`.
- `shaolin_water_return_riverbank_to_shanlu_probe`: go `northup` from riverbank into the special water-carrying mountain path.
- After probing shanlu, inspect exits. The first shanlu exit is random:
  - if exit has `up`, execute `shaolin_water_return_shanlu_to_chufang_via_up`;
  - if exit has `westup`, execute `shaolin_water_return_shanlu_to_chufang_via_westup`;
  - if exit has `northwest`, execute `shaolin_water_return_shanlu_to_chufang_via_northwest`.
  - The return variants cross the temple north gate from outside: at the front square they must run `knock gate`, then immediately `north` before the gate auto-closes.
- `shaolin_chufang_finish_water_job`: give the full bucket and piao to shaofan seng.

Do not spam `look`. Observe once after the shanlu probe because the next exit is random, then select the matching return route.

When already at shaofan seng in `/d/shaolin/chufang`, check `get_runtime_state().progressLoop` before choosing the next water route. If `stage` is `water_filled`, `water_on_shanlu`, or `water_returning`, or `waterTaskState` is `bucket_filled`/`returning`, the bucket is probably full and on the return path: run `shaolin_chufang_finish_water_job` immediately. Do not go back to the riverbank to repeat `yao shui`/`dao shui`.

Task requirements from LPC:

- The player must be Shaolin faction.
- `combat_exp` must be at most 500000.
- The player must not have `ts_pending`.
- The task uses `shaolin/job_asked` and the `tiaoshui` condition.

Timing notes:

- Normal route movement can use the gateway default fast interval.
- Filling water cannot use the fast interval. `yao shui` and `dao shui to shui tong` make the player busy, so use the route skill waits.
- The water job timer was extended in `run/d/shaolin/npc/tiaoshui1.h` to `2000 + random(600)` condition ticks.

Failure notes:

- On the mountain path the player can slip, spill water, or lose the bucket. If the bucket is no longer full, return to riverbank and run `shaolin_water_fill_bucket_at_riverbank` again.
- If `shui piao` is lost, return to kitchen and ask shaofan seng about `水瓢`.
- If route trace shows a gate deviation, stop using ad-hoc movement. Re-observe the current room, then re-enter the nearest stable route segment: inside 山门殿 uses `open gate` -> `south`; outside 广场 uses `knock gate` -> `north`.
- If `shaolin_fzlou_abandon_water_job` actually abandons the job (`下去好好反思一下吧。`), the gateway enforces an in-place cooldown wait in the same tool call via `runtime.waterAbandonHoldMs`; do not spend another turn just waiting.
