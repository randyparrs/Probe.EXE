"""Checks every SHA-256 of the pre-registration files against the published data and code.

    python scripts/verify_preregistration.py [--prereg-dir DIR] [--offline]

DIR is a clone of https://github.com/randyparrs/probe-exe-preregistration (default: a folder with
that name next to this repository).

For each window-<w>.json in the pre-registration repository: fit data files and local data (paths
relative to this project), model code (the repository's model/ folder), local-module code, and the
network snapshot row (canonical JSON of the row in results/bradbury/network-snapshots.jsonl).
Data files are append-only: when a whole file does not match, the script also checks whether the
pre-registered hash is that of a leading block of lines, and says how many lines and what follows.

Two files of the local-module code are not redistributed as they were pre-registered
(contracts/SOURCES.md):
- reference/genvm/genvm-module-llm.yaml belongs to genlayerlabs/genvm (Business Source License 1.1)
  and is not copied here. It is checked when it has been saved at that path.
- harness/contracts.py is published with four lines of a repository with no license replaced by
  markers. harness/restore_contracts.py puts them back from the original and checks the hash.
The script fetches both originals at their exact commits and checks them without writing anything.
With --offline it does not use the network and reports those two as not checked.
"""

import argparse
import hashlib
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GENVM_YAML = "reference/genvm/genvm-module-llm.yaml"
GENVM_YAML_URL = ("https://raw.githubusercontent.com/genlayerlabs/genvm/abb71bf891695b737e6a4f5211f4740a3b25543d/"
                  "modules/install/config/genvm-module-llm.yaml")
HARNESS_CONTRACTS = "harness/contracts.py"
MARKER = b"restored by harness/restore_contracts.py"


def sha(b):
    return hashlib.sha256(b).hexdigest()


def prefix_match(path, want):
    lines = path.read_bytes().split(b"\n")
    for n in range(1, len(lines)):
        if sha(b"\n".join(lines[:n]) + b"\n") == want:
            return n, len([x for x in lines if x])
    return None


def not_redistributed(f, path, want, download):
    """True, False or None (not checked) for the two files that are not published as pre-registered."""
    if f == GENVM_YAML and not path.exists():
        if not download:
            return None
        with urllib.request.urlopen(GENVM_YAML_URL, timeout=60) as res:
            return sha(res.read()) == want
    if f == HARNESS_CONTRACTS and path.exists() and MARKER in path.read_bytes():
        if not download:
            return None
        # restore_contracts.py restores the file in memory and exits with an error unless the result
        # has the pre-registered SHA-256, which it carries as a constant: check that it is this one
        script = ROOT / "harness" / "restore_contracts.py"
        if want not in script.read_text(encoding="utf-8"):
            return False
        return subprocess.run([sys.executable, str(script)], capture_output=True).returncode == 0
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prereg-dir", default=str(ROOT.parent / "probe-exe-preregistration"))
    ap.add_argument("--offline", action="store_true",
                    help="do not fetch the two originals that are not redistributed: report them as not checked")
    args = ap.parse_args()
    repo = Path(args.prereg_dir)
    snaps = [json.loads(line) for line in open(ROOT / "results" / "bradbury" / "network-snapshots.jsonl", encoding="utf-8")]
    ok, notes, pending, bad = 0, [], [], []
    for pf in sorted(repo.glob("window-*.json")):
        d = json.load(open(pf, encoding="utf-8"))
        w = d["window"]
        groups = [("fit data", d["sha256"]["fitData"], ROOT), ("model code", d["sha256"]["code"], repo / "model")]
        if "tertiaryLocalOnly" in d:
            groups += [("local code", d["tertiaryLocalOnly"]["sha256"]["code"], ROOT),
                       ("local data", d["tertiaryLocalOnly"]["sha256"]["data"], ROOT)]
        for name, hashes, base in groups:
            for f, want in hashes.items():
                path = base / f
                if path.exists() and sha(path.read_bytes()) == want:
                    ok += 1
                    continue
                other = not_redistributed(f, path, want, not args.offline) if base == ROOT else False
                if other:
                    ok += 1
                elif other is None:
                    pending.append(f"{w} {name}: {f} is not redistributed as pre-registered (checked without --offline)")
                elif not path.exists():
                    bad.append(f"{w} {name}: {f} missing")
                else:
                    pm = prefix_match(path, want) if name.endswith("data") else None
                    if pm:
                        notes.append(f"{w} {name}: {f} matches its first {pm[0]} lines of {pm[1]} "
                                     "(lines appended after the pre-registration)")
                    else:
                        bad.append(f"{w} {name}: {f} does not match")
        ns = d["networkSnapshot"]
        rows = [s for s in snaps if s.get("campaign") == ns["campaign"] and s["label"] == ns["label"]]
        if rows and sha(json.dumps(rows[-1], sort_keys=True, separators=(",", ":")).encode()) == ns["sha256"]:
            ok += 1
        else:
            bad.append(f"{w} network snapshot {ns['campaign']}/{ns['label']} does not match")
    print(f"{ok} hashes match exactly")
    for n in notes:
        print(f"prefix: {n}")
    for p in pending:
        print(f"not checked: {p}")
    for b in bad:
        print(f"MISMATCH: {b}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
