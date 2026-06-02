---
name: shaolin-water
description: 快速执行少林挑水任务。优先调用 shaolin_fetch_water 工具一键跑完整流程；若失败则回退到 action 分步执行并修正路线步数。
---

# Shaolin Water

用于在 MUD 中高效完成少林挑水任务循环。

## 触发时机

- 用户提到“挑水任务”“少林挑水”“水桶/水瓢”“快速刷潜能”等。
- 用户明确要求自动化执行挑水流程。

## 首选执行方式（推荐）

优先调用：

```text
shaolin_fetch_water({"route":"hanriver"})
```

如果交任务失败，按日志重试：

```text
shaolin_fetch_water({"route":"hanriver","southSteps":7,"returnSteps":7})
```

如后殿水井可用：

```text
shaolin_fetch_water({"route":"well"})
```

## 标准任务流程（回退方案）

当一键工具失败时，用 `action` 分步执行并观察每步输出：

1. `ask zhike about 挑水`
2. `ask shaofan about 水桶`
3. `ask shaofan about 水瓢`
4. 前往取水点（汉水岸边或后殿水井）
5. `yao shui` × 5
6. `putdown tong`
7. `dao shui to tong` × 5
8. 回少林厨房 `give shui tong to shaofan`

## 执行策略

- 默认优先 `shaolin_fetch_water`，减少 token 与回合开销。
- 发现“你现在不在这里/不能这样做/找不到对象”时，立即改用 `action` 定位当前位置并修正路径。
- 完成后提醒用户：可去师傅处练功；状态不足去斋厅补给后继续循环。
