#!/usr/bin/env python3
"""
route.py — shortest walk route over the room graph in map.json (BFS).

Usage:
  python route.py --map data/map.json --from 扬州 --to 少林
  python route.py --map data/map.json --from /d/city/dajie1 --to /d/shaolin/shanmen
  python route.py --map data/map.json --from /d/city --to /d/shaolin   # area dirs ok

--from/--to accept:
  * an exact room_id  (/d/city/dajie1)
  * an area dir prefix (/d/city)            -> a well-connected room in that area
  * a Chinese area name (扬州, 少林)        -> via areas.json region names
  * a fuzzy term matched on room 'short'

Output: ordered (direction, room name) the agent can walk via send_command("go <dir>").
No path -> says so explicitly (map likely missing a cross-area special exit), never guesses.
"""
import argparse, json, os
from collections import deque

def load_map(path):
    data = json.load(open(path, encoding='utf-8'))
    return {r["room_id"]: r for r in data.get("rooms", []) if r.get("room_id")}

def load_areas(map_path):
    p = os.path.join(os.path.dirname(map_path), 'areas.json')
    cn2code = {}
    if os.path.exists(p):
        for a in json.load(open(p, encoding='utf-8')).get('areas', []):
            if a.get('name_cn'):
                cn2code[a['name_cn']] = a['area']
    return cn2code

def resolve_set(term, rooms, cn2code):
    """Return (label, set_of_candidate_room_ids). A single room_id -> {that room};
    an area (dir prefix / Chinese name / area code) -> all its rooms; else fuzzy short."""
    if term in rooms:
        return term, {term}
    code = None
    for cn, c in cn2code.items():
        if term in cn:
            code = c; break
    cand = []
    if term.startswith('/'):
        cand = [rid for rid in rooms if rid.startswith(term.rstrip('/') + '/')]
    if not cand and code:
        cand = [rid for rid, r in rooms.items() if r.get('area') == code]
    if not cand:
        cand = [rid for rid, r in rooms.items()
                if (r.get('short') and term in r['short']) or (r.get('area') and term == r['area'])]
    return term, set(cand)

def bfs(starts, goals, rooms):
    """Multi-source BFS: shortest walk from any start room to any goal room."""
    if starts & goals:
        return [], next(iter(starts & goals))
    prev = {}; q = deque()
    for s in starts:
        if s in rooms:
            prev[s] = None; q.append(s)
    while q:
        cur = q.popleft()
        for d, tgt in rooms.get(cur, {}).get("exits", {}).items():
            if tgt in rooms and tgt not in prev:
                prev[tgt] = (cur, d)
                if tgt in goals:
                    path, node = [], tgt
                    while prev[node] is not None:
                        p, dir_ = prev[node]
                        path.append((dir_, rooms[node].get("short") or node))
                        node = p
                    return list(reversed(path)), tgt
                q.append(tgt)
    return None, None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--map', required=True)
    ap.add_argument('--from', dest='src', required=True)
    ap.add_argument('--to', dest='dst', required=True)
    args = ap.parse_args()
    rooms = load_map(args.map); cn2code = load_areas(args.map)
    _, starts = resolve_set(args.src, rooms, cn2code)
    _, goals = resolve_set(args.dst, rooms, cn2code)
    if not starts: print(f"起点未找到: {args.src}"); return
    if not goals: print(f"终点未找到: {args.dst}"); return
    path, goal = bfs(starts, goals, rooms)
    if path is None:
        print(f"图中无连通路径 {args.src} -> {args.dst}（搜索了 {len(starts)} 个起点房间、{len(goals)} 个终点房间）。"
              f"\n多半是跨区特殊出口（船/镖局/传送/城门）未被静态抓取，见 warnings.json，或让 agent 自探补齐那几跳。")
        return
    end = rooms[goal].get('short') or goal
    print(f"路线 {args.src} -> {end}({goal})  共 {len(path)} 步:")
    for d, name in path:
        print(f"  go {d:<8} -> {name}")

if __name__ == '__main__':
    main()
