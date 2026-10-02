"""Local module (a) report, FASE1-DISENO.md section 4.3 and decision 11.9.

    py -3.12 scripts/local_report.py [--runs local-s1,local-s2]

Per scenario and contract, from results/<run>.jsonl (tests/test_local_module.py):
- committee acceptance: the leader returns and at least 2 of the 4 validators agree (with the
  leader, 3 of 5: METRICAS.md v2); this is also the "local only" first-attempt prediction
  (tertiary reference, decision 11.9), written to results/local-summary.json;
- validator votes by class: agree, content, format, provider_error, judge_without_result,
  other_error; leader errors by class; the same per model;
- latency per call (model and call kind) and per seat (sum of the seat's calls): percentiles and
  share above 30, 60 and 120 s (the real GenVM time limit on Bradbury is not known);
- exec_prompt cap: calls whose answer used more than 1000 completion tokens (they would be cut
  where a node runs a GenVM with the 1000-token cap; runs use 8000);
- spend (OpenRouter usage.cost) against the 5 USD cap.
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from harness.stats import fmt_rate  # noqa: E402

RESULTS = ROOT / "results"
CLASSES = ("agree", "content", "format", "provider_error", "judge_without_result", "other_error")
THRESHOLDS = (30, 60, 120)
CAP = 1000
BUDGET_USD = 5.0


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, int(round(q * len(xs))) - 1))]


def lat_line(xs):
    if not xs:
        return "-"
    over = "  ".join(f">{t}s {sum(x > t for x in xs)}/{len(xs)}" for t in THRESHOLDS)
    return (f"p10 {pct(xs, .1):.1f}  p50 {pct(xs, .5):.1f}  p90 {pct(xs, .9):.1f}  p99 {pct(xs, .99):.1f}  "
            f"max {max(xs):.1f} s (n={len(xs)})  {over}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default="local-s1,local-s2")
    args = ap.parse_args()
    summary, total_cost = {}, 0.0
    for run in args.runs.split(","):
        f = RESULTS / f"{run}.jsonl"
        if not f.exists():
            print(f"\n== {run}: no rows")
            continue
        rows = [json.loads(line) for line in open(f, encoding="utf-8") if line.strip()]
        cost = sum(r.get("costUSD") or 0.0 for r in rows)
        total_cost += cost
        print(f"\n==== {run} (scenario {rows[0]['scenario']}): {len(rows)} passes, spend {cost:.4f} USD")
        for contract in sorted({r["contract"] for r in rows}):
            mine = [r for r in rows if r["contract"] == contract]
            n = len(mine)
            ok = sum(1 for r in mine if r["leader_error"] is None and sum(r["votes"]) >= 2)
            summary.setdefault(run, {})[contract] = {"passes": n, "committeeAccepts": ok,
                                                     "firstAttempt": ok / n if n else None}
            print(f"\n== {contract}: {n} passes")
            print(f"  committee accepts (leader returns, >= 2 of 4 validators agree): {fmt_rate(ok, n)}")
            lead = Counter(r["leader_class"] for r in mine if r["leader_class"])
            print(f"  leader errors: {fmt_rate(sum(lead.values()), n)} {dict(lead)}")
            votes = [x for r in mine for x in r["vote_classes"]]
            for cl in CLASSES:
                k = votes.count(cl)
                if k or cl in ("agree", "content", "format", "provider_error"):
                    print(f"  validator {cl:21s} {fmt_rate(k, len(votes))}")
            by_model = defaultdict(Counter)
            lead_model = defaultdict(Counter)
            for r in mine:
                lead_model[r["seats"]["leader"]]["passes"] += 1
                if r["leader_class"]:
                    lead_model[r["seats"]["leader"]][r["leader_class"]] += 1
                for seat, cl in zip([f"validator-{i}" for i in range(1, 5)], r["vote_classes"]):
                    by_model[r["seats"][seat]][cl] += 1
            if len(by_model) > 1 or len(lead_model) > 1:
                print("  per model (validator votes | leader errors of passes led):")
                for m in sorted(set(by_model) | set(lead_model)):
                    v = by_model[m]
                    tot = sum(v.values())
                    parts = "  ".join(f"{cl} {v[cl]}" for cl in CLASSES if v[cl])
                    le = {k: x for k, x in lead_model[m].items() if k != "passes"}
                    print(f"    {m:9s} votes {tot:3d}: {parts} | led {lead_model[m]['passes']}, errors {le}")
            calls = [c for r in mine for c in r["calls"]]
            lat = defaultdict(list)
            for c in calls:
                if c.get("seconds") is not None:
                    lat[(c["model"].split("/")[-1], c["kind"])].append(c["seconds"])
            print("  latency per call:")
            for (m, kind), xs in sorted(lat.items()):
                print(f"    {m:28s} {kind:26s} {lat_line(xs)}")
            seat = []
            for r in mine:
                per = defaultdict(float)
                for c in r["calls"]:
                    per[c["phase"]] += c.get("seconds") or 0.0
                seat.extend(per.values())
            print(f"  latency per seat (sum of its calls): {lat_line(seat)}")
            capped = [c for c in calls if c["kind"] == "ExecPrompt" and (c.get("completion_tokens") or 0) > CAP]
            passes_hit = {(r["contract"], r["pass"]) for r in mine for c in r["calls"]
                          if c["kind"] == "ExecPrompt" and (c.get("completion_tokens") or 0) > CAP}
            print(f"  exec_prompt answers above {CAP} completion tokens: {len(capped)} of "
                  f"{sum(c['kind'] == 'ExecPrompt' for c in calls)} calls, in {len(passes_hit)} passes "
                  f"(cut under a {CAP}-token cap; results here use 8000)")
    print(f"\n== spend: {total_cost:.4f} USD of {BUDGET_USD} USD")
    out = RESULTS / "local-summary.json"
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"(written {out})")


if __name__ == "__main__":
    main()
