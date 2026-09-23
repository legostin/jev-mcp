import type { Database } from '../trace/sqlite.ts';
import { newId } from '../util/ids.ts';

export interface MemoryEntry {
  id: string; domain: string; pageKind: string; key: string; sig: string; weight: number;
  successes: number; failures: number; consecutiveFailures: number; disabled: boolean; updatedAt: number;
}

const MAX_WEIGHT = 5;

/**
 * Per-domain site memory: which element (by signature) served a purpose ("param:from", "submit") on a kind of
 * page. A hit is only a fast path: JEV still confirms it with one noul before acting.
 */
export class MemoryStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_memory (id TEXT PRIMARY KEY, domain TEXT, page_kind TEXT, key TEXT, sig TEXT, weight REAL,
        successes INTEGER, failures INTEGER, consecutive_failures INTEGER, disabled INTEGER, updated_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS site_memory_uniq ON site_memory(domain, page_kind, key, sig);
      CREATE TABLE IF NOT EXISTS site_hints (id TEXT PRIMARY KEY, domain TEXT, text TEXT, created_at INTEGER);
    `);
  }

  private row(r: any): MemoryEntry {
    return {
      id: r.id, domain: r.domain, pageKind: r.page_kind, key: r.key, sig: r.sig, weight: r.weight, successes: r.successes,
      failures: r.failures, consecutiveFailures: r.consecutive_failures, disabled: !!r.disabled, updatedAt: r.updated_at,
    };
  }

  lookup(domain: string, pageKind: string, key: string): MemoryEntry | null {
    const exact = this.db.prepare(`SELECT * FROM site_memory WHERE domain = ? AND page_kind = ? AND key = ? AND disabled = 0 AND weight >= 1
      ORDER BY weight DESC, updated_at DESC LIMIT 1`).get(domain, pageKind, key);
    const any = exact ?? this.db.prepare(`SELECT * FROM site_memory WHERE domain = ? AND key = ? AND disabled = 0 AND weight >= 1
      ORDER BY weight DESC, updated_at DESC LIMIT 1`).get(domain, key);
    return any ? this.row(any) : null;
  }

  get(id: string): MemoryEntry | null {
    const r = this.db.prepare('SELECT * FROM site_memory WHERE id = ?').get(id);
    return r ? this.row(r) : null;
  }

  recordSuccess(domain: string, pageKind: string, key: string, sig: string): void {
    if (!domain || !sig) return;
    const r = this.db.prepare('SELECT * FROM site_memory WHERE domain = ? AND page_kind = ? AND key = ? AND sig = ?').get(domain, pageKind, key, sig) as any;
    if (r) {
      this.db.prepare(`UPDATE site_memory SET weight = ?, successes = successes + 1, consecutive_failures = 0, disabled = 0, updated_at = ? WHERE id = ?`)
        .run(Math.min(MAX_WEIGHT, r.weight + 0.5), Date.now(), r.id);
    } else {
      this.db.prepare(`INSERT INTO site_memory (id, domain, page_kind, key, sig, weight, successes, failures, consecutive_failures, disabled, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0, 0, ?)`).run(newId('m'), domain, pageKind, key, sig, Date.now());
    }
  }

  recordFailure(id: string): void {
    const r = this.db.prepare('SELECT * FROM site_memory WHERE id = ?').get(id) as any;
    if (!r) return;
    const consecutive = r.consecutive_failures + 1;
    this.db.prepare(`UPDATE site_memory SET weight = ?, failures = failures + 1, consecutive_failures = ?, disabled = ?, updated_at = ? WHERE id = ?`)
      .run(r.weight - 1, consecutive, consecutive >= 2 ? 1 : 0, Date.now(), id);
  }

  addHint(domain: string, text: string): void {
    if (!domain) return;
    const exists = this.db.prepare('SELECT id FROM site_hints WHERE domain = ? AND text = ?').get(domain, text);
    if (!exists) this.db.prepare('INSERT INTO site_hints (id, domain, text, created_at) VALUES (?, ?, ?, ?)').run(newId('h'), domain, text, Date.now());
  }

  hints(domain: string): string[] {
    return (this.db.prepare('SELECT text FROM site_hints WHERE domain = ? ORDER BY created_at').all(domain) as any[]).map((r) => r.text);
  }

  list(): { entries: MemoryEntry[]; hints: { id: string; domain: string; text: string }[] } {
    return {
      entries: (this.db.prepare('SELECT * FROM site_memory ORDER BY domain, key, weight DESC').all() as any[]).map((r) => this.row(r)),
      hints: this.db.prepare('SELECT id, domain, text FROM site_hints ORDER BY domain, created_at').all() as any[],
    };
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM site_memory WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM site_hints WHERE id = ?').run(id);
  }

  setWeight(id: string, weight: number): void {
    this.db.prepare('UPDATE site_memory SET weight = ?, disabled = ?, updated_at = ? WHERE id = ?').run(weight, weight < 1 ? 1 : 0, Date.now(), id);
  }
}
