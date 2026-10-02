// One-off: fills eligible_set and leader_draw for the campaign transactions stored before the
// collector kept the eligible set. It reads the validator lists and stakes at past blocks (the RPC
// answers eth_call for them) and writes SQL to apply with wrangler. It only reads the chain.
//
//   1. export the campaign transactions (from collector/worker):
//      npx wrangler d1 execute probe-exe --remote --yes --json --command "SELECT epoch, hour, first_block, first_ts,
//        json_extract(state, '$.attempts[0].leader') leader FROM tx WHERE camp IS NOT NULL ORDER BY first_block" > backfill-campaign-tx.json
//   2. node backfill-leader-draw.mjs backfill-campaign-tx.json backfill-leader-draw.sql
//   3. npx wrangler d1 execute probe-exe --remote --yes --file=backfill-leader-draw.sql
//
// The rows replace what is stored for the same hours, so it can be repeated; do not run it while a
// campaign is in progress.

import { readFileSync, writeFileSync } from "node:fs";
import { SELECTOR, STAKING_ADDRESS, callData, decodeAddresses, decodeBanned, decodeValidatorView, inEffect, toGen, weightOf } from "../core/staking.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: node backfill-leader-draw.mjs <campaign-tx.json> <out.sql>");
const RPC = process.env.RPC_URL ?? "https://rpc-bradbury.genlayer.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + n.toString(16);

// wrangler --json prints [{ results: [...] }]; PowerShell redirection writes it as UTF-16
function readRows(path) {
  const raw = readFileSync(path);
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString("utf16le") : raw.toString("utf8");
  const json = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  return (json[0]?.results ?? json).filter((r) => r.leader && r.epoch != null);
}

async function batch(calls) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(calls.map(([data, block, to = STAKING_ADDRESS], i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to, data }, hex(block)] }))) });
    const body = await res.json().catch(() => null);
    if (Array.isArray(body) && body.every((r) => !r.error)) return calls.map((_, i) => body.find((r) => r.id === i + 1).result);
    if (attempt === 4) throw new Error("eth_call failed: " + JSON.stringify(body)?.slice(0, 200));
    await sleep(3000);
  }
}

// addresses of the validators active, not banned and with no quarantine in effect at a block of an epoch, sorted
const memberCache = new Map();
async function membersAt(block, epoch) {
  if (!memberCache.has(block)) {
    const [active, banned, quarantined] = await batch([[SELECTOR.activeValidators, block], [callData.bannedValidators(), block], [callData.quarantinedValidators(), block]]);
    const out = new Set([...decodeBanned(banned), ...decodeBanned(quarantined).filter((q) => inEffect(q, epoch))].map((b) => b.validator));
    memberCache.set(block, decodeAddresses(active).filter((a) => !out.has(a)).sort());
  }
  return memberCache.get(block);
}

// first index of each run of transactions with the same eligible validators, by bisection
async function changePoints(txs, lo, hi, out) {
  const [a, b] = [await membersAt(txs[lo].first_block, txs[lo].epoch), await membersAt(txs[hi].first_block, txs[hi].epoch)];
  if (a.join() === b.join()) return;
  if (hi - lo === 1) { out.push(hi); return; }
  const mid = (lo + hi) >> 1;
  await changePoints(txs, lo, mid, out);
  await changePoints(txs, mid, hi, out);
}

async function weightsAt(block, addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 10) {
    const part = addresses.slice(i, i + 10);
    const views = await batch(part.map((a) => [callData.validatorView(a), block]));
    part.forEach((a, k) => { const v = decodeValidatorView(views[k]); out.push([a, Math.round(weightOf(toGen(v.selfStake), toGen(v.delegatedStake)) * 1e4) / 1e4]); });
    await sleep(500);
  }
  return out;
}

const txs = readRows(input).sort((a, b) => a.first_block - b.first_block);
if (!txs.length) throw new Error("no campaign transactions with a leader in " + input);

// one set per epoch and per change of the eligible validators within it
const sets = [];
for (const epoch of [...new Set(txs.map((t) => t.epoch))]) {
  const group = txs.filter((t) => t.epoch === epoch);
  const starts = [0];
  if (group.length > 1) await changePoints(group, 0, group.length - 1, starts);
  for (const i of starts.sort((a, b) => a - b)) {
    const t = group[i];
    sets.push({ block: t.first_block, ts: t.first_ts, epoch, members: await weightsAt(t.first_block, await membersAt(t.first_block, epoch)) });
  }
}
sets.sort((a, b) => a.block - b.block);

const draws = new Map();   // "epoch|hour|validator" -> { first, expected }
const row = (t, validator) => {
  const key = `${t.epoch}|${t.hour}|${validator}`;
  if (!draws.has(key)) draws.set(key, { first: 0, expected: 0 });
  return draws.get(key);
};
for (const t of txs) {
  const set = sets.filter((s) => s.block <= t.first_block).at(-1);
  const total = set.members.reduce((n, [, w]) => n + w, 0);
  for (const [a, w] of set.members) row(t, a).expected += w / total;
  row(t, t.leader.toLowerCase()).first++;
}

const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sql = [
  ...sets.map((s) => `INSERT OR REPLACE INTO eligible_set (block, ts, epoch, members) VALUES (${s.block}, ${s.ts}, ${s.epoch}, ${quote(JSON.stringify(s.members))});`),
  ...[...draws].map(([key, r]) => { const [epoch, hour, validator] = key.split("|"); return `INSERT OR REPLACE INTO leader_draw (epoch, hour, validator, first, expected) VALUES (${epoch}, ${hour}, ${quote(validator)}, ${r.first}, ${r.expected});`; }),
];
writeFileSync(output, sql.join("\n") + "\n");

console.log(`${txs.length} campaign transactions with a first leader, ${sets.length} eligible sets, ${draws.size} rows`);
for (const s of sets) console.log(`  set at block ${s.block} (epoch ${s.epoch}): ${s.members.length} validators`);
const outside = [...draws].filter(([, r]) => r.first > 0 && r.expected === 0);
console.log(outside.length ? `  led without being in the eligible set: ${outside.map(([k]) => k.split("|")[2]).join(", ")}` : "  every first leader was in the eligible set of its transaction");
