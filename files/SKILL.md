---
name: xkx2001-knowledge
description: Queryable knowledge base for the xkx2001 (侠客行 2001) FluffOS MUD world. Use this whenever the agent or user needs facts about the xkx2001 game world — room maps and routes (e.g. 扬州 to 少林), player attributes (精/气/精力/内力/血), martial arts (功法/武功), quests (任务), sects (门派), NPCs, items, or general game conventions (常识). Trigger this skill whenever a MUD agent must decide where to walk, how to interpret a character's status line, what a skill does, or how a quest is structured. Always consult this before guessing room IDs, walk directions, or attribute meanings, since wrong data will misroute the agent.
---

# xkx2001 (侠客行 2001) World Knowledge Base

A structured, queryable reference for an autonomous FluffOS/xkx2001 MUD agent. It turns raw
mudlib source into JSON the agent can read, plus human-readable references for game mechanics.

## ⚠️ Data provenance — read this first

This knowledge base has **two kinds of content**:

1. **Mechanics references** (`references/attributes.md`, `references/skills-lore.md`) — based on
   standard 侠客行 conventions. These are stable across most xkx codebases but **must be
   verified against the live server** using in-game commands (`score`, `hp`, `skills`). Each file
   says how to verify.

2. **Server-specific data** (`data/map.json`, `data/skills.json`, `data/quests.json`) — this
   MUST be generated from the actual mudlib LPC source your agent connects to. Do **not** trust
   hand-written room IDs or routes. Run `scripts/extract_mudlib.py` against the source tree to
   build these files. Until you do, they contain only schemas + examples, not real routes.

## How to use this skill

| The agent/user asks… | Read / run |
|---|---|
| "How do I get from 扬州 to 少林?" | `data/map.json` (must be generated first), then `scripts/route.py` for shortest path |
| "What does 精/气/精力/内力 mean? Is HP low?" | `references/attributes.md` |
| "What is 罗汉拳 / how do 功法 work?" | `references/skills-lore.md` + `data/skills.json` |
| "What does this quest need?" | `data/quests.json` |
| "What other info should we capture?" | `references/data-dimensions.md` |

## Generating server-specific data (the important part)

You need the mudlib LPC source (the `.c` files of the server the agent dials into). Then:

```bash
# Build the room graph + skill list + quest stubs from LPC source
python scripts/extract_mudlib.py --src /path/to/xkx2001/mudlib --out data/

# Query the shortest walk route between two rooms
python scripts/route.py --map data/map.json --from 扬州 --to 少林
```

If you do NOT have the source, the only reliable fallback is **agent self-exploration**: let the
gateway agent walk the world, log every room's `short`/`exits` from `look` output, and append
nodes to `data/map.json` incrementally. See `references/map-schema.md` for the node format.

## File index

- `references/attributes.md` — 精/气/精力/内力/血, 先天四维, 潜能/经验/常识. Status-line decoding.
- `references/skills-lore.md` — 功法 categories, 门派, learning mechanics, combat 常识.
- `references/map-schema.md` — room-graph JSON format + route query semantics.
- `references/data-dimensions.md` — full list of world dimensions worth capturing (answers "还有哪些维度").
- `data/map.json` — room graph (GENERATE from source).
- `data/skills.json` — skill catalog (GENERATE from source).
- `data/quests.json` — quest catalog (GENERATE / curate).
- `scripts/extract_mudlib.py` — LPC source → JSON extractor.
- `scripts/route.py` — shortest-path query over the room graph.
