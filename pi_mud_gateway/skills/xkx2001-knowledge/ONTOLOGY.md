# xkx2001 世界模型 Ontology

供 pi-agent / mud_gateway loop 使用的**游戏世界本体论**：实体、属性、关系，以及它们
如何映射到 gateway 的 `WorldSummary` 与决策。全部从真实 mudlib 源码 (`run/`，config
名 `ES2-UTF8`，telnet 5555，utf-8) 提取或核对，provenance 标在各处。

数据分两层：
- **静态世界**（由 `scripts/build_kb.py` 从 `run/` 生成）：`data/*.json`。
- **机制/解析规则**（从源码核对、手写）：`references/*`，核心是 `status-patterns.json`。
- **运行时记忆**（agent 自己积累，跨会话）：见 §7，与静态库分离。

```
                 ┌── Region(区域) ──┐ 1   * ┌─ Room(房间) ─┐ *   * ┌─ Exit(出口) ─┐
World ──────────►│ areas.json       │──────►│ map.json     │──────►│ dir→room_id  │
                 └──────────────────┘       └──────┬───────┘       └──────────────┘
                                                   │ contains *
                                   ┌───────────────┼────────────────┐
                                   ▼               ▼                ▼
                              NPC(npcs.json)   Item             Player(角色)
                                 │ teaches *                       │ has
                                 ▼                                 ▼
                              Skill(skills.json) ◄── learns ── Attributes(精/气/精力/内力…)
                                 │ has mechanics                   │ in
                                 ▼                                 ▼
                              SkillMechanics(skill_mechanics.json)
                                 │ belongs_to
                                 ▼                                 ▼
                              Sect(门派) ◄────── member_of ── PlayerState(busy/combat/disabled)
```

## 1. Region 区域  (`data/areas.json`)
- 主键 `area`（代码，如 `city` `shaolin`），`name_cn`（如 扬州 / 嵩山少林），`room_count`。
- 来源：`run/d/REGIONS.h`（region_names）+ 房间 `set("outdoors", <area>)` 统计。
- 关系：Region 1—* Room。注意 area 由房间的 `outdoors` tag 决定，**地理边界房间可能挂在邻区**
  （例：扬州城外某青石大道 `outdoors=wudang`，属武当区）。
- 对 agent：决定"敢不敢去"。城镇(city/beijing/hangzhou…)相对安全；门派/野外有强 NPC。

## 2. Room 房间  (`data/map.json`)
- 主键 `room_id` = LPC 源码路径（如 `/d/shaolin/shanmen`），全局唯一、最稳。
- 字段：`short`(房间名), `area`, `indoors`, `exits{dir→room_id}`, `npcs[room 内常驻 NPC 的 npc_id]`。
- 来源：`set("short")` `set("exits",([...]))` `set("objects",([...]))`，宏 `__DIR__/CLASS_D/SKILL_D` 已解析。
- 关系：Room *—* Room（有向图，边=方向）；Room *—* NPC（contains）。
- 路线查询：`scripts/route.py`（多源 BFS，支持房间id/区域目录/中文区域名/房名模糊）。
- 已知缺口：约 4% 出口是计算式/特殊出口（船、镖局、城门、传送），在 `data/warnings.json`，
  跨区可能断链——靠 agent 自探补齐那几跳。

## 3. Player 角色 + Attributes 属性
映射到 `WorldSummary.player`，解析规则在 `references/status-patterns.json`（命令 `hp`）。

| 游戏内 | 字段 | WorldSummary | 含义 | 危险/归零 |
|---|---|---|---|---|
| 气 | qi/eff_qi | hp/hp_max | 主生命，承伤 | qi<0 昏迷→死 |
| 精 | jing/eff_jing | jing/jing_max | 精元，重伤掉精 | jing<0 死 |
| 精力 | jingli/max_jingli | mp | 行动耐力 | jingli<0 死；低→busy |
| 内力 | neili/max_neili | neili | 驱动招式/疗伤 | 低→高级招式不可用 |

- **两种"满度"要分开**（关键）：`当前/有效上限`(qi/eff_qi) = 即时承伤余量；
  `有效上限/真上限`(hp 显示的 %) = **内伤**程度，<100% 须静坐/疗伤，补气无效。
- 先天四维（基本固定）：膂力 str / 悟性 int / 根骨 con / 身法 dex → 决定学习与战斗上限。
- 成长资源：combat_exp(经验/等级称号)、potential(潜能，学武消耗)、literate(武学常识，可学上限闸门)、food/water。
- PlayerState 标志：`busy`("你正忙着呢")、`combat`、`disabled`(昏迷/半昏迷)。详见解析表 §messages。

## 4. NPC  (`data/npcs.json`)
- 主键 `npc_id`（源码路径）。字段：`name`+`aliases`(交互用), `nickname`, `attitude`
  (friendly/neutral/hostile→WorldSummary.entities.npcs.attitude), `class`, `sect`,
  `is_master`(可拜师), `teaches[skill_id…]`, `combat_exp`(实力≈危险度)。
- 来源：`inherit NPC` + `set_name` + `set("attitude")` + `inherit F_MASTER` + `set_skill(...)`。
- 关系：NPC member_of Sect；Master NPC teaches Skill；NPC located_in Room（见 Room.npcs）。
- 对 agent：找师傅学武 → 过滤 `is_master && teaches⊇{想学的}`；判断能否打 → 比 combat_exp。

## 5. Skill 武功/功法  (`data/skills.json`)
- 主键 `skill_id`(文件名，如 `luohan-quan`)。`types[]` 来自 `valid_enable` 的 usage：
  force(内功)/parry(招架)/dodge,move(轻功闪避)/sword,blade,staff,whip,club,hook,pike,hammer,halberd(兵器)/
  strike,cuff,hand,finger,claw,kick(徒手)/throwing/spell。
- 关系：Skill enabled_as usage（决定战斗角色）；Skill taught_by Master(见 npcs.teaches)；Skill belongs_to Sect。
- 机制：学武耗 potential，受 悟性 与 武学常识 上限限制；兵器类需装备对应兵器，徒手退回拳脚；
  内功(force)是资源底座，需先 `enable` 才能施展特异功能。

## 5.5 SkillMechanics 武功机制  (`data/skill_mechanics.json`)
- 主键 `skill_id`，补充 `skills.json` 不承载的决策细节：`valid_learn.requirements[]`,
  `practice.requirements[]`, `performs[]`, `action_unlocks[]`, `source_files[]`。
- 来源：`scripts/build_kb.py` 从 skill 主文件与 `run/kungfu/skill/<skill_id>/*.c` perform 文件抽取常见条件，
  少林核心技能再用手工校正覆盖关键门槛。
- `skills.json` 是基础索引；`skill_mechanics.json` 才是“能不能学、怎么练、perform 需要什么”的依据。
- **perform 与招式动作不同**：`query_action`/`query_skill_name` 中的招式名是普通出招动作或等级解锁；
  `perform_action_file()` 指向的子目录文件才是主动绝招/perform。例：`shaolin-shenfa` 没有对应 perform
  子目录，学到中高级只扩大 dodge 动作池，不提供主动 perform。

## 6. Sect 门派
- 代码列表（`run/kungfu/class/`）：shaolin 武当wudang emei gaibang(丐帮) huashan quanzhen(全真)
  mingjiao(明教) dali(大理) baituo(白驼) gumu(古墓) lingjiu(灵鹫) murong(慕容) taohua(桃花)
  shenlong(神龙) xingxiu(星宿) xixia(西夏) xuedao xueshan。
- 关系：Sect has Master(s) → teaches sect Skills；Player member_of Sect（`family`）。
- 门规示例（解析表已编码）：少林山门 `valid_leave` 拒女性/持兵器/外门派上 eastup（`run/d/shaolin/shanmen.c`）。

## 6.5 Quest 任务  (`data/quests.json` + `references/quests.md`)
- 实体：`Quest(giver@Room, prerequisites, tool, fill/use verb@Room, monitor, rewards, cooldown)`。
- 关系：Quest given_by NPC；requires {family/combat_exp/flag/cooldown/potential/literate}；
  uses Object（动作动词绑定在**具体房间的 add_action**）；turned_in_to NPC checks Object.state+Player.condition；
  rewards potential/combat_exp 并清 flag/condition、置 cooldown。
- **核心认知**：能否做任务由源码 `add_action`/`accept_object`/`apply_condition` 决定，**不能从房间描述推断**。
  例：少林挑水的 `yao shui` 取水动词只在 `riverbank.c` 硬编码；后殿"清水井"虽近但无此动词 ⇒ 死路（详见 quests.md §1.2）。
- 随机出口任务（如 `shanlu.c` 山路返回腿在 create() 随机设出口）不在静态图，agent 必须运行时读 exits 自探。
- 进阶主线=拜师学艺：`find_master.py --skill X --from 这里` → masters.json 找师傅+route → `learn/study`，受潜能/常识/exp/门派闸门。

## 7. 运行时记忆（agent 自积累，跨会话；与静态库分离）
gateway 当前缺长期记忆，COMPACT 会丢信息。建议 agent 维护 `memory.json`：
去过的房间（补全 map 缺口）、遇到的 NPC、任务进度、关键事件摘要、当前门派/身份。
静态库回答"世界是什么样"，记忆回答"我经历了什么、现在的目标"。

## 8. 决策落地优先级
1. **解析**：用 `status-patterns.json` 升级 `parseFluffosText`（查表 > 启发式）——感知准确率最大提升。
2. **导航**：`route.py` 解决扬州↔少林等已知路线；断链处 agent 自探。
3. **目标**：用 `find_master.py`(masters.json) + `quests.json` 给 agent "去找谁学什么/做哪个任务"的目标，而非乱逛。
4. **记忆**：积累 memory.json（任务进度/condition ttl/携带物状态），越玩越懂这台服务器。
```
