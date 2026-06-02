#!/usr/bin/env python3
"""
build_kb.py — Extract a game-world ontology from the live xkx2001 (侠客行) FluffOS
mudlib into JSON the pi-agent / mud_gateway loop can query.

Outputs (into --out, default ../data):
  map.json     room graph: room_id, short, area, exits{dir:room_id}, npcs[], indoors
  areas.json   area code -> Chinese name (from d/REGIONS.h) + room counts
  npcs.json    npc_id, name, aliases, attitude, sect/class, is_master, teaches[], power
  skills.json  skill_id, name(best-effort), types[] (from valid_enable), sect
  warnings.json edges/targets that did not resolve (cross-area / computed exits)

Run:
  python build_kb.py --src ../../../../run --out ../data
(paths are relative to this script's location by default)

This is a heuristic LPC parser. xkx rooms look like:
    inherit ROOM;
    set("short","少林寺");
    set("exits", ([ "eastup":__DIR__"shijie8", "west":"/d/city/x" ]));
    set("outdoors","shaolin");
    set("objects",([ CLASS_D("shaolin")+"/xu-tong":1 ]));
NPCs:  inherit NPC; set_name("澄观",({...})); set("attitude","friendly");
       set("class","bonze"); inherit F_MASTER; set_skill("force",100);
"""
import argparse, json, os, re
from pathlib import Path

# ---- regexes -------------------------------------------------------------
SHORT_RE   = re.compile(r'set\(\s*"short"\s*,\s*"([^"]*)"')
OUTDOOR_RE = re.compile(r'set\(\s*"(?:outdoors|indoors)"\s*,\s*"([^"]*)"')
IS_INDOOR  = re.compile(r'set\(\s*"indoors"')
EXITS_BLOCK= re.compile(r'set\(\s*"exits"\s*,\s*\(\[(.*?)\]\)\s*\)', re.S)
OBJS_BLOCK = re.compile(r'set\(\s*"objects"\s*,\s*\(\[(.*?)\]\)\s*\)', re.S)
PAIR_RE    = re.compile(r'"([^"]+)"\s*:\s*(.+?)(?:,\s*(?="[^"]+"\s*:)|,?\s*$)', re.S)

SETNAME_RE = re.compile(r'set_name\(\s*"([^"]*)"\s*,\s*\(\{(.*?)\}\)', re.S)
ALIAS_RE   = re.compile(r'"([^"]+)"')
ATTITUDE_RE= re.compile(r'set\(\s*"attitude"\s*,\s*"([^"]*)"')
CLASS_RE   = re.compile(r'set\(\s*"(?:class|family)"\s*,\s*"([^"]*)"')
NICK_RE    = re.compile(r'set\(\s*"nickname"\s*,\s*"([^"]*)"')
GENDER_RE  = re.compile(r'set\(\s*"gender"\s*,\s*"([^"]*)"')
EXP_RE     = re.compile(r'set\(\s*"combat_exp"\s*,\s*(\d+)')
SETSKILL_RE= re.compile(r'(?:set_skill|map_skill|learn)\(\s*"([a-z0-9_\-]+)"')
VALID_EN_RE= re.compile(r'valid_enable\s*\([^)]*\)\s*\{[^}]*?return([^;}]+)')
USAGE_RE   = re.compile(r'usage\s*==\s*"([a-z0-9_\-]+)"')

def read(p: Path) -> str:
    try:
        return p.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return ''

def room_id_of(path: Path, src: Path) -> str:
    rid = '/' + str(path.relative_to(src))
    return rid[:-2] if rid.endswith('.c') else rid

def resolve_expr(raw: str, room_dir: str) -> str:
    """Resolve an LPC path expression (exit/object RHS) to a /-rooted room_id.
    Handles __DIR__, CLASS_D(x), SKILL_D(x), string concat of quoted literals,
    absolute "/d/..." and relative "file" paths. Returns '' if unresolvable."""
    s = raw.strip().rstrip(',').strip()
    s = s.split('//')[0].strip()
    # strip trailing ": 1" count if it leaked from objects parsing
    # macro substitutions -> quoted literals
    s = re.sub(r'__DIR__', f'"{room_dir}/"', s)
    s = re.sub(r'CLASS_D\(\s*"([^"]+)"\s*\)', r'"/kungfu/class/\1"', s)
    s = re.sub(r'SKILL_D\(\s*"([^"]+)"\s*\)', r'"/kungfu/skill/\1"', s)
    # now collect quoted literals joined by '+'
    if '+' in s or s.startswith('"'):
        parts = re.findall(r'"([^"]*)"', s)
        if not parts:
            return ''
        # only safe if the whole expr is literals + '+' (no unresolved identifiers)
        stripped = re.sub(r'"[^"]*"', '', s).replace('+', '').strip()
        if stripped:  # leftover identifier => computed, give up
            return ''
        joined = ''.join(parts)
    else:
        return ''
    # normalize path: collapse //, resolve relative (no leading /)
    if not joined.startswith('/'):
        joined = room_dir + '/' + joined
    joined = re.sub(r'/+', '/', joined)
    # collapse any '/./' and trailing
    joined = joined.replace('/./', '/')
    if joined.endswith('.c'):
        joined = joined[:-2]
    return joined

def parse_pairs(block: str):
    return PAIR_RE.findall(block)

def extract_rooms(src: Path):
    rooms, warnings, seen = [], [], set()
    for cfile in src.rglob('*.c'):
        txt = read(cfile)
        if 'set("exits"' not in txt and "set( \"exits\"" not in txt:
            continue
        rid = room_id_of(cfile, src)
        room_dir = rid.rsplit('/', 1)[0]
        short_m = SHORT_RE.search(txt)
        area_m = OUTDOOR_RE.search(txt)
        exits = {}
        em = EXITS_BLOCK.search(txt)
        if em:
            for d, rhs in parse_pairs(em.group(1)):
                tgt = resolve_expr(rhs, room_dir)
                exits[d.strip()] = tgt or ('?' + rhs.strip()[:40])
                if not tgt:
                    warnings.append({"room_id": rid, "dir": d.strip(),
                                     "raw": rhs.strip()[:60], "reason": "computed/unresolved exit"})
        npcs = []
        om = OBJS_BLOCK.search(txt)
        if om:
            for key, _v in parse_pairs(om.group(1)):
                pass
            for m in re.finditer(r'(?:CLASS_D\("[^"]+"\)\s*\+\s*"[^"]*"|"[^"]*npc[^"]*"|"/[^"]+")\s*:', om.group(1)):
                tgt = resolve_expr(m.group(0).rstrip(':'), room_dir)
                if tgt:
                    npcs.append(tgt)
        rooms.append({
            "room_id": rid,
            "short": short_m.group(1) if short_m else None,
            "area": area_m.group(1) if area_m else (rid.split('/')[2] if rid.startswith('/d/') else None),
            "indoors": bool(IS_INDOOR.search(txt)) or not bool(area_m),
            "exits": exits,
            "npcs": sorted(set(npcs)),
        })
        seen.add(rid)
    # flag edges to unparsed rooms
    for r in rooms:
        for d, tgt in r["exits"].items():
            if tgt.startswith('/') and tgt not in seen:
                warnings.append({"room_id": r["room_id"], "dir": d, "target": tgt,
                                 "reason": "target room not in parsed set"})
    return rooms, warnings

def extract_npcs(src: Path):
    npcs = []
    for cfile in list((src / 'kungfu' / 'class').rglob('*.c')) + list((src / 'd').rglob('*.c')):
        txt = read(cfile)
        if 'inherit NPC' not in txt and 'set_name(' not in txt:
            continue
        nm = SETNAME_RE.search(txt)
        if not nm:
            continue
        name = nm.group(1)
        aliases = ALIAS_RE.findall(nm.group(2))
        att = ATTITUDE_RE.search(txt)
        cls = CLASS_RE.search(txt)
        nick = NICK_RE.search(txt)
        exp = EXP_RE.search(txt)
        teaches = sorted(set(SETSKILL_RE.findall(txt))) if 'F_MASTER' in txt else []
        rid = room_id_of(cfile, src)
        sect = None
        if '/kungfu/class/' in rid:
            sect = rid.split('/kungfu/class/')[1].split('/')[0]
        npcs.append({
            "npc_id": rid,
            "name": name,
            "aliases": aliases,
            "nickname": nick.group(1) if nick else None,
            "attitude": att.group(1) if att else "neutral",
            "class": cls.group(1) if cls else None,
            "sect": sect,
            "is_master": 'F_MASTER' in txt,
            "teaches": teaches,
            "combat_exp": int(exp.group(1)) if exp else None,
        })
    return npcs

def extract_skills(src: Path):
    out = []
    sdir = src / 'kungfu' / 'skill'
    for cfile in sdir.rglob('*.c'):
        txt = read(cfile)
        sid = cfile.stem
        types = set()
        for m in VALID_EN_RE.finditer(txt):
            types.update(USAGE_RE.findall(m.group(1)))
        # force-type internal skills often: usage=="force"
        nm = SHORT_RE.search(txt)  # rare
        out.append({
            "skill_id": sid,
            "file": room_id_of(cfile, src),
            "types": sorted(types) or None,
        })
    # de-dup by skill_id (dir + .c variants)
    dedup = {}
    for s in out:
        k = s["skill_id"]
        if k not in dedup or s["types"]:
            dedup[k] = s
    return sorted(dedup.values(), key=lambda x: x["skill_id"])

def build_masters(npcs, rooms):
    """Join is_master NPCs with the room(s) that spawn them (room.npcs refs)."""
    npc_room = {}
    for r in rooms:
        for nid in r.get("npcs", []):
            npc_room.setdefault(nid, r)
    out = []
    for n in npcs:
        if not n.get("is_master") or not n.get("teaches"):
            continue
        r = npc_room.get(n["npc_id"])
        out.append({
            "name": n["name"],
            "npc_id": n["npc_id"],
            "aliases": n.get("aliases", []),
            "sect": n.get("sect"),
            "teaches": n["teaches"],
            "combat_exp": n.get("combat_exp"),
            "room_id": r["room_id"] if r else None,
            "room_short": r["short"] if r else None,
            "area": r["area"] if r else None,
        })
    return out

def extract_areas(src: Path, rooms):
    regions = {}
    rh = read(src / 'd' / 'REGIONS.h')
    for code, name in re.findall(r'"([a-z]+)"\s*:\s*"([^"]+)"', rh):
        regions[code] = name
    counts = {}
    for r in rooms:
        a = r.get("area")
        if a:
            counts[a] = counts.get(a, 0) + 1
    areas = []
    for code in sorted(set(list(regions) + list(counts))):
        areas.append({"area": code, "name_cn": regions.get(code),
                      "room_count": counts.get(code, 0)})
    return areas

def main():
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=str(here / '../../../../run'))
    ap.add_argument('--out', default=str(here / '../data'))
    args = ap.parse_args()
    src = Path(args.src).resolve()
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)

    rooms, warnings = extract_rooms(src)
    npcs = extract_npcs(src)
    skills = extract_skills(src)
    areas = extract_areas(src, rooms)
    masters = build_masters(npcs, rooms)

    (out / 'map.json').write_text(json.dumps(
        {"_generated_from": str(src), "room_count": len(rooms), "rooms": rooms},
        ensure_ascii=False, indent=1), encoding='utf-8')
    (out / 'areas.json').write_text(json.dumps(
        {"areas": areas}, ensure_ascii=False, indent=1), encoding='utf-8')
    (out / 'npcs.json').write_text(json.dumps(
        {"npc_count": len(npcs), "npcs": npcs}, ensure_ascii=False, indent=1), encoding='utf-8')
    (out / 'skills.json').write_text(json.dumps(
        {"skill_count": len(skills), "skills": skills}, ensure_ascii=False, indent=1), encoding='utf-8')
    (out / 'warnings.json').write_text(json.dumps(
        warnings, ensure_ascii=False, indent=1), encoding='utf-8')
    (out / 'masters.json').write_text(json.dumps(
        {"master_count": len(masters), "masters": masters}, ensure_ascii=False, indent=1), encoding='utf-8')

    print(f"rooms={len(rooms)} npcs={len(npcs)} skills={len(skills)} "
          f"masters={len(masters)} areas={len(areas)} warnings={len(warnings)} -> {out}")

if __name__ == '__main__':
    main()
