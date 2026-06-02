# 地图 / 房间图 schema

地图本质是一张**有向图**：节点=房间，边=出口方向。路线查询 = 图上的最短路径（BFS）。

## 节点格式（`data/map.json` 的 rooms 数组元素）

```json
{
  "room_id": "/d/yangzhou/dajie1",      // LPC 源码文件路径，全局唯一主键
  "short": "扬州城大街",                  // set("short", ...)
  "area": "扬州",                         // 区域归属（按目录或 region 推断）
  "exits": { "north": "/d/yangzhou/dajie2", "west": "/d/yangzhou/shop" },
  "tags": ["city", "safe"],              // 可选：城镇/野外/危险区/有传送
  "npcs": ["店小二"],                     // 可选：常驻 NPC（用于"在哪能找到X"）
  "notes": "可在此购物"                   // 可选
}
```

- `room_id` 用源码文件路径，是最稳的唯一键（游戏内 look 不一定给 id）。
- `exits` 的方向用小写英文/拼音方向（north/south/east/west/up/down/北/南… 按服务器实际）。
- 边的 value 是目标房间的 `room_id`。

## 路线查询语义

`scripts/route.py` 在该图上做 BFS：
- 输入起点、终点（可用 room_id，或用 short/area 模糊匹配自动解析到 room_id）。
- 输出：方向序列（agent 直接照着 `send_command("go north")` 走）+ 经过的房间名。
- 找不到路 → 明确返回"图中无连通路径，可能地图未抓全"，**不要让 agent 瞎猜方向**。

## "扬州 → 少林" 怎么得到真实路线

1. 跑 `extract_mudlib.py` 把扬州目录、少林目录、以及沿途所有区域的房间都抓进图。
   ——注意：跨区域往往靠"特殊出口"（船、镖局、传送、城门连接），这些在源码里可能是
   非标准 exit（比如在 NPC 或 `do_go` 里硬编码），提取脚本会把可疑跨区连接单独列到
   `data/map_warnings.json` 让你人工确认。
2. `python scripts/route.py --from 扬州 --to 少林`。
3. 若中间断链（常因跨区特殊出口没抓到）→ 用 agent 自探补齐那几跳。

## agent 自探补图（无源码时的唯一可靠法）

每到一个房间，从 `look` 输出解析 `short` 与"明显的出口"，构造节点 append 进 map.json：
gateway 的 `parseFluffosText` 已经在解析 exits，只需把"当前房间→出口"持久化即可逐步成图。
