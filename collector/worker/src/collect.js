// Passive observation: one run reads the consensus events emitted since the last stored block,
// applies them to the state of their transactions, updates the hourly counters and saves everything
// with the new cursor in one transaction. It only reads the chain; it never signs.

import { CONSENSUS_ADDRESS, apply, decodeLog, newTx, status, txIdsOf } from "../../core/events.js";
import { EPOCH_ADVANCE_TOPIC, EPOCH_SELECTOR, SELECTOR, STAKING_ADDRESS, callData, decodeAddresses, decodeBanned, decodeEpochAdvance,
  decodeMoniker, decodeValidatorView, inEffect, toGen, weightOf } from "../../core/staking.js";

export const MAX_SPAN = 250;        // blocks per run; the chain makes 8 to 40 a minute, so a backlog catches up
export const MIN_SPAN = 10;
export const FIRST_SPAN = 300;      // on an empty store with no start block, start this far behind the tip
export const BACK_SPAN = 2000;      // blocks per step when looking backwards for the start of an epoch
export const BACK_LIMIT = 160000;   // give up looking this many blocks before the start
export const CODE_BATCH = 3;        // contracts whose code is read per run, for the LLM label
export const CODE_TIMEOUT_MS = 10000;
export const SENDER_BATCH = 10;     // senders read per run: the RPC limits eth_getTransactionByHash
export const SETS_SECONDS = 300;    // the validator sets (active, quarantined, banned) are read this often
export const VALIDATOR_BATCH = 4;   // validators whose stake and name are read per run
export const STALL_STREAK = 5;      // transactions created in a row with no vote on any transaction of the contract
export const STALL_SECONDS = 3600;  // and the last of them created this long ago: the contract is stalled
const LLM_CALLS = /exec_prompt|prompt_comparative|prompt_non_comparative/;

const hex = (n) => "0x" + n.toString(16);
const order = (a, b) => a.block - b.block || a.logIndex - b.logIndex;

// JSON-RPC over fetch. Counts HTTP requests, time and answers that are not JSON (the RPC sometimes
// returns HTML pages). batch() sends several calls in one request and returns, in the same order,
// { result } or { error } for each.
export function rpcClient(url, fetchFn = fetch) {
  const stats = { calls: 0, ms: 0, nonJson: 0 };
  async function post(body, label, timeoutMs) {
    stats.calls++;
    const t0 = Date.now();
    let text;
    try {
      const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
      text = await res.text();
    } finally {
      stats.ms += Date.now() - t0;
    }
    try { return JSON.parse(text); } catch { stats.nonJson++; throw new Error(`${label}: non-JSON response`); }
  }
  // timeoutMs: give up after this long (the call then throws)
  async function call(method, params = [], timeoutMs) {
    const body = await post({ jsonrpc: "2.0", id: 1, method, params }, method, timeoutMs);
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  }
  async function batch(calls) {
    if (!calls.length) return [];
    const body = await post(calls.map(([method, params], i) => ({ jsonrpc: "2.0", id: i + 1, method, params })), "batch");
    if (!Array.isArray(body)) throw new Error(`batch: ${body?.error?.message ?? "unexpected response"}`);
    const byId = new Map(body.map((r) => [r.id, r]));
    return calls.map((_, i) => byId.get(i + 1) ?? { error: { message: "missing from the batch response" } });
  }
  return { call, batch, stats };
}

// What a transaction adds to the hourly counters of its contract: null while it cannot be counted
// (its start was not observed), otherwise its class and whether it ended cancelled or without votes.
export function classOf(tx) {
  if (tx.recipient == null || tx.epoch == null) return null;
  const s = status(tx);
  const cls = s === "first" || s === "retry" || s === "none" ? s : "pending";
  const voted = tx.attempts.some((a) => a.votes.length > 0);
  return { cls, cancelled: cls === "none" && (tx.cancelled || !voted) };
}

const VOTE_COLUMN = [null, "agree", "disagree", "timeout", "dv"];   // by voteType; 0 is NOT_VOTED

// Progress of the contracts (table contract_stall). rows: what is stored for the contracts of this
// run and for the ones waiting to be counted as stalled. A transaction that stays idle for ever
// never ends, so the rule counts creations and votes, not final states.
export function stallTracker(rows) {
  const blank = (address) => ({ address, streak: 0, streak_ts: null, fifth_ts: null, since_ts: null, stalled_ts: null, stalled_tx: null, recovered_ts: null });
  const key = (s) => [s.streak, s.streak_ts, s.fifth_ts, s.since_ts, s.stalled_ts, s.stalled_tx, s.recovered_ts].join("|");
  const stalls = new Map(rows.map((r) => [r.address, { ...r }]));
  const stored = new Map(rows.map((r) => [r.address, key(r)]));
  const log = [];
  const open = (s) => s.stalled_ts != null && s.recovered_ts == null;
  return {
    log,
    created(address, ts) {
      if (!stalls.has(address)) stalls.set(address, blank(address));
      const s = stalls.get(address);
      if (++s.streak === 1) s.streak_ts = ts;
      if (s.streak === STALL_STREAK) s.fifth_ts = ts;
    },
    voted(address, ts, txId) {
      const s = stalls.get(address);
      if (!s || s.streak === 0) return;
      if (open(s)) {
        Object.assign(s, { recovered_ts: ts, stalled_tx: s.streak });
        log.push(["recovered", { contract: address, since: s.since_ts, transactions: s.streak, tx: txId }, ts]);
      }
      Object.assign(s, { streak: 0, streak_ts: null, fifth_ts: null });
    },
    // asOf: the time up to which the chain has been read
    detect(asOf) {
      if (asOf == null) return;
      for (const s of stalls.values()) {
        if (open(s) || s.fifth_ts == null || asOf - s.fifth_ts < STALL_SECONDS) continue;
        Object.assign(s, { stalled_ts: asOf, since_ts: s.streak_ts, stalled_tx: null, recovered_ts: null });
        log.push(["stalled", { contract: s.address, since: s.since_ts }, asOf]);
      }
    },
    // the rows that changed
    changed: () => [...stalls.values()].filter((s) => key(s) !== (stored.get(s.address) ?? key(blank(s.address)))),
  };
}

// A validator can be drawn when it is active, not banned and with no quarantine in effect.
// `quarantined` is set only while a quarantine record applies: expired records are ignored.
export const isEligible = (v) => !!v && v.active === 1 && v.quarantined !== 1 && v.banned !== 1;

// The eligible set after the reads of a run: [[address, weight], ...] sorted by address. weight is
// the selection weight, null while the stake of the validator has not been read.
// stored: rows of the validators table; changes: what validatorChanges returned.
export function eligibleMembers(stored, changes) {
  const known = new Map(stored.map((v) => [v.address, { ...v }]));
  for (const [address, active, quarantined, banned] of changes.sets) known.set(address, { ...(known.get(address) ?? { address }), active, quarantined, banned });
  for (const [address, , self, delegated] of changes.info) {
    const v = known.get(address);
    if (v) Object.assign(v, { self_stake: self ?? v.self_stake, delegated_stake: delegated ?? v.delegated_stake });
  }
  const weight = (v) => (v.self_stake == null ? null : Math.round(weightOf(toGen(v.self_stake), toGen(v.delegated_stake ?? "0")) * 1e4) / 1e4);
  return [...known.values()].filter(isEligible).map((v) => [v.address, weight(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// The row of eligible_set to write, or null. A new one when an epoch starts (at its block) or when
// the validators in the set change (at the block the lists were read at); the last one is rewritten
// when it only lacked weights that are known now.
export function nextEligibleSet(last, members, { advance = null, block, ts, epoch }) {
  if (advance) return { block: advance.block, ts: advance.ts, epoch: advance.epoch, members };
  const same = !!last && last.members.length === members.length && last.members.every(([a], i) => a === members[i][0]);
  if (!same) return { block, ts, epoch, members };
  if (last.members.some(([, w], i) => w == null && members[i][1] != null)) return { ...last, members: last.members.map(([a, w], i) => [a, w ?? members[i][1]]) };
  return null;
}

// rpc: rpcClient(); store: store.js; now: seconds.
// reference: Map of reference contract address -> { name, llm }; campaignWallet: its sender.
// startBlock: where an empty store starts reading (default: FIRST_SPAN blocks behind the tip).
export async function collect({ rpc, store, now, reference = new Map(), campaignWallet = null, startBlock = null, senderBatch = SENDER_BATCH }) {
  const run = { ts: now, from: null, to: null, tip: null, logs: 0, txs: 0, rowsWritten: null, error: null };
  try {
    const st = await store.state(CODE_BATCH);
    run.tip = parseInt(await rpc.call("eth_blockNumber"), 16);
    const from = st.cursor == null ? (startBlock ?? Math.max(0, run.tip - FIRST_SPAN)) : st.cursor + 1;
    if (from <= run.tip) {
      // the first run decides where to look, backwards, for the start of the epoch it begins in
      const back = st.epochBack ?? from - 1;
      const backFloor = st.epochBackFloor ?? Math.max(0, from - 1 - BACK_LIMIT);
      // A run that is killed (CPU limit) leaves no row in `runs`: every minute without one halves the range.
      const missed = st.lastRunTs == null ? 0 : Math.max(0, Math.floor((now - st.lastRunTs) / 60) - 1);
      const span = Math.max(MIN_SPAN, MAX_SPAN >> Math.min(missed, 5));
      const read = await readRange(rpc, from, Math.min(run.tip, from + span - 1), st.epoch == null, back);
      let events = read.logs.map((l) => decodeLog(l)).filter(Boolean).sort(order);
      let advances = read.advances.map(decodeEpochAdvance).sort(order);

      // aux batch: sender of each new transaction to a reference contract, and code of pending contracts
      const isStart = (ev) => ev.name === "NewTransaction" && reference.has(ev.args.recipient) && ev.evmHash;
      let starts = events.filter(isStart);
      if (starts.length > senderBatch) {   // too many senders to read at once: stop before the next one
        read.to = Math.max(from, starts[senderBatch].block - 1);
        events = events.filter((ev) => ev.block <= read.to);
        advances = advances.filter((a) => a.block <= read.to);
        starts = events.filter(isStart);
      }
      // also in the aux batch: the validator sets when they are due, and stake and name of the
      // validators whose data is oldest
      // The lists are read at the last block of the range, not at the tip, so they are also right
      // while the collector catches up; then, and when an epoch starts, they are read in every run.
      const wantSets = st.setsTs == null || now - st.setsTs >= SETS_SECONDS || advances.length > 0 || !st.synced;
      const refresh = [...st.validators].sort((a, b) => (a.info_ts ?? 0) - (b.info_ts ?? 0)).slice(0, VALIDATOR_BATCH).map((v) => v.address);
      const ethCall = (to, data, block = "latest") => ["eth_call", [{ to, data }, block]];
      const aux = await rpc.batch([
        ...starts.map((ev) => ["eth_getTransactionByHash", [ev.evmHash]]),
        ...(wantSets ? [ethCall(STAKING_ADDRESS, SELECTOR.activeValidators, hex(read.to)), ethCall(STAKING_ADDRESS, callData.quarantinedValidators(), hex(read.to)),
          ethCall(STAKING_ADDRESS, callData.bannedValidators(), hex(read.to))] : []),
        ...refresh.flatMap((address) => [ethCall(STAKING_ADDRESS, callData.validatorView(address)), ethCall(address, SELECTOR.getIdentity)]),
      ]);
      const setsAt = starts.length, infoAt = setsAt + (wantSets ? 3 : 0);
      const epochAtEnd = advances.at(-1)?.epoch ?? st.epoch ?? read.epochAtStart;
      const validators = validatorChanges(st, wantSets ? aux.slice(setsAt, infoAt) : null, refresh, aux.slice(infoAt), epochAtEnd);
      // at the tip the chain has been read up to now; behind it, up to the last event read
      const synced = read.to === run.tip, asOf = synced ? now : events.at(-1)?.ts ?? st.cursorTs;
      // the eligible set, stored when it changes: an epoch change counts only with the lists read after it
      const advance = validators.setsRead ? advances.at(-1) : null;
      const newSet = validators.setsRead || st.setsTs != null
        ? nextEligibleSet(st.eligibleSet, eligibleMembers(st.validators, validators), { advance, block: read.to, ts: asOf ?? now, epoch: epochAtEnd })
        : null;
      const senders = new Map();
      starts.forEach((ev, i) => {
        if (aux[i].error || !aux[i].result) throw new Error(`eth_getTransactionByHash: ${aux[i].error?.message ?? "no transaction"}`);
        senders.set(ev.args.txId, String(aux[i].result.from).toLowerCase());
      });
      // LLM label of the contracts seen for the first time: one request each, with a time limit. For
      // some contracts the RPC takes over 30 s to answer that it cannot retrieve the code; a contract
      // whose code is not read in time is labeled "code not available".
      const labels = await Promise.all(st.pendingContracts.map(async (address) => {
        try {
          return [address, LLM_CALLS.test(atob(await rpc.call("gen_getContractCode", [{ address }], CODE_TIMEOUT_MS))) ? "llm" : "none"];
        } catch {
          return [address, "na"];
        }
      }));

      const ids = [...new Set(events.flatMap(txIdsOf))];
      const created = [...new Set(events.filter((ev) => ev.name === "NewTransaction").map((ev) => ev.args.recipient))];
      const [txs, stallRows] = await Promise.all([store.loadTx(ids), store.loadStalls(created, ids)]);
      const due = st.stallsDue.filter((r) => !stallRows.some((s) => s.address === r.address));
      const stalls = stallTracker([...stallRows, ...due]);
      const before = new Map();       // class of each transaction before this run
      const contractHour = new Map(), opHour = new Map(), newContracts = new Map();
      const op = (epoch, ts, src, validator, column) => {
        if (!validator || epoch == null) return;
        const key = `${epoch}|${Math.floor(ts / 3600)}|${src}|${validator}`;
        const row = opHour.get(key) ?? { votes: 0, agree: 0, disagree: 0, dv: 0, timeout: 0, led: 0, leader_timeouts: 0 };
        row[column]++;
        opHour.set(key, row);
      };
      // the row of a transaction in the counters of its contract: the hour and epoch it was created in
      const contractRow = (tx) => {
        const key = `${tx.epoch}|${tx.hour}|${tx.recipient}|${tx.camp ? 1 : 0}`;
        if (!contractHour.has(key)) contractHour.set(key, { tx: 0, first: 0, retry: 0, none: 0, cancelled: 0, last_ts: 0, agree: 0, disagree: 0, dv: 0, timeout: 0 });
        return contractHour.get(key);
      };
      // First leader of a campaign transaction: one more for that validator, and for every
      // validator of the eligible set in effect at that block its share of the total weight.
      const leaderDraw = new Map();
      const drawRow = (tx, validator) => {
        const key = `${tx.epoch}|${tx.hour}|${validator}`;
        if (!leaderDraw.has(key)) leaderDraw.set(key, { first: 0, expected: 0 });
        return leaderDraw.get(key);
      };
      const firstLeader = (tx, ev) => {
        const set = newSet && ev.block >= newSet.block ? newSet : st.eligibleSet;
        const total = set ? set.members.reduce((n, [, w]) => n + (w ?? 0), 0) : 0;
        if (!(total > 0) || tx.epoch == null) return;
        for (const [address, w] of set.members) if (w) drawRow(tx, address).expected += w / total;
        drawRow(tx, ev.args.leader).first++;
      };

      let epoch = st.epoch ?? read.epochAtStart, next = 0;
      for (const ev of events) {
        while (next < advances.length && order(advances[next], ev) < 0) epoch = advances[next++].epoch;
        for (const id of txIdsOf(ev)) {
          if (!txs.has(id)) txs.set(id, newTx(id));
          const tx = txs.get(id);
          if (!before.has(id)) before.set(id, classOf(tx));
          apply(tx, ev);
          if (ev.name === "NewTransaction" && tx.epoch == null) {
            tx.epoch = epoch;
            tx.hour = Math.floor(ev.ts / 3600);
            const ref = reference.get(tx.recipient);
            tx.sender = senders.get(id) ?? null;
            tx.camp = ref && campaignWallet && tx.sender === campaignWallet ? ref.name : null;
            newContracts.set(tx.recipient, ref ? ref.name : null);
            stalls.created(tx.recipient, ev.ts);
          }
          const src = tx.camp ? (reference.get(tx.recipient).llm ? "camp_llm" : "camp_control") : "net";
          if (ev.name === "VoteRevealed") {
            if (tx.recipient != null) stalls.voted(tx.recipient, ev.ts, id);
            op(epoch, ev.ts, src, ev.args.validator, "votes");
            if (VOTE_COLUMN[ev.args.voteType]) {
              op(epoch, ev.ts, src, ev.args.validator, VOTE_COLUMN[ev.args.voteType]);
              if (tx.recipient != null && tx.epoch != null) contractRow(tx)[VOTE_COLUMN[ev.args.voteType]]++;
            }
          } else if (ev.name === "TransactionActivated") {
            op(epoch, ev.ts, src, ev.args.leader, "led");
            if (tx.camp && tx.attempts.length === 1) firstLeader(tx, ev);
          } else if (ev.name === "TransactionLeaderRotated") {
            op(epoch, ev.ts, src, ev.args.newLeader, "led");
          } else if (ev.name === "TransactionLeaderTimeout") {
            op(epoch, ev.ts, src, tx.attempts.at(-1)?.leader, "leader_timeouts");
          }
        }
      }
      while (next < advances.length) epoch = advances[next++].epoch;

      // contract counters: a transaction moves from its class before the run to its class now
      for (const id of ids) {
        const tx = txs.get(id), was = before.get(id), is = classOf(tx);
        if (!is) continue;
        const row = contractRow(tx);
        if (!was) row.tx++;
        if (was && was.cls !== "pending") row[was.cls]--;
        if (is.cls !== "pending") row[is.cls]++;
        row.cancelled += (is.cancelled ? 1 : 0) - (was?.cancelled ? 1 : 0);
        row.last_ts = Math.max(row.last_ts, tx.lastTs ?? 0);
      }

      // start of the oldest known epoch, looked for backwards one step per run
      const epochStarts = [...advances];
      let epochBack = back;
      if (back >= 0) {
        const found = read.backAdvances.map(decodeEpochAdvance).sort(order).at(-1);
        if (found) { epochStarts.push(found); epochBack = -1; }
        else if (read.backDone) epochBack = back - BACK_SPAN < backFloor ? -1 : back - BACK_SPAN;
      }

      // a validator seen voting or leading that is in no list yet gets its row too
      const listed = new Set([...st.validators.map((v) => v.address), ...validators.sets.map((r) => r[0])]);
      for (const key of opHour.keys()) {
        const address = key.split("|")[3];
        if (!listed.has(address)) { listed.add(address); validators.sets.push([address, 0, 0, 0, null]); }
      }

      stalls.detect(asOf);

      run.rowsWritten = await store.save({
        events, txs: ids.map((id) => ({ tx: txs.get(id), status: status(txs.get(id)) })),
        contractHour, opHour, epochStarts, newContracts, labels, cursor: read.to, epoch, epochBack, epochBackFloor: backFloor, now,
        validatorSets: validators.sets, validatorInfo: validators.info,
        log: [...validators.log.map(([type, data]) => [type, data, synced ? null : asOf]), ...stalls.log], stalls: stalls.changed(),
        eligibleSets: newSet ? [newSet] : [], leaderDraw,
        setsRead: validators.setsRead, synced, startedAt: st.cursor,
      });
      run.from = from; run.to = read.to; run.logs = events.length; run.txs = ids.length;
    }
  } catch (err) {
    run.error = String(err && err.message ? err.message : err).slice(0, 200);
  }
  Object.assign(run, { rpcCalls: rpc.stats.calls, rpcMs: rpc.stats.ms, nonJson: rpc.stats.nonJson });
  await store.logRun(run);
  return run;
}

// What changed in the validators. sets: answers of activeValidators, the quarantine records and the
// banned list (null when they were not asked), read in `epoch`; a quarantine record counts only
// while it is in effect. info: answers of validatorView and getIdentity for `refresh`.
// Returns rows to store: sets [address, active, quarantined, banned, banned_until] only for the
// validators whose flags changed, info [address, moniker, self_stake, delegated_stake, live,
// primed_epoch], and log entries for the Events section (none on the first read).
export function validatorChanges(st, sets, refresh, info, epoch) {
  const out = { sets: [], info: [], log: [], setsRead: false };
  if (sets && sets.every((r) => !r.error)) {
    const active = new Set(decodeAddresses(sets[0].result));
    const quarantined = new Set(decodeBanned(sets[1].result).filter((q) => inEffect(q, epoch)).map((q) => q.validator));
    const banned = new Map(decodeBanned(sets[2].result).map((b) => [b.validator, b]));
    const known = new Map(st.validators.map((v) => [v.address, v]));
    const eligible = isEligible;
    const joined = [], left = [];
    let count = 0;
    for (const address of new Set([...known.keys(), ...active, ...quarantined, ...banned.keys()])) {
      const was = known.get(address), ban = banned.get(address);
      // banned_until: the epoch the ban ends; 0 when the ban is permanent
      const is = { active: +active.has(address), quarantined: +quarantined.has(address), banned: +!!ban, banned_until: ban ? (ban.permanent ? 0 : ban.until) : null };
      if (eligible(is)) count++;
      if (was && was.active === is.active && was.quarantined === is.quarantined && was.banned === is.banned && (was.banned_until ?? null) === is.banned_until) continue;
      out.sets.push([address, is.active, is.quarantined, is.banned, is.banned_until]);
      if (eligible(is) && !eligible(was)) joined.push(address);
      if (!eligible(is) && eligible(was)) left.push(address);
      if (is.quarantined && was?.quarantined !== 1) out.log.push(["quarantined", { validator: address }]);
      if (is.banned && was?.banned !== 1) out.log.push(["banned", { validator: address, until: is.banned_until }]);
    }
    if (joined.length || left.length) out.log.push(["eligible", { joined, left, eligible: count }]);
    if (st.setsTs == null) out.log = [];   // the first read is the starting point, not a change
    out.setsRead = true;
  }
  refresh.forEach((address, i) => {
    const view = info[2 * i], identity = info[2 * i + 1];
    const v = view && !view.error ? decodeValidatorView(view.result) : null;
    const moniker = identity && !identity.error ? decodeMoniker(identity.result) : null;
    out.info.push([address, moniker, v?.selfStake ?? null, v?.delegatedStake ?? null, v ? +v.live : null, v?.primedEpoch ?? null]);
  });
  return out;
}

// One batch: consensus logs and EpochAdvance logs of [from, to]; the epoch in effect just before
// `from` when it is not known yet; and one step backwards looking for the start of that epoch.
// Large or busy ranges fail with an internal RPC error: retry once with a quarter of the range.
async function readRange(rpc, from, to, needEpoch, back) {
  const logsOf = (address, a, b, topics) => ["eth_getLogs", [{ address, fromBlock: hex(a), toBlock: hex(b), ...(topics ? { topics } : {}) }]];
  const ask = async (end, withBack) => {
    const calls = [logsOf(CONSENSUS_ADDRESS, from, end), logsOf(STAKING_ADDRESS, from, end, [EPOCH_ADVANCE_TOPIC])];
    if (needEpoch) calls.push(["eth_call", [{ to: STAKING_ADDRESS, data: EPOCH_SELECTOR }, hex(Math.max(0, from - 1))]]);
    if (withBack) calls.push(logsOf(STAKING_ADDRESS, Math.max(0, back - BACK_SPAN + 1), back, [EPOCH_ADVANCE_TOPIC]));
    return rpc.batch(calls);
  };
  const wantBack = back >= 0;
  let end = to, res = await ask(end, wantBack), usedBack = wantBack;
  if (res[0].error || res[1].error) {
    if (end === from) throw new Error(`eth_getLogs: ${(res[0].error ?? res[1].error).message}`);
    end = from + Math.max(0, Math.floor((to - from + 1) / 4) - 1);
    res = await ask(end, false);
    usedBack = false;
    if (res[0].error || res[1].error) throw new Error(`eth_getLogs: ${(res[0].error ?? res[1].error).message}`);
  }
  let epochAtStart = null;
  if (needEpoch) {
    if (res[2].error) throw new Error(`eth_call epoch: ${res[2].error.message}`);
    epochAtStart = parseInt(res[2].result, 16);
  }
  const backRes = usedBack ? res[needEpoch ? 3 : 2] : null;
  return { logs: res[0].result, advances: res[1].result, to: end, epochAtStart,
           backAdvances: backRes && !backRes.error ? backRes.result : [], backDone: !!backRes && !backRes.error };
}
