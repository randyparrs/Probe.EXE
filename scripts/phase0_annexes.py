"""The two annexes of Phase 0, produced from the published rows of its campaigns.

    python scripts/phase0_annexes.py v5      > results/bradbury/annex-phase0-v5.txt
    python scripts/phase0_annexes.py reread  > results/bradbury/annex-reread-v4.txt

v5: first-attempt acceptance of every Phase 0 campaign with the rule of version 4 and with the rule
of version 5 (docs/METRICS.md), and the rows that change. Phase 0 is not rewritten: this is the
reference for comparing it with Phase 1.

reread: the report of version 4 (scripts/final_report.py) on the campaigns that ran before version 4
was fixed: campaign 1, campaign 2 and the DETERMINISTIC_VIOLATION experiment (dv1). An analysis made
after seeing the data.

Rows: results/bradbury/campaign-<contract>.jsonl (campaign 1, 5 s polling),
campaign-<contract>-r2.jsonl (campaign 2), -dv1.jsonl and -final.jsonl (1 s polling).
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from harness.stats import fmt_rate  # noqa: E402
from scripts import final_report  # noqa: E402
from scripts.campaign_report import attempts, attempts_v5, valid_rows  # noqa: E402

OUT = ROOT / "results" / "bradbury"
CAMPAIGNS = [
    ("campaign 1 (5 s polling)", "", ["wizard", "company", "tribunal"]),
    ("campaign 2 (1 s polling)", "r2", ["tribunal"]),
    ("DV experiment (1 s polling)", "dv1", ["dvA", "dvB", "dvC"]),
    ("final campaign v4 (1 s polling)", "final", ["wizard", "company", "dvA"]),
]
REREAD = [
    ("CAMPAIGN 1 (5 s polling)", "", ["wizard", "company", "tribunal"]),
    ("CAMPAIGN 2 (tribunal, 1 s polling)", "r2", ["tribunal"]),
    ("DV1 (1 s polling, with hashes)", "dv1", ["dvA", "dvB", "dvC"]),
]


def load(name, tag):
    f = OUT / (f"campaign-{name}-{tag}.jsonl" if tag else f"campaign-{name}.jsonl")
    return [json.loads(line) for line in open(f, encoding="utf-8") if line.strip()]


def annex_v5():
    print("Annex: Phase 0 re-read with METRICS version 5 (first attempt), without rewriting Phase 0.")
    print("v4 = ACCEPTED with no retries according to attempts(); v5 = also with no LEADER_TIMEOUT or VALIDATORS_TIMEOUT")
    print("in the timeline. Valid rows as in Phase 0 (valid_rows).")
    print()
    for title, tag, names in CAMPAIGNS:
        print(f"== {title}")
        for name in names:
            rows, _ = valid_rows(load(name, tag))
            accepted = [r for r in rows if r["outcome"] == "accepted"]
            v4 = [r for r in accepted if not attempts(r)]
            v5 = [r for r in accepted if not attempts_v5(r)]
            changed = [r["index"] for r in v4 if attempts_v5(r)]
            print(f"  {name:9s} v4 {fmt_rate(len(v4), len(rows))}")
            print(f"            v5 {fmt_rate(len(v5), len(rows))}  changed: {changed if changed else 'none'}")


def annex_reread():
    print("ANNEX: v4 re-read of campaigns 1, 2 and dv1. Analysis made AFTER seeing the data "
          "(docs/METRICS.md version 4, 'Earlier data').")
    print("Campaigns 1 and 2: no hashes in failed rounds; '(pattern)' = DV type inferred from the vote pattern only. "
          "The deciding round uses the hashes of decisiveVotes.")
    for title, tag, names in REREAD:
        print(f"\n######## {title}")
        sys.argv = ["final_report.py", "--tag", tag, *names]
        final_report.main()


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which == "v5":
        annex_v5()
    elif which == "reread":
        annex_reread()
    else:
        sys.exit("usage: python scripts/phase0_annexes.py v5|reread")
