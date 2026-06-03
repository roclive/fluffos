#!/usr/bin/env python3
"""
route.py — shortest walk route over the room graph in map.json.

Usage:
  python route.py --map data/map.json --from 扬州 --to 少林
  python route.py --map data/map.json --from /d/yangzhou/dajie1 --to /d/shaolin/gate

--from / --to accept either a room_id (starts with /) or a fuzzy term matched
against room 'short' or 'area'. If fuzzy term matches many rooms, the first
city/safe-ish match is used; pass a room_id to be exact.

Output: an ordered list of (direction, room name) the agent can walk, e.g.
  go north  -> 扬州城大街
  go west   -> 城门
If no path exists it says so explicitly (map likely incomplete) rather than guessing.
"""
import argparse, json
from collections import deque

def load(path):
    data = json.load(open(path, encoding='utf-8'))
    rooms = {r["room_id"]: r for r in data.get("rooms", []) if r.get("room_id")}
    return rooms

def resolve(term, rooms):
    if term.startswith('/') and term in rooms:
        return term
    # fuzzy: match short or area substring
    hits = [rid for rid, r in rooms.items()
            if (r.get("short") and term in r["short"]) or (r.get("area") and term in r["area"])]
    return hits[0] if hits else None

def bfs(start, goal, rooms):
    if start == goal:
        return []
    q = deque([start]); prev = {start: None}
    while q:
        cur = q.popleft()
        for d, tgt in rooms.get(cur, {}).get("exits", {}).items():
            if tgt in rooms and tgt not in prev:
                prev[tgt] = (cur, d)
                if tgt == goal:
                    # reconstruct
                    path = []
                    node = goal
                    while prev[node] is not None:
                        p, dir_ = prev[node]
                        path.append((dir_, rooms[node].get("short") or node))
                        node = p
                    return list(reversed(path))
                q.append(tgt)
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--map', required=True)
    ap.add_argument('--from', dest='src', required=True)
    ap.add_argument('--to', dest='dst', required=True)
    args = ap.parse_args()
    rooms = load(args.map)
    s = resolve(args.src, rooms); g = resolve(args.dst, rooms)
    if not s:  print(f"起点未找到: {args.src}"); return
    if not g:  print(f"终点未找到: {args.dst}"); return
    path = bfs(s, g, rooms)
    if path is None:
        print(f"图中无连通路径 {s} -> {g}。地图很可能未抓全（常见于跨区特殊出口），"
              f"请检查 map_warnings.json 或用 agent 自探补齐。")
        return
    print(f"路线 {rooms[s].get('short') or s} -> {rooms[g].get('short') or g}  共 {len(path)} 步:")
    for d, name in path:
        print(f"  go {d:<6} -> {name}")

if __name__ == '__main__':
    main()
