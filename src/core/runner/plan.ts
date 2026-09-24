import type { Json } from '../jev/types.ts';
import type { PlanStep } from './types.ts';

/**
 * The agent's plan as milestones. JEV aims at the current milestone (its "do" goes into questions about where to
 * go) and checks its "done_when" on every page, in the same call as the page assessment.
 */
export class Plan {
  steps: PlanStep[];
  index: number;

  constructor(steps: PlanStep[], index = 0) {
    this.steps = steps;
    this.index = index;
  }

  static from(data?: { steps: PlanStep[]; index: number } | null): Plan | null {
    return data?.steps?.length ? new Plan(data.steps, data.index) : null;
  }

  toJSON(): { steps: PlanStep[]; index: number } { return { steps: this.steps, index: this.index }; }

  get current(): PlanStep | undefined { return this.steps[this.index]; }
  get next(): PlanStep | undefined { return this.steps[this.index + 1]; }
  get finished(): boolean { return this.index >= this.steps.length; }

  advance(n = 1): void { this.index = Math.min(this.steps.length, this.index + n); }

  /** A new plan from the agent replaces what is left; milestones already done stay done. */
  replace(steps: PlanStep[]): void {
    this.steps = [...this.steps.slice(0, this.index), ...steps];
  }

  /** For question state: what is done, what is being done now, what comes next. */
  forState(): Record<string, Json> | undefined {
    if (!this.steps.length) return undefined;
    const out: Record<string, Json> = {};
    if (this.index > 0) out.done = this.steps.slice(0, this.index).map((s) => s.do);
    if (this.current) out.now = this.current.do;
    if (this.next) out.then = this.next.do;
    return out;
  }
}
