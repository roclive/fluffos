import { commandSequenceWaitMs } from './core.mjs';

export class SkillError extends Error {
  constructor(message, code, state) {
    super(message);
    this.code = code;
    this.state = state;
    this.name = 'SkillError';
  }
}

export class SkillRegistry {
  constructor() {
    this.skills = new Map();
  }

  register(definition) {
    this.skills.set(definition.id, definition);
  }

  get(id) {
    return this.skills.get(id);
  }

  list() {
    return Array.from(this.skills.values());
  }
}

export class SkillExecutor {
  constructor(transport, registry) {
    this.transport = transport;
    this.registry = registry;
    this.currentSkill = null;
    this.currentState = 'IDLE';
    this.currentStepIndex = 0;
    this.startTime = 0;
  }

  async execute(skillId, initialGameState = {}) {
    const skill = this.registry.get(skillId);
    if (!skill) throw new Error(`Skill ${skillId} not found`);

    this.currentSkill = skill;
    this.currentState = 'CHECKING_PREREQS';
    this.currentStepIndex = 0;
    this.startTime = Date.now();

    try {
      // 1. Check Prerequisites
      const prereqResult = skill.prerequisites(initialGameState);
      if (prereqResult !== true) {
        throw new SkillError(`Prerequisites failed: ${prereqResult}`, 'PREREQ_FAILED', initialGameState);
      }

      this.currentState = 'EXECUTING';

      // 2. Execute Steps
      while (this.currentStepIndex < skill.steps.length) {
        const step = skill.steps[this.currentStepIndex];
        
        // Timeout check at start of each step
        if (Date.now() - this.startTime > (skill.timeoutMs || 60000)) {
          throw new SkillError('Skill execution timed out', 'TIMEOUT', initialGameState);
        }

        const iterations = step.repeat || 1;
        for (let i = 0; i < iterations; i++) {
          // Timeout check inside iteration
          if (Date.now() - this.startTime > (skill.timeoutMs || 60000)) {
            throw new SkillError('Skill execution timed out', 'TIMEOUT', initialGameState);
          }

          const command = step.action(initialGameState, i);
          const waitMs = step.waitMs || commandSequenceWaitMs(command, 150);
          
          this.transport.write(command + '\n');
          await this.transport.wait(waitMs);

          // Timeout check after wait, before verification
          if (Date.now() - this.startTime > (skill.timeoutMs || 60000)) {
            throw new SkillError('Skill execution timed out', 'TIMEOUT', initialGameState);
          }

          const events = this.transport.collectEvents();
          const verifyResult = step.verify(events, i);
          
          if (verifyResult !== true) {
            if (step.recovery) {
              const recoveryAction = step.recovery(verifyResult, events);
              if (recoveryAction === 'RETRY') {
                i--; // Retry current iteration
                continue;
              } else if (recoveryAction === 'ABORT') {
                throw new SkillError(`Step iteration ${i} failed: ${verifyResult}`, 'STEP_FAILED', initialGameState);
              }
            } else {
              throw new SkillError(`Step iteration ${i} failed: ${verifyResult}`, 'STEP_FAILED', initialGameState);
            }
          }
        }

        this.currentStepIndex++;
      }

      // 3. Verify Post-condition
      const finalEvents = this.transport.collectEvents();
      const postResult = skill.postcondition(initialGameState, finalEvents);
      if (postResult !== true) {
        throw new SkillError(`Post-condition failed: ${postResult}`, 'POST_CONDITION_FAILED', initialGameState);
      }

      this.currentState = 'COMPLETED';
      return { status: 'SUCCESS', stepsTaken: this.currentStepIndex };

    } catch (error) {
      this.currentState = 'RECOVERING';
      if (error instanceof SkillError && skill.recovery) {
        const recoveryResult = skill.recovery(error, initialGameState);
        if (recoveryResult === 'RECOVERED') {
          return { status: 'RECOVERED', error: error.message };
        }
      }
      this.currentState = 'FAILED';
      throw error;
    } finally {
      this.currentSkill = null;
    }
  }

  stop() {
    this.currentState = 'CANCELLED';
    this.currentSkill = null;
  }
}

export class MockTransport {
  constructor() {
    this.writes = [];
    this.events = [];
    this.waits = [];
  }

  write(cmd) {
    this.writes.push(cmd);
  }

  async wait(ms) {
    this.waits.push(ms);
  }

  collectEvents() {
    const e = [...this.events];
    this.events = [];
    return e;
  }

  pushEvent(content) {
    this.events.push({ content });
  }
}
