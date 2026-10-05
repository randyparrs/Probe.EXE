// One-off: applies the counting rules of 2026-10-05 (docs/METRICS.md, "Finalized decides" and "Votes
// and attempts") to the transactions stored before them. It replays the stored consensus events of
// every transaction with collector/core/events.js and writes SQL that updates the transactions whose
// state changed and moves them between the classes of the hourly counters. It only reads the chain
// data already stored.
//
//   1. export the database (from collector/worker):
//      npx wrangler d1 export probe-exe --remote --output=<copy>.sql
//   2. node recount-v6.mjs <copy>.sql recount-v6.sql
//   3. npx wrangler d1 execute probe-exe --remote --yes --file=recount-v6.sql
//
// Every statement applies only while the transaction is as it was in the copy (same last block and
// status): a transaction that the collector updated in between keeps what the collector wrote.

import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { apply, newTx, status, txIdsOf } from "../core/events.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: node recount-v6.mjs <copy.sql> <out.sql>");

const db = new DatabaseSync(":memory:");
db.exec("BEGIN");
db.exec(readFileSync(input, "utf8").replace(/^\s*(BEGIN TRANSACTION|COMMIT);\s*$/gim, ""));
db.exec("COMMIT");

// fields the collector keeps in the state besides what the events give
const KEEP = ["epoch", "hour", "sender", "camp", "queued", "createdBlock", "createdTs", "queueSecs"];
const classOf = (tx, st) => {
  if (tx.recipient == null || tx.epoch == null) return null;
  const cls = st === "first" || st === "retry" || st === "none" ? st : "pending";
  return { cls, cancelled: cls === "none" && (tx.cancelled || !tx.attempts.some((a) => a.votes.length > 0)) };
};

const stored = new Map(db.prepare("SELECT tx_id, status, last_block, state FROM tx").all().map((r) => [r.tx_id, r]));
const replayed = new Map();
for (const row of db.prepare("SELECT block, log_index, ts, name, args FROM events ORDER BY block, log_index").iterate()) {
  const ev = { name: row.name, args: JSON.parse(row.args), block: row.block, logIndex: row.log_index, ts: row.ts };
  for (const id of txIdsOf(ev)) {
    if (!stored.has(id)) continue;
    if (!replayed.has(id)) replayed.set(id, newTx(id));
    apply(replayed.get(id), ev);
  }
}

// the same JSON whatever the order of the keys
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const q = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sql = [], moves = new Map(), counts = new Map();
let changed = 0;
for (const [id, tx] of replayed) {
  const row = stored.get(id), old = JSON.parse(row.state);
  for (const k of KEEP) if (k in old) tx[k] = old[k];
  if (old.queued) tx.recipient = old.recipient;
  const now = status(tx);
  if (canon(tx) === canon(old) && now === row.status) continue;
  changed++;
  const guard = `tx_id = ${q(id)} AND last_block = ${row.last_block} AND status = ${q(row.status)}`;
  const was = classOf(old, row.status), is = classOf(tx, now);
  if (was && is && (was.cls !== is.cls || was.cancelled !== is.cancelled)) {
    const set = [];
    if (was.cls !== "pending") set.push(`${was.cls} = ${was.cls} - 1`);
    if (is.cls !== "pending") set.push(`${is.cls} = ${is.cls} + 1`);
    const dc = (is.cancelled ? 1 : 0) - (was.cancelled ? 1 : 0);
    if (dc) set.push(`cancelled = cancelled + ${dc}`);
    sql.push(`UPDATE contract_hour SET ${set.join(", ")} WHERE epoch = ${tx.epoch} AND hour = ${tx.hour} AND contract = ${q(tx.recipient)}`
      + ` AND camp = ${tx.camp ? 1 : 0} AND EXISTS (SELECT 1 FROM tx WHERE ${guard});`);
    const key = `${row.status} to ${now}`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
    counts.set(tx.epoch, (counts.get(tx.epoch) ?? 0) + 1);
  }
  const acceptSecs = tx.acceptedTs != null && tx.firstTs != null ? tx.acceptedTs - tx.firstTs : null;
  sql.push(`UPDATE tx SET status = ${q(now)}, accepted_ts = ${q(tx.acceptedTs)}, accept_secs = ${q(acceptSecs)},`
    + ` leader_timeouts = ${tx.leaderTimeouts}, rotations = ${tx.rotations}, appeals = ${tx.appeals},`
    + ` recomputations = ${tx.recomputations}, state = ${q(JSON.stringify(tx))} WHERE ${guard};`);
}
writeFileSync(output, sql.join("\n") + "\n");
console.log(`${replayed.size} transactions replayed, ${changed} with a different state`);
console.log(`class changes: ${[...moves].map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
console.log(`by epoch: ${[...counts].sort((a, b) => a[0] - b[0]).map(([e, n]) => `${e}: ${n}`).join(", ") || "none"}`);
console.log(`${sql.length} statements written to ${output}`);
