// node --test pages/api-function.test.mjs
// The Pages Function in front of the API: what it caches and what reaches the collector Worker.

import assert from "node:assert/strict";
import { test } from "node:test";

const { cacheKey, onRequest } = await import("./functions/api/[[path]].js");

// a cache like caches.default, keyed by URL, and a Worker that counts what it is asked
function setup(answer = () => new Response('{"ok":true}', { status: 200, headers: { "cache-control": "public, max-age=60" } })) {
  const stored = new Map(), asked = [], pending = [];
  globalThis.caches = { default: {
    match: async (req) => stored.get(req.url)?.clone(),
    put: async (req, res) => { stored.set(req.url, res); },
  } };
  const env = { COLLECTOR: { fetch: async (req) => { asked.push(req); return answer(req); } } };
  const call = async (url, init) => {
    const res = await onRequest({ request: new Request(url, init), env, waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return res;
  };
  return { call, asked, stored };
}

test("the cache key keeps only the parameters the API reads, in a fixed order", () => {
  assert.equal(cacheKey("https://page/api/events?before=l5&x=1&view=epoch%3A168&utm=a#top"), "https://page/api/events?view=epoch%3A168&before=l5");
  assert.equal(cacheKey("https://page/api/meta?nocache=123"), "https://page/api/meta");
  // a badge address in any case is one cache entry
  assert.equal(cacheKey("https://page/api/badge/0xAbCdEf0000000000000000000000000000000001.svg?x=1"), "https://page/api/badge/0xabcdef0000000000000000000000000000000001.svg");
});

test("a response is asked to the Worker once and then served from the cache", async () => {
  const { call, asked } = setup();
  const first = await call("https://page/api/overview?view=24h", { headers: { "cf-connecting-ip": "203.0.113.7" } });
  assert.equal(await first.text(), '{"ok":true}');
  await call("https://page/api/overview?view=24h&junk=1");               // same entry: the extra parameter is dropped
  const again = await call("https://page/api/overview?view=24h");
  assert.equal(await again.text(), '{"ok":true}');
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].url, asked[0].headers.get("cf-connecting-ip")], ["https://page/api/overview?view=24h", "203.0.113.7"]);
  await call("https://page/api/overview?view=epoch:168");                // another view: another entry
  assert.equal(asked.length, 2);
});

test("errors and requests that are not GET are never stored", async () => {
  const limited = setup(() => new Response('{"error":"rate limit"}', { status: 429 }));
  assert.equal((await limited.call("https://page/api/meta")).status, 429);
  assert.equal((await limited.call("https://page/api/meta")).status, 429);
  assert.deepEqual([limited.asked.length, limited.stored.size], [2, 0]);
  const post = setup();
  await post.call("https://page/api/meta", { method: "POST" });
  assert.deepEqual([post.asked.length, post.asked[0].method, post.stored.size], [1, "POST", 0]);
});
