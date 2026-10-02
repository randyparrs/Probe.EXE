"""Local module (a), FASE1-DISENO.md section 4 and decision 11.9: the contracts of the validation
windows, run locally with a real model per committee seat.

Per pass and contract: a fresh deploy; each of the 5 seats (leader and 4 validators) draws its model
from the scenario mix with a fixed seed; the leader runs the write method once, then the 4
validators re-run it with direct_vm.run_validator(). Every LLM request goes to OpenRouter through
harness.genvm_llm with a fixed provider per model and no fallbacks. One row per pass in
results/<run>.jsonl; scripts/local_report.py reads them.

    $env:OPENROUTER_API_KEY="..."
    $env:CR_SCENARIO="s1"
    py -3.14 -m pytest tests/test_local_module.py -q -s -p no:cacheprovider -m live

Settings (environment):
  CR_SCENARIO   s1 (every seat Llama 3.3 70B) or s2 (each seat 25 % Llama 3.3 70B, DeepSeek V4
                Flash, Gemma 4 31B, Qwen3 235B A22B 2507)
  CR_CONTRACTS  default wizard,company,dvB (same contracts and inputs as the windows)
  CR_PASSES     default 50
  CR_RUN        default local-<scenario>; rows of an existing run are appended to, and passes
                already in the file are skipped (a run can be resumed)
A pass is not started once the spend recorded in results/local-*.jsonl reaches BUDGET_USD.
Needs genlayer-test 0.29.x (v0.2 SDK), Python 3.14 here.
"""

import json
import os
import random
from pathlib import Path

import pytest

from harness import genvm_llm
from harness.contracts import PORTS, build

ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = ROOT / "results"

# model key -> (OpenRouter model id, fixed OpenRouter endpoint slug); chosen 2026-09-28 from the
# OpenRouter catalog: JSON mode supported, max output >= 8000 tokens, best recent uptime.
# Llama on Parasail: the provider of most Phase 0 local calls (free routing then). Gemma moved from
# crusoe/bf16 to deepinfra/fp8 after the first test pass (2026-09-28): repeated 429 from Crusoe, a
# limit on this account's traffic, not a property of the model (rows kept in local-smoke1-s2.jsonl).
ATTEMPTS, MAX_BACKOFF = 8, 30
MODELS = {
    "llama": ("meta-llama/llama-3.3-70b-instruct", "parasail/fp8"),
    "deepseek": ("deepseek/deepseek-v4-flash", "gmicloud/fp8"),
    "gemma": ("google/gemma-4-31b-it", "deepinfra/fp8"),
    "qwen": ("qwen/qwen3-235b-a22b-2507", "parasail/fp8"),
}
SCENARIOS = {
    "s1": {"llama": 1.0},
    "s2": {"llama": 0.25, "deepseek": 0.25, "gemma": 0.25, "qwen": 0.25},
}
SEATS = ["leader"] + [f"validator-{i}" for i in range(1, 5)]
SEED = 20260928
BUDGET_USD = 5.0

SCENARIO = os.environ.get("CR_SCENARIO", "s1")
CONTRACTS = [c for c in os.environ.get("CR_CONTRACTS", "wizard,company,dvB").split(",") if c]
PASSES = int(os.environ.get("CR_PASSES", "50"))
RUN = os.environ.get("CR_RUN") or f"local-{SCENARIO}"
RESULTS = RESULTS_DIR / f"{RUN}.jsonl"
JUDGES = ("EqComparative", "EqNonComparativeValidator")

pytestmark = pytest.mark.live


def seat_models(scenario, contract, pass_no):
    """Model key of every seat, drawn with a seed fixed by scenario, contract and pass."""
    rng = random.Random(f"{SEED}-{scenario}-{contract}-{pass_no}")
    keys, weights = zip(*SCENARIOS[scenario].items())
    return {seat: rng.choices(keys, weights)[0] for seat in SEATS}


def classify(calls, phase, accepted, error):
    """Decision 11.9: agree, format (the answer does not parse), content (it parses but does not
    match), provider_error (no answer after the retries); judge_without_result (the judge's JSON
    parses but has no boolean "result", read as false by GenVM) and other_error kept apart."""
    if accepted:
        return "agree"
    mine = [c for c in calls if c["phase"] == phase]
    errors = [c.get("error") or "" for c in mine if c.get("error")]
    if any(e.startswith("invalid json") for e in errors) or (error and "JSONDecodeError" in error):
        return "format"
    if errors:
        return "provider_error"
    if error:
        return "other_error"
    if any(c.get("bool_missing") for c in mine if c["kind"] in JUDGES):
        return "judge_without_result"
    return "content"


def spent_usd():
    total = 0.0
    for f in RESULTS_DIR.glob("local-*.jsonl"):
        for line in open(f, encoding="utf-8"):
            if line.strip():
                total += json.loads(line).get("costUSD") or 0.0
    return total


def done_passes():
    if not RESULTS.exists():
        return set()
    rows = [json.loads(line) for line in open(RESULTS, encoding="utf-8") if line.strip()]
    return {(r["contract"], r["pass"]) for r in rows}


def _summary(calls):
    out = []
    for r in calls:
        usage = r.get("usage") or {}
        out.append({k: r.get(k) for k in ("phase", "kind", "model", "format", "provider", "seconds",
                                          "finish_reason", "retries", "bool", "bool_missing", "error", "raw")}
                   | {"completion_tokens": usage.get("completion_tokens"), "prompt_tokens": usage.get("prompt_tokens"),
                      "cost": usage.get("cost")})
    return out


@pytest.mark.parametrize("pass_no", range(PASSES))
@pytest.mark.parametrize("name", CONTRACTS)
def test_pass(direct_vm, direct_deploy, name, pass_no):
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        pytest.skip("OPENROUTER_API_KEY not set")
    if (name, pass_no) in done_passes():
        pytest.skip("pass already recorded")
    spent = spent_usd()
    if spent >= BUDGET_USD:
        pytest.skip(f"budget reached: {spent:.2f} of {BUDGET_USD} USD")
    spec = PORTS[name]
    seats = seat_models(SCENARIO, name, pass_no)
    transport = genvm_llm.openrouter_transport(key, provider_by_model={m: p for m, p in MODELS.values()},
                                               include_cost=True, attempts=ATTEMPTS, max_backoff=MAX_BACKOFF)
    llm = genvm_llm.GenvmLLM(transport, seat_models={s: MODELS[k][0] for s, k in seats.items()})
    c = direct_deploy(str(build(spec.source, spec.runner)), *spec.deploy_args)
    llm.install(direct_vm)

    llm.phase = "leader"
    leader_out, leader_error = None, None
    try:
        leader_out = spec.run(direct_vm, c)
    except Exception as e:  # noqa: BLE001 - a leader error is a measured outcome
        leader_error = f"{type(e).__name__}: {e}"[:1000]

    votes, vote_errors = [], []
    if leader_error is None:
        for seat in SEATS[1:]:
            llm.phase = seat
            try:
                votes.append(bool(direct_vm.run_validator()))
                vote_errors.append(None)
            except Exception as e:  # noqa: BLE001 - on the network a validator error is not an agree
                votes.append(False)
                vote_errors.append(f"{type(e).__name__}: {e}"[:1000])

    calls = _summary(llm.calls)
    row = {"run": RUN, "scenario": SCENARIO, "contract": name, "pass": pass_no, "seats": seats,
           "models": {k: MODELS[k][0] for k in set(seats.values())},
           "providers": {k: MODELS[k][1] for k in set(seats.values())},
           "input": spec.input_desc, "leader_output": leader_out, "leader_error": leader_error,
           "leader_class": None if leader_error is None else classify(calls, "leader", False, leader_error),
           "votes": votes, "vote_errors": vote_errors,
           "vote_classes": [classify(calls, s, v, e) for s, v, e in zip(SEATS[1:], votes, vote_errors)],
           "calls": calls, "costUSD": sum(x["cost"] or 0.0 for x in calls)}
    RESULTS.parent.mkdir(exist_ok=True)
    with open(RESULTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, default=str) + "\n")
