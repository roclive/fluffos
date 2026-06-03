#!/usr/bin/env python3
"""
build_kb.py — Extract a game-world ontology from the live xkx2001 (侠客行) FluffOS
mudlib into JSON the pi-agent / mud_gateway loop can query.

Outputs (into --out, default ../data):
  map.json     room graph: room_id, short, area, exits{dir:room_id}, npcs[], indoors
  areas.json   area code -> Chinese name (from d/REGIONS.h) + room counts
  npcs.json    npc_id, name, aliases, attitude, sect/class, is_master, teaches[], power
  skills.json  skill_id, name(best-effort), types[] (from valid_enable), sect
  skill_mechanics.json  valid_learn/practice/perform requirements and action unlocks
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
FUNC_RE_TMPL = r'(?:int|mixed|void|string|mapping)\s+{name}\s*\([^)]*\)\s*\{{(?P<body>.*?)\n\}}'
SKILL_CMP_RE = re.compile(r'query_skill\(\s*"([a-z0-9_\-]+)"\s*(?:,\s*1)?\s*\)\s*([<>]=?)\s*(\d+)')
MAPPED_RE = re.compile(r'query_skill_mapped\(\s*"([a-z0-9_\-]+)"\s*\)\s*!=\s*"([a-z0-9_\-]+)"')
PREPARED_RE = re.compile(r'query_skill_prepared\(\s*"([a-z0-9_\-]+)"\s*\)\s*!=\s*"([a-z0-9_\-]+)"')
QUERY_CMP_RE = re.compile(r'query\(\s*"([a-z0-9_/\-]+)"\s*\)\s*([<>]=?)\s*(\d+)')
WEAPON_TYPE_RE = re.compile(r'weapon->query\(\s*"skill_type"\s*\)\s*!=\s*"([a-z0-9_\-]+)"')
ACTION_ITEM_RE = re.compile(r'\(\[(.*?)\]\)', re.S)
LVL_RE = re.compile(r'"lvl"\s*:\s*(\d+)')
SKILL_NAME_RE = re.compile(r'"skill_name"\s*:\s*"([^"]+)"')
ACTION_NAME_RE = re.compile(r'「([^」]+)」')

SHAOLIN_CORE_SKILLS = {
    'shaolin-shenfa', 'luohan-quan', 'hunyuan-yiqi', 'jingang-quan',
    'cibei-dao', 'weituo-gun', 'banruo-zhang', 'damo-jian',
    'xiuluo-dao', 'yizhi-chan', 'nianhua-zhi', 'longzhua-gong',
}

MANUAL_MECHANICS = {
    "shaolin-shenfa": {
        "valid_learn": {"requirements": []},
        "practice": {"requirements": [
            {"kind": "attribute", "attribute": "jingli", "op": ">=", "value": 40, "text": "精力至少40才能练少林身法。"},
        ]},
        "performs": [],
        "action_unlocks": [
            {"level": 0, "name": "一苇渡江"},
            {"level": 0, "name": "雨燕掠波"},
            {"level": 0, "name": "移步换形"},
            {"level": 0, "name": "分身化影"},
            {"level": 0, "name": "孤骛落日"},
            {"level": 40, "name": "鸿雁双飞"},
            {"level": 50, "name": "苍龙出水"},
            {"level": 60, "name": "稚凤归巢"},
        ],
        "notes": ["源码没有 run/kungfu/skill/shaolin-shenfa/ perform 文件；中高级只扩大 query_action 的 dodge 动作池。"],
    },
    "luohan-quan": {
        "valid_learn": {"requirements": [
            {"kind": "state", "state": "unarmed", "text": "练罗汉拳必须空手。"},
            {"kind": "skill", "skill": "hunyuan-yiqi", "op": ">=", "value": 20, "text": "混元一气功至少20。"},
            {"kind": "attribute", "attribute": "max_neili", "op": ">=", "value": 50, "text": "最大内力至少50。"},
        ]},
        "practice": {"requirements": [
            {"kind": "attribute", "attribute": "jingli", "op": ">=", "value": 30, "text": "精力至少30。"},
            {"kind": "attribute", "attribute": "neili", "op": ">=", "value": 20, "text": "内力至少20。"},
        ]},
        "performs": [],
        "action_unlocks": [
            {"level": 0, "name": "黄莺落架"},
            {"level": 8, "name": "丹凤朝阳"},
            {"level": 15, "name": "洛钟东应"},
            {"level": 24, "name": "偏花七星"},
            {"level": 33, "name": "苦海回头"},
            {"level": 42, "name": "挟山超海"},
            {"level": 50, "name": "慑服外道"},
            {"level": 58, "name": "三入地狱"},
        ],
    },
    "jingang-quan": {
        "performs": [{
            "name": "jingang",
            "file": "/kungfu/skill/jingang-quan/jingang",
            "requirements": [
                {"kind": "state", "state": "unarmed", "text": "必须空手。"},
                {"kind": "skill", "skill": "hunyuan-yiqi", "op": ">=", "value": 60},
                {"kind": "skill", "skill": "jingang-quan", "op": ">=", "value": 90},
                {"kind": "attribute", "attribute": "max_neili", "op": ">", "value": 600},
                {"kind": "attribute", "attribute": "neili", "op": ">=", "value": 600},
            ],
        }],
    },
    "hunyuan-yiqi": {
        "valid_learn": {"requirements": [
            {"kind": "attribute", "attribute": "gender", "op": "==", "value": "男性", "text": "非童男之体不能练混元一气功。"},
            {"kind": "conditional", "when": "hunyuan-yiqi > 39", "requires": [{"kind": "attribute", "attribute": "class", "op": "==", "value": "bonze"}], "text": "40级后未入佛门不能继续修练。"},
            {"kind": "conditional", "when": "buddhism < 120", "requires": [{"kind": "skill_relation", "skill": "buddhism", "op": ">", "other_skill": "hunyuan-yiqi"}], "text": "禅宗心法不足120时必须高于混元一气功当前等级。"},
            {"kind": "skill", "skill": "force", "op": ">=", "value": 10, "text": "基本内功至少10。"},
            {"kind": "skill_ratio", "skill": "force", "op": ">=", "ratio_of": "hunyuan-yiqi", "ratio": "2/3", "text": "基本内功约需达到混元一气功的2/3。"},
            {"kind": "attribute", "attribute": "guilty", "op": "==", "value": 0, "text": "犯僧家戒律后无法领会更高深混元一气功。"},
            {"kind": "conditional", "when": "hunyuan-yiqi > 99", "requires": [{"kind": "exclusive_force", "max_force_skills": 1}], "text": "100级后若体内已有多种内功会互相冲撞。"},
        ]},
        "practice": {"requirements": [
            {"kind": "skill", "skill": "hunyuan-yiqi", "op": ">=", "value": 150, "text": "150级前只能靠 learn 增加熟练度。"},
            {"kind": "attribute", "attribute": "qi", "op": ">=", "value": 150},
            {"kind": "attribute", "attribute": "jingli", "op": ">=", "value": 150},
            {"kind": "attribute", "attribute": "neili", "op": ">=", "value": 150},
        ]},
        "performs": [{
            "name": "du",
            "file": "/kungfu/skill/hunyuan-yiqi/du",
            "requirements": [
                {"kind": "family", "family_name": "少林派", "generation": 35, "text": "必须是少林派35代。"},
                {"kind": "skill", "skill": "shaolin-shenfa", "op": ">=", "value": 200},
                {"kind": "skill", "skill": "hunyuan-yiqi", "op": ">=", "value": 160},
                {"kind": "mapped_skill", "usage": "dodge", "skill": "shaolin-shenfa", "text": "enable dodge shaolin-shenfa。"},
                {"kind": "attribute", "attribute": "max_neili", "op": ">=", "value": 2000},
                {"kind": "attribute", "attribute": "neili", "op": ">=", "value": 1000},
            ],
        }],
    },
    "banruo-zhang": {
        "performs": [{
            "name": "san",
            "file": "/kungfu/skill/banruo-zhang/san",
            "requirements": [
                {"kind": "state", "state": "unarmed", "text": "必须空手。"},
                {"kind": "mapped_skill", "usage": "force", "skill": "hunyuan-yiqi", "text": "enable force hunyuan-yiqi。"},
                {"kind": "skill", "skill": "hunyuan-yiqi", "op": ">=", "value": 180},
                {"kind": "skill", "skill": "banruo-zhang", "op": ">=", "value": 180},
                {"kind": "skill", "skill": "buddhism", "op": ">=", "value": 180},
                {"kind": "attribute", "attribute": "max_neili", "op": ">", "value": 1000},
                {"kind": "attribute", "attribute": "neili", "op": ">=", "value": 1000},
            ],
        }],
    },
}

def read(p: Path) -> str:
    try:
        return p.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return ''

def function_body(txt: str, name: str) -> str:
    m = re.search(FUNC_RE_TMPL.format(name=re.escape(name)), txt, re.S)
    return m.group('body') if m else ''

def invert_threshold(op: str, value: int):
    # LPC commonly rejects with "if current < N"; requirement is current >= N.
    if op == '<':
        return '>=', value
    if op == '<=':
        return '>', value
    if op == '>':
        return '<=', value
    if op == '>=':
        return '<', value
    return op, value

def add_req(reqs, req):
    key = json.dumps(req, ensure_ascii=False, sort_keys=True)
    if key not in {json.dumps(r, ensure_ascii=False, sort_keys=True) for r in reqs}:
        reqs.append(req)

def extract_requirements(block: str):
    reqs = []
    if not block:
        return reqs
    if 'query_temp("weapon")' in block or "query_temp('weapon')" in block:
        if 'secondary_weapon' in block or '必须空手' in block or '空手' in block:
            add_req(reqs, {"kind": "state", "state": "unarmed", "text": "必须空手。"})
    for skill, op, value in SKILL_CMP_RE.findall(block):
        rop, rval = invert_threshold(op, int(value))
        add_req(reqs, {"kind": "skill", "skill": skill, "op": rop, "value": rval})
    for usage, skill in MAPPED_RE.findall(block):
        add_req(reqs, {"kind": "mapped_skill", "usage": usage, "skill": skill, "text": f"enable {usage} {skill}。"})
    for usage, skill in PREPARED_RE.findall(block):
        add_req(reqs, {"kind": "prepared_skill", "usage": usage, "skill": skill, "text": f"prepare {usage} {skill}。"})
    for attr, op, value in QUERY_CMP_RE.findall(block):
        if attr.startswith('temp/') or attr.startswith('apply/'):
            continue
        rop, rval = invert_threshold(op, int(value))
        add_req(reqs, {"kind": "attribute", "attribute": attr, "op": rop, "value": rval})
    for weapon_type in WEAPON_TYPE_RE.findall(block):
        add_req(reqs, {"kind": "weapon", "weapon_type": weapon_type, "text": f"必须装备 {weapon_type} 类武器。"})
    return reqs

def extract_action_unlocks(txt: str):
    unlocks = []
    for item in ACTION_ITEM_RE.findall(txt):
        lvl = LVL_RE.search(item)
        skill_name = SKILL_NAME_RE.search(item)
        name = skill_name.group(1) if skill_name else None
        if not name:
            action_name = ACTION_NAME_RE.search(item)
            name = action_name.group(1) if action_name else None
        if name:
            unlocks.append({"level": int(lvl.group(1)) if lvl else 0, "name": name})
    seen = set()
    out = []
    for u in unlocks:
        key = (u["level"], u["name"])
        if key not in seen:
            seen.add(key)
            out.append(u)
    return out

def merge_mechanics(base: dict, override: dict):
    merged = dict(base)
    for key, value in override.items():
        if key in ("valid_learn", "practice") and isinstance(value, dict):
            current = dict(merged.get(key) or {})
            current.update(value)
            merged[key] = current
        elif key == "performs" and isinstance(value, list):
            by_name = {p.get("name"): p for p in merged.get("performs", [])}
            for p in value:
                by_name[p.get("name")] = p
            merged[key] = list(by_name.values())
        else:
            merged[key] = value
    return merged

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

def extract_skill_mechanics(src: Path):
    out = []
    sdir = src / 'kungfu' / 'skill'
    for cfile in sorted(sdir.glob('*.c')):
        sid = cfile.stem
        if sid not in SHAOLIN_CORE_SKILLS:
            continue
        txt = read(cfile)
        perform_dir = sdir / sid
        performs = []
        if perform_dir.is_dir():
            for pfile in sorted(perform_dir.glob('*.c')):
                ptxt = read(pfile)
                performs.append({
                    "name": pfile.stem,
                    "file": room_id_of(pfile, src),
                    "requirements": extract_requirements(function_body(ptxt, 'perform') or ptxt),
                })
        item = {
            "skill_id": sid,
            "file": room_id_of(cfile, src),
            "types": next((s["types"] for s in extract_skills(src) if s["skill_id"] == sid), None),
            "valid_learn": {"requirements": extract_requirements(function_body(txt, 'valid_learn'))},
            "practice": {"requirements": extract_requirements(function_body(txt, 'practice_skill'))},
            "performs": performs,
            "action_unlocks": extract_action_unlocks(txt),
            "source_files": [room_id_of(cfile, src)] + [p["file"] for p in performs],
            "notes": [],
        }
        item = merge_mechanics(item, MANUAL_MECHANICS.get(sid, {}))
        out.append(item)
    return sorted(out, key=lambda x: x["skill_id"])

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
    skill_mechanics = extract_skill_mechanics(src)
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
    (out / 'skill_mechanics.json').write_text(json.dumps(
        {"skill_count": len(skill_mechanics), "skills": skill_mechanics},
        ensure_ascii=False, indent=1), encoding='utf-8')
    (out / 'warnings.json').write_text(json.dumps(
        warnings, ensure_ascii=False, indent=1), encoding='utf-8')
    (out / 'masters.json').write_text(json.dumps(
        {"master_count": len(masters), "masters": masters}, ensure_ascii=False, indent=1), encoding='utf-8')

    print(f"rooms={len(rooms)} npcs={len(npcs)} skills={len(skills)} skill_mechanics={len(skill_mechanics)} "
          f"masters={len(masters)} areas={len(areas)} warnings={len(warnings)} -> {out}")

if __name__ == '__main__':
    main()
