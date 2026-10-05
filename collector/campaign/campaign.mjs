// Daily measurement campaign on GenLayer Bradbury.
//
// Sends TX_PER_CONTRACT calls to every reference contract of contracts.json (one call in flight per
// copy: the transaction queue is per contract) and follows each one until ACCEPTED or a
// no-consensus end, polling getTransaction every POLL_MS (the method of the September 2026
// validation windows). After the run it also reads the consensus events of its own transactions,
// so the same run can be counted by polling and by events.
//
//   CAMPAIGN_PRIVATE_KEY=0x... node collector/campaign/campaign.mjs
//
// Environment: CAMPAIGN_PRIVATE_KEY (required; testnet-only wallet), TX_PER_CONTRACT (default 80),
// POLL_MS (default 1000), RUN_ID (default: UTC timestamp), OUT_DIR (default out/<RUN_ID>).
// Output: one JSON row per call in campaign-<contract>.jsonl, network snapshots, eligible-set
// samples, the consensus events of the run's transactions, and summary.json.
// Logs show only public data (addresses, transaction hashes, votes); never the key.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { createPublicClient, decodeEventLog, http } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, "contracts.json"), "utf8"));
const RPC = testnetBradbury.rpcUrls.default.http[0];

const KEY = process.env.CAMPAIGN_PRIVATE_KEY;
if (!KEY) throw new Error("CAMPAIGN_PRIVATE_KEY is not set");
const TX_PER_CONTRACT = Number(process.env.TX_PER_CONTRACT ?? 80);
if (!Number.isInteger(TX_PER_CONTRACT) || TX_PER_CONTRACT < 1 || TX_PER_CONTRACT > 200) {
  throw new Error(`TX_PER_CONTRACT must be a whole number from 1 to 200, not ${process.env.TX_PER_CONTRACT}`);
}
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const RUN_ID = process.env.RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const OUT = process.env.OUT_DIR ?? join("out", RUN_ID);
mkdirSync(OUT, { recursive: true });

const STALL_MS = 10 * 60 * 1000;     // no progress at a final-looking timeout status
const GIVE_UP_MS = 45 * 60 * 1000;   // no ACCEPTED at all
const GAS_FLOOR = 5_000_000n;        // the bare estimate reverts LLM writes at the EVM layer
const ELIG_POLL_MS = 30_000;
const EXECUTION_SET = new Set(["FINISHED_WITH_RETURN", "FINISHED_WITH_ERROR"]);

// ---------------------------------------------------------------- clients
const base = createAccount(`0x${KEY.replace(/^0x/, "")}`);
const account = {
  ...base,
  signTransaction: (tx, opts) => base.signTransaction({ ...tx, gas: tx.gas && tx.gas > GAS_FLOOR ? tx.gas : GAS_FLOOR }, opts),
};
const signer = createClient({ chain: testnetBradbury, account });
const reader = createClient({ chain: testnetBradbury });
const evm = createPublicClient({ transport: http(RPC) });

let queue = Promise.resolve();
function enqueue(fn) {  // one send at a time: a send returns after its EVM receipt, so nonces never clash
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const json = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (...a) => console.log(now().slice(11, 19), ...a);

async function withRetry(what, fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      log(`${what}: ${String(e).split("\n")[0].slice(0, 160)} (retry ${i})`);
      await sleep(5000 * i);
    }
  }
}

const write = (address, functionName, args) =>
  enqueue(() => withRetry(`send ${functionName}`, () => signer.writeContract({ address, functionName, args, value: 0n })));
const read = (address, functionName, args = []) =>
  withRetry(`read ${functionName}`, () => reader.readContract({ address, functionName, args }));

// ---------------------------------------------------------------- epoch and eligible set
const net = { epoch: null, seq: 0, key: null };

async function sampleNetwork() {
  const [info, active, quarantined, banned] = await Promise.all([
    reader.getEpochInfo(), reader.getActiveValidators(), reader.getQuarantinedValidators(), reader.getBannedValidators(),
  ]);
  const q = new Set(quarantined.map((x) => x.toLowerCase()));
  const b = new Set(banned.map((x) => x.validator.toLowerCase()));
  const eligible = active.filter((a) => !q.has(a.toLowerCase()) && !b.has(a.toLowerCase())).sort();
  const epoch = String(info.currentEpoch);
  const key = `${epoch}|${eligible.join(",")}`;
  if (key === net.key) return;
  const row = { seq: net.seq + 1, at: now(), epoch, epochChanged: net.epoch !== null && net.epoch !== epoch,
                nextEpochEstimate: info.nextEpochEstimate?.toISOString() ?? null, activeCount: active.length,
                eligibleCount: eligible.length, eligible, quarantined, banned: banned.map((x) => x.validator) };
  appendFileSync(join(OUT, "eligibility.jsonl"), json(row) + "\n");
  if (row.epochChanged) log(`epoch ${net.epoch} -> ${epoch}`);
  Object.assign(net, { epoch, seq: row.seq, key });
}

async function networkSnapshot(label) {
  const gen = (raw) => Number(BigInt(raw ?? 0)) / 1e18;
  const [active, quarantined, epoch] = await Promise.all([
    withRetry("getActiveValidators", () => reader.getActiveValidators()),
    withRetry("getQuarantinedValidators", () => reader.getQuarantinedValidators()),
    withRetry("getEpochInfo", () => reader.getEpochInfo()),
  ]);
  const q = new Set(quarantined.map((x) => x.toLowerCase()));
  const validators = [];
  for (const addr of active) {
    try {
      const i = await reader.getValidatorInfo(addr);
      const self = gen(i.vStakeRaw), deleg = gen(i.dStakeRaw);
      validators.push({ address: addr, moniker: i.identity?.moniker ?? null, selfStake: self, delegatedStake: deleg,
                        weight: Math.sqrt(0.6 * self + 0.4 * deleg), live: i.live, banned: i.banned,
                        quarantined: q.has(addr.toLowerCase()) });
    } catch (e) {
      validators.push({ address: addr, error: String(e).split("\n")[0].slice(0, 120) });
    }
  }
  const row = { at: now(), label, epoch: epoch.currentEpoch, activeCount: active.length,
                eligibleCount: validators.filter((v) => !v.banned && !v.quarantined && !v.error).length, validators };
  appendFileSync(join(OUT, "snapshots.jsonl"), json(row) + "\n");
  log(`network snapshot ${label}: epoch ${row.epoch}, ${row.activeCount} active, ${row.eligibleCount} eligible`);
}

// ---------------------------------------------------------------- following one tx (polling)
function view(tx) {
  const r = tx.lastRound ?? {};
  const names = r.validatorVotesName ?? [];
  return {
    status: tx.statusName ?? `STATUS_${tx.status}`, result: tx.resultName, round: Number(r.round ?? 0),
    rotationsLeft: r.rotationsLeft != null ? Number(r.rotationsLeft) : null, leader: tx.lastLeader,
    leaderIndex: r.leaderIndex != null ? Number(r.leaderIndex) : null,
    votes: (r.roundValidators ?? []).map((v, i) => ({ validator: v, vote: names[i], resultHash: r.validatorResultHash?.[i] })),
  };
}

async function track(hash) {
  const t0 = Date.now();
  const timeline = [];
  let lastKey = null, lastChange = Date.now(), tx = null, v = null, outcome = null;
  while (!outcome) {
    try {
      tx = await reader.getTransaction({ hash });
    } catch {
      tx = null;  // not indexed yet, or a transient RPC error
    }
    if (tx) {
      v = view(tx);
      const created = Number(tx.createdTimestamp);
      const key = [v.status, v.round, v.votes.map((x) => x.vote).join(",")].join("|");
      if (key !== lastKey) {
        lastKey = key;
        lastChange = Date.now();
        // [status, round, seconds, votes, resultHashes, leaderIndex, committee, leader, rotationsLeft, epoch, eligibleSeq]
        timeline.push([v.status, v.round, Math.round(Date.now() / 1000 - created), v.votes.map((x) => x.vote),
                       v.votes.map((x) => x.resultHash), v.leaderIndex, v.votes.map((x) => x.validator),
                       v.leader, v.rotationsLeft, net.epoch, net.seq]);
      }
      const stalled = Date.now() - lastChange > STALL_MS;
      if (v.status === "ACCEPTED" || (["FINALIZED", "READY_TO_FINALIZE"].includes(v.status) && v.result === "AGREE")) {
        outcome = "accepted";
      } else if (v.status === "UNDETERMINED" || v.status === "CANCELED") {
        outcome = "no_consensus";
      } else if (stalled && (v.status === "VALIDATORS_TIMEOUT" || (v.status === "LEADER_TIMEOUT" && v.rotationsLeft === 0))) {
        outcome = "no_consensus";
      }
    }
    if (!outcome && Date.now() - t0 > GIVE_UP_MS) outcome = "no_consensus_watch_limit";
    if (!outcome) await sleep(POLL_MS);
  }
  // at the first ACCEPTED read the execution result can still be empty: read again until it is set
  let executionAtAccept = null;
  if (tx && !EXECUTION_SET.has(tx.txExecutionResultName)) {
    executionAtAccept = tx.txExecutionResultName ?? null;
    for (let i = 0; i < 12 && !EXECUTION_SET.has(tx.txExecutionResultName); i++) {
      await sleep(5000);
      try { tx = await reader.getTransaction({ hash }); } catch { /* keep the last read */ }
    }
  }
  const created = tx ? Number(tx.createdTimestamp) : null;
  const acceptedAt = timeline.find((e) => e[0] === "ACCEPTED");
  return {
    hash, outcome, finalStatus: v?.status, result: v?.result, round: v?.round, rotationsLeft: v?.rotationsLeft,
    decisiveVotes: v?.votes ?? [], timeline,
    latency: { acceptedFirstSeenS: acceptedAt ? acceptedAt[2] : null,
               lastVoteS: tx && Number(tx.lastVoteTimestamp) ? Number(tx.lastVoteTimestamp) - created : null },
    execution: tx?.txExecutionResultName, executionAtAccept, txExecutionHash: tx?.txExecutionHash ?? null,
  };
}

// ---------------------------------------------------------------- one measured call
async function measure(name, address) {
  const c = CONFIG.contracts[name];
  const hash = await write(address, c.method, c.args);
  const m = await track(hash);
  if (name === "wizard" && m.outcome === "accepted") {
    m.state = { have_coin: await read(address, "get_have_coin") };
    if (m.state.have_coin === false) m.copyRetired = true;  // later calls to this copy would skip the LLM
  }
  // an accepted tx whose execution ended in error is reported apart (rule 5.3 of the validation)
  if (m.outcome === "accepted" && m.execution === "FINISHED_WITH_ERROR") m.invalidMeasurement = true;
  return m;
}

const hashes = new Set();

async function runContract(name) {
  const copies = CONFIG.contracts[name].copies.map((address) => ({ address, retired: false }));
  const out = join(OUT, `campaign-${name}.jsonl`);
  let written = 0, claimed = 0;
  await Promise.all(copies.map(async (copy) => {
    while (!copy.retired && claimed < TX_PER_CONTRACT) {
      claimed++;
      const sentAt = now();
      const atSend = { epoch: net.epoch, eligibleSeq: net.seq };
      let m;
      try {
        m = await measure(name, copy.address);
      } catch (e) {
        log(`${name} on ${copy.address.slice(0, 10)} failed before measuring: ${String(e).split("\n")[0].slice(0, 200)}`);
        claimed--;
        await sleep(30000);
        continue;
      }
      hashes.add(m.hash.toLowerCase());
      const row = { contract: name, run: RUN_ID, pollMs: POLL_MS, index: written++, copy: copy.address, sentAt, atSend, ...m };
      appendFileSync(out, json(row) + "\n");
      const counts = {};
      for (const x of m.decisiveVotes) counts[x.vote] = (counts[x.vote] ?? 0) + 1;
      log(`${name} #${row.index} ${m.outcome} round ${m.round} ${json(counts)} ${m.latency.acceptedFirstSeenS ?? "-"}s`);
      if (m.copyRetired) {
        copy.retired = true;
        log(`${name}: copy ${copy.address} gave the coin away; not used for the rest of the run`);
      }
    }
  }));
  return written;
}

// ---------------------------------------------------------------- consensus events of the run
async function fetchEvents(fromBlock, toBlock) {
  const C = testnetBradbury.consensusMainContract;
  const rows = [];
  async function range(a, b) {  // large spans fail with an internal RPC error when the network is busy
    try {
      const logs = await evm.getLogs({ address: C.address, fromBlock: a, toBlock: b });
      for (const l of logs) {
        let d;
        try { d = decodeEventLog({ abi: C.abi, data: l.data, topics: l.topics }); } catch { continue; }
        const txId = String(d.args?.txId ?? d.args?.tx_id ?? "").toLowerCase();
        if (!hashes.has(txId)) continue;
        rows.push({ txId, name: d.eventName, block: Number(l.blockNumber), logIndex: l.logIndex, args: d.args });
      }
    } catch (e) {
      if (b - a < 50n) throw e;
      const m = (a + b) / 2n;
      await range(a, m);
      await range(m + 1n, b);
    }
  }
  for (let a = fromBlock; a <= toBlock; a += 2000n) await range(a, a + 1999n > toBlock ? toBlock : a + 1999n);
  writeFileSync(join(OUT, "events.jsonl"), rows.map((r) => json(r)).join("\n") + (rows.length ? "\n" : ""));
  return rows.length;
}

// ---------------------------------------------------------------- main
const started = now();
const startBlock = await withRetry("blockNumber", () => evm.getBlockNumber());
log(`run ${RUN_ID}: ${TX_PER_CONTRACT} tx per contract, poll ${POLL_MS} ms, sender ${account.address}`);
const balanceBefore = await evm.getBalance({ address: account.address });
await networkSnapshot("run-start");
await sampleNetwork();
const sampler = setInterval(() => sampleNetwork().catch((e) => log(`network sample: ${String(e).split("\n")[0].slice(0, 160)}`)), ELIG_POLL_MS);
const done = {};
await Promise.all(Object.keys(CONFIG.contracts).map(async (name) => { done[name] = await runContract(name); }));
clearInterval(sampler);
await sampleNetwork().catch(() => {});
await networkSnapshot("run-end");
const endBlock = await withRetry("blockNumber", () => evm.getBlockNumber());
const events = await fetchEvents(startBlock - 10n, endBlock);
const balanceAfter = await evm.getBalance({ address: account.address });
const summary = { run: RUN_ID, startedAt: started, endedAt: now(), sender: account.address, txPerContract: TX_PER_CONTRACT,
                  pollMs: POLL_MS, rows: done, events, blocks: [startBlock, endBlock],
                  spentGen: Number(balanceBefore - balanceAfter) / 1e18, balanceGen: Number(balanceAfter) / 1e18 };
writeFileSync(join(OUT, "summary.json"), json(summary) + "\n");
log(`done: ${json(done)}, ${events} consensus events, spent ${summary.spentGen} GEN, balance ${summary.balanceGen} GEN`);
