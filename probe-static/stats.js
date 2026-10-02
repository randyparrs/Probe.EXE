// Exact binomial (Clopper-Pearson) interval, the one used for every rate on the page. The API
// returns counts; anyone can reproduce the intervals with this function.
//   ProbeStats.clopperPearson(k, n)        -> [lower, upper] as fractions, 95% by default
//   ProbeStats.clopperPearson(40, 50)      -> [0.6628..., 0.8997...]
(() => {
  'use strict';

  // ln of the gamma function (Lanczos approximation)
  const G = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    let a = G[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += G[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  // regularized incomplete beta function I_x(a, b), by its continued fraction (Lentz)
  function betai(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x > (a + 1) / (a + b + 2)) return 1 - betai(1 - x, b, a);
    const TINY = 1e-300;
    let c = 1, d = 1 - (a + b) * x / (a + 1);
    d = 1 / (Math.abs(d) < TINY ? TINY : d);
    let h = d;
    for (let m = 1; m <= 500; m++) {
      let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
      d = 1 + num * d; d = 1 / (Math.abs(d) < TINY ? TINY : d);
      c = 1 + num / c; if (Math.abs(c) < TINY) c = TINY;
      h *= d * c;
      num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
      d = 1 + num * d; d = 1 / (Math.abs(d) < TINY ? TINY : d);
      c = 1 + num / c; if (Math.abs(c) < TINY) c = TINY;
      const step = d * c;
      h *= step;
      if (Math.abs(step - 1) < 1e-14) break;
    }
    return front * h / a;
  }

  // x with I_x(a, b) = p, by bisection
  function betaInv(p, a, b) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (betai(mid, a, b) < p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // k successes in n trials -> [lower, upper] of the Clopper-Pearson interval at the given level
  function clopperPearson(k, n, level = 0.95) {
    if (!(n > 0) || k < 0 || k > n) return [NaN, NaN];
    const alpha = 1 - level;
    return [k === 0 ? 0 : betaInv(alpha / 2, k, n - k + 1), k === n ? 1 : betaInv(1 - alpha / 2, k + 1, n - k)];
  }

  // regularized upper incomplete gamma function Q(a, x): series for small x, continued fraction otherwise
  function gammaq(a, x) {
    if (x <= 0) return 1;
    const front = Math.exp(-x + a * Math.log(x) - lgamma(a));
    if (x < a + 1) {
      let term = 1 / a, total = term;
      for (let n = 1; n <= 1000; n++) {
        term *= x / (a + n);
        total += term;
        if (Math.abs(term) < Math.abs(total) * 1e-15) break;
      }
      return 1 - total * front;
    }
    const TINY = 1e-300;
    let b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d;
    for (let i = 1; i <= 1000; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
      c = b + an / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      const step = d * c;
      h *= step;
      if (Math.abs(step - 1) < 1e-15) break;
    }
    return front * h;
  }

  // p-value of a chi-square statistic with df degrees of freedom
  const chiSquareP = (statistic, df) => (df > 0 ? gammaq(df / 2, statistic / 2) : NaN);

  // Goodness of fit of observed counts against expected ones: { statistic, df, p }
  function chiSquare(observed, expected) {
    let statistic = 0, cells = 0;
    observed.forEach((o, i) => { if (expected[i] > 0) { statistic += (o - expected[i]) ** 2 / expected[i]; cells++; } });
    return { statistic, df: cells - 1, p: chiSquareP(statistic, cells - 1) };
  }

  const api = { clopperPearson, betai, chiSquareP, chiSquare };
  if (typeof window !== 'undefined') window.ProbeStats = api;
  if (typeof globalThis !== 'undefined') globalThis.ProbeStats = api;
})();
