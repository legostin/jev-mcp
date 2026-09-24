import type { Json } from '../jev/types.ts';

/** Something JEV established with high confidence that later questions can take as given. */
export interface Fact { key: string; text: string; step: number }
/** A page the task passed through. */
export interface TrailEntry { path: string; title: string; progress?: number; via?: string }
/** A way that was tried and rolled back. */
export interface DeadEnd { path: string; element: string; why: string }

export interface JournalData { facts: Fact[]; trail: TrailEntry[]; deadEnds: DeadEnd[] }

/** The page's address without scheme, query noise and fragment: stable enough to compare and short to show. */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search.length <= 60 ? u.search : ''}`;
  } catch { return url; }
}

/**
 * The task's working memory: facts it established, the pages it passed and the ways that did not work. Questions
 * that decide where to go get a compact slice of it; questions about one field do not (unrelated context costs
 * JEV accuracy).
 */
export class Journal {
  facts: Fact[] = [];
  trail: TrailEntry[] = [];
  deadEnds: DeadEnd[] = [];

  static from(data?: Partial<JournalData>): Journal {
    const j = new Journal();
    j.facts = data?.facts ?? [];
    j.trail = data?.trail ?? [];
    j.deadEnds = data?.deadEnds ?? [];
    return j;
  }

  toJSON(): JournalData { return { facts: this.facts, trail: this.trail, deadEnds: this.deadEnds }; }

  has(key: string): boolean { return this.facts.some((f) => f.key === key); }

  addFact(key: string, text: string, step: number): void {
    this.facts = [...this.facts.filter((f) => f.key !== key), { key, text, step }];
  }

  dropFact(key: string): void { this.facts = this.facts.filter((f) => f.key !== key); }

  /** Records the page the task is on (once per address in a row). */
  visit(url: string, title: string, via?: string): void {
    const path = pagePath(url);
    const last = this.trail[this.trail.length - 1];
    if (last?.path === path) { if (title) last.title = title; return; }
    this.trail.push({ path, title, via });
    if (this.trail.length > 12) this.trail.shift();
  }

  /** How close the current page is to the goal (0-4), once assessed. */
  setProgress(level: number): void {
    const last = this.trail[this.trail.length - 1];
    if (last) last.progress = level;
  }

  deadEnd(url: string, element: string, why: string): void {
    const path = pagePath(url);
    if (this.deadEnds.some((d) => d.path === path && d.element === element)) return;
    this.deadEnds.push({ path, element, why });
    if (this.deadEnds.length > 20) this.deadEnds.shift();
  }

  /** The slice for questions about where to go next: facts, the last pages, and what did not work. */
  forQuestion(): Record<string, Json> | undefined {
    const out: Record<string, Json> = {};
    if (this.facts.length) out.facts = this.facts.map((f) => f.text);
    if (this.trail.length > 1) {
      out.pages_passed = this.trail.slice(-6).map((t) => `${t.title ? `"${t.title.slice(0, 60)}" ` : ''}${t.path}${t.via ? ` (via "${t.via}")` : ''}`);
    }
    if (this.deadEnds.length) out.tried_without_success = this.deadEnds.slice(-6).map((d) => `"${d.element}" on ${d.path}: ${d.why}`);
    return Object.keys(out).length ? out : undefined;
  }
}

const SIGN_IN = /sign.?in|log.?in|password|passcode|парол|логин|username|user name|учётн/i;

/** Params that only serve signing in (the account phone, login, password): not needed once signed in. */
export function isSignInParam(key: string, about?: string): boolean {
  return SIGN_IN.test(`${key.replace(/_/g, ' ')} ${about ?? ''}`);
}
