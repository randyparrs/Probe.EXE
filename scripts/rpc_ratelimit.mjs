// Read-only probe of the Bradbury RPC request limit, to size the campaign poll interval.
// Runs the watcher's own call (genlayer-js 1.2.0 getTransaction on a finished tx) at increasing
// rates, 20 s per step, and stops at the first step with errors. Counts the HTTP requests each
// getTransaction makes (it is several eth_calls).
//
//   node scripts/rpc_ratelimit.mjs [txHash]

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// genlayer-js 1.2.0 from the node_modules of this repository (npm ci); GLJS_DIST points to another build
const GLJS = process.env.GLJS_DIST ?? join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "genlayer-js", "dist") + "/";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "results", "bradbury");
mkdirSync(OUT, { recursive: true });

let httpCalls = 0;
const statuses = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  httpCalls++;
  const res = await realFetch(...args);
  statuses[res.status] = (statuses[res.status] ?? 0) + 1;
  return res;
};

const { createClient } = await import(pathToFileURL(GLJS + "index.js").href);
const { testnetBradbury } = await import(pathToFileURL(GLJS + "chains/index.js").href);
const client = createClient({ chain: testnetBradbury });
const hash = process.argv[2] ?? "0x77221dfb3ad642a3940f5edb2af8a37578fa539db05a39b047f1270511b06f18";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// requests per getTransaction
httpCalls = 0;
await client.getTransaction({ hash });
const perCall = httpCalls;
console.log(`HTTP requests per getTransaction: ${perCall}`);

const results = [];
for (const rate of [1, 2, 4, 8]) {
  const t0 = Date.now();
  let ok = 0, fail = 0;
  const lat = [];
  const errors = {};
  httpCalls = 0;
  for (const k of Object.keys(statuses)) delete statuses[k];
  const inflight = [];
  while (Date.now() - t0 < 20000) {
    const s = Date.now();
    inflight.push(client.getTransaction({ hash }).then(() => { ok++; lat.push(Date.now() - s); })
      .catch((e) => { fail++; const m = String(e).slice(0, 80); errors[m] = (errors[m] ?? 0) + 1; }));
    await sleep(1000 / rate);
  }
  await Promise.all(inflight);
  const secs = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const row = { rate, getTxPerS: +(ok / secs).toFixed(2), httpPerS: +(httpCalls / secs).toFixed(2), ok, fail,
                httpStatuses: { ...statuses }, latencyMs: { median: lat[lat.length >> 1] ?? null, max: lat.at(-1) ?? null }, errors };
  results.push(row);
  console.log(JSON.stringify(row));
  if (fail > 0) break;
  await sleep(5000);
}
appendFileSync(join(OUT, "rpc-ratelimit.jsonl"), JSON.stringify({ at: new Date().toISOString(), perCall, results }) + "\n");
