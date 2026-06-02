---
name: xkx2001-knowledge
description: Queryable game-world ontology + knowledge base for the xkx2001 (侠客行) FluffOS MUD that the pi-agent / mud_gateway loop plays (telnet 5555, ES2-UTF8 mudlib). Use whenever the agent must decide where to walk, parse a status/combat line, find a master to learn a skill, judge danger, or interpret room/exit text. Provides REAL data generated from the live mudlib source (run/): room graph + routes (扬州↔少林), NPCs + masters, skills + sects, areas; plus an authoritative FluffOS-text→state parse table. Always consult before guessing room_ids, walk directions, attribute meanings, or status regexes.
---

# xkx2001 (侠客行) World Knowledge Base

Structured world model for the autonomous FluffOS/xkx2001 MUD agent. Unlike a hand-written
stub, the `data/*.json` here is **generated from the live mudlib** (`run/`, config `ES2-UTF8`,
the same server the gateway dials at telnet 5555). The big picture lives in `ONTOLOGY.md`.

## Start here
- **`ONTOLOGY.md`** — the world model: entities (Region/Room/NPC/Skill/Sect/Player), their
  attributes, relations, and how they map to gateway `WorldSummary` + decisions. Read this first.

## How to use

| The agent/user asks… | Read / run |
|---|---|
| "扬州 → 少林 怎么走？" | `python scripts/route.py --map data/map.json --from 扬州 --to 少林` |
| "这一行状态/战斗文本什么意思？HP 低吗？busy 吗？" | `references/status-patterns.json`（解析表，含精确正则）+ `references/attributes.md` |
| "精/气/精力/内力 含义、危险阈值？" | `references/attributes.md` |
| "去哪找师傅学 X 武功？" | `data/npcs.json`（`is_master==true` 且 `teaches` 含 X）|
| "X 武功是什么类型/属哪门派？" | `data/skills.json` + `references/skills-lore.md` |
| "去哪找教 X 的师傅，怎么走？" | `python scripts/find_master.py --skill X --from 这里`（masters.json + route）|
| "挑水任务怎么做？后殿水井是不是更近？" | `references/quests.md` §1 + `data/quests.json`（答：后殿水井是死路）|
| "怎么拜师学艺/进阶？学不动卡在哪？" | `references/quests.md` §2（潜能/常识/exp/门派 闸门）|
| "这个区域安全吗？有哪些区？" | `data/areas.json` + `ONTOLOGY.md` §1 |
| "低血/内伤/没钱怎么办？命令怎么发？" | `references/common-sense.md` |
| "还该捕捉哪些维度？" | `references/data-dimensions.md` |

## 数据来源与再生成

`data/*.json` 由 `scripts/build_kb.py` 从 mudlib 源码解析。源码变了就重跑：

```bash
python scripts/build_kb.py --src ../../../run --out data
#   rooms≈3700  npcs≈2200  skills≈430  masters≈191  areas≈57   (启发式 LPC 解析)
```

辅助脚本：
- `scripts/route.py --from 扬州 --to 少林` — 房间图 BFS 求路线。
- `scripts/find_master.py --skill <id> [--sect s] [--from 这里]` — 列出教某武功的师傅+房间+路线（masters.json+route）。

产物：
- `data/map.json` — 房间图：room_id / short / area / indoors / exits{dir→room_id} / npcs[]。
- `data/areas.json` — 区域代码→中文名 + 房间数（源 `run/d/REGIONS.h`）。
- `data/npcs.json` — NPC：name/aliases/attitude/class/sect/is_master/teaches/combat_exp。
- `data/skills.json` — 武功：skill_id / types[]（force/sword/parry/dodge…）。
- `data/masters.json` — 师傅：name/npc_id/sect/teaches[]/combat_exp + 房间(room_id/short/area)。191 位，139 有固定房间。
- `data/quests.json` — 任务目录：挑水(含后殿水井死路分析)、拜师学艺；giver/前置/动作序列/灌满&交付判定/奖励/失败模式/路线。
- `data/warnings.json` — 未解析/跨区特殊出口（船/镖局/城门/传送），约 4%，需 agent 自探补齐。

## 关键文件（机器可读，给 gateway 直接用）
- **`references/status-patterns.json`** — FluffOS 文本→状态枚举的解析表：`hp` 状态行四资源的
  精确正则、危险阈值、`look` 房名/出口格式、战斗/busy/昏迷/门规拦截文案。**用它把 gateway 的
  `parseFluffosText` 从启发式升级为查表**（旧版正则 `气血:N/N` 不匹配本服务器真实输出 `气： N/ N (N%)`）。

## 与 gateway 的集成建议
1. `parseFluffosText`：strip ANSI → 按 `status-patterns.json` 查表填 `WorldSummary.player/location`。
2. 跨区移动：先 `route.py` 求路线再 `execute_route_skill`，断链处自探。
3. 目标驱动：用 `npcs.json` masters + `skills.json` 给 agent "找谁学什么"。
4. 运行时记忆（`memory.json`，见 `ONTOLOGY.md` §7）与本静态库分离，避免 COMPACT 丢失。

## 校验清单（接新服务器/源码更新后）
1. 重跑 `build_kb.py`，看 `warnings.json` 跨区断链。
2. 游戏内发 `hp` / `look`，核对 `status-patterns.json` 正则仍匹配。
3. `route.py` 抽查几条已知路线（扬州↔少林/武当/大理）连通。
