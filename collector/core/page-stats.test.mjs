// node --test collector/core/page-stats.test.mjs
// The Clopper-Pearson function of the page against intervals published in the validation report
// (docs/VALIDATION-REPORT.md, computed there with harness/stats.py).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "probe-static", "stats.js"), "utf8"), ctx);
const { clopperPearson, chiSquareP, chiSquare } = ctx.ProbeStats;
const pct = ([lo, hi]) => `${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}`;

test("intervals of the 15 validation pairs", () => {
  const pairs = [[40, 50, "66.3-90.0"], [26, 50, "37.4-66.3"], [41, 50, "68.6-91.4"], [33, 50, "51.2-78.8"], [10, 45, "11.2-37.1"],
    [45, 50, "78.2-96.7"], [36, 50, "57.5-83.8"], [13, 39, "19.1-50.2"], [37, 50, "59.7-85.4"], [10, 44, "11.5-37.8"],
    [43, 50, "73.3-94.2"], [31, 50, "47.2-75.3"], [42, 50, "70.9-92.8"]];
  for (const [k, n, expected] of pairs) assert.equal(pct(clopperPearson(k, n)), expected, `${k}/${n}`);
});

test("chi-square p-values at the usual critical values", () => {
  // 5% critical values of the chi-square distribution
  for (const [df, critical] of [[1, 3.841], [2, 5.991], [5, 11.070], [14, 23.685], [26, 38.885]]) {
    assert.equal(chiSquareP(critical, df).toFixed(3), "0.050", `df ${df}`);
  }
  assert.equal(chiSquareP(0, 5), 1);
  assert.equal(chiSquareP(2, 2).toFixed(4), Math.exp(-1).toFixed(4));   // with 2 degrees of freedom p = exp(-x / 2)
  const fit = chiSquare([10, 20, 30], [20, 20, 20]);
  assert.deepEqual([fit.statistic, fit.df, fit.p.toFixed(4)], [10, 2, Math.exp(-5).toFixed(4)]);
  assert.equal(chiSquare([5, 5, 0], [5, 5, 0]).df, 1);                    // a cell with nothing expected is left out
});

test("edges and larger samples", () => {
  assert.equal(pct(clopperPearson(0, 250)), "0.0-1.5");      // 0 of 250 votes of the control
  assert.equal(pct(clopperPearson(50, 50)), "92.9-100.0");
  assert.equal(pct(clopperPearson(313, 400)), "73.9-82.2");  // the example of the page inventory
  const [lo, hi] = clopperPearson(2184, 2617);
  assert.ok(lo < 2184 / 2617 && 2184 / 2617 < hi && hi - lo < 0.04);
  assert.ok(Number.isNaN(clopperPearson(1, 0)[0]));
});
