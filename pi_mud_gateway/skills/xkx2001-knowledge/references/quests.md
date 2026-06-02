# 任务体系（Quests）— 已对源码核对

> 机器可读目录见 `data/quests.json`。本文件解释任务的世界模型、判定机制与给 agent 的执行要点。
> 找师傅/学武功用 `scripts/find_master.py`，求路线用 `scripts/route.py`。

## 0. 任务在世界模型中的位置（ontology）

```
Player --has--> Condition(name, ttl)        # 任务多用 condition 计时/标记 (apply/query_condition)
Player --has--> Flag(job_asked, ts_pending) # 接任务/冷却 的布尔标记
Quest  --given_by--> NPC(giver) @ Room
Quest  --requires--> {family, combat_exp, !flag, !cooldown, potential, literate}
Quest  --uses--> Object(tool)  --filled_at/used_at--> Room(special verb add_action)
Quest  --turned_in_to--> NPC(monitor)  --checks--> Object.query(state) & Player.condition
Quest  --rewards--> {potential, combat_exp}  --and clears--> Flag/Condition  --sets--> cooldown
```

关键认知：**任务的"能不能做"几乎全由源码里的 `add_action` 动词位置 + `accept_object`/`apply_condition` 判定决定**，
不能从房间描述（long/short）推断。描述里提到某物（如"清水井"）≠ 那里有对应动作动词。

## 1. 少林挑水任务（water-carrying）— 完整链路

**用途**：少林低级弟子刷 潜能 + 经验 的循环杂役。也是教会 agent loop"取物→携带→走随机出口→交付"的范例。

### 1.1 流程
1. **接任务**：到 `/d/shaolin/fzlou`（方丈楼/知客处）→ `ask <知客僧> about 挑水`。
   - 前置（`npc/tiaoshui1.h`）：family==少林派、combat_exp≤500000、未 job_asked、ts_pending 冷却已过。
   - 成功后置：set `job_asked`；给 `tiaoshui` condition = `2000 + random(600)`（**时间预算**，过期则交付失败）。
2. **取桶**：到 `/d/shaolin/chufang`（厨房）拿 **水桶 tong**（`obj/tong.c`）。
   - 动词：`tiao`(挑起) / `fang`(放下，舀水前必须先放下，置 tong_pos) / `dao`(把瓢里水倒进桶)。
3. **去河边灌水**：到 `/d/shaolin/riverbank`。
   - 循环：`yao shui`（舀水入瓢，1/100 出水）→ `dao`（倒入桶，water_level+1）→ 重复直到 `water_level==5` ⇒ 桶 `set("full",1)`。
4. **挑桶走山路返回**：`riverbank → shanlu → …(随机出口)… → chufang`。见 §1.3 随机出口。
5. **交付**：把满桶 `give tong to <挑水监督>`（`npc/tiaoshui2.h`）。
   - 检查：`tong.query("full")` && job_asked && 有 `tiaoshui` condition（没过期）&& 桶 owner 是本人。
   - 奖励：potential + 少量 combat_exp；清 job_asked / tiaoshui condition；置 ts_pending 冷却。

### 1.2 后殿水井是不是更近的取水点？——**不是，是死路**
- `run/d/shaolin/houdian.c` 只有 `set("resource/water",1)` 并在 long 里写了「佛心清水井」，但**没有 `add_action("do_yao","yao")`**。
- `yao shui` 这个取水动作**只硬编码在 `riverbank.c` / `npc/riverbank.c` 的 `init()` 里**（且要求挑水者已 job_asked）。
- 交付端（`tiaoshui2.h accept_object`）只检查桶 `full`，**不检查取水地点**；但 `full` 只能由 `dao` 倒入「在河边用 `yao` 灌满的瓢」累积而来。
- **结论**：后殿水井再近也灌不满桶。河边取水 + 山路随机返回是**强制路径**，没有捷径。

### 1.3 山路随机出口（agent 必须运行时自探）
- `run/d/shaolin/shanlu.c` 在 `create()` 里**随机设置**出口：`southdown→riverbank` 恒有，外加 `{up|westup|northwest|northup}` 之一 `→shanlu1`（每次 reset 变）。
- `valid_leave` 有概率（约 1/30）打滑/泼洒/摔桶/跌倒。
- 因此**返回腿不是固定图路径**（不在 `map.json`，见 `warnings.json`）：agent 每次进 shanlu 要 `look`/读 exits 选当前活动的那个上行出口；若桶泼了，回河边重灌。
- 这就是现有 gateway skill 里要 `shaolin_water_return_riverbank_to_shanlu_probe` + 四个 `..._via_{up|westup|northwest|northup}` 变体的原因。

### 1.4 失败模式
- `tiaoshui` condition 过期（时间预算耗尽）→ 交付被拒。
- 山路打滑/摔桶 → water_level 归零，回河边重灌。
- 取水地点错（如试后殿水井）→ 桶永远到不了 `full`，无法交付。
- combat_exp>500000 或 非少林派 → 知客僧拒发任务。

## 2. 拜师学艺（进阶主线）— 用 masters.json 驱动

侠客行的核心成长循环 = **入门(bai/拜师) → 反复 learn/study 武功**，由潜能、学生 combat_exp、门派身份、武学常识(literate) 共同闸门。

### 2.1 给 agent 的执行式
```bash
# 1) 想学某武功，先问"谁教、在哪、怎么走"
python scripts/find_master.py --skill <skill_id> --from <当前房间或中文区名>
#    例: --skill luohan-quan --from 少林    /    --skill taiji-jian --from 扬州
# 2) 走过去（route 已由 find_master 内嵌打印；或单独 route.py）
# 3) 在场: learn <master> <skill>  反复，直到提示潜能/常识不足
#         study / lian <skill> 把潜能转成等级; 若是内功(force)先 dazuo 攒内力
```

### 2.2 闸门（学不动时对照）
- **潜能 potential**：learn 消耗潜能，不足就去刷（挑水等杂役 / 打怪）。
- **学生 combat_exp / 前置武功**：很多 teaching apply 要求达到某 exp 或先学某基础。
- **武学常识 literate**：决定武功可学到的**等级上限**；读书识字提升（见 `attributes.md §5`）。
- **门派身份 family**：门派限定武功必须先入该门派。

### 2.3 数据
- `data/masters.json`：191 位师傅，139 位有固定房间。字段 name/npc_id/sect/teaches[]/combat_exp/room_id/room_short/area。
- `data/skills.json`：skill_id → types[]（force/sword/parry/dodge/blade/cuff/…）。
- **注意**：`npc_id` 以 `/kungfu/class/` 开头的是师傅**类 mixin**（无固定房间，room_id=null）；真正站在房间里的是继承它的 `/d/<area>/npc/` 具体 NPC。`find_master` 两者都列，只对有 room_id 的求路线。

### 2.4 找师傅示例（来自实际数据）
| 想学 | 低 exp 师傅 | 在 | 教（节选） |
|---|---|---|---|
| force/罗汉拳 | 清无比丘 (exp 20000) | 广场 /d/shaolin/guangchang1e | force, luohan-quan, cibei-dao, shaolin-shenfa |
| 风云手 | 道成禅师 (exp 50000) | 练武场 /d/shaolin/wuchang3 | fengyun-shou, luohan-quan, force |
| 太极剑 | 制香道长 (exp 30000, 武当) | (类mixin) | taiji-jian, taiji-quan, taoism, sword |
| 全真剑 | 姬清虚 (exp 40000, 全真) | 重阳宫广场 /d/zhongnan/guangchang | quanzhen-jian, chunyang-quan, jinyangong, sword |

## 3. 给 gateway 的接入建议
1. 任务状态进 `WorldSummary`/runtime memory：当前 condition（含 ttl）、job_asked/ts_pending、携带物 full 状态。
2. 挑水 loop 用现成 route-skills（`pi_mud_gateway/skills/shaolin-water-carrying/`）；shanlu 段必须运行时读 exits 选活动出口，不要写死。
3. 学艺 loop：目标武功 → `find_master.py` → `route.py` → `learn/study`；学不动时按 §2.2 闸门去补潜能/常识/exp。
4. 取水/学艺等"动作动词"绑定在具体房间的 `add_action`，**不可由房间描述推断**——拿不准就 grep 源码或先在场试一次再缓存到 memory。
