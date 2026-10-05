"""Every figure of the Findings section of the README, computed from the published data, so that none
is written by hand.

    python scripts/findings.py [--prereg-dir ../probe-exe-preregistration]

Windows V1 to V6 of Phase 1 (results/bradbury/campaign-<contract>-v<N>.jsonl), with the same valid
rows, first-attempt rule (METRICS version 5) and per-attempt committees as
scripts/network_report.py. The local module from results/local-s1.jsonl and local-s2.jsonl. The
prediction criterion as scripts/evaluate_validation.py. The sensitivity from
scripts/sensitivity_events.py.
"""

import argparse
import contextlib
import io
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from harness.stats import cp_lower, cp_upper  # noqa: E402
from scripts import sensitivity_events  # noqa: E402
from scripts.campaign_report import attempts_v5  # noqa: E402
from scripts.evaluate_validation import SHARE, pairs_for  # noqa: E402
from scripts.final_report import attempt_entries, classify_round  # noqa: E402
from scripts.network_report import DV, load, attempt_views  # noqa: E402

WINDOWS = [f"v{n}" for n in range(1, 7)]
LLM = ["wizard", "dvB", "company"]
CONTROL = "dvA"
# The five operators that voted TIMEOUT on every vote with an LLM call. Neturion Global did so from
# the second window on: its 31 votes of V1, with no TIMEOUT, are counted in its own row, not in the rest.
FIVE = {
    "0xb93a46b843fb32e8ce392e68edfe93faa4a40817": "BlackNodes",
    "0x3f5caed686336ed9cf3dede61154b0cd67fb9bd7": "Blockscope",
    "0xe8fdefdfe18fd8e5b0d576b7ccfc5a29ce43fd7f": "Brightlystake",
    "0x0c526a6af46a038e31da21c123756ab2d75f06bc": "StakingCabin",
    "0xfd811b16001077243e07173ec72a4735ff04c3aa": "Neturion Global",
}
NETURION = "0xfd811b16001077243e07173ec72a4735ff04c3aa"


def is_div(label):
    return label == "TIMEOUT" or label == DV or label.startswith("DV")


def pct(k, n):
    return f"{100 * k / n:.1f}%"


def contracts():
    print("== Contracts, V1 to V6: first attempt (METRICS version 5)")
    rates = []
    for c in LLM + [CONTROL]:
        first = n = votes = div = 0
        for w in WINDOWS:
            rows, _ = load(c, w)
            k = sum(1 for r in rows if r["outcome"] == "accepted" and not attempts_v5(r))
            first, n = first + k, n + len(rows)
            if c != CONTROL:
                rates.append(k / len(rows))
            for r in rows:
                for e in attempt_entries(r):
                    labels, _ = classify_round(e[3], e[4] if len(e) > 4 else None)
                    votes += sum(1 for x in labels if x)
                    div += sum(1 for x in labels if x and is_div(x))
        extra = f"; votes {votes:,}, TIMEOUT or DETERMINISTIC_VIOLATION {div}" if c == CONTROL else ""
        print(f"  {c:8s} {first} of {n}{extra}")
    print(f"  contracts with an LLM call, per window: {100 * min(rates):.0f}% to {100 * max(rates):.0f}%")


def local():
    ok = n = 0
    for run in ("local-s1", "local-s2"):
        for line in open(ROOT / "results" / f"{run}.jsonl", encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                n += 1
                ok += r["leader_error"] is None and sum(r["votes"]) >= 2
    print(f"\n== Local module: the committee accepted {ok} of {n} passes")


def operators():
    seats, timeouts, lead, lead_to = (defaultdict(Counter) for _ in range(4))
    for w in WINDOWS:
        for c in LLM + [CONTROL]:
            kind = "control" if c == CONTROL else "llm"
            rows, _ = load(c, w)
            for r in rows:
                for committee, leader, labels, timed_out in attempt_views(r) or []:
                    if leader and kind == "llm":
                        lead[leader.lower()][w] += 1
                        lead_to[leader.lower()][w] += timed_out
                    for a, label in zip(committee or [], labels or []):
                        if a and label:
                            seats[(a.lower(), kind)][w] += 1
                            timeouts[(a.lower(), kind)][w] += label == "TIMEOUT" if kind == "llm" else is_div(label)
    total = lambda d, key, ws=WINDOWS: sum(d[key][w] for w in ws)  # noqa: E731
    print("\n== Operators, V1 to V6: TIMEOUT with LLM | timeouts as leader | votes without LLM with TIMEOUT or DV")
    control = 0
    for a, name in FIVE.items():
        if a == NETURION:
            later = WINDOWS[1:]
            llm = (f"V1 {total(timeouts, (a, 'llm'), WINDOWS[:1])}/{total(seats, (a, 'llm'), WINDOWS[:1])}; "
                   f"V2-V6 {total(timeouts, (a, 'llm'), later)}/{total(seats, (a, 'llm'), later)}")
            led = (f"V1 {total(lead_to, a, WINDOWS[:1])}/{total(lead, a, WINDOWS[:1])}; "
                   f"V2-V6 {total(lead_to, a, later)}/{total(lead, a, later)}")
        else:
            llm = f"{total(timeouts, (a, 'llm'))}/{total(seats, (a, 'llm'))}"
            led = f"{total(lead_to, a)}/{total(lead, a)}"
        control += total(seats, (a, "control"))
        print(f"  {name:16s} {llm} | {led} | {total(timeouts, (a, 'control'))}/{total(seats, (a, 'control'))}")
    print(f"  the five without LLM: {control} votes")
    rest = [a for (a, kind) in seats if kind == "llm" and a not in FIVE]
    t, n = sum(total(timeouts, (a, "llm")) for a in rest), sum(total(seats, (a, "llm")) for a in rest)
    print(f"  the rest of the operators: {t} TIMEOUT in {n:,} votes with LLM ({pct(t, n)})")


def prediction(prereg_dir):
    pairs, pending = pairs_for(WINDOWS[1:], prereg_dir)
    if pending:
        print(f"\n== Prediction: pending {pending}")
        return
    inside, err, err_naive = 0, [], []
    for x in pairs:
        pred, rate = x["predictions"]["primary"]["firstAttempt"], x["first"] / x["n"]
        inside += cp_lower(x["first"], x["n"]) <= pred <= cp_upper(x["first"], x["n"])
        err.append(abs(pred - rate))
        err_naive.append(abs(x["naive"] - rate))
    print(f"\n== Prediction: inside the measured 95% interval in {inside} of {len(pairs)} pairs "
          f"({math.ceil(SHARE * len(pairs))} required); mean absolute error {100 * sum(err) / len(err):.1f} points "
          f"against {100 * sum(err_naive) / len(err_naive):.1f} for the naive prediction")


def sensitivity(prereg_dir):
    sensitivity_events.PREREG = prereg_dir
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        sensitivity_events.main()
    text = out.getvalue()
    agree = re.search(r"agree (\d+) of (\d+)", text)
    crit = re.search(r"sensitivity \(first attempt from events\): (\d+)/(\d+) inside .*?MAE C ([\d.]+) vs naive ([\d.]+)", text)
    changes = text.count("<-- changes")
    print(f"\n== Sensitivity: {int(agree[2]) - int(agree[1])} of {agree[2]} transactions counted differently; "
          f"pairs that change: {changes}; from events {crit[1]} of {crit[2]} inside, mean absolute error "
          f"{crit[3]} against {crit[4]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prereg-dir", default=str(ROOT.parent / "probe-exe-preregistration"))
    args = ap.parse_args()
    contracts()
    local()
    operators()
    prediction(Path(args.prereg_dir))
    sensitivity(Path(args.prereg_dir))


if __name__ == "__main__":
    main()
