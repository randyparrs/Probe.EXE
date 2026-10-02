"""Builds the Bradbury port of the GenAntiTrust tribunal contract, and its fixed evidence input,
from the original files.

The original repository has no license, so its files are not redistributed here. This script
downloads them at the exact commit, checks their SHA-256, applies the port (syntax replacements for
the GenVM v0.2 runner that Bradbury accepts; the logic is unchanged) and checks the SHA-256 of the
results, which are the files measured in Phase 0.

Original, commit e6ade9441d05398928103807b45ccc4697f0f4b8:
  https://github.com/ebukaarcryppted-git/GenAntiTrust/blob/e6ade9441d05398928103807b45ccc4697f0f4b8/contracts/tribunal.py
  https://github.com/ebukaarcryppted-git/GenAntiTrust/blob/e6ade9441d05398928103807b45ccc4697f0f4b8/tests/direct/test_tribunal.py

Usage (from the repository root):
  python contracts/bradbury/port_tribunal.py
  python contracts/bradbury/port_tribunal.py --contract <tribunal.py> --test <test_tribunal.py>

It writes contracts/bradbury/tribunal.py and contracts/bradbury/inputs/tribunal_evidence.json.
"""

import argparse
import ast
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

RAW = "https://raw.githubusercontent.com/ebukaarcryppted-git/GenAntiTrust/e6ade9441d05398928103807b45ccc4697f0f4b8/"
HERE = Path(__file__).resolve().parent

SHA256 = {
    "contracts/tribunal.py (original)": "b89a6066ef20d68edb4a22b7c1f9723e1327770b5c68a18714ece92d5e11f0ef",
    "tests/direct/test_tribunal.py (original)": "63273916d2ed3da52c0fb48e50ef781aba043974dd1325dbd4bb91dc4fa06af6",
    "tribunal.py (port)": "e481996ee46532cbfa6ce6f5d24e6117c2d1ee94bde2a85bf0a8029d3dd0b62d",
    "tribunal_evidence.json": "9b38654252e88073cf74d4dd2c3e758ff7fabf9fd3826b9361cc9a8462d6fb87",
}

# (pattern in the original, text in the port): each pattern occurs exactly once in the original.
# They are SDK names only, so this file carries no line of the original.
REPLACEMENTS = [
    # runner of the header: GenVM v0.6 -> v0.2
    (r"py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng",
     "py-genlayer:1j12s63yfjpva9ik2xgnffgrs6v44y1f52jvj9w7xvdn7qckd379"),
    # one import of everything instead of the module import plus the storage import
    (r"^import genlayer as \w+\n", "from genlayer import *\n"),
    (r"^from genlayer\.storage import [^\n]*\n", ""),
    (r"\(gl\.contract\.Contract\)", "(gl.Contract)"),
    (r"gl\.message\.raw\[", "gl.message_raw["),
    # same default as the original: the transfer is applied when the transaction is finalized
    (r"gl\.chain\.Account\(", "gl.get_contract_at("),
    (r"\.emit_transfer\(", ".emit_transfer(value="),
]


def check(name: str, data: bytes) -> None:
    got = hashlib.sha256(data).hexdigest()
    if got != SHA256[name]:
        sys.exit(f"{name}: SHA-256 {got}, expected {SHA256[name]}")
    print(f"ok  {name}  {got}")


def read(path: str | None, upstream: str) -> bytes:
    if path:
        return Path(path).read_bytes()
    with urllib.request.urlopen(RAW + upstream, timeout=60) as res:
        return res.read()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--contract", help="local copy of the original contracts/tribunal.py (default: download)")
    ap.add_argument("--test", help="local copy of the original tests/direct/test_tribunal.py (default: download)")
    args = ap.parse_args()

    original = read(args.contract, "contracts/tribunal.py")
    check("contracts/tribunal.py (original)", original)
    text = original.decode("utf-8")
    for pattern, new in REPLACEMENTS:
        text, n = re.subn(pattern, lambda _m: new, text, flags=re.M)
        if n != 1:
            sys.exit(f"expected exactly one occurrence of {pattern!r}, found {n}")
    port = text.encode("utf-8")
    check("tribunal.py (port)", port)

    # the evidence is the list the original direct test passes to file_complaint
    test = read(args.test, "tests/direct/test_tribunal.py")
    check("tests/direct/test_tribunal.py (original)", test)
    found = re.search(r"^EVIDENCE = json\.dumps\(\s*(\[.*?\])\s*\)", test.decode("utf-8"), re.S | re.M)
    if not found:
        sys.exit("EVIDENCE not found in the original test")
    evidence = json.dumps(ast.literal_eval(found.group(1))).encode("utf-8")
    check("tribunal_evidence.json", evidence)

    (HERE / "tribunal.py").write_bytes(port)
    (HERE / "inputs").mkdir(exist_ok=True)
    (HERE / "inputs" / "tribunal_evidence.json").write_bytes(evidence)
    print("written: contracts/bradbury/tribunal.py, contracts/bradbury/inputs/tribunal_evidence.json")


if __name__ == "__main__":
    main()
