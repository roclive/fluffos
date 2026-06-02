# 常识规则（生存 / 操作 / 危险 / 礼仪）

供 agent 决策的"常识"层。生存/操作规则从源码核对，危险点举例为主。机器可读的状态/危险
阈值见 `status-patterns.json`；这里是人类可读的策略。

## 生存常识
- **低血先撤**：`气`(hp) 当前/有效上限 < 30%（解析表 danger 档）→ 停止进攻，`flee` 或运功疗伤。
  < 10%（critical）→ 立即 `flee`，别赌下一招。死亡条件：qi/jing/jingli 任一 < 0（`char.c:115`）。
- **内伤要养不要硬扛**：`hp` 行的 (%) < 100% = 有效上限被打折（内伤）。只补气无用，须 `dazuo`/静坐/疗伤
  恢复有效上限，再战。
- **内力是发招前提**：`neili` 低 → 改普通攻击或先 `dazuo` 补内力；内功特异功能须先 `enable <内功>`。
- **wimpy 自动逃**：可设 `set wimpy <百分比>`，战斗中任一资源比例 ≤ wimpy 自动逃跑（`char.c:130`），
  给 agent 一道保命兜底。
- **没钱先变现**：补给/拜师/买药需钱；钱庄(bank)存取，商店 sell 变现。

## 操作常识（命令语法，本服务器实测）
- 移动：`<dir>` 或 `go <dir>`；方向是英文/拼音，含复合方向 `eastup` `northwest` 等（照 look 出口原样发）。
- 观察：`look`/`l`，看物/看人 `look <名>`；状态 `hp`、`score`/`sc`；背包 `i`；武功 `skills`。
- 战斗：`kill <目标>`(生死斗) / `fight <目标>`(切磋)；逃 `flee`。禁战区会被"这里禁止战斗"拒绝。
- 内功：`enable <内功>` → `exert <func>`(运功疗伤等) / `perform <skill> <target>` / `dazuo`(打坐) / `yun`。
- 学武：`learn <师傅> <武功>`；师傅见 `npcs.json` 里 `is_master==true` 且 `teaches` 含目标武功。
- 这些"动作集"应动态填进 `WorldSummary.capabilities.available_actions`（按当前 busy/combat/有无兵器裁剪）。

## 危险常识
- **强 NPC 秒杀**：门派/野外大佬 `combat_exp` 极高（如澄观 60万）。打前比 combat_exp，差距大别打。
- **禁战区**：城内多处禁战（"这里禁止战斗/不准战斗"），别在禁战区指望打架解决问题。
- **门规拦路**：少林山门拒女性、拒持兵器、拒外门派走 eastup（`shanmen.c`）。进门派前 `unwield` 兵器、看性别/门派限制。
- **昏迷链**：受重伤掉精，精竭则气崩；"已经陷入半昏迷状态"是死亡前兆，立即脱离。

## 礼仪 / 反作弊
- **别刷屏**：gateway `turnIntervalMs` 很短(150ms)，连发命令易被服务器判为外挂/刷屏。
  busy 动作（疗伤、舀水、打坐、长渡船）必须用 per-step `waitMs` 等待完成，不要短间隔狂发
  （已知坑见 `skills/shaolin-water-carrying`）。
- **busy 时不连发**："你正忙着呢" / "上一个动作还没有完成" 命中 → 等待，别堆命令。
- **cooldown**：`WorldSummary.capabilities.cooldowns` 应被填上并尊重（当前留空未用）。
