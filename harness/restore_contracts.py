"""Restores the pre-registered harness/contracts.py and checks its SHA-256.

harness/contracts.py is listed in the pre-registration (window-v3.json). It carried four lines taken
from the direct test of GenAntiTrust, a repository with no license: the placeholder address of the
respondent and three evidence records. The file is published with those lines replaced by two
markers. This script downloads the original test at the exact commit, checks its SHA-256, puts the
lines back where the markers are and checks that the result has the pre-registered SHA-256.

Original, commit e6ade9441d05398928103807b45ccc4697f0f4b8:
  https://github.com/ebukaarcryppted-git/GenAntiTrust/blob/e6ade9441d05398928103807b45ccc4697f0f4b8/tests/direct/test_tribunal.py

Usage (from the repository root):
  python harness/restore_contracts.py                  check only, nothing is written
  python harness/restore_contracts.py --write          also restore harness/contracts.py in place
  python harness/restore_contracts.py --test <test_tribunal.py>   use a local copy of the original

A restored harness/contracts.py must not be committed.
"""

import argparse
import hashlib
import re
import sys
import urllib.request
from pathlib import Path

ORIGINAL = ("https://raw.githubusercontent.com/ebukaarcryppted-git/GenAntiTrust/"
            "e6ade9441d05398928103807b45ccc4697f0f4b8/tests/direct/test_tribunal.py")
ORIGINAL_SHA256 = "63273916d2ed3da52c0fb48e50ef781aba043974dd1325dbd4bb91dc4fa06af6"
PREREGISTERED_SHA256 = "683f9345d360ddb49fcdb8c5d540372c0cccca5248389b4ebaba9eb907578a3d"
MARKER_RESPONDENT = b"# RESPONDENT: one line removed, restored by harness/restore_contracts.py\n"
MARKER_EVIDENCE = b"    # EVIDENCE-RECORDS: three lines removed, restored by harness/restore_contracts.py\n"
TARGET = Path(__file__).resolve().parent / "contracts.py"

sha256 = lambda data: hashlib.sha256(data).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--test", help="local copy of the original tests/direct/test_tribunal.py (default: download)")
    ap.add_argument("--write", action="store_true", help="restore harness/contracts.py in place")
    args = ap.parse_args()

    if args.test:
        test = Path(args.test).read_bytes()
    else:
        with urllib.request.urlopen(ORIGINAL, timeout=60) as res:
            test = res.read()
    if sha256(test) != ORIGINAL_SHA256:
        sys.exit(f"original test: SHA-256 {sha256(test)}, expected {ORIGINAL_SHA256}")

    # the records of the EVIDENCE list of the original test, re-indented as they were in contracts.py
    block = re.search(rb"^EVIDENCE = json\.dumps\(\s*\[\n(.*?)^\s*\]\s*\)", test, re.S | re.M)
    records = [line.strip() for line in block.group(1).splitlines()] if block else []
    if len(records) != 3:
        sys.exit("the three evidence records were not found in the original test")
    evidence = b"".join(b"    " + record + b"\n" for record in records)
    respondent = re.findall(rb"^RESPONDENT = [^\n]*\n", test, re.M)
    if len(respondent) != 1:
        sys.exit("the RESPONDENT line was not found in the original test")

    published = TARGET.read_bytes()
    if published.count(MARKER_RESPONDENT) == 1 and published.count(MARKER_EVIDENCE) == 1:
        restored = published.replace(MARKER_RESPONDENT, respondent[0]).replace(MARKER_EVIDENCE, evidence)
    elif sha256(published) == PREREGISTERED_SHA256:
        restored = published  # already restored
    else:
        sys.exit("harness/contracts.py: markers not found")

    if sha256(restored) != PREREGISTERED_SHA256:
        sys.exit(f"restored harness/contracts.py: SHA-256 {sha256(restored)}, expected {PREREGISTERED_SHA256}")
    print(f"ok  harness/contracts.py restored in memory  {sha256(restored)} (pre-registered)")
    if args.write:
        TARGET.write_bytes(restored)
        print("written: harness/contracts.py (restored; do not commit it)")


if __name__ == "__main__":
    main()
