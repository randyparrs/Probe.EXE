// node --test collector/export/export.test.mjs
// The daily data export against a fake page: which files it writes and what the commit says.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COLUMNS, RULES, changes, exportAll, fromJsonl, toCsv } from "./export.mjs";

const tx = (n, epoch, status, more = {}) => ({ tx_id: "0x" + String(n).padStart(64, "0"), epoch, contract: "0xc", llm: "llm", campaign: null, created: 1000 + n,
  created_block: 10 + n, status, accepted: status === "first" ? 1010 + n : null, accept_seconds: status === "first" ? 10 : null, leader_timeouts: 0, rotations: 0,
  appeals: 0, recomputations: 0, votes_agree: 5, votes_disagree: 0, votes_dv: 0, votes_timeout: 0, attempts: [{ leader: "0xl", leader_timeout: false, result: "agree", votes: [["0xv", "agree"]] }], ...more });

// a page that serves `epochs` (Map of epoch -> rows), two rows per page of the export
function fakePage(epochs, current) {
  return async (url) => {
    const u = new URL(url);
    let body;
    if (u.pathname === "/api/meta") body = { epoch: { number: current }, epochs: [...epochs.keys()].map((epoch) => ({ epoch })) };
    else {
      const rows = epochs.get(Number(u.searchParams.get("epoch"))), from = Number(u.searchParams.get("after") ?? 0);
      body = { rows: rows.slice(from, from + 2), next: from + 2 < rows.length ? String(from + 2) : null };
    }
    return { ok: true, status: 200, json: async () => body };
  };
}

test("CSV: the columns of a row without its attempts, with quoted cells where needed", () => {
  const csv = toCsv([tx(1, 168, "first", { campaign: 'a "b", c' }), tx(2, 168, "pending")]).split("\n");
  assert.equal(csv[0], COLUMNS.join(","));
  assert.ok(!COLUMNS.includes("attempts"));
  assert.equal(csv[1].split(",").length, COLUMNS.length + 1);          // one comma inside the quoted cell
  assert.ok(csv[1].includes('"a ""b"", c"'));
  assert.ok(csv[2].includes(",pending,,,0,"));                          // not accepted: empty cells
  assert.equal(csv[3], "");
});

test("what changed in an epoch is said in one sentence", () => {
  const before = [tx(1, 167, "first"), tx(2, 167, "pending"), tx(3, 167, "pending")];
  assert.equal(changes(before, before), null);
  assert.equal(changes(before, [tx(1, 167, "first"), tx(2, 167, "first"), tx(3, 167, "none"), tx(4, 167, "first")]),
    "1 new transactions, 1 went from pending to first, 1 went from pending to none");
  assert.equal(changes(before, [tx(1, 167, "first", { votes_agree: 6 }), tx(2, 167, "pending")]), "1 transactions removed, 1 with later events and the same status");
});

test("the export writes one pair of files per epoch, rewrites what changed and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-export-"));
  const closed = [tx(1, 167, "first"), tx(2, 167, "pending"), tx(3, 167, "first")], open = [tx(4, 168, "first")];
  const epochs = new Map([[167, closed], [168, open]]);
  const run = (now) => exportAll({ base: "http://page", dir, now, fetchFn: fakePage(epochs, 168) });

  assert.equal(await run(1790899200), "Data export 2026-10-02\n\nepoch 167: new, 3 rows\nepoch 168: new, 1 rows\n");
  assert.deepEqual(readdirSync(dir).sort(), ["epoch-167.csv", "epoch-167.jsonl", "epoch-168.csv", "epoch-168.jsonl", "index.json"]);
  assert.deepEqual(fromJsonl(readFileSync(join(dir, "epoch-167.jsonl"), "utf8")), closed);     // three rows over two pages, with their attempts
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")), { updated: "2026-10-02T00:00:00.000Z", rules: RULES.version, files: [
    { epoch: 168, csv: "epoch-168.csv", jsonl: "epoch-168.jsonl", rows: 1 }, { epoch: 167, csv: "epoch-167.csv", jsonl: "epoch-167.jsonl", rows: 3 }] });

  assert.equal(await run(1790985600), null);                           // nothing changed: nothing written
  assert.equal(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).updated, "2026-10-02T00:00:00.000Z");

  // the next day: the epoch in progress grew, and a transaction of the closed one ended
  open.push(tx(5, 168, "retry"));
  closed[1] = tx(2, 167, "none");
  assert.equal(await run(1790985600), "Data export 2026-10-03\n\nepoch 167 (closed) rewritten: 1 went from pending to none\nepoch 168 (in progress): 2 rows\n");
  assert.equal(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).files[0].rows, 2);

  // an epoch the page no longer lists keeps its files and its entry in the index
  epochs.delete(167);
  open.push(tx(6, 168, "first"));
  await run(1791072000);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).files.map((f) => [f.epoch, f.rows]), [[168, 3], [167, 3]]);
});

test("a new column rewrites every file and is said once; a corrected creation time is said apart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-export-"));
  const closed = [tx(1, 167, "first"), tx(2, 167, "none")], open = [tx(3, 168, "pending")];
  const epochs = new Map([[167, closed], [168, open]]);
  const run = (now) => exportAll({ base: "http://page", dir, now, fetchFn: fakePage(epochs, 168) });
  await run(1790899200);

  const withQueue = (r, queue_seconds = 0) => { const { attempts, ...rest } = r; return { ...rest, queue_seconds, attempts }; };
  epochs.set(167, [withQueue(closed[0]), withQueue({ ...closed[1], created: 1500, created_block: 99 }, 840)]);
  epochs.set(168, [withQueue(open[0])]);
  assert.equal(await run(1790985600), "Data export 2026-10-03\n\nNew column in every file: queue_seconds (see Data files in the README).\n"
    + "epoch 167 (closed) rewritten: 1 with a different creation time\nepoch 168 (in progress): 1 rows\n");
  assert.equal(readFileSync(join(dir, "epoch-167.csv"), "utf8").split("\n")[0].split(",").at(-1), "queue_seconds");
});

test("a change of the counting rules is said once, before the epochs it rewrites", async () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-export-"));
  const closed = [tx(1, 167, "first"), tx(2, 167, "pending")];
  const epochs = new Map([[167, closed]]);
  const run = (now) => exportAll({ base: "http://page", dir, now, fetchFn: fakePage(epochs, 168) });
  await run(1790899200);
  const index = join(dir, "index.json");
  writeFileSync(index, JSON.stringify({ ...JSON.parse(readFileSync(index, "utf8")), rules: "2026-10-01" }));   // written under older rules
  epochs.set(167, [tx(1, 167, "first"), tx(2, 167, "none")]);
  assert.equal(await run(1790985600), `Data export 2026-10-03\n\nCounting rules of ${RULES.version} (docs/METRICS.md): ${RULES.summary}.\n`
    + "epoch 167 (closed) rewritten: 1 went from pending to none\n");
  assert.equal(JSON.parse(readFileSync(index, "utf8")).rules, RULES.version);
  assert.equal(await run(1791072000), null);                            // said once
});
