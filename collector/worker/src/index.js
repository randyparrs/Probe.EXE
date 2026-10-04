// Cloudflare Worker of Probe.EXE. A Cron Trigger runs the passive collector every minute; the
// fetch handler serves read-only JSON to the page (what it answers is built in api.js).

import campaign from "../../campaign/contracts.json";
import { EVENT_GROUPS, EXPORT_PAGE, OPERATOR_EPOCHS, SERIES_EPOCHS, badge, campaigns, contracts, events, exportPage, failedCampaigns, operators,
  overview, rpcIncidents, validView, viewFilter, viewRange } from "./api.js";
import { collect, rpcClient } from "./collect.js";
import { d1Store } from "./store.js";

const TAPE_SIZE = 40;
const EPOCH_MIN_SECONDS = 86400;       // epochMinDuration of the staking contract: an epoch lasts at least this
const EVENTS_SINCE = "2026-10-01";     // the page counts from consensus events, and observes the network, since this day
const SINCE_TS = Date.parse(EVENTS_SINCE + "T00:00:00Z") / 1000;
const LOG_LIMIT = 500;                 // log entries read for the events of a view
const API_LIMIT_PER_MINUTE = 120;      // the limit of the API_LIMIT binding (wrangler.jsonc), for the error message

// reference contract address -> { name, llm }, and name -> llm
const REFERENCE = new Map(Object.entries(campaign.contracts).flatMap(([name, c]) =>
  c.copies.map((address) => [address.toLowerCase(), { name, llm: !/no LLM/i.test(c.kind) }])));
const REF_LLM = new Map(Object.entries(campaign.contracts).map(([name, c]) => [name, !/no LLM/i.test(c.kind)]));
// name -> what the page shows about a reference contract; a retired copy is listed under the
// contract its reason starts with
const REF_DETAILS = new Map(Object.entries(campaign.contracts).map(([name, c]) => [name, {
  kind: c.kind,
  input: `${c.method}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`,
  retired: Object.entries(campaign.retired ?? {}).filter(([, reason]) => reason.startsWith(name + " ")).map(([address, reason]) => ({ address: address.toLowerCase(), reason })),
}]));

const json = (body, maxAge, status = 200, more = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    ...more,
  },
});

export default {
  async scheduled(controller, env) {
    const run = await collect({
      rpc: rpcClient(env.RPC_URL), store: d1Store(env.DB), now: Math.floor(controller.scheduledTime / 1000),
      reference: REFERENCE, campaignWallet: env.CAMPAIGN_WALLET.toLowerCase(),
      startBlock: env.START_BLOCK ? Number(env.START_BLOCK) : null,
    });
    console.log(JSON.stringify(run));
  },

  async fetch(request, env) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 0, 405);
    // Only requests that missed the cache of the page get here. One address may send a limited
    // number of them per minute; the binding is absent in tests and where it is not available.
    if (env.API_LIMIT) {
      const { success } = await env.API_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
      if (!success) return json({ error: `rate limit: at most ${API_LIMIT_PER_MINUTE} uncached requests per minute from one address` }, 0, 429, { "retry-after": "60" });
    }
    const store = d1Store(env.DB);
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);

    // last transactions of the network, oldest first: { hash, contract, status, ts }
    if (url.pathname === "/api/tape") {
      const [txs, runs] = await Promise.all([store.latestTx(TAPE_SIZE), store.latestRuns(1)]);
      return json({
        updated: runs[0]?.ts ?? null,
        txs: txs.map((t) => ({ hash: t.tx_id, contract: t.recipient, status: t.status, ts: t.first_ts })),
      }, 60);
    }

    // what is current: last update, epochs and RPC health
    if (url.pathname === "/api/meta") {
      const m = await store.meta(now);
      const starts = new Map(m.epochs.map((e) => [e.epoch, e.start_ts]));
      const numbers = [...new Set([m.epoch, ...starts.keys()])].filter((e) => e != null).sort((a, b) => b - a);
      const since = starts.get(m.epoch) ?? null;
      return json({
        now,
        // network: up to when it has been read (the last run, or the last event read while catching
        // up); chain: the last read of the validator sets
        updated: { network: m.asOf, chain: m.setsTs ?? m.asOf, campaign: await store.lastCampaign(m.epoch) },
        synced: m.synced,
        epoch: m.epoch == null ? null : { number: m.epoch, since, next_estimate: since == null ? null : since + EPOCH_MIN_SECONDS },
        epochs: numbers.map((e) => ({ epoch: e, since: starts.get(e) ?? null })),
        rpc: { state: m.rpc.non_json > 0 ? "degraded" : "normal", non_json_last_hour: m.rpc.non_json, failed_runs_last_hour: m.rpc.failed, runs_last_hour: m.rpc.runs },
        campaign_wallet: env.CAMPAIGN_WALLET,
        network_since: EVENTS_SINCE,
        events_since: EVENTS_SINCE,
      }, 60);
    }

    // a view (an epoch or the last 24 hours): the network and the campaign against its control
    if (["/api/overview", "/api/contracts", "/api/operators", "/api/events"].includes(url.pathname)) {
      const view = url.searchParams.get("view");
      if (!validView(view)) return json({ error: "unknown view: use epoch:N or 24h" }, 0, 400);
      const m = await store.meta(now);
      const filter = viewFilter(view, now, m);
      if (!filter) return json({ error: "no data yet" }, 0, 503);
      const range = viewRange(filter.view, now, m);

      // what happened in the view, newest first: ?type= one of EVENT_GROUPS, ?before= the id of
      // the last event of the previous page
      if (url.pathname === "/api/events") {
        const type = url.searchParams.get("type");
        if (type && !EVENT_GROUPS.includes(type)) return json({ error: "unknown type" }, 0, 400);
        // campaigns are numbered within their UTC day, so they are read from the start of the day
        const from = Math.floor(Math.max(range.from, SINCE_TS) / 86400) * 86400;
        const [logRows, bad, times, validators] = await Promise.all([
          store.logRows(range.from, range.to, LOG_LIMIT), store.badRuns(range.from - 3600, range.to),
          store.campaignTimes(Math.max(0, filter.params[0] - 1), Math.floor(from / 3600), Math.floor(range.to / 3600) + 2), store.validators()]);
        const campaignList = campaigns(times, m.asOf);
        return json(events({
          view: filter.view, range, logRows, epochs: m.epochs, campaignList, since: SINCE_TS, sinceDate: EVENTS_SINCE,
          failed: failedCampaigns(campaignList, range.from, range.to, m.asOf, SINCE_TS), incidents: rpcIncidents(bad, now),
          names: new Map(validators.map((v) => [v.address, v.moniker])), reference: REFERENCE,
          type, before: url.searchParams.get("before"),
        }), 300);
      }

      if (url.pathname === "/api/overview") {
        const [rows, campTx, voters, lastTs, validators] = await Promise.all([
          store.contractTotals(filter), store.campaignTx(filter), store.campaignVoters(filter), store.lastCampaign(m.epoch), store.validators()]);
        const last = lastTs ? await store.campaignAround(m.epoch, lastTs) : null;
        return json(overview({ view: filter.view, rows, campTx, voters, last, refLlm: REF_LLM, asOf: m.asOf, validators }), 300);
      }

      // one row per validator: votes and leader rounds per source, status, stake and weight
      if (url.pathname === "/api/operators") {
        const [totals, series, validators, draws] = await Promise.all([
          store.operatorTotals(filter), store.operatorSeries(Math.max(0, m.epoch - OPERATOR_EPOCHS + 1)), store.validators(), store.leaderDraws(filter)]);
        return json(operators({ view: filter.view, totals, series, validators, draws }), 300);
      }

      const [rows, campTx, byEpoch, stalled] = await Promise.all([store.contractRows(filter, 400), store.campaignTx(filter),
        store.campaignByEpoch(Math.max(0, m.epoch - SERIES_EPOCHS + 1)), store.stalled(range.from, range.to)]);
      return json(contracts({ view: filter.view, rows, campTx, byEpoch, reference: REFERENCE, refLlm: REF_LLM, details: REF_DETAILS, stalled }), 300);
    }

    // badge of a contract, to embed anywhere: its first-attempt acceptance in the current epoch
    const badgeOf = /^\/api\/badge\/(0x[0-9a-fA-F]{40})\.svg$/.exec(url.pathname);
    if (badgeOf) {
      const epoch = (await store.meta(now)).epoch;
      if (epoch == null) return json({ error: "no data yet" }, 0, 503);
      return new Response(badge({ epoch, totals: await store.contractEpoch(epoch, badgeOf[1].toLowerCase()) }), {
        headers: { "content-type": "image/svg+xml; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
      });
    }

    // Every transaction of an epoch, EXPORT_PAGE per page: ?epoch= a number, ?after= the `next` of
    // the previous page. It is what the daily data export reads.
    if (url.pathname === "/api/export") {
      const epoch = /^\d{1,9}$/.test(url.searchParams.get("epoch") ?? "") ? Number(url.searchParams.get("epoch")) : null;
      const after = /^(\d{1,12}):(0x[0-9a-f]{64})$/.exec(url.searchParams.get("after") ?? "");
      if (epoch == null || (url.searchParams.has("after") && !after)) return json({ error: "epoch must be a number and after the next of the previous page" }, 0, 400);
      const starts = new Map((await store.meta(now)).epochs.map((e) => [e.epoch, e.start_block]));
      const rows = await store.exportTx(epoch, starts.get(epoch) ?? 0, starts.get(epoch + 1) ?? Number.MAX_SAFE_INTEGER,
        after ? Number(after[1]) : -1, after ? after[2] : "", EXPORT_PAGE + 1);
      return json(exportPage({ epoch, rows }), 300);
    }

    // collector health: cursor and the last runs
    if (url.pathname === "/api/status") {
      const [st, runs] = await Promise.all([store.meta(now), store.latestRuns(10)]);
      return json({ cursor: st.cursor, epoch: st.epoch, runs }, 60);
    }

    return json({ error: "not found" }, 0, 404);
  },
};
