// Minimal D1Database stand-in over node:sqlite for tests. Covers prepare/bind/all/first/run/batch.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

type Params = (number | string | null)[];

/** node:sqlite returns null-prototype rows; D1 returns plain objects. */
const plain = (r: any) => ({ ...r });

class Stmt {
  private db: DatabaseSync;
  private sql: string;
  private params: Params;
  constructor(db: DatabaseSync, sql: string, params: Params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...values: unknown[]) {
    return new Stmt(this.db, this.sql, values.map((v) => (v === undefined ? null : (v as number | string | null))));
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params).map(plain) as T[], success: true, meta: {} as any };
  }
  async first<T>(col?: string) {
    const row = this.db.prepare(this.sql).get(...this.params) as any;
    if (row == null) return null;
    return (col ? row[col] : plain(row)) as T;
  }
  async run<T>() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { results: [] as T[], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } as any };
  }
  async raw() { return this.db.prepare(this.sql).all(...this.params).map((r: any) => Object.values(r)); }
}

export class FakeD1 {
  db: DatabaseSync;
  constructor(migration = new URL("../migrations/0001_history.sql", import.meta.url)) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(migration, "utf8"));
  }
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) { this.db.exec(sql); return { count: 0, duration: 0 }; }
  /** sync helper for assertions */
  rows<T = any>(sql: string, ...params: Params): T[] { return this.db.prepare(sql).all(...params).map(plain) as T[]; }
  count(table: string, where = "1=1", ...params: Params): number { return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as any).n); }
}

export const d1 = () => new FakeD1() as unknown as D1Database & FakeD1;
