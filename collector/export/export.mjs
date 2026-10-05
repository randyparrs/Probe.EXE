// Daily data export: one CSV file and one JSON Lines file per epoch, plus index.json, written to a
// directory that the workflow commits to the "data" branch. It reads the public API of the page
// (GET /api/meta and GET /api/export), so anyone can reproduce the files.
//
//   node collector/export/export.mjs <output directory>
//   PAGE_URL: where the page is served (default https://probe-exe.pages.dev)
//
// The epoch in progress is rewritten every day. A closed epoch is rewritten only when its rows
// changed, and then the commit message says what changed. The columns are documented in the README.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The counting rules the rows follow (docs/METRICS.md), kept in index.json. A change is said once in
// the commit message; the rows it changes are rewritten like any other change.
export const RULES = {
  version: "2026-10-05",
  summary: "a decision other than an acceptance is final only once the transaction is finalized, a transaction "
    + "finalized with no acceptance is no consensus, and each vote belongs to the attempt whose committee contains the voter",
};

// CSV columns, in order: every field of a row but `attempts`, which only the JSON Lines file carries
export const COLUMNS = ["tx_id", "epoch", "contract", "llm", "campaign", "created", "created_block", "status", "accepted", "accept_seconds",
  "leader_timeouts", "rotations", "appeals", "recomputations", "votes_agree", "votes_disagree", "votes_dv", "votes_timeout", "queue_seconds"];

const cell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (rows) => [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
export const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
export const fromJsonl = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line));

// Fields of the rows that the previous version of a file did not have (a new column).
export const newFields = (before, after) => (before.length && after.length ? Object.keys(after[0]).filter((k) => !(k in before[0])) : []);

// What changed between two versions of the rows of an epoch, as one sentence; null when nothing did.
// A new column is reported once by exportAll, not as a change of every row.
export function changes(before, after) {
  const old = new Map(before.map((r) => [r.tx_id, r]));
  const added = after.filter((r) => !old.has(r.tx_id)).length;
  const removed = before.length - (after.length - added);
  const fresh = new Set(newFields(before, after));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => !fresh.has(k))));
  const moves = new Map();
  let created = 0, other = 0;
  for (const r of after) {
    const was = old.get(r.tx_id);
    if (!was || same(was, r)) continue;
    if (was.status !== r.status) moves.set(`${was.status} to ${r.status}`, (moves.get(`${was.status} to ${r.status}`) ?? 0) + 1);
    else if (was.created !== r.created) created++;
    else other++;
  }
  const parts = [];
  if (added) parts.push(`${added} new transactions`);
  if (removed) parts.push(`${removed} transactions removed`);
  for (const [move, n] of moves) parts.push(`${n} went from ${move}`);
  if (created) parts.push(`${created} with a different creation time`);
  if (other) parts.push(`${other} with later events and the same status`);
  return parts.length ? parts.join(", ") : null;
}

// every page of the export of an epoch
export async function fetchEpoch(base, epoch, fetchFn = fetch) {
  const rows = [];
  for (let after = null, pages = 0; ; pages++) {
    if (pages > 2000) throw new Error(`epoch ${epoch}: too many pages`);
    const res = await fetchFn(`${base}/api/export?epoch=${epoch}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (!res.ok) throw new Error(`export of epoch ${epoch}: HTTP ${res.status}`);
    const page = await res.json();
    rows.push(...page.rows);
    if (!page.next) return rows;
    after = page.next;
  }
}

// Writes the files of every epoch the page lists and returns the commit message, or null when
// nothing changed. now: seconds.
export async function exportAll({ base, dir, now, fetchFn = fetch }) {
  const res = await fetchFn(`${base}/api/meta`);
  if (!res.ok) throw new Error(`meta: HTTP ${res.status}`);
  const meta = await res.json();
  const current = meta.epoch?.number ?? null;
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, "index.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : null;
  const files = new Map((index ? index.files : []).map((f) => [f.epoch, f]));
  const notes = [], columns = new Set();
  for (const { epoch } of [...meta.epochs].sort((a, b) => a.epoch - b.epoch)) {
    const rows = await fetchEpoch(base, epoch, fetchFn);
    const name = { csv: `epoch-${epoch}.csv`, jsonl: `epoch-${epoch}.jsonl` };
    const path = join(dir, name.jsonl), jsonl = toJsonl(rows);
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (before === jsonl || (before === null && !rows.length)) continue;
    writeFileSync(path, jsonl);
    writeFileSync(join(dir, name.csv), toCsv(rows));
    files.set(epoch, { epoch, ...name, rows: rows.length });
    if (before !== null) newFields(fromJsonl(before), rows).forEach((k) => columns.add(k));
    if (before === null) notes.push(`epoch ${epoch}: new, ${rows.length} rows`);
    else if (epoch === current) notes.push(`epoch ${epoch} (in progress): ${rows.length} rows`);
    else notes.push(`epoch ${epoch} (closed) rewritten: ${changes(fromJsonl(before), rows) ?? "rows reordered"}`);
  }
  const newRules = index !== null && index.rules !== RULES.version;
  if (!notes.length && !newRules) return null;
  const updated = new Date(now * 1000).toISOString();
  writeFileSync(indexPath, JSON.stringify({ updated, rules: RULES.version, files: [...files.values()].sort((a, b) => b.epoch - a.epoch) }, null, 2) + "\n");
  // a new column rewrites every file, a change of rules may rewrite several: each is said once, first
  if (columns.size) notes.unshift(`New column in every file: ${[...columns].join(", ")} (see Data files in the README).`);
  if (newRules) notes.unshift(`Counting rules of ${RULES.version} (docs/METRICS.md): ${RULES.summary}.`);
  return `Data export ${updated.slice(0, 10)}\n\n${notes.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: node collector/export/export.mjs <output directory>");
  const base = (process.env.PAGE_URL ?? "https://probe-exe.pages.dev").replace(/\/+$/, "");
  const message = await exportAll({ base, dir, now: Math.floor(Date.now() / 1000) });
  console.log(message ?? "nothing changed");
  // the workflow commits only when this file exists
  if (message && process.env.COMMIT_MESSAGE_FILE) writeFileSync(process.env.COMMIT_MESSAGE_FILE, message);
}
