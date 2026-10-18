import { KNOWN_ROUTES } from './core.mjs';

export const SHAOLIN_WATER_CARRYING = {
  id: 'shaolin-water-carrying',
  name: '少林挑水',
  description: '执行少林挑水任务',
  prerequisites: (state) => {
    if (state.faction !== 'shaolin') return '必须是少林派';
    if (state.combat_exp > 500000) return '经验值过高';
    if (state.ts_pending) return '处于冷却中';
    return true;
  },
  steps: [
    {
      id: 'accept_job',
      action: () => 'ask zhike seng about 工作',
      verify: (events) => events.some(e => e.content.includes('领了工作') || e.content.includes('接了任务')) || '未成功领取任务',
    },
    {
      id: 'get_tools',
      action: () => 'ask shaofan seng about 水桶',
      verify: (events) => events.some(e => e.content.includes('给你水桶')) || '未拿到水桶',
    },
    {
      id: 'get_piao',
      action: () => 'ask shaofan seng about 水瓢',
      verify: (events) => events.some(e => e.content.includes('给你水瓢')) || '未拿到水瓢',
    },
    {
      id: 'move_to_river',
      action: () => {
        // In a real implementation, this would use KNOWN_ROUTES
        return 'move to riverbank'; 
      },
      verify: (events) => events.some(e => e.content.includes('汉水岸边')) || '未到达河边',
    },
    {
      id: 'fill_bucket',
      action: () => 'yao shui',
      verify: (events) => events.some(e => e.content.includes('舀起一桶水')) || '舀水失败',
      // Note: The actual skill needs 5 cycles, the state machine should handle loops or we define 10 steps.
      // For simplicity in the registry schema, let's assume the action can be a sequence or we'll handle the loop in the executor.
    },
    {
      id: 'finish_job',
      action: () => 'give shui tong to shaofan seng',
      verify: (events) => events.some(e => e.content.includes('接过了水桶')) || '交付失败',
    }
  ],
  postcondition: (state, events) => {
    return events.some(e => e.content.includes('奖励')) || '未获得任务奖励';
  },
  timeoutMs: 300000,
};

export const TRAINING_SKILL = {
  id: 'basic-training',
  name: '基础训练',
  description: '执行基础技能训练',
  prerequisites: (state) => state.mp > 10 || '精力不足',
  steps: [
    {
      id: 'start_training',
      action: () => 'train',
      verify: (events) => events.some(e => e.content.includes('开始训练')) || '训练启动失败',
    },
    {
      id: 'wait_training',
      action: () => 'wait',
      verify: (events) => events.some(e => e.content.includes('训练结束')) || '训练未完成',
    }
  ],
  postcondition: (state, events) => true,
  timeoutMs: 60000,
};

export const RECOVERY_SKILL = {
  id: 'health-recovery',
  name: '状态恢复',
  description: '恢复生命值和精力',
  prerequisites: (state) => state.hp < state.hp_max || state.mp < state.mp_max,
  steps: [
    {
      id: 'meditate',
      action: () => 'dazuo',
      verify: (events) => events.some(e => e.content.includes('进入打坐')) || '无法打坐',
    }
  ],
  postcondition: (state, events) => true,
  timeoutMs: 120000,
};
