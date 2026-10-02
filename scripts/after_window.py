"""Steps after a validation window, up to (not including) the pre-registration commit.

    python scripts/after_window.py --fit v1,v2 --next v3

--fit: every window measured so far, in order; the last one is the window that just finished (its
operator health predicts --next; the naive prediction is the mean of all of them).
Steps (reads and computations only, no GEN spent):
 1. checks that the finished window has 50 rows per contract;
 2. re-reads execution results (bradbury_campaign.mjs recheck-execution);
 3. network report of the finished window (results/bradbury/network-report-<w>.txt);
 4. checks that the model code is the frozen version in the pre-registration repository (model/);
 5. fresh network snapshot (campaign prereg-<next>, label prereg);
 6. prediction of --next (results/prereg/window-<next>.json) and copy to the repository;
 7. evaluation so far (scripts/evaluate_validation.py).
The commit and the push of the pre-registered file are made separately, before the next window runs.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PREREG = ROOT.parent / "probe-exe-preregistration"
OUT = ROOT / "results" / "bradbury"
CONTRACTS = ("wizard", "company", "dvB", "dvA")
MODEL_FILES = ("scripts/predict_model.py", "scripts/network_report.py", "scripts/campaign_report.py",
               "scripts/final_report.py", "harness/stats.py")
PY = [sys.executable]


def run(cmd, env=None, out=None):
    print(f"\n$ {' '.join(cmd)}")
    res = subprocess.run(cmd, cwd=ROOT, env={**os.environ, **(env or {})}, capture_output=True, text=True,
                         encoding="utf-8")
    text = "\n".join(l for l in res.stdout.splitlines() if not l.startswith("INFO"))
    if out:
        Path(out).write_text(text + "\n", encoding="utf-8")
        print(f"(written {out})")
    else:
        print(text)
    if res.returncode != 0:
        sys.exit(f"step failed ({res.returncode}): {res.stderr[-800:]}")
    return text


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


LOCAL_CODE = ("tests/test_local_module.py", "harness/genvm_llm.py", "harness/contracts.py", "scripts/local_report.py",
              "reference/genvm/genvm-module-llm.yaml", "contracts/bradbury/wizard_of_coin.py",
              "contracts/bradbury/company_naming.py", "contracts/dv/dv_b_word.py")
LOCAL_RUNS = {"s1": "local-s1", "s2": "local-s2"}


def add_local(path):
    """Tertiary reference (decision 11.9): committee acceptance of the local module per scenario."""
    run([*PY, "scripts/local_report.py", "--runs", ",".join(LOCAL_RUNS.values())],
        out=ROOT / "results" / "local-report.txt")
    summary = json.load(open(ROOT / "results" / "local-summary.json", encoding="utf-8"))
    doc = json.load(open(path, encoding="utf-8"))
    for c in doc["predictions"]:
        for sc, r in LOCAL_RUNS.items():
            v = summary.get(r, {}).get(c)
            if not v or v["passes"] < 50:
                sys.exit(f"local run {r} has {v and v['passes']} passes of {c}; needs 50")
            doc["predictions"][c][f"tertiaryLocalOnly{sc.upper()}"] = {
                "firstAttempt": round(v["firstAttempt"], 4), "passes": v["passes"]}
    doc["tertiaryLocalOnly"] = {
        "note": ("reference only, not judged: committee acceptance of the local module (leader returns "
                 "and >= 2 of 4 validators agree), no network effects; S1 every seat Llama 3.3 70B, "
                 "S2 each seat 25% Llama 3.3 70B / DeepSeek V4 Flash / Gemma 4 31B / Qwen3 235B A22B 2507, "
                 "fixed provider per model, 50 passes per contract and scenario"),
        "sha256": {"code": {f: sha(ROOT / f) for f in LOCAL_CODE},
                   "data": {f"results/{r}.jsonl": sha(ROOT / "results" / f"{r}.jsonl") for r in LOCAL_RUNS.values()}},
    }
    Path(path).write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"local-only tertiary prediction added to {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fit", required=True)
    ap.add_argument("--next", required=True)
    ap.add_argument("--local", action="store_true", help="add the local-only tertiary prediction")
    args = ap.parse_args()
    fit = args.fit.split(",")
    done = fit[-1]

    for c in CONTRACTS:
        f = OUT / f"campaign-{c}-{done}.jsonl"
        n = sum(1 for l in open(f, encoding="utf-8") if l.strip()) if f.exists() else 0
        if n < 50:
            sys.exit(f"{done}: {c} has {n} of 50 rows; the window has not finished")
    print(f"{done}: 50 rows per contract")

    run(["node", "scripts/bradbury_campaign.mjs", "recheck-execution", done])
    run(PY + ["scripts/network_report.py", "--tag", done, "--llm", "wizard,company,dvB", "--control", "dvA"],
        out=OUT / f"network-report-{done}.txt")

    changed = [f for f in MODEL_FILES if sha(ROOT / f) != sha(PREREG / "model" / f)]
    if changed:
        sys.exit(f"model code differs from the frozen version in {PREREG / 'model'}: {changed}. "
                 "A model change needs a new version with its reason (decision 11.8); stopping.")
    print("model code = frozen version in the pre-registration repository")

    run(["node", "scripts/bradbury_campaign.mjs", "network-snapshot", "prereg"],
        env={"CAMPAIGN_TAG": f"prereg-{args.next}"})
    run(PY + ["scripts/predict_model.py", "--fit", args.fit, "--prereg", args.next,
              "--snapshot-campaign", f"prereg-{args.next}", "--snapshot-label", "prereg"])
    src = ROOT / "results" / "prereg" / f"window-{args.next}.json"
    if args.local:
        add_local(src)
    dst = PREREG / f"window-{args.next}.json"
    if dst.exists():
        sys.exit(f"{dst} already exists: a pre-registered file is never overwritten")
    shutil.copyfile(src, dst)
    doc = json.load(open(dst, encoding="utf-8"))
    bad = [f for f, h in doc["sha256"]["code"].items() if h != sha(PREREG / "model" / f)]
    if bad:
        sys.exit(f"code hashes in {dst.name} do not match model/: {bad}")
    print(f"copied to {dst}; code hashes match model/")

    run(PY + ["scripts/evaluate_validation.py", "--windows", ",".join(w for w in fit if w != "v1")])
    print(f"\nready: commit and push {dst.name} in {PREREG}, then run {args.next}")


if __name__ == "__main__":
    main()
