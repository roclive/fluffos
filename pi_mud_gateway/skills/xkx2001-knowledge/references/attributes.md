# 角色属性体系（精 / 气 / 精力 / 内力）— 已对源码核对

> 来源已核对：`run/cmds/usr/hp.c`（命令 `hp` 输出）+ `run/inherit/char/char.c`（heart_beat 生死逻辑）。
> 机器可读的解析正则与状态机见 `status-patterns.json`，本文件解释"含义与机制"。

## 1. `hp` 命令真实输出布局（核对自 hp.c:29-49）

```
 精： {jing}/ {eff_jing} ({jing有效上限%})    精力： {jingli} / {max_jingli} (+{jiajin})
 气： {qi}/ {eff_qi} ({qi有效上限%})          内力： {neili} / {max_neili} (+{jiali})
 食物： {food}/ {max}                          潜能： {potential} / {max_potential}
 饮水： {water}/ {max}                          经验： {combat_exp}
```
数值外包 ANSI 颜色码，解析前先 strip `\[[0-9;]*m`。

## 2. 四条动态资源 → WorldSummary

| 游戏内 | 字段 | WorldSummary | 含义 | 归零后果 | 恢复 |
|---|---|---|---|---|---|
| 气 | qi / eff_qi / max_qi | hp / hp_max | 主生命，承伤 | qi<0 昏迷→死(char.c:115) | 休息、疗伤、静坐、药 |
| 精 | jing / eff_jing / max_jing | jing / jing_max | 精元，重伤掉精 | jing<0 死 | 打坐、睡眠 |
| 精力 | jingli / max_jingli | mp | 行动耐力，走/战消耗 | jingli<0 死；低→busy/迟缓 | 休息、停下 |
| 内力 | neili / max_neili | neili | 驱动招式、运功疗伤 | 低→高级招式不可用 | dazuo 打坐运功 |

## 3. 两种"满度"——务必区分（决策关键）

`hp` 一行有两个比例，含义不同：
1. **当前 / 有效上限**（如 `气： 120/ 200`）= 即时承伤余量 → 直接的战斗危险度。
2. **有效上限 / 真上限**（行尾 `(85%)`，= eff_qi*100/max_qi）= **内伤**程度。
   < 100% 表示有效上限被打低，受了内伤；只补气无效，须静坐/疗伤恢复有效上限。

危险阈值（核对自 `status_color` hp.c:53-65，按 当前/有效上限 比例）：
≥90 健康 / ≥60 正常 / ≥30 注意 / ≥10 **低血(撤离/疗伤)** / <10 **危急(立即 flee)**。
自动逃跑：战斗中任一资源比例 ≤ `env/wimpy` 触发(char.c:130)。

## 4. 先天四维（建号设定，基本固定）

膂力 str（负重、外功伤害）/ 悟性 int（学习速度、可学上限）/ 根骨 con（气血上限、抗打）/
身法 dex（闪避、出手速度、轻功）。

## 5. 成长资源

| 名称 | 字段 | 含义 |
|---|---|---|
| 经验 | combat_exp | 战斗积累，决定等级称号/实力比较 |
| 潜能 | potential / max_potential | 学/升武功消耗的点数 |
| 武学常识 | literate | 武功可学到的等级上限闸门（读书识字提升） |
| 食物/饮水 | food / water | 过低饿/渴，影响恢复 |

## 6. PlayerState 标志（解析见 status-patterns.json §messages）
- `busy`："你正忙着呢" / "上一个动作还没有完成" → 有读条动作，勿连发命令。
- `combat`：进入(击中/招架/闪避/大吼想杀死)，**退出必须靠文案清除**(被…死了/逃离/的尸体)——
  旧 parser 只置 true 从不置 false，是已知 bug。
- `disabled`：" <昏迷不醒>"(char.c:121) / "已经陷入半昏迷状态"(combatd.c:195)。
