// What the read API answers, built from rows of the store. Pure functions: no database, no network.
// The API returns counts and rates; intervals are computed by whoever reads it (probe-static/stats.js).

import { toGen, weightOf } from "../../core/staking.js";

export const CAMPAIGN_RUNNING_SECONDS = 600;   // a campaign with an event in the last ten minutes is still running

// view: "epoch:168" or "24h" (clock hours, so up to one hour more at the edge); default: the current
// epoch. Returns the filter over a table aliased h with epoch and hour columns, or null with no data.
export function viewFilter(view, now, meta) {
  if (view === "24h") {
    const cutoff = now - 86400;
    const older = meta.epochs.filter((e) => e.start_ts != null && e.start_ts <= cutoff).map((e) => e.epoch);
    return { view: "24h", sql: "h.epoch >= ?1 AND h.hour >= ?2", params: [older.length ? Math.max(...older) : 0, Math.floor(cutoff / 3600)] };
  }
  const m = /^epoch:(\d{1,9})$/.exec(view ?? "");
  const epoch = m ? Number(m[1]) : meta.epoch;
  return epoch == null ? null : { view: `epoch:${epoch}`, sql: "h.epoch = ?1", params: [epoch] };
}

// Time range [from, to) of a view returned by viewFilter, in seconds. An epoch whose start is not
// known starts at 0; the current epoch and the last 24 hours end now.
export function viewRange(view, now, meta) {
  if (view === "24h") return { from: now - 86400, to: now + 1 };
  const epoch = Number(view.slice(6));
  const starts = new Map(meta.epochs.map((e) => [e.epoch, e.start_ts]));
  return { from: starts.get(epoch) ?? 0, to: starts.get(epoch + 1) ?? now + 1 };
}

const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);

// counts of a group of transactions, their first-attempt rate over the decided ones, and their votes
export function tally(rows) {
  const t = { tx: sum(rows, "tx"), first: sum(rows, "first"), retry: sum(rows, "retry"), none: sum(rows, "none"), cancelled: sum(rows, "cancelled") };
  const decided = t.first + t.retry + t.none;
  const votes = { agree: sum(rows, "agree"), disagree: sum(rows, "disagree"), dv: sum(rows, "dv"), timeout: sum(rows, "timeout") };
  votes.total = votes.agree + votes.disagree + votes.dv + votes.timeout;
  return { ...t, in_progress: t.tx - decided, decided, first_rate: decided ? t.first / decided : null, votes };
}

// what made transactions retry, counted before their first acceptance
export function retries(txs) {
  return { transactions: txs.length, leader_timeouts: sum(txs, "leader_timeouts"), no_majority: sum(txs, "rotations"),
           appeals: sum(txs, "appeals"), recomputations: sum(txs, "recomputations") };
}

// seconds from creation to acceptance of the accepted transactions: nearest-rank median and p90
export function latency(txs) {
  const secs = txs.filter((t) => t.accept_secs != null && (t.status === "first" || t.status === "retry")).map((t) => t.accept_secs).sort((a, b) => a - b);
  const n = secs.length;
  if (!n) return { accepted: 0, median: null, p90: null, max: null, under_30s: 0, s30_to_60: 0, m1_to_5: 0, over_5m: 0 };
  const rank = (p) => secs[Math.max(0, Math.ceil(p * n) - 1)];
  return { accepted: n, median: rank(0.5), p90: rank(0.9), max: secs[n - 1],
           under_30s: secs.filter((s) => s < 30).length, s30_to_60: secs.filter((s) => s >= 30 && s < 60).length,
           m1_to_5: secs.filter((s) => s >= 60 && s < 300).length, over_5m: secs.filter((s) => s >= 300).length };
}

// The daily campaign runs in one 3-hour bucket of the UTC day: bucket number (day of year mod 8),
// the rule of collector/campaign/slot.mjs. Returns the bucket of the day of `now`, in seconds.
export function campaignSlot(now) {
  const d = new Date(now * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const dayOfYear = Math.floor((day - Date.UTC(d.getUTCFullYear(), 0, 1) / 1000) / 86400) + 1;
  return { start: day + (dayOfYear % 8) * 10800, end: day + (dayOfYear % 8 + 1) * 10800 };
}
export const CAMPAIGN_GRACE_SECONDS = 1800;   // after the bucket ends, before a missing campaign counts as failed

// The last campaign: running, completed, or failed when the bucket of the day passed with no
// transaction of the campaign wallet. asOf: the time up to which the network has been read.
export function lastCampaign(last, asOf) {
  const seen = last && last.transactions ? last : null;
  const slot = asOf == null ? null : campaignSlot(asOf);
  if (slot && asOf > slot.end + CAMPAIGN_GRACE_SECONDS && (!seen || seen.started < slot.start)) {
    return { status: "failed", expected_from: slot.start, expected_until: slot.end, transactions: 0, started: null, last_event: null };
  }
  if (!seen) return null;
  return { status: asOf != null && asOf - seen.last_event < CAMPAIGN_RUNNING_SECONDS ? "running" : "completed",
           started: seen.started, last_event: seen.last_event, transactions: seen.transactions, epoch: seen.epoch ?? null };
}

// rows: contractTotals; campTx: campaignTx; voters: campaignVoters; last: campaignAround or null;
// refLlm: Map of reference contract name -> whether it calls an LLM; validators: rows of the table;
// asOf: the time up to which the network has been read
export function overview({ view, rows, campTx, voters, last, refLlm, asOf, validators = [] }) {
  const camp = rows.filter((r) => r.camp === 1);
  const isLlm = (name) => refLlm.get(name) === true, isControl = (name) => refLlm.get(name) === false;
  const llmTx = campTx.filter((t) => isLlm(t.camp));
  const allTimeout = voters.filter((v) => v.votes > 0 && v.timeout === v.votes).map((v) => v.validator);
  return {
    view,
    network: { all: tally(rows), llm: tally(rows.filter((r) => r.llm === "llm")) },
    campaign: {
      llm: { ...tally(camp.filter((r) => isLlm(r.ref_name))), retries: retries(llmTx), time_to_acceptance: latency(llmTx) },
      control: tally(camp.filter((r) => isControl(r.ref_name))),
      voters: voters.length,
      operators_all_timeout: allTimeout,
    },
    validators: validatorCounts(validators),
    last_campaign: lastCampaign(last, asOf),
  };
}

// How many validators are in each set. quarantined: with a quarantine record in effect (the
// collector ignores the expired ones). eligible: active, not banned and not quarantined.
const isEligible = (v) => v.active === 1 && v.quarantined !== 1 && v.banned !== 1;
export function validatorCounts(validators) {
  if (!validators.length) return null;
  return { active: validators.filter((v) => v.active === 1).length, eligible: validators.filter(isEligible).length,
           quarantined: validators.filter((v) => v.quarantined === 1).length, banned: validators.filter((v) => v.banned === 1).length };
}

export const OPERATOR_EPOCHS = 5;   // epochs in the "by epoch" series of an operator
const NO_VOTES = { votes: 0, agree: 0, disagree: 0, dv: 0, timeout: 0, led: 0, leader_timeouts: 0 };
const addCounts = (a, b) => Object.fromEntries(Object.keys(NO_VOTES).map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]));

// totals: operatorTotals; series: operatorSeries; validators: rows of the validators table; draws:
// leaderDraws. One row per validator that is in a list or voted in the view. Stakes in GEN; weight
// is the selection weight of the staking documentation, null while the stake has not been read.
// leader: campaign transactions of the view whose first leader was the validator, and how many
// were expected from its weight in the eligible set in effect at each transaction; null when the
// validator was in no eligible set of the view and led none.
export function operators({ view, totals, series, validators, draws = [] }) {
  const known = new Map(validators.map((v) => [v.address, v]));
  const bySource = new Map();   // address -> { net, camp_llm, camp_control }
  for (const r of totals) bySource.set(r.validator, { ...(bySource.get(r.validator) ?? {}), [r.src]: r });
  const drawn = new Map(draws.map((r) => [r.validator, { first: r.first, expected: r.expected }]));
  const rows = [...new Set([...known.keys(), ...bySource.keys(), ...drawn.keys()])].map((address) => {
    const v = known.get(address) ?? {}, s = bySource.get(address) ?? {};
    const own = toGen(v.self_stake), delegated = toGen(v.delegated_stake);
    const llm = addCounts(NO_VOTES, s.camp_llm ?? {}), control = addCounts(NO_VOTES, s.camp_control ?? {});
    const epochs = new Map();
    for (const r of series) {
      if (r.validator !== address) continue;
      const e = epochs.get(r.epoch) ?? { epoch: r.epoch, llm_votes: 0, llm_timeout: 0, llm_dv: 0, leader_timeouts: 0 };
      if (r.src === "camp_llm") { e.llm_votes += r.votes; e.llm_timeout += r.timeout; e.llm_dv += r.dv; }
      e.leader_timeouts += r.leader_timeouts;
      epochs.set(r.epoch, e);
    }
    return {
      address, moniker: v.moniker ?? null,
      status: v.banned === 1 ? "Banned" : v.quarantined === 1 ? "Quarantined" : v.active === 1 ? "Active" : "Not active",
      eligible: isEligible(v), banned_until: v.banned === 1 ? v.banned_until : null,
      stake: own == null ? null : { own, delegated: delegated ?? 0 },
      weight: own == null ? null : weightOf(own, delegated ?? 0),
      campaign_llm: llm, campaign_control: control, network: addCounts(addCounts(llm, control), s.net ?? {}),
      leader: drawn.get(address) ?? null,
      by_epoch: [...epochs.values()].sort((a, b) => a.epoch - b.epoch),
    };
  });
  return { view, validators: validatorCounts(validators), operators: rows };
}

export const SERIES_EPOCHS = 8;   // epochs in the "by epoch" series of a reference contract

// rows of store.stalled: contracts with five transactions in a row without a vote, the fifth over
// an hour old. transactions: how many went without a vote (so far, or until it recovered);
// last_tx: the last transaction the contract received.
export function stalledContracts(rows) {
  return rows.map((r) => ({
    contract: r.address, reference: r.ref_name ?? null, llm: r.llm ?? null, since: r.since_ts,
    transactions: r.recovered_ts == null ? r.streak : r.stalled_tx,
    status: r.recovered_ts == null ? "stalled" : "recovered", recovered: r.recovered_ts ?? null, last_tx: r.last_tx ?? null,
  }));
}

// rows: contractRows; campTx: campaignTx; byEpoch: campaignByEpoch; reference: Map of address ->
// { name, llm }; details: Map of name -> { kind, input, retired: [{ address, reason }] };
// stalled: rows of store.stalled
export function contracts({ view, rows, campTx, byEpoch = [], reference, refLlm, details = new Map(), stalled = [] }) {
  const byContract = new Map();
  for (const r of rows) byContract.set(r.contract, [...(byContract.get(r.contract) ?? []), r]);
  const network = [...byContract].map(([contract, list]) => ({
    contract, llm: list[0].llm ?? null, reference: list[0].ref_name ?? null,
    ...tally(list), last_seen: Math.max(...list.map((r) => r.last_ts ?? 0)) || null,
  })).sort((a, b) => b.tx - a.tx);
  const copiesOf = (name) => [...reference].filter(([, ref]) => ref.name === name).map(([address]) => address);
  return {
    view,
    reference: [...refLlm].map(([name, llm]) => {
      const txs = campTx.filter((t) => t.camp === name);
      return { name, llm, ...(details.get(name) ?? {}), copies: copiesOf(name),
               ...tally(rows.filter((r) => r.camp === 1 && r.ref_name === name)),
               retries: retries(txs), time_to_acceptance: latency(txs),
               by_epoch: byEpoch.filter((r) => r.ref_name === name).map((r) => ({ epoch: r.epoch, ...tally([r]) })) };
    }),
    network,
    stalled: stalledContracts(stalled),
  };
}

// ---- Badge

// SVG badge of a contract: its first-attempt acceptance in an epoch, with the color of the health
// label of the page (90% or more green, 70 to 90% amber, below 70% red, grey with nothing decided).
// totals: { first, retry, none } of the contract in the epoch.
export function badge({ epoch, totals }) {
  const decided = totals.first + totals.retry + totals.none, rate = decided ? totals.first / decided : null;
  const label = `first attempt, epoch ${epoch}`;
  const value = rate == null ? "no data" : `${(rate * 100).toFixed(1)}% (n = ${decided})`;
  const color = rate == null ? "#5b6b5e" : rate >= 0.9 ? "#1f8b3b" : rate >= 0.7 ? "#a87400" : "#c23a37";
  const CHAR = 6.7, PAD = 7;     // 11 px monospace
  const left = Math.round(label.length * CHAR + 2 * PAD), right = Math.round(value.length * CHAR + 2 * PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${left + right}" height="20" role="img" aria-label="${label}: ${value}">`
    + `<title>Probe.EXE: ${label}: ${value}</title>`
    + `<rect width="${left}" height="20" fill="#0b0f0c"/><rect x="${left}" width="${right}" height="20" fill="${color}"/>`
    + `<g fill="#ffffff" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" font-size="11" text-anchor="middle">`
    + `<text x="${left / 2}" y="14" fill="#c9d1c9">${label}</text><text x="${left + right / 2}" y="14">${value}</text></g></svg>`;
}

// ---- Data export

export const EXPORT_PAGE = 200;   // transactions per page of the export
const VOTE_NAME = ["not_voted", "agree", "disagree", "timeout", "dv"];
const RESULT_NAME = ["idle", "agree", "disagree", "timeout", "dv", "no_majority", "majority_agree", "majority_disagree"];

// One page of the export of an epoch. rows: store.exportTx, read with one row more than the page
// to know whether there is another page. The columns are documented in the README.
export function exportPage({ epoch, rows }) {
  const page = rows.slice(0, EXPORT_PAGE);
  const out = page.map((r) => {
    const attempts = (JSON.parse(r.state).attempts ?? []).map((a) => ({
      leader: a.leader ?? null, leader_timeout: !!a.timedOut, result: a.result == null ? null : RESULT_NAME[a.result] ?? String(a.result),
      votes: a.votes.map(([validator, type]) => [validator, VOTE_NAME[type] ?? String(type)]),
    }));
    const votes = { agree: 0, disagree: 0, dv: 0, timeout: 0 };
    for (const a of attempts) for (const [, type] of a.votes) if (type in votes) votes[type]++;
    return {
      tx_id: r.tx_id, epoch: r.epoch, contract: r.recipient, llm: r.llm ?? null, campaign: r.camp ?? null,
      created: r.first_ts, created_block: r.first_block, status: r.status, accepted: r.accepted_ts ?? null, accept_seconds: r.accept_secs ?? null,
      leader_timeouts: r.leader_timeouts, rotations: r.rotations, appeals: r.appeals, recomputations: r.recomputations,
      votes_agree: votes.agree, votes_disagree: votes.disagree, votes_dv: votes.dv, votes_timeout: votes.timeout, attempts,
    };
  });
  const last = page.at(-1);
  return { epoch, rows: out, next: rows.length > EXPORT_PAGE ? `${last.first_block}:${last.tx_id}` : null };
}

// ---- Events section

export const CAMPAIGN_GAP_SECONDS = 1800;   // campaign transactions created further apart belong to two campaigns
const utcDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

// times: [{ first_ts, last_ts, epoch }] of campaign transactions, oldest first. One entry per campaign,
// with the epoch of its first transaction. Its
// id is the UTC date it started on, with -2, -3 for further campaigns that started the same day.
export function campaigns(times, asOf) {
  const list = [];
  let prev = null;
  for (const t of times) {
    const c = prev != null && t.first_ts - prev <= CAMPAIGN_GAP_SECONDS ? list.at(-1) : null;
    if (c) { c.transactions++; c.last_event = Math.max(c.last_event, t.last_ts ?? t.first_ts); }
    else list.push({ started: t.first_ts, last_event: t.last_ts ?? t.first_ts, transactions: 1, epoch: t.epoch ?? null });
    prev = t.first_ts;
  }
  const perDay = new Map();
  for (const c of list) {
    const day = utcDate(c.started), n = (perDay.get(day) ?? 0) + 1;
    perDay.set(day, n);
    c.id = n === 1 ? day : `${day}-${n}`;
    c.status = asOf != null && asOf - c.last_event < CAMPAIGN_RUNNING_SECONDS ? "running" : "completed";
  }
  return list;
}

// Days of [from, to) whose campaign bucket passed, with its grace time, and no campaign started in
// it. since: the first second observed; asOf: the time up to which the network has been read.
export function failedCampaigns(list, from, to, asOf, since) {
  const out = [];
  if (asOf == null) return out;
  const first = Math.floor(Math.max(from, since) / 86400), last = Math.min(Math.floor(Math.min(to, asOf) / 86400), first + 60);
  for (let day = first; day <= last; day++) {
    const slot = campaignSlot(day * 86400);
    if (slot.start < since || slot.end < from || slot.end >= to || asOf <= slot.end + CAMPAIGN_GRACE_SECONDS) continue;
    if (list.some((c) => c.started >= slot.start && c.started <= slot.end + CAMPAIGN_GRACE_SECONDS)) continue;
    out.push({ id: utcDate(slot.start), status: "failed", transactions: 0, expected_from: slot.start, expected_until: slot.end });
  }
  return out;
}

export const RUN_SECONDS = 60;       // the collector runs once a minute
export const RPC_OPEN_RUNS = 2;      // runs in a row with an answer that is not JSON open an incident
export const RPC_CLOSE_RUNS = 5;     // clean runs in a row close it

// bad: times of the runs that got an answer that was not JSON, oldest first. An incident runs from
// its first bad run to its last one; open: fewer than RPC_CLOSE_RUNS clean runs since then.
export function rpcIncidents(bad, now) {
  const out = [];
  let cur = null, row = 0;   // row: bad runs in a row ending at the previous one
  for (let i = 0; i < bad.length; i++) {
    row = i > 0 && bad[i] - bad[i - 1] <= RUN_SECONDS ? row + 1 : 1;
    if (cur && bad[i] - cur.to <= RPC_CLOSE_RUNS * RUN_SECONDS) { cur.to = bad[i]; cur.runs++; continue; }
    cur = null;
    if (row >= RPC_OPEN_RUNS) { cur = { from: bad[i - RPC_OPEN_RUNS + 1], to: bad[i], runs: RPC_OPEN_RUNS }; out.push(cur); }
  }
  for (const c of out) c.open = now - c.to < RPC_CLOSE_RUNS * RUN_SECONDS;
  return out;
}

export const EVENTS_PAGE = 50;
export const EVENT_GROUPS = ["epochs", "validators", "contracts", "campaigns", "rpc"];
const GROUP = { epoch: "epochs", eligible: "validators", quarantined: "validators", banned: "validators",
                stalled: "contracts", recovered: "contracts", campaign: "campaigns", method: "campaigns", rpc: "rpc" };

// The event log of a view, newest first, EVENTS_PAGE per page.
// range: viewRange; logRows: store.logRows; epochs: rows of the epochs table; campaignList:
// campaigns(); failed: failedCampaigns(); incidents: rpcIncidents(); since: the first second
// observed; names: Map of validator address -> declared name; reference: Map of contract address ->
// { name }; type: one of EVENT_GROUPS or null; before: id of the last event of the previous page.
export function events({ view, range, logRows = [], epochs = [], campaignList = [], failed = [], incidents = [], since, sinceDate,
                         names = new Map(), reference = new Map(), type = null, before = null }) {
  const inRange = (ts) => ts != null && ts >= range.from && ts < range.to && ts >= since;
  const starts = new Map(epochs.map((e) => [e.epoch, e.start_ts]));
  const list = [];
  for (const r of logRows) {
    const data = JSON.parse(r.data);
    if (data.validator) data.moniker = names.get(data.validator) ?? null;
    if (data.contract) data.reference = reference.get(data.contract)?.name ?? null;
    list.push({ id: `l${r.id}`, ts: r.ts, type: r.type, data });
  }
  for (const e of epochs) {
    if (!inRange(e.start_ts)) continue;
    const prev = starts.get(e.epoch - 1);
    list.push({ id: `e${e.epoch}`, ts: e.start_ts, type: "epoch", data: { epoch: e.epoch, block: e.start_block ?? null, previous_seconds: prev == null ? null : e.start_ts - prev } });
  }
  for (const c of campaignList) if (inRange(c.started)) list.push({ id: `c${c.started}`, ts: c.started, type: "campaign", data: c });
  for (const c of failed) list.push({ id: `f${c.expected_from}`, ts: c.expected_until, type: "campaign", data: c });
  for (const i of incidents) if (inRange(i.from)) list.push({ id: `r${i.from}`, ts: i.from, type: "rpc", data: i });
  if (since >= range.from && since < range.to) list.push({ id: "m", ts: since, type: "method", data: { since: sinceDate } });

  const all = list.map((e) => ({ ...e, group: GROUP[e.type] ?? null })).filter((e) => !type || e.group === type)
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  const at = before == null ? 0 : all.findIndex((e) => e.id === before) + 1;
  const page = before != null && at === 0 ? [] : all.slice(at, at + EVENTS_PAGE);
  return { view, events: page, next: at + EVENTS_PAGE < all.length && page.length ? page.at(-1).id : null };
}
