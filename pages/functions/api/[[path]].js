// Serves /api/* from the page's own origin: answers from the cache of the data center when it has
// the response, and otherwise forwards the request to the collector Worker through a service
// binding (the Worker has no public address). The Worker says how long each response may be kept
// (Cache-Control: 60 s for the tape and the current state, 300 s for the aggregates).

// the query parameters the API reads: anything else is dropped, so it cannot multiply cache entries
const PARAMS = ["view", "type", "before", "epoch", "after"];

export function cacheKey(requestUrl) {
  const url = new URL(requestUrl);
  const kept = PARAMS.filter((name) => url.searchParams.has(name)).map((name) => [name, url.searchParams.get(name)]);
  url.search = new URLSearchParams(kept).toString();
  url.hash = "";
  // a badge address in any case is the same badge
  if (/^\/api\/badge\//i.test(url.pathname)) url.pathname = url.pathname.toLowerCase();
  return url.toString();
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") return env.COLLECTOR.fetch(request);
  const key = new Request(cacheKey(request.url), { method: "GET" });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  // the client address goes along: the Worker limits the requests of one address that miss the cache
  const response = await env.COLLECTOR.fetch(new Request(key, { headers: request.headers }));
  if (response.ok) context.waitUntil(cache.put(key, response.clone()));
  return response;
}
