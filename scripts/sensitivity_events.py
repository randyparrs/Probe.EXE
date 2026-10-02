"""Sensitivity of the Phase 1 validation to counting by consensus events instead of polling.

    python scripts/sensitivity_events.py

The validation (METRICS v5, polling every 1 s, 45 min watch limit) is not rewritten. Input:
results/bradbury/sensitivity-events-tx.json, one record per row of windows v2 to v6 with its state
according to the consensus events (read-only eth_getLogs, collector core of the Probe.EXE repository),
and, for the rows the events leave unresolved, the final state read from the chain (getTransaction).

Rule by events: TransactionAccepted marks the end of a round, not consensus (it is also emitted on a
validators timeout); the round is a real acceptance only when the last revealed vote reports AGREE.
First attempt = real acceptance after one proposal and no leader timeout, rotation, appeal,
recomputation or validators-timeout round. The final decision counts.

Reports: (1) what the chain did with the rows the launcher gave up on at its 45 min limit; (2) every
row where polling and events differ; (3) the criterion with first attempts counted by events.
"""

import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from harness.stats import cp_lower, cp_upper  # noqa: E402
from scripts.campaign_report import attempts_v5  # noqa: E402
from scripts.network_report import load  # noqa: E402

OUT = ROOT / "results" / "bradbury"
PREREG = ROOT.parent / "probe-exe-preregistration"
WINDOWS = ["v2", "v3", "v4", "v5", "v6"]
CONTRACTS = ["wizard", "company", "dvB"]


def by_events(t):
    """first / retry / none for one transaction, from the events and, if unresolved, the chain."""
    if t["v6"] in ("first", "retry", "none"):
        return t["v6"]
    ch = t.get("chain") or {}
    if ch.get("result") in ("AGREE", "MAJORITY_AGREE") and ch.get("status") in ("ACCEPTED", "FINALIZED", "READY_TO_FINALIZE"):
        clean = t["proposals"] == 1 and not (t["leaderTimeouts"] or t["rotations"] or t["appeals"] or t["validatorsTimeouts"])
        return "first" if clean else "retry"
    return "none"


def main():
    recs = {(t["window"], t["contract"], t["index"]): t for t in json.load(open(OUT / "sensitivity-events-tx.json", encoding="utf-8"))}
    rows_all = {}
    for w in WINDOWS:
        for c in CONTRACTS:
            rows_all[(w, c)] = load(c, w)[0]

    print("== 1. Rows that polling cut at its 45 min limit (no_consensus_watch_limit), V2 to V6")
    lim = [(w, c, r) for (w, c), rows in rows_all.items() for r in rows if r["outcome"] == "no_consensus_watch_limit"]
    cnt = Counter()
    for w, c, r in lim:
        t = recs[(w, c, r["index"])]
        e = by_events(t)
        cnt[e] += 1
        print(f"  {w} {c:8s} #{r['index']:2d} polling: {r['finalStatus']:18s} -> events/chain: {e:5s} "
              f"(events: {t['v6']}; chain: {(t.get('chain') or {}).get('status')}/{(t.get('chain') or {}).get('result')})")
    print(f"  total {len(lim)}: " + ", ".join(f"{k} {v}" for k, v in sorted(cnt.items())))

    print("\n== 2. Rows where polling (v5) and events differ, V2 to V6")
    diff = Counter()
    for (w, c), rows in rows_all.items():
        for r in rows:
            v5 = "none" if r["outcome"] != "accepted" else ("retry" if attempts_v5(r) else "first")
            e = by_events(recs[(w, c, r["index"])])
            if v5 != e:
                diff[(v5, e)] += 1
                t = recs[(w, c, r["index"])]
                print(f"  {w} {c:8s} #{r['index']:2d} v5 {v5:5s} -> events {e:5s} (proposals {t['proposals']}, leader timeouts {t['leaderTimeouts']}, "
                      f"rotations {t['rotations']}, appeals {t['appeals']}, validators timeouts {t['validatorsTimeouts']})")
    n = sum(len(v) for v in rows_all.values())
    print(f"  agree {n - sum(diff.values())} of {n}; differences: " + ", ".join(f"{a}->{b} {v}" for (a, b), v in sorted(diff.items())))

    print("\n== 3. Criterion with the first attempt counted from events (same n, same pre-registered predictions)")
    inside = {"v5": 0, "ev": 0}
    err = defaultdict(list)
    for w in WINDOWS:
        doc = json.load(open(PREREG / f"window-{w}.json", encoding="utf-8"))
        for c in CONTRACTS:
            rows = rows_all[(w, c)]
            n = len(rows)
            x5 = sum(1 for r in rows if r["outcome"] == "accepted" and not attempts_v5(r))
            xe = sum(1 for r in rows if by_events(recs[(w, c, r["index"])]) == "first")
            pred = doc["predictions"][c]["primary"]["firstAttempt"]
            naive = doc["predictions"][c]["naiveFirstAttempt"]
            res = {}
            for key, k in (("v5", x5), ("ev", xe)):
                res[key] = cp_lower(k, n) <= pred <= cp_upper(k, n)
                inside[key] += res[key]
                err[key].append(abs(pred - k / n))
                err["naive_" + key].append(abs(naive - k / n))
            mark = "  <-- changes" if res["v5"] != res["ev"] else ""
            print((f"  {w} {c:8s} C {100 * pred:5.1f} | v5 {x5}/{n} = {100 * x5 / n:5.1f} % {'inside ' if res['v5'] else 'OUTSIDE'} | "
                   f"events {xe}/{n} = {100 * xe / n:5.1f} % {'inside ' if res['ev'] else 'OUTSIDE'}{mark}").rstrip())
    need = math.ceil(0.8 * len(err["v5"]))
    for key, label in (("v5", "validation (v5, polling)"), ("ev", "sensitivity (first attempt from events)")):
        mae = sum(err[key]) / len(err[key])
        mn = sum(err["naive_" + key]) / len(err[key])
        ok = inside[key] >= need and mae < mn
        print(f"  {label}: {inside[key]}/{len(err[key])} inside  (needs {need}); MAE C {100 * mae:.1f} vs naive {100 * mn:.1f} -> "
              f"{'passes' if ok else 'does NOT pass'}")
    print("  (the naive prediction is the pre-registered one, v5 average of the previous windows; it is not recomputed)")


if __name__ == "__main__":
    main()
