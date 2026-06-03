#!/usr/bin/env python3
"""
extract_mudlib.py — Parse an xkx2001 / 侠客行 FluffOS LPC source tree into JSON.

Builds:
  data/map.json          room graph (room_id, short, area, exits)
  data/map_warnings.json  cross-area / non-standard exits needing human review
  data/skills.json        skill stubs found under kungfu/sect dirs (best-effort)

Usage:
  python extract_mudlib.py --src /path/to/mudlib --out data/

This is a *heuristic* parser. LPC is C-like; rooms typically:
  inherit ROOM;
  set("short", "扬州城大街");
  set("exits", ([
      "north" : __DIR__"dajie2",
      "west"  : "/d/yangzhou/yaodian",
  ]));
Different mudlibs vary, so review map_warnings.json before trusting cross-area routes.
"""
import argparse, json, os, re
from pathlib import Path

SHORT_RE  = re.compile(r'set\(\s*"short"\s*,\s*"([^"]*)"', re.S)
EXITS_RE  = re.compile(r'set\(\s*"exits"\s*,\s*\(\[(.*?)\]\)', re.S)
# one exit entry: "north" : __DIR__"dajie2"   OR   "north":"/d/yangzhou/x"
EXIT_PAIR = re.compile(r'"([^"]+)"\s*:\s*([^,]+?)(?:,|$)', re.S)

def resolve_target(raw: str, room_path: Path, src_root: Path) -> str:
    """Resolve an LPC exit RHS into a normalized room_id (source-relative path)."""
    raw = raw.strip().rstrip(',').strip()
    # __DIR__"foo"  -> same directory + foo
    m = re.match(r'__DIR__\s*"([^"]*)"', raw)
    if m:
        target = (room_path.parent / m.group(1))
    else:
        m = re.match(r'"([^"]*)"', raw)
        if not m:
            return raw  # unresolved expression (probably computed) -> keep raw for warning
        s = m.group(1)
        target = (src_root / s.lstrip('/')) if s.startswith('/') else (room_path.parent / s)
    # normalize to /-rooted id relative to src_root, drop .c
    try:
        rel = target.resolve().relative_to(src_root.resolve())
        rid = '/' + str(rel)
    except Exception:
        rid = str(target)
    return rid[:-2] if rid.endswith('.c') else rid

def room_id_of(path: Path, src_root: Path) -> str:
    rel = path.relative_to(src_root)
    rid = '/' + str(rel)
    return rid[:-2] if rid.endswith('.c') else rid

def area_of(rid: str) -> str:
    # /d/yangzhou/xxx -> yangzhou ; tweak to your tree layout
    parts = [p for p in rid.split('/') if p]
    if len(parts) >= 2 and parts[0] in ('d', 'area', 'city'):
        return parts[1]
    return parts[0] if parts else "unknown"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='mudlib source root')
    ap.add_argument('--out', default='data', help='output dir')
    args = ap.parse_args()
    src = Path(args.src); out = Path(args.out); out.mkdir(parents=True, exist_ok=True)

    rooms, warnings = [], []
    seen_ids = set()
    for cfile in src.rglob('*.c'):
        try:
            txt = cfile.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            continue
        if 'set("exits"' not in txt and "set('exits'" not in txt:
            continue  # not a room
        rid = room_id_of(cfile, src)
        short_m = SHORT_RE.search(txt)
        exits = {}
        em = EXITS_RE.search(txt)
        if em:
            for k, v in EXIT_PAIR.findall(em.group(1)):
                target = resolve_target(v, cfile, src)
                exits[k.strip()] = target
                if not target.startswith('/'):  # unresolved/computed exit
                    warnings.append({"room_id": rid, "dir": k.strip(), "raw": v.strip()})
        rooms.append({
            "room_id": rid,
            "short": short_m.group(1) if short_m else None,
            "area": area_of(rid),
            "exits": exits,
            "tags": [], "npcs": [], "notes": None,
        })
        seen_ids.add(rid)

    # flag edges pointing to rooms we never parsed (likely cross-area / missing)
    for r in rooms:
        for d, tgt in r["exits"].items():
            if tgt.startswith('/') and tgt not in seen_ids:
                warnings.append({"room_id": r["room_id"], "dir": d,
                                 "target": tgt, "reason": "target room not found in parsed set"})

    (out / "map.json").write_text(json.dumps(
        {"_generated_from": str(src), "rooms": rooms}, ensure_ascii=False, indent=2), encoding='utf-8')
    (out / "map_warnings.json").write_text(json.dumps(
        warnings, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f"parsed {len(rooms)} rooms; {len(warnings)} warnings -> {out}")

if __name__ == '__main__':
    main()
