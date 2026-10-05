// node --test collector/worker/index.test.mjs
// The request handler of the collector Worker: routes, error answers, headers and the rate limit,
// against an empty database (node:sqlite standing in for D1).

import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./src/index.js";
import { emptyDb, fakeD1 } from "./fake-d1.mjs";

const WALLET = "0x" + "aa".repeat(20);

// env of the Worker; queries: the SQL prepared, to see what reached the database
function setup({ allowed = Infinity, epoch = null } = {}) {
  const queries = [], keys = [], db = emptyDb();
  if (epoch != null) db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?)").run(String(epoch));
  const env = { DB: fakeD1(db, (sql) => queries.push(sql)), CAMPAIGN_WALLET: WALLET,
    API_LIMIT: { limit: async ({ key }) => { keys.push(key); return { success: keys.length <= allowed }; } } };
  const call = (path, init = {}) => worker.fetch(new Request("https://collector" + path, init), env);
  return { call, queries, keys };
}

test("a known route answers JSON with the cache time and open CORS", async () => {
  const { call } = setup();
  const res = await call("/api/meta");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  const body = await res.json();
  assert.deepEqual([body.epoch, body.epochs, body.campaign_wallet], [null, [], WALLET]);
  assert.equal((await call("/api/status")).headers.get("cache-control"), "public, max-age=60");
  assert.equal((await call("/api/tape")).status, 200);
});

test("an unknown route is 404, a method other than GET is 405, and errors are never cached", async () => {
  const { call, keys } = setup();
  const missing = await call("/api/nothing");
  assert.deepEqual([missing.status, missing.headers.get("cache-control")], [404, "no-store"]);
  const post = await call("/api/meta", { method: "POST", body: "{}" });
  assert.deepEqual([post.status, post.headers.get("cache-control")], [405, "no-store"]);
  assert.equal(keys.length, 1);                                         // the POST did not use the limit
});

test("malformed parameters are answered with 400 before any database query", async () => {
  const { call, queries } = setup();
  for (const path of ["/api/overview?view=bad", "/api/contracts?view=epoch:", "/api/events?type=nothing",
    "/api/events?before=x1", "/api/events?before=l1;drop", "/api/export?epoch=abc", "/api/export?epoch=1&after=nope"]) {
    const res = await call(path);
    assert.equal(res.status, 400, path);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.ok((await res.json()).error, path);
  }
  assert.deepEqual(queries, []);
});

test("an epoch that is not stored is 400 once the epochs are read", async () => {
  const { call } = setup();
  const res = await call("/api/overview?view=epoch:168");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown epoch/);
});

test("the badge: a contract address gives an SVG, anything else is 404; with no data yet, 503", async () => {
  assert.equal((await setup().call("/api/badge/0x" + "ab".repeat(20) + ".svg")).status, 503);
  const { call } = setup({ epoch: 171 });
  assert.equal((await call("/api/badge/0x123.svg")).status, 404);
  const res = await call("/api/badge/0x" + "Ab".repeat(20) + ".svg");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.match(await res.text(), /^<svg /);
});

test("over the limit of one address the API answers 429 with Retry-After, keyed by the client address", async () => {
  const { call, keys } = setup({ allowed: 2 });
  const from = (ip) => ({ headers: { "cf-connecting-ip": ip } });
  assert.equal((await call("/api/meta", from("203.0.113.7"))).status, 200);
  assert.equal((await call("/api/meta", from("203.0.113.7"))).status, 200);
  const over = await call("/api/meta", from("203.0.113.7"));
  assert.deepEqual([over.status, over.headers.get("retry-after"), over.headers.get("cache-control")], [429, "60", "no-store"]);
  assert.deepEqual(keys, ["203.0.113.7", "203.0.113.7", "203.0.113.7"]);
});
