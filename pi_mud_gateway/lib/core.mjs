// Extracted gateway rules. No sockets, files, sessions, or provider calls.
function isInfoCommand(cmd) {
  const c = cmd.trim().toLowerCase();
  return ['look', 'l', 'score', 'sc', 'inventory', 'i', 'hp', 'help', 'skills', 'who', 'chat'].includes(c);
}


const KNOWN_ROUTES = {
  wizard_guest_room_to_wumiao: {
    from: '巫师会客室',
    to: '武庙',
    directions: ['southeast'],
    notes: '竹门已在 mudlib 中去掉，southeast 应直接到武庙。',
  },
  wumiao_to_wizard_guest_room: {
    from: '武庙',
    to: '巫师会客室',
    directions: ['northwest'],
  },
  probe_from_current_room: {
    from: '当前房间',
    to: '未知区域试探',
    directions: ['north', 'east', 'south', 'west'],
    notes: '只选择一个方向分支试探；失败后停止观察，不要硬闯。',
  },
  yangzhou_guangchang_to_shaolin_shanmen_overland: {
    from: '扬州中央广场 /d/city/guangchang',
    to: '少林山门 /d/shaolin/shanmen',
    commands: [
      'north', 'north', 'north', 'north', 'northwest',
      'north', 'north', 'north',
      'yell boat',
      { cmd: 'enter', waitMs: 36_000 },
      'out',
      'north', 'north', 'north', 'west',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east',
    ],
    notes: '公开地面路线。汉水南岸需 yell boat 叫船，enter 上船后约35秒到北岸，再 out 下船。',
  },
  shaolin_shanmen_to_yangzhou_guangchang_overland: {
    from: '少林山门 /d/shaolin/shanmen',
    to: '扬州中央广场 /d/city/guangchang',
    commands: [
      'west',
      'southdown', 'southdown', 'southdown', 'eastdown', 'southdown', 'southdown',
      'east', 'south', 'south', 'south',
      'yell boat',
      { cmd: 'enter', waitMs: 36_000 },
      'out',
      'south', 'south', 'south', 'southeast',
      'south', 'south', 'south', 'south',
    ],
    notes: '公开地面返回路线。汉水北岸同样需 yell boat，上船等待到南岸后 out。',
  },
  yangzhou_guangchang_to_shaolin_chufang2_gaibang_shortcut: {
    from: '扬州中央广场 /d/city/guangchang',
    to: '少林厨房 /d/shaolin/chufang2',
    commands: [
      'enter dong',
      'say 天堂有路你不走呀',
      'down',
      '3',
      'northeast',
      'northeast',
      'up',
    ],
    requirements: ['丐帮身份', '可在树洞内用口令打开 down；非丐帮会被梁长老挡住。'],
    notes: '丐帮暗道捷径，不适合普通账号。出口三通往少林，终点是少林厨房而非山门。',
  },
  shaolin_chufang2_to_yangzhou_guangchang_gaibang_shortcut: {
    from: '少林厨房 /d/shaolin/chufang2',
    to: '扬州中央广场 /d/city/guangchang',
    commands: [
      'enter dong',
      'southwest',
      'southwest',
      'southwest',
      'up',
      'out',
    ],
    requirements: ['丐帮身份', '少林厨房 enter dong 需要丐帮缩骨功/身份。'],
    notes: '丐帮暗道返回路线。',
  },
  shaolin_fzlou_accept_water_job: {
    from: '少林方丈楼 /d/shaolin/fzlou',
    to: '已领取少林挑水任务',
    commands: [
      'ask zhike seng about 工作',
    ],
    requirements: ['少林派', 'combat_exp <= 500000', '无 ts_pending 冷却', '未领取其它挑水任务。'],
    notes: '方丈楼有知客僧。也可向玄慈问“挑水/job”，但此路线默认使用知客僧。',
  },
  shaolin_fzlou_to_chufang: {
    from: '少林方丈楼 /d/shaolin/fzlou',
    to: '少林厨房 /d/shaolin/chufang',
    commands: ['south', 'south', 'southdown', 'south', 'west', 'north', 'north'],
    notes: '方丈楼 -> 练武场 -> 后殿 -> 精进场 -> 勤修场 -> 斋厅 -> 厨房。',
  },
  shaolin_chufang_to_fzlou: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '少林方丈楼 /d/shaolin/fzlou',
    commands: ['south', 'south', 'east', 'north', 'northup', 'north', 'north'],
    notes: '厨房 -> 斋厅 -> 勤修场 -> 精进场 -> 后殿 -> 练武场 -> 方丈楼，用于潜能不足时重新接挑水任务。',
  },
  shaolin_chufang_to_qingshan_biqiu: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '清善比丘处 /d/shaolin/guangchang2',
    commands: ['south', 'south', 'east', 'south'],
    notes: '厨房到寺内广场，清善比丘在此。当前角色可用 alias qingshan 向他学习基础技能。',
  },
  shaolin_qingshan_biqiu_to_chufang: {
    from: '清善比丘处 /d/shaolin/guangchang2',
    to: '少林厨房 /d/shaolin/chufang',
    commands: ['north', 'west', 'north', 'north'],
    notes: '清善比丘处返回厨房，用于学完/潜能不足后转挑水。',
  },
  shaolin_fzlou_to_qingshan_biqiu: {
    from: '少林方丈楼 /d/shaolin/fzlou',
    to: '清善比丘处 /d/shaolin/guangchang2',
    commands: ['south', 'south', 'southdown', 'south', 'south'],
    notes: '方丈楼到清善比丘所在广场。',
  },
  shaolin_qingshan_biqiu_to_fzlou: {
    from: '清善比丘处 /d/shaolin/guangchang2',
    to: '少林方丈楼 /d/shaolin/fzlou',
    commands: ['north', 'north', 'northup', 'north', 'north'],
    notes: '清善比丘所在广场到方丈楼。',
  },
  shaolin_chufang_to_qingwu_biqiu: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '清无比丘处 /d/shaolin/guangchang1e',
    commands: [
      'south', 'south', 'east', 'south',
      'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 300, note: 'gate_special: 山门殿内开南门；下一步必须立刻 south。' },
      'south', 'east',
    ],
    notes: '清无比丘在寺前广场东侧，可教 blade/force/dodge/parry/cuff/literate/buddhism 等低阶技能。',
  },
  shaolin_qingwu_biqiu_to_chufang: {
    from: '清无比丘处 /d/shaolin/guangchang1e',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'west',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；下一步必须立刻 north。' },
      'north', 'north', 'northup', 'north',
      'north', 'west', 'north', 'north',
    ],
    notes: '清无比丘处回厨房。',
  },
  shaolin_qingshan_biqiu_to_qingwu_biqiu: {
    from: '清善比丘处 /d/shaolin/guangchang2',
    to: '清无比丘处 /d/shaolin/guangchang1e',
    commands: [
      'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 300, note: 'gate_special: 山门殿内开南门；下一步必须立刻 south。' },
      'south', 'east',
    ],
    notes: '从寺内清善处出山门到清无处，常用于 blade 学习。',
  },
  shaolin_qingwu_biqiu_to_qingshan_biqiu: {
    from: '清无比丘处 /d/shaolin/guangchang1e',
    to: '清善比丘处 /d/shaolin/guangchang2',
    commands: [
      'west',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；下一步必须立刻 north。' },
      'north', 'north', 'northup', 'north',
    ],
    notes: '清无处回寺内清善处。',
  },
  shaolin_chufang_to_qingfa_biqiu: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '清法比丘处 /d/shaolin/guangchang1',
    commands: [
      'south', 'south', 'east', 'south',
      'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 300, note: 'gate_special: 山门殿内开南门；下一步必须立刻 south。' },
      'south',
    ],
    notes: '清法比丘在寺前广场，可作为清善不能教时的低阶学习 fallback。',
  },
  shaolin_qingfa_biqiu_to_chufang: {
    from: '清法比丘处 /d/shaolin/guangchang1',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；下一步必须立刻 north。' },
      'north', 'north', 'northup', 'north',
      'north', 'west', 'north', 'north',
    ],
    notes: '清法比丘处回厨房。',
  },
  shaolin_chufang_prepare_water_tools: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '已领取水桶和水瓢',
    commands: [
      'ask shaofan seng about 水桶',
      'ask shaofan seng about 水瓢',
    ],
    requirements: ['必须先领取挑水任务。'],
    notes: '烧饭僧在厨房。水桶只能领一次；水瓢丢失后可再次问水瓢。',
  },
  shaolin_fzlou_abandon_water_job: {
    from: '少林方丈楼 /d/shaolin/fzlou',
    to: '已放弃少林挑水任务',
    commands: [
      'ask zhike seng about abandon',
    ],
    requirements: ['当前在方丈楼；挑水工具或任务状态不可恢复时使用。'],
    notes: '知客僧会清除 job_asked/tool_assigned/tiaoshui，并进入短暂 pending；之后成长循环重新判断。',
  },
  shaolin_chufang_to_riverbank_for_water_job: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '汉水岸边 /d/shaolin/riverbank',
    commands: [
      'south', 'south', 'east',
      'south', 'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 1_500, note: 'gate_special: 山门殿内开南门；等待门状态同步后立刻 south，门10秒后会关。' },
      'south',
      'south', 'southdown', 'southdown', 'southdown', 'westdown',
      'west', 'southdown', 'southdown', 'southdown', 'eastdown', 'southdown', 'southdown',
      'east', 'south', 'south', 'south',
      'west',
    ],
    requirements: ['少林僧人可从正门出寺；在山门殿必须 open gate 后迅速 south。'],
    notes: '去河边不要走挑水山路；从正门下山到汉水北岸，再 west 到汉水岸边。gate special: 山门殿 open gate -> south。',
  },
  shaolin_chufang_to_south_gate_for_water_job: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '寺前广场 /d/shaolin/guangchang1',
    commands: [
      'south', 'south', 'east',
      'south', 'south', 'southdown', 'south',
      { cmd: 'open gate', waitMs: 1_500, note: 'gate_special: 山门殿内开南门；等待门状态同步后立刻 south，门10秒后会关。' },
      'south',
    ],
    requirements: ['已从烧饭僧处拿到水桶和水瓢。'],
    notes: '拿到挑水工具后先直达山门殿，open gate 后稍等同步，再 south 出寺到寺前广场。',
  },
  shaolin_south_gate_to_riverbank_for_water_job: {
    from: '寺前广场 /d/shaolin/guangchang1',
    to: '汉水岸边 /d/shaolin/riverbank',
    commands: [
      'south', 'southdown', 'southdown', 'southdown', 'westdown',
      'west', 'southdown', 'southdown', 'southdown', 'eastdown', 'southdown', 'southdown',
      'east', 'south', 'south', 'south',
      'west',
    ],
    requirements: ['已从山门南门出寺，携带挑水工具。'],
    notes: '从寺前广场下山到汉水岸边，接在 shaolin_chufang_to_south_gate_for_water_job 后执行。',
  },
  shaolin_water_fill_bucket_at_riverbank: {
    from: '汉水岸边 /d/shaolin/riverbank',
    to: '水桶已装满并重新挑起',
    commands: [
      { cmd: 'putdown shui tong', waitMs: 1_000 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'yao shui', waitMs: 4_000 },
      { cmd: 'dao shui to shui tong', waitMs: 3_500 },
      { cmd: 'carry shui tong', waitMs: 1_000 },
    ],
    requirements: ['身上有水瓢', '水桶属于自己', '已领取挑水任务。'],
    notes: '舀水/倒水会 busy，不能用 150ms 短间隔；此 skill 使用每步 waitMs 覆盖。',
  },
  shaolin_water_return_riverbank_to_shanlu_probe: {
    from: '汉水岸边 /d/shaolin/riverbank',
    to: '挑水山路第一段 /d/shaolin/shanlu',
    commands: ['northup'],
    requirements: ['水桶已满并 carry 在身上。'],
    notes: '进入山路后出口随机为 up / westup / northwest 之一；执行后先观察出口，再选择对应后续 return variant。',
  },
  shaolin_water_shanlu_to_riverbank_for_refill: {
    from: '挑水山路 /d/shaolin/shanlu*',
    to: '汉水岸边 /d/shaolin/riverbank',
    commands: ['southdown'],
    requirements: ['水桶仍在，但水不满；回汉水重新舀水加满。'],
    notes: '桶没碎只是水洒了时，不放弃任务，先回河边 refill。',
  },
  shaolin_water_return_shanlu_to_chufang_via_up: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'up',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；门10秒后会关，下一步必须立刻 north。' }, 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 up', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。gate special: 寺前广场 knock gate -> north。',
  },
  shaolin_water_return_shanlu_to_chufang_via_westup: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'westup',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；门10秒后会关，下一步必须立刻 north。' }, 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 westup', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。gate special: 寺前广场 knock gate -> north。',
  },
  shaolin_water_return_shanlu_to_chufang_via_northwest: {
    from: '挑水山路第一段 /d/shaolin/shanlu',
    to: '少林厨房 /d/shaolin/chufang',
    commands: [
      'northwest',
      'northeast', 'east',
      'northup', 'northup', 'westup', 'northup', 'northup', 'northup',
      'east', 'eastup', 'northup', 'northup', 'northup', 'north',
      { cmd: 'knock gate', waitMs: 300, note: 'gate_special: 寺前广场敲北门；门10秒后会关，下一步必须立刻 north。' }, 'north',
      'north', 'northup', 'north', 'north', 'west', 'north', 'north',
    ],
    requirements: ['当前山路出口包含 northwest', '少林僧人，携带满水桶。'],
    notes: '回程上山可能摔倒或洒水；若水洒了，回河边重新 fill。gate special: 寺前广场 knock gate -> north。',
  },
  shaolin_chufang_finish_water_job: {
    from: '少林厨房 /d/shaolin/chufang',
    to: '少林挑水任务完成',
    commands: [
      'give shui tong to shaofan seng',
      'give shui piao to shaofan seng',
    ],
    requirements: ['水桶已满', '仍在 tiaoshui 条件时间内。'],
    notes: '烧饭僧只奖励满水桶；水瓢可以顺手归还。',
  },
};

const DIRECTION_ALIASES = {
  n: 'north',
  north: 'north',
  s: 'south',
  south: 'south',
  e: 'east',
  east: 'east',
  w: 'west',
  west: 'west',
  ne: 'northeast',
  northeast: 'northeast',
  nw: 'northwest',
  northwest: 'northwest',
  se: 'southeast',
  southeast: 'southeast',
  sw: 'southwest',
  southwest: 'southwest',
  u: 'up',
  up: 'up',
  d: 'down',
  down: 'down',
  enter: 'enter',
  out: 'out',
};


function normalizeDirection(raw) {
  const dir = String(raw || '').trim().toLowerCase();
  return DIRECTION_ALIASES[dir] || dir;
}


function summarizeEvents(events, limit = 8) {
  return events.slice(-limit).map((e) => e.content).join('\n');
}

function routeStepCommand(step) {
  return typeof step === 'string' ? step : step.cmd;
}

function routeStepNote(step) {
  return typeof step === 'string' ? '' : (step.note || '');
}

function commandSequenceWaitMs(cmd, defaultWaitMs) {
  const c = cmd.trim().toLowerCase();
  if (/^(yao|舀)\s+(shui|water|水)$/.test(c)) return Math.max(defaultWaitMs, 4_000);
  if (/^(dao|倒)\s+(shui|water|水)\s+to\s+/.test(c)) return Math.max(defaultWaitMs, 3_500);
  if (/^(dazuo|exercise|tuna|respirate)\b/.test(c)) return Math.max(defaultWaitMs, 3_000);
  if (/^(putdown|fang|放)\s+/.test(c)) return Math.max(defaultWaitMs, 1_000);
  if (/^(carry|tiao|挑)\s+/.test(c)) return Math.max(defaultWaitMs, 1_000);
  return defaultWaitMs;
}


function chooseProgressSkill(loop) {
  const plan = loop.skillPlan.length ? loop.skillPlan : ['buddhism', 'literate', 'force', 'dodge', 'parry', 'cuff', 'strike', 'sword'];
  for (let offset = 0; offset < plan.length; offset += 1) {
    const idx = (loop.skillIndex + offset) % plan.length;
    const skill = plan[idx];
    if (!loop.blockedSkills[skill]) return { skill, index: idx };
  }
  return { skill: plan[0] || 'force', index: 0 };
}


function detectStopReason(
  events,
  currentCommand = '', player = {},
) {
  const currentIsInfo = currentCommand ? isInfoCommand(currentCommand) : false;
  const qi = player.hp;
  const qiMax = player.hp_max;
  if (!currentIsInfo && typeof qi === 'number' && typeof qiMax === 'number' && qiMax > 0 && qi / qiMax < 0.3) {
    return 'low_qi';
  }

  const text = summarizeEvents(events, 20);
  if (!text) return null;
  if (/蛇毒|中毒|毒发|疼痛|四肢发麻/.test(text)) return 'poison_or_poison_damage';
  if (/战斗|你对|你被|招架|闪避|躲开|击中|杀死|打死/.test(text)) return 'combat_or_damage';
  if (/你必须先把|这个方向没有门|没有这个方向|不能往那个方向|那里没有|无法往|不能这样走/.test(text)) return 'blocked_exit';
  if (/拦住|挡住|不让你|正忙|busy|现在不能/.test(text)) return 'blocked_or_busy';
  return null;
}

function shouldStopBeforeNextCommand(stop, nextCommand = '') {
  if (!stop || stop === 'combat_or_damage') return false;
  if (stop === 'low_qi' && nextCommand && isInfoCommand(nextCommand)) {
    return false;
  }
  return true;
}


const STATUS_RE = {
  jing: /精[:：]\s*(\d+)\s*\/\s*(\d+)\s*\((\d+)%\)/,
  jingli: /精力[:：]\s*(\d+)\s*\/\s*(\d+)\s*\(\+?\d+\)/,
  qi: /气[:：]\s*(\d+)\s*\/\s*(\d+)\s*\((\d+)%\)/,
  neili: /内力[:：]\s*(\d+)\s*\/\s*(\d+)\s*\(\+?\d+\)/,
  food: /食物[:：]\s*(\d+)\s*\/\s*(\d+)/,
  water: /饮水[:：]\s*(\d+)\s*\/\s*(\d+)/,
  potential: /潜能[:：]\s*(\d+)\s*\/\s*(\d+)/,
  combat_exp: /经验[:：]\s*(\d+)/,
};

function parseStatusLine(text, p) {
  let m;
  // 气 → hp（当前/有效上限），第三组=内伤%
  if ((m = text.match(STATUS_RE.qi))) {
    p.hp = Number(m[1]); p.hp_max = Number(m[2]); p.hp_injury_pct = Number(m[3]);
  }
  // 精 → jing，第三组=内伤%
  if ((m = text.match(STATUS_RE.jing))) {
    p.jing = Number(m[1]); p.jing_max = Number(m[2]); p.jing_injury_pct = Number(m[3]);
  }
  // 精力 → mp（行动耐力）
  if ((m = text.match(STATUS_RE.jingli))) {
    p.mp = Number(m[1]); p.mp_max = Number(m[2]);
  }
  // 内力
  if ((m = text.match(STATUS_RE.neili))) {
    p.neili = Number(m[1]); p.neili_max = Number(m[2]);
  }
  if ((m = text.match(STATUS_RE.food))) {
    p.food = Number(m[1]); p.food_max = Number(m[2]);
  }
  if ((m = text.match(STATUS_RE.water))) {
    p.water = Number(m[1]); p.water_max = Number(m[2]);
  }
  if ((m = text.match(STATUS_RE.potential))) {
    p.potential = Number(m[1]); p.potential_max = Number(m[2]);
  }
  if ((m = text.match(STATUS_RE.combat_exp))) p.combat_exp = Number(m[1]);
}

const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
const ANSI_OSC_RE = /\x1B\][^\x07\x1B]*?(?:\x07|\x1B\\)/g;
const MUD_METADATA_RE = /<!--[\s\S]*?-->/g;
const DECORATIVE_LINE_RE = /^[\s`~!@#$%^&*()_+\-=\[\]{}|\\:;'",.<>/?，。、；：！？【】《》“”‘’（）【】…*·]+$/u;
const SEMANTIC_CHAR_RE = /[A-Za-z0-9\u4E00-\u9FFF]/;

function cleanMudText(raw) {
  return String(raw || '')
    .replace(MUD_METADATA_RE, '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\r/g, '');
}

function splitCleanMudLines(raw) {
  return cleanMudText(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (DECORATIVE_LINE_RE.test(line)) return false;
      // 去掉无可读内容的装饰行（如纯标点、纯空白）
      return SEMANTIC_CHAR_RE.test(line);
    });
}


export { DIRECTION_ALIASES, KNOWN_ROUTES, normalizeDirection, isInfoCommand, summarizeEvents, routeStepCommand, routeStepNote, commandSequenceWaitMs, chooseProgressSkill, detectStopReason, shouldStopBeforeNextCommand, parseStatusLine, cleanMudText, splitCleanMudLines };
