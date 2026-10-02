// node --test collector/worker/collect.test.mjs
// The collector and its SQL on real consensus logs, with node:sqlite standing in for D1 and a
// fake RPC that serves the fixture.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testnetBradbury } from "genlayer-js/chains";
import { encodeAbiParameters, encodeFunctionResult } from "viem";
import { decodeLog } from "../core/events.js";
import { EPOCH_ADVANCE_TOPIC, EPOCH_SELECTOR, SELECTOR, STAKING_ADDRESS } from "../core/staking.js";

const S = testnetBradbury.stakingContract;
const IDENTITY = [...["moniker", "logoUri", "website", "description", "email", "twitter", "telegram", "github"].map((name) => ({ name, type: "string" })),
  { name: "extraCid", type: "bytes" }];
import { toGen, weightOf } from "../core/staking.js";
import TABLE from "../core/consensus-events.js";
import { EVENTS_PAGE, badge, campaignSlot, campaigns, contracts, events, exportPage, failedCampaigns, lastCampaign, latency, operators, overview,
  rpcIncidents, stalledContracts, tally, viewFilter, viewRange } from "./src/api.js";
import { BACK_SPAN, MAX_SPAN, STALL_SECONDS, collect, eligibleMembers, nextEligibleSet, rpcClient } from "./src/collect.js";
import { d1Store } from "./src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "..", "core", "fixtures", "two-transactions.json"), "utf8"));
// the fixture has no EVM transaction hashes: give every log one
const LOGS = fx.logs.map((l, i) => ({ ...l, transactionHash: "0x" + String(i).padStart(64, "0") }));
const FIRST = Number(LOGS[0].blockNumber), LAST = Number(LOGS.at(-1).blockNumber);
const EVENTS = LOGS.map((l) => decodeLog(l));
const STARTS = EVENTS.filter((ev) => ev.name === "NewTransaction");
const A = fx.firstAttempt.toLowerCase(), B = fx.afterLeaderTimeout.toLowerCase();
const recipientOf = (id) => STARTS.find((ev) => ev.args.txId === id).args.recipient;
const count = (name) => EVENTS.filter((ev) => ev.name === name).length;

const WALLET = "0x" + "aa".repeat(20), STRANGER = "0x" + "bb".repeat(20);
// A goes to the control and is sent by the campaign wallet; B goes to an LLM contract, sent by someone else
const REFERENCE = new Map([[recipientOf(A), { name: "dvA", llm: false }], [recipientOf(B), { name: "wizard", llm: true }]]);
const SENDER = new Map([[STARTS.find((ev) => ev.args.txId === A).evmHash, WALLET], [STARTS.find((ev) => ev.args.txId === B).evmHash, STRANGER]]);

// the subset of the D1 API that store.js uses
function fakeD1(db) {
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
    prepare: (sql) => stmt(sql),
    // like D1: the statements of a batch run as one transaction, with nothing else in between
    async batch(list) {
      db.exec("BEGIN");
      try { const out = list.map((s) => s.runSync()); db.exec("COMMIT"); return out; }
      catch (err) { db.exec("ROLLBACK"); throw err; }
    },
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return { db, store: d1Store(fakeD1(db)), get: (sql, ...p) => db.prepare(sql).get(...p) };
}

// Answers the calls of the collector from the fixture. advances: EpochAdvance logs of the staking
// contract; epochAtStart: what epoch() answers; code: contract address -> source or null (not found).
const NO_VALIDATORS = { active: [], quarantined: [], banned: [], stake: {}, moniker: {} };
function fakeFetch({ tip = LAST, logs = LOGS, advances = [], epochAtStart = 167, code = {}, calls = [], validators = NO_VALIDATORS } = {}) {
  const answer = ({ method, params }) => {
    calls.push({ method, params });
    if (method === "eth_blockNumber") return { result: "0x" + tip.toString(16) };
    if (method === "eth_getLogs") {
      const { address, fromBlock, toBlock } = params[0];
      const source = address === STAKING_ADDRESS ? advances : logs;
      return { result: source.filter((l) => Number(l.blockNumber) >= Number(fromBlock) && Number(l.blockNumber) <= Number(toBlock)) };
    }
    if (method === "eth_call") {
      const { to, data } = params[0];
      if (data === EPOCH_SELECTOR) return { result: "0x" + epochAtStart.toString(16).padStart(64, "0") };
      if (data === SELECTOR.activeValidators) return { result: encodeFunctionResult({ abi: S.abi, functionName: "activeValidators", result: validators.active }) };
      // quarantined: an address (a record in effect) or [address, until epoch]
      if (data.startsWith(SELECTOR.quarantinedValidators)) return { result: encodeFunctionResult({ abi: S.abi, functionName: "getAllQuarantinedValidators",
        result: validators.quarantined.map((q) => (Array.isArray(q) ? q : [q, 999])).map(([validator, until]) => ({ validator, untilEpochBanned: BigInt(until), permanentlyBanned: false })) }) };
      if (data.startsWith(SELECTOR.bannedValidators)) return { result: encodeFunctionResult({ abi: S.abi, functionName: "getAllBannedValidators",
        result: validators.banned.map(([validator, until]) => ({ validator, untilEpochBanned: BigInt(until), permanentlyBanned: false })) }) };
      if (data.startsWith(SELECTOR.validatorView)) {
        const stake = validators.stake["0x" + data.slice(-40)];
        if (!stake) return { error: { message: "execution reverted" } };
        return { result: encodeFunctionResult({ abi: S.abi, functionName: "validatorView", result: { left: to, right: to, parent: to, eBanned: 0n, ePrimed: 167n,
          vStake: stake[0], vShares: 0n, dStake: stake[1], dShares: 0n, vDeposit: 0n, vWithdrawal: 0n, live: true } }) };
      }
      if (data === SELECTOR.getIdentity) {
        const moniker = validators.moniker[to];
        if (moniker == null) return { error: { message: "execution reverted" } };
        return { result: encodeAbiParameters([{ type: "tuple", components: IDENTITY }],
          [{ moniker, logoUri: "", website: "", description: "", email: "", twitter: "", telegram: "", github: "", extraCid: "0x" }]) };
      }
      return { error: { message: "unexpected eth_call " + data.slice(0, 10) } };
    }
    if (method === "eth_getTransactionByHash") return { result: { from: SENDER.get(params[0]) } };
    if (method === "gen_getContractCode") {
      const source = code[params[0].address];
      return source == null ? { error: { code: -32001, message: "contract code not found at address" } } : { result: btoa(source) };
    }
    return { error: { message: "unexpected " + method } };
  };
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const out = Array.isArray(body) ? body.map((c) => ({ jsonrpc: "2.0", id: c.id, ...answer(c) })) : { jsonrpc: "2.0", id: body.id, ...answer(body) };
    return { text: async () => JSON.stringify(out) };
  };
}

const advance = (epoch, block) => ({ address: STAKING_ADDRESS, topics: [EPOCH_ADVANCE_TOPIC], data: "0x" + epoch.toString(16).padStart(64, "0"),
  blockNumber: "0x" + block.toString(16), logIndex: "0x0", blockTimestamp: "0x" + (1790000000 + block).toString(16) });

async function runAll(store, options = {}, extra = 0) {
  let n = 0, last;
  do {
    last = await collect({ rpc: rpcClient("http://rpc", fakeFetch(options)), store, now: 1000 + n, reference: REFERENCE,
      campaignWallet: WALLET, startBlock: FIRST });
    assert.equal(last.error, null);
    n++;
  } while (last.to < LAST);
  for (let i = 0; i < extra; i++) {
    await collect({ rpc: rpcClient("http://rpc", fakeFetch(options)), store, now: 1000 + n++, reference: REFERENCE, campaignWallet: WALLET, startBlock: FIRST });
  }
  return n;
}

test("runs of at most MAX_SPAN blocks rebuild both transactions and stop at the tip", async () => {
  const { store, get } = setup();
  const calls = [];
  const runs = await runAll(store, { calls });
  assert.equal(runs, Math.ceil((LAST - FIRST + 1) / MAX_SPAN));
  assert.ok(calls.filter((c) => c.method === "eth_getLogs" && c.params[0].address !== STAKING_ADDRESS)
    .every((c) => Number(c.params[0].toBlock) - Number(c.params[0].fromBlock) < MAX_SPAN));
  assert.equal((await store.state(3)).cursor, LAST);
  assert.equal(get("SELECT count(*) n FROM events").n, LOGS.length);
  assert.equal(get("SELECT status FROM tx WHERE tx_id = ?", A).status, "first");
  assert.equal(get("SELECT status FROM tx WHERE tx_id = ?", B).status, "retry");
  assert.equal(get("SELECT count(*) n FROM runs").n, runs);

  // nothing new: one RPC request, no rows touched
  const idle = await collect({ rpc: rpcClient("http://rpc", fakeFetch()), store, now: 2000, reference: REFERENCE, campaignWallet: WALLET });
  assert.deepEqual([idle.error, idle.logs, idle.rpcCalls, idle.rowsWritten], [null, 0, 1, null]);
});

test("each transaction is counted once in the hour and epoch it was created, in its final class", async () => {
  const { store, get } = setup();
  await runAll(store);
  const a = get("SELECT epoch, hour, first_ts, sender, camp, leader_timeouts, accept_secs FROM tx WHERE tx_id = ?", A);
  const b = get("SELECT epoch, hour, first_ts, sender, camp, leader_timeouts, accept_secs FROM tx WHERE tx_id = ?", B);
  assert.deepEqual([a.epoch, a.hour, a.sender, a.camp, a.leader_timeouts], [167, Math.floor(a.first_ts / 3600), WALLET, "dvA", 0]);
  assert.deepEqual([b.epoch, b.sender, b.camp, b.leader_timeouts], [167, STRANGER, null, 1]);   // not ours: not campaign
  assert.ok(a.accept_secs >= 0 && b.accept_secs > 0);
  assert.deepEqual({ ...get("SELECT sum(tx) tx, sum(first) first, sum(retry) retry, sum(none) none, sum(cancelled) cancelled FROM contract_hour") },
    { tx: 2, first: 1, retry: 1, none: 0, cancelled: 0 });
  assert.deepEqual({ ...get("SELECT camp, tx, first FROM contract_hour WHERE contract = ?", recipientOf(A)) }, { camp: 1, tx: 1, first: 1 });
  assert.deepEqual({ ...get("SELECT camp, tx, retry FROM contract_hour WHERE contract = ?", recipientOf(B)) }, { camp: 0, tx: 1, retry: 1 });
});

test("votes, leader rounds and leader timeouts are counted per validator and source", async () => {
  const { store, get } = setup();
  await runAll(store);
  const sums = get("SELECT sum(votes) votes, sum(agree + disagree + dv + timeout) typed, sum(led) led, sum(leader_timeouts) lt FROM op_hour");
  assert.equal(sums.votes, count("VoteRevealed"));
  assert.ok(sums.typed <= sums.votes && sums.typed > 0);
  assert.equal(sums.led, count("TransactionActivated") + count("TransactionLeaderRotated"));
  assert.equal(sums.lt, count("TransactionLeaderTimeout"));
  const control = EVENTS.filter((ev) => ev.name === "VoteRevealed" && ev.args.txId === A).length;
  assert.equal(get("SELECT sum(votes) n FROM op_hour WHERE src = 'camp_control'").n, control);
  assert.equal(get("SELECT sum(votes) n FROM op_hour WHERE src = 'net'").n, count("VoteRevealed") - control);
  assert.equal(get("SELECT count(*) n FROM op_hour WHERE src = 'camp_llm'").n, 0);
  // the same votes, by type, in the counters of the contract of each transaction
  assert.equal(get("SELECT sum(agree + disagree + dv + timeout) n FROM contract_hour").n, sums.typed);
  assert.equal(get("SELECT agree + disagree + dv + timeout n FROM contract_hour WHERE contract = ?", recipientOf(A)).n, control);
});

test("an epoch change inside the range splits the transactions and is stored", async () => {
  const { store, get } = setup();
  const firstB = EVENTS.find((ev) => ev.args.txId === B).block, firstA = EVENTS.find((ev) => ev.args.txId === A).block;
  const later = firstA > firstB ? A : B, earlier = later === A ? B : A;
  const at = Math.max(firstA, firstB) - 1;   // the epoch starts just before the later transaction
  await runAll(store, { advances: [advance(168, at)] });
  assert.equal(get("SELECT epoch FROM tx WHERE tx_id = ?", earlier).epoch, 167);
  assert.equal(get("SELECT epoch FROM tx WHERE tx_id = ?", later).epoch, 168);
  assert.deepEqual({ ...get("SELECT epoch, start_block FROM epochs WHERE epoch = 168") }, { epoch: 168, start_block: at });
  assert.equal((await store.state(3)).epoch, 168);
  assert.equal(get("SELECT count(DISTINCT epoch) n FROM contract_hour").n, 2);
});

test("the start of the first epoch is found looking backwards, one step per run", async () => {
  const { store, get } = setup();
  const start = FIRST - BACK_SPAN - 10;   // in the second step backwards
  await runAll(store, { advances: [advance(167, start)] });
  assert.deepEqual({ ...get("SELECT epoch, start_block FROM epochs") }, { epoch: 167, start_block: start });
  assert.equal((await store.state(3)).epochBack, -1);
});

test("new contracts get their LLM label from their code, a few per run", async () => {
  const { store, get } = setup();
  const code = { [recipientOf(B)]: "x = gl.eq_principle.prompt_comparative(f, 'same')" };   // A's code is not found
  await runAll(store, { code }, 1);
  assert.equal(get("SELECT llm FROM contracts WHERE address = ?", recipientOf(B)).llm, "llm");
  assert.equal(get("SELECT llm FROM contracts WHERE address = ?", recipientOf(A)).llm, "na");
  assert.deepEqual({ ...get("SELECT ref_name FROM contracts WHERE address = ?", recipientOf(A)) }, { ref_name: "dvA" });
  assert.equal((await store.state(3)).pendingContracts.length, 0);
});

test("with more senders to read than allowed, a run stops before the next one and the totals are the same", async () => {
  const { store, get } = setup();
  const calls = [];
  let n = 0, last;
  do {
    last = await collect({ rpc: rpcClient("http://rpc", fakeFetch({ calls })), store, now: 1000 + n++, reference: REFERENCE,
      campaignWallet: WALLET, startBlock: Math.min(...STARTS.map((ev) => ev.block)), senderBatch: 1 });
    assert.equal(last.error, null);
  } while (last.to < LAST);
  const lookups = calls.filter((c) => c.method === "eth_getTransactionByHash");
  assert.ok(lookups.length === 2 && STARTS.length === 2);    // each sender read once, in separate runs
  assert.deepEqual({ ...get("SELECT sum(tx) tx, sum(first) first, sum(retry) retry FROM contract_hour") }, { tx: 2, first: 1, retry: 1 });
  assert.equal(get("SELECT sum(votes) n FROM op_hour").n, count("VoteRevealed"));
  assert.equal(get("SELECT count(*) n FROM events").n, EVENTS.filter((ev) => ev.block >= Math.min(...STARTS.map((s) => s.block))).length);
});

test("two runs that overlap do not count the same range twice: the second one to save fails", async () => {
  const { store, get } = setup();
  const start = () => collect({ rpc: rpcClient("http://rpc", fakeFetch()), store, now: 1000, reference: REFERENCE, campaignWallet: WALLET, startBlock: FIRST });
  const both = await Promise.all([start(), start()]);
  assert.equal(both.filter((r) => r.error === null).length, 1);
  assert.match(both.find((r) => r.error).error, /malformed JSON/i);
  const once = setup();
  await collect({ rpc: rpcClient("http://rpc", fakeFetch()), store: once.store, now: 1000, reference: REFERENCE, campaignWallet: WALLET, startBlock: FIRST });
  for (const sql of ["SELECT sum(votes) n FROM op_hour", "SELECT sum(tx) n FROM contract_hour", "SELECT count(*) n FROM events", "SELECT value n FROM meta WHERE key = 'cursor'"]) {
    assert.deepEqual(get(sql).n, once.get(sql).n, sql);
  }
});

test("a contract whose code cannot be read is labeled as not available, without stopping the run", async () => {
  const { store, get } = setup();
  const failing = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body) && body.method === "gen_getContractCode") throw new Error("The operation was aborted due to timeout");
    return fakeFetch()(url, init);
  };
  let n = 0, last;
  do { last = await collect({ rpc: rpcClient("http://rpc", failing), store, now: 1000 + n++, reference: REFERENCE, campaignWallet: WALLET, startBlock: FIRST }); assert.equal(last.error, null); } while (last.to < LAST);
  await collect({ rpc: rpcClient("http://rpc", failing), store, now: 1000 + n, reference: REFERENCE, campaignWallet: WALLET, startBlock: FIRST });
  assert.deepEqual({ ...get("SELECT count(*) n, sum(llm = 'na') na FROM contracts") }, { n: 2, na: 2 });
});

test("after minutes without a recorded run, the range is halved for each one", async () => {
  const { db, store } = setup();
  db.prepare("INSERT INTO runs (ts, logs, txs, rpc_calls, rpc_ms, non_json) VALUES (1000, 0, 0, 0, 0, 0)").run();
  const calls = [];
  await collect({ rpc: rpcClient("http://rpc", fakeFetch({ calls })), store, now: 1000 + 3 * 60, startBlock: FIRST });   // two minutes missing
  const range = calls.find((c) => c.method === "eth_getLogs").params[0];
  assert.equal(Number(range.toBlock) - Number(range.fromBlock) + 1, MAX_SPAN >> 2);
});

test("the read queries return the transactions oldest first and totals by view", async () => {
  const { store } = setup();
  await runAll(store);
  const txs = await store.latestTx(40);
  assert.equal(txs.length, 2);
  assert.ok(txs[0].first_ts <= txs[1].first_ts);
  const meta = await store.meta(5000);
  assert.deepEqual([meta.cursor, meta.epoch, meta.lastOk > 0], [LAST, 167, true]);
  const rows = await store.contractTotals({ sql: "h.epoch = ?1", params: [167] });
  assert.equal(rows.reduce((n, r) => n + r.tx, 0), 2);
  assert.equal((await store.contractTotals({ sql: "h.epoch = ?1", params: [166] })).length, 0);
  const list = await store.contractRows({ sql: "h.epoch >= ?1 AND h.hour >= ?2", params: [0, 0] }, 10);
  assert.deepEqual(list.map((r) => r.contract).sort(), [recipientOf(A), recipientOf(B)].sort());
});

test("the export of an epoch: its transactions in creation order, page by page, with votes and attempts", async () => {
  const { store } = setup();
  await runAll(store, { code: { [recipientOf(B)]: "gl.nondet.exec_prompt('x')" } }, 1);
  const order = [A, B].sort((x, y) => STARTS.find((ev) => ev.args.txId === x).block - STARTS.find((ev) => ev.args.txId === y).block);
  const all = await store.exportTx(167, 0, Number.MAX_SAFE_INTEGER, -1, "", 10);
  assert.deepEqual(all.map((r) => r.tx_id), order);
  // one transaction per page: the cursor is the block and the id of the last one
  const first = await store.exportTx(167, 0, Number.MAX_SAFE_INTEGER, -1, "", 1);
  const second = await store.exportTx(167, 0, Number.MAX_SAFE_INTEGER, first[0].first_block, first[0].tx_id, 1);
  assert.deepEqual([first[0].tx_id, second[0].tx_id], order);
  assert.equal((await store.exportTx(167, 0, Number.MAX_SAFE_INTEGER, second[0].first_block, second[0].tx_id, 1)).length, 0);
  assert.equal((await store.exportTx(166, 0, Number.MAX_SAFE_INTEGER, -1, "", 10)).length, 0);              // another epoch
  assert.equal((await store.exportTx(167, 0, all[0].first_block - 1, -1, "", 10)).length, 0);                // outside its block range

  const page = exportPage({ epoch: 167, rows: all });
  assert.equal(page.next, null);
  const a = page.rows.find((r) => r.tx_id === A), b = page.rows.find((r) => r.tx_id === B);
  assert.deepEqual([a.status, a.campaign, a.llm, a.contract, a.leader_timeouts], ["first", "dvA", "na", recipientOf(A), 0]);
  assert.deepEqual([b.status, b.campaign, b.llm, b.leader_timeouts], ["retry", null, "llm", 1]);
  assert.ok(a.accepted > a.created && a.accept_seconds === a.accepted - a.created && a.created_block > 0);
  const votesOf = (id) => EVENTS.filter((ev) => ev.name === "VoteRevealed" && ev.args.txId === id);
  assert.equal(a.votes_agree + a.votes_disagree + a.votes_dv + a.votes_timeout, votesOf(A).filter((ev) => ev.args.voteType > 0).length);
  assert.equal(b.attempts.reduce((n, t) => n + t.votes.length, 0), votesOf(B).length);
  assert.ok(b.attempts.some((t) => t.leader_timeout) && b.attempts.every((t) => t.votes.every(([v, type]) => v.startsWith("0x") && typeof type === "string")));
  assert.equal(a.attempts[0].leader, EVENTS.find((ev) => ev.name === "TransactionActivated" && ev.args.txId === A).args.leader);
});

test("the badge of a contract: its first-attempt rate in the epoch, colored by the health thresholds", async () => {
  const { store } = setup();
  await runAll(store);
  const totals = await store.contractEpoch(167, recipientOf(A));
  assert.deepEqual({ ...totals }, { tx: 1, first: 1, retry: 0, none: 0 });
  assert.deepEqual({ ...(await store.contractEpoch(167, "0x" + "00".repeat(20))) }, { tx: 0, first: 0, retry: 0, none: 0 });
  const svg = badge({ epoch: 167, totals });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20"/);
  assert.ok(svg.includes(">first attempt, epoch 167</text>") && svg.includes(">100.0% (n = 1)</text>") && svg.includes('fill="#1f8b3b"'));
  assert.ok(badge({ epoch: 168, totals: { first: 78, retry: 12, none: 10 } }).includes(">78.0% (n = 100)</text>"));
  assert.ok(badge({ epoch: 168, totals: { first: 78, retry: 12, none: 10 } }).includes('fill="#a87400"'));       // 70 to 90%
  assert.ok(badge({ epoch: 168, totals: { first: 6, retry: 2, none: 2 } }).includes('fill="#c23a37"'));           // below 70%
  const empty = badge({ epoch: 168, totals: { first: 0, retry: 0, none: 0 } });
  assert.ok(empty.includes(">no data</text>") && empty.includes('fill="#5b6b5e"'));
});

test("validator sets, stake and names are read from the chain, and changes of the sets are logged", async () => {
  const { store, get, db } = setup();
  const V1 = "0x" + "11".repeat(20), V2 = "0x" + "22".repeat(20), V3 = "0x" + "33".repeat(20), V4 = "0x" + "44".repeat(20);
  // V3 has a quarantine in effect; the one of V4 ended when epoch 167 started
  const validators = { active: [V1, V2, V3, V4], quarantined: [V3, [V4, 167]], banned: [], stake: { [V1]: [4000n * 10n ** 18n, 100n * 10n ** 18n], [V2]: [900n * 10n ** 18n, 0n] },
    moniker: { [V1]: "Alpha Node", [V2]: "" } };
  const runs = await runAll(store, { validators }, 12);
  const row = (a) => ({ ...get("SELECT moniker, self_stake, delegated_stake, active, quarantined, banned, live FROM validators WHERE address = ?", a) });
  assert.deepEqual(row(V1), { moniker: "Alpha Node", self_stake: "4000000000000000000000", delegated_stake: "100000000000000000000", active: 1, quarantined: 0, banned: 0, live: 1 });
  assert.deepEqual([row(V2).moniker, row(V2).self_stake], [null, "900000000000000000000"]);      // no declared name
  assert.deepEqual([row(V3).active, row(V3).quarantined, row(V3).self_stake], [1, 1, null]);    // its view could not be read
  assert.deepEqual([row(V4).active, row(V4).quarantined], [1, 0]);                             // an expired quarantine record does not count
  // every validator that voted or led has a row, also when it is in no list
  assert.equal(get("SELECT count(*) n FROM (SELECT DISTINCT validator FROM op_hour) o LEFT JOIN validators v ON v.address = o.validator WHERE v.address IS NULL").n, 0);
  assert.ok(get("SELECT count(*) n FROM validators WHERE info_ts IS NOT NULL").n > 3);
  assert.equal(get("SELECT count(*) n FROM log").n, 0);                 // the first read is the starting point
  const setsTs = (await store.state(3)).setsTs;
  assert.ok(setsTs >= 1000);

  // five minutes later V2 is banned until epoch 170 and V3 leaves quarantine
  const later = { ...validators, quarantined: [[V4, 167]], banned: [[V2, 170]] };
  await collect({ rpc: rpcClient("http://rpc", fakeFetch({ tip: LAST + 5, validators: later })), store, now: setsTs + 301, reference: REFERENCE, campaignWallet: WALLET });
  assert.deepEqual([row(V2).banned, row(V3).quarantined], [1, 0]);
  const log = db.prepare("SELECT type, data FROM log ORDER BY id").all().map((r) => [r.type, JSON.parse(r.data)]);
  assert.deepEqual(log, [["banned", { validator: V2, until: 170 }], ["eligible", { joined: [V3], left: [V2], eligible: 3 }]]);
  // the eligible set is stored when it changes: V4 is in it all along, V3 only after its quarantine
  const sets = db.prepare("SELECT block, members FROM eligible_set ORDER BY block").all().map((r) => [r.block, JSON.parse(r.members)]);
  assert.deepEqual(sets.map(([, m]) => m.map(([a]) => a)), [[V1, V2, V4], [V1, V3, V4]]);
  assert.deepEqual([sets[1][0], sets[1][1][0][1], sets[1][1][1][1]], [LAST + 5, Math.round(weightOf(4000, 100) * 1e4) / 1e4, null]);
  assert.ok(runs > 0);
});

test("the API answers of a view: campaign against its control, retries, latency and reference contracts", async () => {
  // here both transactions are sent by the campaign wallet
  const { store: s2 } = setup();
  const reference = REFERENCE, refLlm = new Map([["dvA", false], ["wizard", true]]);
  let n = 0, last;
  const bothOurs = fakeFetch();
  SENDER.set(STARTS.find((ev) => ev.args.txId === B).evmHash, WALLET);
  try {
    do {
      last = await collect({ rpc: rpcClient("http://rpc", bothOurs), store: s2, now: 1000 + n++, reference, campaignWallet: WALLET, startBlock: FIRST });
    } while (last.to < LAST);
  } finally {
    SENDER.set(STARTS.find((ev) => ev.args.txId === B).evmHash, STRANGER);
  }
  const meta = await s2.meta(5000);
  const filter = viewFilter(undefined, 5000, meta);
  assert.deepEqual([filter.view, filter.params], ["epoch:167", [167]]);
  assert.equal(viewFilter("24h", 5000, meta).view, "24h");
  assert.equal(viewFilter("epoch:9", 5000, meta).params[0], 9);
  assert.equal(viewFilter(undefined, 5000, { epoch: null, epochs: [] }), null);

  const [rows, campTx, voters, lastTs] = [await s2.contractTotals(filter), await s2.campaignTx(filter), await s2.campaignVoters(filter), await s2.lastCampaign(167)];
  const around = await s2.campaignAround(167, lastTs);
  const o = overview({ view: filter.view, rows, campTx, voters, last: around, refLlm, asOf: lastTs + 60 });
  assert.deepEqual([o.network.all.tx, o.network.all.first, o.network.all.retry, o.network.all.first_rate], [2, 1, 1, 0.5]);
  assert.deepEqual([o.campaign.control.tx, o.campaign.control.first_rate, o.campaign.control.votes.timeout], [1, 1, 0]);
  assert.deepEqual([o.campaign.llm.tx, o.campaign.llm.retry, o.campaign.llm.retries.leader_timeouts, o.campaign.llm.retries.transactions], [1, 1, 1, 1]);
  assert.equal(o.campaign.llm.votes.total, EVENTS.filter((ev) => ev.name === "VoteRevealed" && ev.args.txId === B && ev.args.voteType > 0).length);
  assert.equal(o.campaign.llm.time_to_acceptance.accepted, 1);
  assert.ok(o.campaign.llm.time_to_acceptance.median > 0 && o.campaign.voters > 0);
  assert.deepEqual([o.last_campaign.transactions, o.last_campaign.status], [2, "running"]);
  assert.equal(overview({ view: filter.view, rows, campTx, voters, last: around, refLlm, asOf: lastTs + 3600 }).last_campaign.status, "completed");
  assert.equal(o.validators, null);                                      // no validator read yet
  assert.deepEqual([meta.synced, meta.asOf === meta.lastOk], [true, true]);

  // operators: one row per validator that voted, with its votes per source
  const ops = operators({ view: filter.view, totals: await s2.operatorTotals(filter), series: await s2.operatorSeries(0), validators: await s2.validators() });
  assert.equal(ops.operators.reduce((n, r) => n + r.campaign_llm.votes + r.campaign_control.votes, 0), count("VoteRevealed"));
  assert.equal(ops.operators.reduce((n, r) => n + r.network.votes, 0), count("VoteRevealed"));     // network = every source
  assert.equal(ops.operators.reduce((n, r) => n + r.network.leader_timeouts, 0), count("TransactionLeaderTimeout"));
  assert.ok(ops.operators.every((r) => r.status === "Not active" && r.stake === null && r.weight === null && r.by_epoch.length === 1));
  const withStake = operators({ view: filter.view, totals: [], series: [], validators: [
    { address: "0x1", moniker: "A", self_stake: "100000000000000000000", delegated_stake: "100000000000000000000", active: 1, quarantined: 0, banned: 0 },
    { address: "0x2", moniker: null, self_stake: null, delegated_stake: null, active: 1, quarantined: 1, banned: 0 },
    { address: "0x3", moniker: "C", self_stake: "1", delegated_stake: "0", active: 0, quarantined: 0, banned: 1, banned_until: 170 }] });
  assert.deepEqual(withStake.validators, { active: 2, eligible: 1, quarantined: 1, banned: 1 });
  assert.deepEqual(withStake.operators.map((r) => [r.status, r.eligible, r.weight, r.banned_until, r.leader]),
    [["Active", true, 10, null, null], ["Quarantined", false, null, null, null], ["Banned", false, weightOf(toGen("1"), 0), 170, null]]);
  const drawn = operators({ view: filter.view, totals: [], series: [], validators: [], draws: [{ validator: "0x9", first: 3, expected: 2.5 }] });
  assert.deepEqual(drawn.operators.map((r) => [r.address, r.leader]), [["0x9", { first: 3, expected: 2.5 }]]);

  const c = contracts({ view: filter.view, rows: await s2.contractRows(filter, 50), campTx, reference, refLlm });
  assert.deepEqual(c.reference.map((r) => [r.name, r.llm, r.tx, r.copies.length, r.retries.leader_timeouts]), [["dvA", false, 1, 1, 0], ["wizard", true, 1, 1, 1]]);
  assert.equal(c.network.length, 2);
  assert.ok(c.network.every((r) => r.last_seen > 0 && r.reference));
});

test("the campaign bucket of a day, and a day whose bucket passed with no campaign transaction", () => {
  const at = (iso) => Date.parse(iso) / 1000;
  // 2026-10-01 is day 274 of the year: 274 mod 8 = 2, the bucket from 06:00 to 09:00 UTC
  assert.deepEqual(campaignSlot(at("2026-10-01T15:00:00Z")), { start: at("2026-10-01T06:00:00Z"), end: at("2026-10-01T09:00:00Z") });
  assert.deepEqual(campaignSlot(at("2026-10-02T00:30:00Z")), { start: at("2026-10-02T09:00:00Z"), end: at("2026-10-02T12:00:00Z") });
  const ran = { transactions: 320, started: at("2026-10-01T07:01:00Z"), last_event: at("2026-10-01T08:22:00Z") };
  assert.equal(lastCampaign(ran, at("2026-10-01T08:25:00Z")).status, "running");       // an event three minutes ago
  assert.equal(lastCampaign(ran, at("2026-10-01T15:00:00Z")).status, "completed");
  // the next day: before its bucket ends the last campaign is still yesterday's; after it, with none seen, failed
  assert.equal(lastCampaign(ran, at("2026-10-02T11:00:00Z")).status, "completed");
  assert.deepEqual(lastCampaign(ran, at("2026-10-02T12:31:00Z")),
    { status: "failed", expected_from: at("2026-10-02T09:00:00Z"), expected_until: at("2026-10-02T12:00:00Z"), transactions: 0, started: null, last_event: null });
  assert.equal(lastCampaign(null, at("2026-10-01T05:00:00Z")), null);
  assert.equal(lastCampaign(null, null), null);
});

test("latency: nearest-rank median and p90 over accepted transactions, in ranges", () => {
  const txs = [5, 10, 20, 31, 59, 60, 200, 300, 900, 12].map((s) => ({ accept_secs: s, status: "first" }));
  txs.push({ accept_secs: null, status: "pending" }, { accept_secs: 40, status: "none" });   // not accepted: left out
  assert.deepEqual(latency(txs), { accepted: 10, median: 31, p90: 300, max: 900, under_30s: 4, s30_to_60: 2, m1_to_5: 2, over_5m: 2 });
  assert.equal(latency([]).median, null);
  assert.deepEqual(tally([]).votes, { agree: 0, disagree: 0, dv: 0, timeout: 0, total: 0 });
});

test("a contract with five transactions in a row without a vote is stalled an hour after the fifth, until a vote arrives", async () => {
  const { store, db } = setup();
  const topic = (name) => Object.entries(TABLE.events).find(([, def]) => def.name === name)[0];
  const hex = (n) => "0x" + n.toString(16), word = (n) => n.toString(16).padStart(64, "0"), pad = (a) => "0x" + a.slice(2).padStart(64, "0");
  const T0 = 1790000000, C = "0x" + "cc".repeat(20), D = "0x" + "dd".repeat(20), V = "0x" + "11".repeat(20);
  const at = (block) => ({ address: TABLE.address, blockNumber: hex(block), logIndex: "0x0", blockTimestamp: hex(T0 + block), transactionHash: "0x" + word(block) });
  const start = (n, to, block) => ({ ...at(block), topics: [topic("NewTransaction"), "0x" + word(n), pad(to), pad(WALLET)], data: "0x" });
  const vote = (n, block) => ({ ...at(block), topics: [topic("VoteRevealed"), "0x" + word(n), pad(V)], data: "0x" + word(1) + word(0) + word(0) });
  // five transactions to C that nobody votes on; one to D, voted in the same run; later a sixth to C and a vote on the third
  const logs = [1, 2, 3, 4, 5].map((n) => start(n, C, 100 + n)).concat([start(7, D, 106), vote(7, 107), start(6, C, 200), vote(3, 201)]);
  const run = (tip, now) => collect({ rpc: rpcClient("http://rpc", fakeFetch({ tip, logs })), store, now, reference: REFERENCE, campaignWallet: WALLET, startBlock: 100 });
  const rows = () => db.prepare("SELECT address, streak, since_ts, stalled_ts, stalled_tx, recovered_ts FROM contract_stall").all().map((r) => ({ ...r }));
  const log = () => db.prepare("SELECT ts, type, data FROM log ORDER BY id").all().map((r) => [r.ts, r.type, JSON.parse(r.data)]);
  const fifth = T0 + 105;

  assert.equal((await run(110, fifth + 60)).error, null);
  assert.deepEqual(rows(), [{ address: C, streak: 5, since_ts: null, stalled_ts: null, stalled_tx: null, recovered_ts: null }]);   // D made progress: no row
  assert.equal((await run(111, fifth + STALL_SECONDS - 1)).error, null);
  assert.deepEqual(log(), []);

  const detected = fifth + STALL_SECONDS;
  assert.equal((await run(112, detected)).error, null);            // a run with no events of the contract
  assert.deepEqual(log(), [[detected, "stalled", { contract: C, since: T0 + 101 }]]);
  assert.deepEqual(stalledContracts(await store.stalled(0, detected + 1)),
    [{ contract: C, reference: null, llm: "na", since: T0 + 101, transactions: 5, status: "no_progress", recovered: null }]);
  assert.equal((await run(113, detected + 60)).error, null);       // detected once
  assert.equal(log().length, 1);

  assert.equal((await run(201, detected + 120)).error, null);
  assert.deepEqual(rows(), [{ address: C, streak: 0, since_ts: T0 + 101, stalled_ts: detected, stalled_tx: 6, recovered_ts: T0 + 201 }]);
  assert.deepEqual(log()[1], [T0 + 201, "recovered", { contract: C, since: T0 + 101, transactions: 6 }]);
  assert.deepEqual(stalledContracts(await store.stalled(0, detected + 200)).map((r) => [r.status, r.transactions, r.recovered]), [["recovered", 6, T0 + 201]]);
  assert.equal((await store.stalled(T0 + 202, T0 + 9999)).length, 0);   // a view that starts after the recovery
  assert.equal(viewRange("24h", 100000, { epochs: [] }).from, 100000 - 86400);
  assert.deepEqual(viewRange("epoch:168", 5000, { epochs: [{ epoch: 168, start_ts: 1000 }, { epoch: 169, start_ts: 2000 }] }), { from: 1000, to: 2000 });
  assert.deepEqual(viewRange("epoch:169", 5000, { epochs: [{ epoch: 169, start_ts: 2000 }] }), { from: 2000, to: 5001 });
});

test("the first leader of each campaign transaction is counted against the eligible set in effect at its block", async () => {
  const { store, db } = setup();
  const leaderOf = (id) => EVENTS.find((ev) => ev.name === "TransactionActivated" && ev.args.txId === id);
  const LA = leaderOf(A).args.leader, LB = leaderOf(B).args.leader, X = "0x" + "ee".repeat(20);
  const gen = (n) => String(BigInt(n) * 10n ** 18n);
  // three validators active and not banned, with their stake already read, and the set they form in effect before the range
  const stake = new Map([[LA, 400], [LB, 100], [X, 900]]);
  for (const [address, self] of stake) db.prepare("INSERT OR REPLACE INTO validators (address, self_stake, delegated_stake, active, info_ts) VALUES (?, ?, '0', 1, 1)").run(address, gen(self));
  const old = [...new Set([LA, LB, X])].sort().map((a) => [a, a === X ? 6 : 1]);     // weights of the stored set: not the current ones
  db.prepare("INSERT INTO eligible_set (block, ts, epoch, members) VALUES (?, 1, 167, ?)").run(FIRST - 1, JSON.stringify(old));
  // an epoch starts between the two activations: a new set, with the weights of the stakes, from that block
  const blocks = [leaderOf(A).block, leaderOf(B).block].sort((a, b) => a - b);
  assert.ok(blocks[1] > blocks[0]);
  const at = blocks[1];
  const options = { advances: [advance(168, at)], validators: { ...NO_VALIDATORS, active: [...stake.keys()] } };
  SENDER.set(STARTS.find((ev) => ev.args.txId === B).evmHash, WALLET);   // both transactions are campaign
  try { await runAll(store, options); } finally { SENDER.set(STARTS.find((ev) => ev.args.txId === B).evmHash, STRANGER); }

  const sets = db.prepare("SELECT block, epoch, members FROM eligible_set ORDER BY block").all().map((r) => ({ ...r, members: JSON.parse(r.members) }));
  const fresh = [...stake].sort(([a], [b]) => (a < b ? -1 : 1)).map(([a, self]) => [a, Math.round(Math.sqrt(0.6 * self) * 1e4) / 1e4]);
  assert.deepEqual(sets.map((s) => [s.block, s.epoch]), [[FIRST - 1, 167], [at, 168]]);
  assert.deepEqual(sets[1].members, fresh);

  const want = new Map([...stake.keys()].map((a) => [a, { first: 0, expected: 0 }]));
  for (const ev of [leaderOf(A), leaderOf(B)]) {
    const members = ev.block >= at ? fresh : old, total = members.reduce((n, [, w]) => n + w, 0);
    for (const [a, w] of members) want.get(a).expected += w / total;
    want.get(ev.args.leader).first++;
  }
  const got = await store.leaderDraws({ sql: "h.epoch >= ?1", params: [0] });
  assert.equal(got.length, want.size);
  for (const r of got) {
    assert.equal(r.first, want.get(r.validator).first);
    assert.ok(Math.abs(r.expected - want.get(r.validator).expected) < 1e-9);
  }
  assert.ok(Math.abs(got.reduce((n, r) => n + r.expected, 0) - 2) < 1e-9);      // two transactions, two expected leaders in all
});

test("the eligible set is written again only when its validators change, an epoch starts or a missing weight arrives", () => {
  const stored = [{ address: "0xa", active: 1, banned: 0, quarantined: 0, self_stake: "100000000000000000000", delegated_stake: "100000000000000000000" },
    { address: "0xb", active: 1, banned: 1, self_stake: "1", delegated_stake: "0" }, { address: "0xc", active: 1, banned: 0, self_stake: null, delegated_stake: null },
    { address: "0xd", active: 1, banned: 0, quarantined: 1, self_stake: "1", delegated_stake: "0" }];
  const none = { sets: [], info: [] };
  const members = eligibleMembers(stored, none);
  assert.deepEqual(members, [["0xa", 10], ["0xc", null]]);             // neither the banned one nor the one in quarantine
  const last = { block: 50, ts: 5, epoch: 167, members };
  const at = { block: 90, ts: 9, epoch: 167 };
  assert.equal(nextEligibleSet(last, members, at), null);
  assert.deepEqual(nextEligibleSet(null, members, at), { ...at, members });
  // a ban ends: the validator joins the set, from the block the lists were read at
  const unbanned = eligibleMembers(stored, { sets: [["0xb", 1, 0, 0, null]], info: [] });
  assert.deepEqual(nextEligibleSet(last, unbanned, at).members.map(([a]) => a), ["0xa", "0xb", "0xc"]);
  // an epoch starts: a new row at its block, also with the same validators
  assert.deepEqual(nextEligibleSet(last, members, { ...at, advance: { block: 70, ts: 7, epoch: 168 } }), { block: 70, ts: 7, epoch: 168, members });
  // the stake of 0xc is read: the last row gets the missing weight, at its own block
  const read = eligibleMembers(stored, { sets: [], info: [["0xc", null, "400000000000000000000", "0", 1, 167]] });
  assert.deepEqual(nextEligibleSet(last, read, at), { block: 50, ts: 5, epoch: 167, members: [["0xa", 10], ["0xc", Math.round(Math.sqrt(240) * 1e4) / 1e4]] });
});

test("campaigns of a view: one per group of transactions, numbered within the day, and days with none", () => {
  const at = (iso) => Date.parse(iso) / 1000;
  const txs = (iso, n) => Array.from({ length: n }, (_, i) => ({ first_ts: at(iso) + i * 20, last_ts: at(iso) + i * 20 + 100 }));
  const times = [...txs("2026-10-01T07:01:00Z", 4), ...txs("2026-10-01T15:00:00Z", 2), ...txs("2026-10-02T09:10:00Z", 3)];
  const list = campaigns(times, at("2026-10-02T09:15:00Z"));
  assert.deepEqual(list.map((c) => [c.id, c.transactions, c.status]),
    [["2026-10-01", 4, "completed"], ["2026-10-01-2", 2, "completed"], ["2026-10-02", 3, "running"]]);
  assert.deepEqual([list[0].started, list[0].last_event], [at("2026-10-01T07:01:00Z"), at("2026-10-01T07:02:00Z") + 100]);
  // 2026-10-03 (day 276, bucket 12:00 to 15:00): no campaign started in it
  const since = at("2026-10-01T00:00:00Z");
  assert.deepEqual(failedCampaigns(list, since, at("2026-10-04T00:00:00Z"), at("2026-10-03T15:31:00Z"), since),
    [{ id: "2026-10-03", status: "failed", transactions: 0, expected_from: at("2026-10-03T12:00:00Z"), expected_until: at("2026-10-03T15:00:00Z") }]);
  assert.deepEqual(failedCampaigns(list, since, at("2026-10-04T00:00:00Z"), at("2026-10-03T15:29:00Z"), since), []);   // still within the grace time
  assert.deepEqual(failedCampaigns(list, since, at("2026-10-04T00:00:00Z"), null, since), []);
});

test("RPC incidents: two bad runs in a row open one, five clean runs close it", () => {
  const m = (...minutes) => minutes.map((x) => x * 60);
  assert.deepEqual(rpcIncidents(m(1), 9999), []);                                   // a single bad run
  assert.deepEqual(rpcIncidents(m(1, 3, 5), 9999), []);                             // never two in a row
  assert.deepEqual(rpcIncidents(m(1, 2, 3, 8, 14, 20, 21), 99999),                  // 3 to 8: four clean runs; 8 to 14: five
    [{ from: 60, to: 480, runs: 4, open: false }, { from: 1200, to: 1260, runs: 2, open: false }]);
  assert.equal(rpcIncidents(m(1, 2), 120 + 299)[0].open, true);
  assert.equal(rpcIncidents(m(1, 2), 120 + 300)[0].open, false);
});

test("the event log merges its sources newest first, filters by type and pages", () => {
  const since = 1000, range = { from: 1000, to: 100000 };
  const logRows = [
    { id: 2, ts: 5000, type: "banned", data: JSON.stringify({ validator: "0xv", until: 170 }) },
    { id: 1, ts: 4000, type: "stalled", data: JSON.stringify({ contract: "0xc", since: 300 }) }];
  const base = { view: "epoch:168", range, since, sinceDate: "2026-10-01", logRows,
    epochs: [{ epoch: 168, start_ts: 6000 }, { epoch: 167, start_ts: 500 }],
    campaignList: [{ id: "2026-10-01", started: 3000, last_event: 3500, transactions: 320, status: "completed" }],
    failed: [{ id: "2026-10-02", status: "failed", transactions: 0, expected_from: 7000, expected_until: 8000 }],
    incidents: [{ from: 2000, to: 2300, runs: 4, open: false }],
    names: new Map([["0xv", "Alpha"]]), reference: new Map([["0xc", { name: "company" }]]) };
  const all = events(base);
  assert.deepEqual(all.events.map((e) => [e.id, e.type, e.group]), [["f7000", "campaign", "campaigns"], ["e168", "epoch", "epochs"],
    ["l2", "banned", "validators"], ["l1", "stalled", "contracts"], ["c3000", "campaign", "campaigns"], ["r2000", "rpc", "rpc"], ["m", "method", "campaigns"]]);
  assert.equal(all.next, null);
  assert.deepEqual(all.events[1].data, { epoch: 168, previous_seconds: 5500 });      // epoch 167 started before the range: not listed
  assert.deepEqual([all.events[2].data.moniker, all.events[3].data.reference], ["Alpha", "company"]);
  assert.deepEqual(events({ ...base, type: "campaigns" }).events.map((e) => e.id), ["f7000", "c3000", "m"]);
  assert.deepEqual(events({ ...base, before: "l1" }).events.map((e) => e.id), ["c3000", "r2000", "m"]);
  assert.deepEqual(events({ ...base, before: "nothing" }).events, []);
  // more than a page
  const many = Array.from({ length: EVENTS_PAGE + 5 }, (_, i) => ({ id: i + 1, ts: 2000 + i, type: "eligible", data: "{}" }));
  const first = events({ view: "24h", range, since: 0, logRows: many });
  assert.deepEqual([first.events.length, first.events[0].id, first.next], [EVENTS_PAGE, `l${EVENTS_PAGE + 5}`, "l6"]);
  const second = events({ view: "24h", range, since: 0, logRows: many, before: first.next });
  assert.deepEqual([second.events.length, second.events.at(-1).id, second.next], [5, "l1", null]);
});

test("a non-JSON answer of the RPC is recorded and the cursor does not move", async () => {
  const { store, get } = setup();
  const html = async () => ({ text: async () => "<html>502</html>" });
  const run = await collect({ rpc: rpcClient("http://rpc", html), store, now: 3000, startBlock: FIRST });
  assert.match(run.error, /non-JSON/);
  assert.equal(run.nonJson, 1);
  assert.equal((await store.state(3)).cursor, null);
  assert.equal(get("SELECT non_json FROM runs WHERE ts = 3000").non_json, 1);
});
