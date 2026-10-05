import assert from "node:assert/strict";
import { test } from "node:test";
import { SCHEDULE_SINCE, dailySlot, decide, lateOf, offsetOf, windowsOf } from "./schedule.js";

const at = (iso) => Date.parse(iso) / 1000;
const H = 3600;

// Epochs 167 to 172 as the chain started them (EpochAdvance); 167 lasted 28 h 3 min. The end of 172
// is assumed to be 24 h 2 min after its start, like the others.
const STARTS = { 167: 1790776071, 168: 1790877093, 169: 1790963614, 170: 1791050135, 171: 1791136656, 172: 1791223176, 173: 1791223176 + 86402 };
const epochAt = (t) => Object.keys(STARTS).map(Number).filter((e) => STARTS[e] <= t).at(-1);

// Every dispatch of the external cron from the start of 167 to the end of 172, applied to the rule:
// the campaigns it starts, one minute after the dispatch, per epoch.
function simulate(minute, { skip = () => false, unknown = () => false } = {}) {
  const ran = {};
  for (let t = at("2026-09-30T13:00:00Z") + minute * 60; t < STARTS[173]; t += 3 * H) {
    const epoch = epochAt(t);
    if (epoch == null || skip(t)) continue;
    const d = decide({ epoch, start: STARTS[epoch], now: t, campaigns: unknown(t) ? null : (ran[epoch] ?? []).map((c) => c.started) });
    if (d.run) (ran[epoch] ??= []).push({ started: t + 60, late: d.late });
  }
  return ran;
}
const hours = (ran) => Object.fromEntries(Object.entries(ran).map(([e, cs]) => [e, cs.map((c) => new Date(c.started * 1000).toISOString().slice(5, 16) + (c.late ? " late" : ""))]));

test("the real epochs 167 to 172: one campaign each, at a different hour of its epoch", () => {
  // the cron of the campaigns so far: 01:00, 04:00 ... 22:00 UTC
  assert.deepEqual(hours(simulate(0)), {
    167: ["10-01T13:01"],   // 167 mod 8 = 7: 21 h after 2026-09-30 13:47
    168: ["10-01T19:01"],   // 0 h after 2026-10-01 17:51
    169: ["10-02T22:01"],   // 3 h after 17:53
    170: ["10-04T01:01"],   // 6 h after 17:55
    171: ["10-05T04:01"],   // 9 h after 17:57
    172: ["10-06T07:01"],   // 12 h after 17:59
  });
  // any minute of the cron gives one campaign per epoch
  for (const minute of [0, 17, 59, 90, 179]) {
    const ran = simulate(minute);
    for (let e = 167; e <= 172; e++) assert.equal(ran[e]?.length, 1, `epoch ${e}, cron minute ${minute}`);
    for (const [e, cs] of Object.entries(ran)) {
      const w = windowsOf(+e, STARTS[e], cs[0].started)[0];
      assert.ok(cs[0].started >= w.start && cs[0].started < w.end + 60 && !cs[0].late);
    }
  }
});

test("a missed window is made up at the next dispatch, late; unknown campaigns run only inside a window", () => {
  // the dispatch of 2026-10-02 22:00 fails: 169 runs at 01:00, late
  const ran = simulate(0, { skip: (t) => t === at("2026-10-02T22:00:00Z") });
  assert.deepEqual(hours(ran)[169], ["10-03T01:01 late"]);
  // while the campaigns of the epoch cannot be read, a window gets its campaign once more at most
  const all = simulate(0, { unknown: () => true });
  for (let e = 167; e <= 172; e++) assert.equal(all[e].length, 1);
  const missed = simulate(0, { skip: (t) => t === at("2026-10-02T22:00:00Z"), unknown: () => true });
  assert.equal(missed[169], undefined);
});

test("an epoch longer than a day gets a further window every 24 hours, once it has lasted 25 hours", () => {
  // 167 (offset 21 h) lasted 28 h 3 min: its second window would open at 45 h
  assert.equal(windowsOf(167, STARTS[167], STARTS[168]).length, 1);
  // offset 6 h: the second window opens at 30 h
  assert.deepEqual(windowsOf(170, 0, 31 * H), [{ start: 6 * H, end: 9 * H }, { start: 30 * H, end: 33 * H }]);
  // offset 0: no window at 24 h (the epoch usually ends 2 minutes later); the next one at 48 h
  assert.deepEqual(windowsOf(168, 0, 47 * H).map((w) => w.start), [0]);
  assert.deepEqual(windowsOf(168, 0, 48 * H).map((w) => w.start), [0, 48 * H]);
  // one campaign already in the epoch: the second window asks for one more
  assert.equal(decide({ epoch: 170, start: 0, now: 30 * H + 60, campaigns: [6 * H + 60] }).run, true);
  assert.equal(decide({ epoch: 170, start: 0, now: 30 * H + 60, campaigns: [6 * H + 60, 30 * H] }).run, false);
});

test("before its window an epoch waits; a campaign run earlier by hand counts for it", () => {
  const d = decide({ epoch: 173, start: STARTS[173], now: STARTS[173] + H, campaigns: [] });
  assert.deepEqual([d.run, d.window.start - STARTS[173]], [false, offsetOf(173)]);
  assert.equal(offsetOf(173), 15 * H);
  assert.equal(decide({ epoch: 173, start: STARTS[173], now: STARTS[173] + 15 * H + 60, campaigns: [STARTS[173] + 2 * H] }).run, false);
});

test("late campaigns: the n-th campaign of an epoch against its n-th window; none before 2026-10-06", () => {
  const s = SCHEDULE_SINCE + 18 * H;   // an epoch of 2026-10-06, 18:00 UTC; offset of 173: 15 h
  assert.deepEqual(lateOf(173, s, [s + 15 * H + 60]), [false]);
  assert.deepEqual(lateOf(173, s, [s + 18 * H + 60]), [true]);
  assert.deepEqual(lateOf(173, s, [s + H, s + 18 * H]), [false, false]);   // the second came before a second window
  assert.deepEqual(lateOf(169, STARTS[169], [STARTS[169] + 23 * H]), [false]);
  assert.deepEqual(lateOf(173, null, [s]), [false]);
});

test("the daily bucket used before 2026-10-06", () => {
  // 2026-10-01 is day 274 of the year: 274 mod 8 = 2, the bucket from 06:00 to 09:00 UTC
  assert.deepEqual(dailySlot(at("2026-10-01T15:00:00Z")), { start: at("2026-10-01T06:00:00Z"), end: at("2026-10-01T09:00:00Z") });
  assert.deepEqual(dailySlot(at("2026-10-02T00:30:00Z")), { start: at("2026-10-02T09:00:00Z"), end: at("2026-10-02T12:00:00Z") });
  // the bucket of 2026-10-04 (day 277, 15:00 to 18:00) opened in epoch 170, which got its campaign at
  // 16:01; the one of 2026-10-05 (day 278, 18:00 to 21:00) opened after epoch 172 started: 171 had none
  assert.ok(dailySlot(at("2026-10-04T12:00:00Z")).start < STARTS[171] && dailySlot(at("2026-10-05T12:00:00Z")).start > STARTS[172]);
});
