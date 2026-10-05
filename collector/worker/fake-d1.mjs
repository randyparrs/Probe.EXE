// For the tests: node:sqlite standing in for D1, with the subset of the D1 API that store.js uses.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export function fakeD1(db, onPrepare = () => {}) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    async first(col) { const row = db.prepare(sql).get(...params); return row == null ? null : col ? row[col] : row; },
    async all() { return { success: true, results: db.prepare(sql).all(...params) }; },
    runSync() {
      if (/^\s*SELECT/i.test(sql)) return { success: true, results: db.prepare(sql).all(...params) };
      return { success: true, results: [], meta: { rows_written: Number(db.prepare(sql).run(...params).changes) } };
    },
    async run() { return this.runSync(); },
  });
  return {
    prepare: (sql) => { onPrepare(sql); return stmt(sql); },
    // like D1: the statements of a batch run as one transaction, with nothing else in between
    async batch(list) {
      db.exec("BEGIN");
      try { const out = list.map((s) => s.runSync()); db.exec("COMMIT"); return out; }
      catch (err) { db.exec("ROLLBACK"); throw err; }
    },
  };
}

// an empty database with the schema of the collector
export function emptyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8"));
  return db;
}
