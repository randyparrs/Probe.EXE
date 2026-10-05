// Decides whether this dispatch runs the campaign, with the rule of collector/core/schedule.js.
//
// An external cron (cron-job.org) dispatches the workflow every 3 hours, so every 3-hour window gets
// one dispatch whatever minute the cron uses. The epoch, its start and its campaigns come from the
// page's public API. When the API does not answer, or its data is behind, the epoch and its start are
// read from the chain and the campaigns of the epoch count as unknown.
//
//   node collector/campaign/slot.mjs            prints the decision; with GITHUB_OUTPUT set,
//                                               also writes run=true|false for the next steps
//   FORCE=true node collector/campaign/slot.mjs always run (manual dispatch)

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decide } from "../core/schedule.js";
import { EPOCH_ADVANCE_TOPIC, EPOCH_SELECTOR, STAKING_ADDRESS, decodeEpochAdvance } from "../core/staking.js";

const API = "https://probe-exe.pages.dev/api";
const RPC = "https://rpc-bradbury.genlayer.com";
const STALE_SECONDS = 1800;    // API data older than this does not say whether a campaign ran
const BACK_SPAN = 2000;        // blocks per step when looking backwards for the start of the epoch
const BACK_STEPS = 60;         // the chain makes 8 to 40 blocks a minute: more than 2 days

const getJson = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};

// { epoch, start, campaigns }: campaigns null when the API cannot say
export async function fromApi(now, api = API, get = getJson) {
  const meta = await get(`${api}/meta`);
  const epoch = meta.epoch?.number, start = meta.epoch?.since;
  if (epoch == null || start == null) throw new Error("the API has no current epoch");
  if (!(now - meta.updated?.network <= STALE_SECONDS)) return { epoch, start, campaigns: null, note: "API data behind" };
  const { events } = await get(`${api}/events?view=epoch:${epoch}&type=campaigns`);
  const campaigns = events.filter((e) => e.type === "campaign" && e.data.status !== "failed").map((e) => e.data.started).sort((a, b) => a - b);
  return { epoch, start, campaigns };
}

// { epoch, start, campaigns: null } from the staking contract
export async function fromChain(rpc = RPC) {
  let id = 0;
  const call = async (method, params) => {
    const r = await getJson(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  };
  const tip = Number(await call("eth_blockNumber", []));
  const epoch = Number(await call("eth_call", [{ to: STAKING_ADDRESS, data: EPOCH_SELECTOR }, "latest"]));
  for (let to = tip, step = 0; to >= 0 && step < BACK_STEPS; to -= BACK_SPAN, step++) {
    const logs = await call("eth_getLogs", [{ address: STAKING_ADDRESS, fromBlock: "0x" + Math.max(0, to - BACK_SPAN + 1).toString(16),
      toBlock: "0x" + to.toString(16), topics: [EPOCH_ADVANCE_TOPIC] }]);
    const found = logs.map(decodeEpochAdvance).find((a) => a.epoch === epoch);
    if (found) {
      const ts = found.ts ?? Number((await call("eth_getBlockByNumber", ["0x" + found.block.toString(16), false])).timestamp);
      return { epoch, start: ts, campaigns: null, note: "read from the chain" };
    }
  }
  throw new Error(`no start found for epoch ${epoch}`);
}

const utc = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const force = process.env.FORCE === "true";
  let state;
  try {
    state = await fromApi(now);
  } catch (e) {
    console.log(`API: ${e.message}`);
    try {
      state = await fromChain();
    } catch (e2) {
      console.log(`chain: ${e2.message}`);
    }
  }
  let run = force, line = `${utc(now)}: `;
  if (state) {
    const d = decide({ ...state, now });
    run = force || d.run;
    line += `epoch ${state.epoch} since ${utc(state.start)}${state.note ? ` (${state.note})` : ""}, `
      + `campaigns in it: ${state.campaigns == null ? "unknown" : state.campaigns.length}, `
      + `window ${utc(d.window.start)} to ${utc(d.window.end)}: ${d.reason}`;
  } else {
    line += "epoch unknown";
  }
  console.log(`${line} -> ${run ? "run" : "skip"}${force ? " (forced)" : ""}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
