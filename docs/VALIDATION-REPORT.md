# Validation of the prediction model (c): final report

Phase 1 of Probe.EXE. Date: 2026-09-30. Network: GenLayer Bradbury (chain 4221). Counting rules: [METRICS.md](METRICS.md),
version 5. Post-hoc sensitivity analysis: [SENSITIVITY.md](SENSITIVITY.md).
This report names the operators (name declared on chain and address) because the fitting data that
is published includes them. Per-operator data is presented as data, with no judgment on how they
operate.
Tags: **[measured]**, **[inferred]**, **[hypothesis]**, and **[pre-planned]** for the analyses
defined before seeing the data they evaluate.
Paths under `results/` and `scripts/` are relative to the root of this repository, where the data
and the code of the measurements are published (section 10).

## 1. Result

**Model C did not pass the pre-registered criterion.** Its predictions of first-attempt acceptance
fell inside the 95% Clopper-Pearson interval of the measured value in **11 of 15** contract-window
pairs, and the criterion required at least 12. It did meet the other condition: its mean absolute
error was 9.5 points against 10.0 for the naive prediction. Since both conditions were required, the
verdict is **does not pass**, by one pair [measured].

**Post-hoc analysis (not pre-registered; it does not change the official result).** Counting the
first attempt from consensus events instead of 1 s polling, 2 transactions change (dvB in V3: the
first leader timed out in under 3 s and polling did not see it) and the criterion would be met: 12
of 15 pairs, MAE 9.1 against 9.7. The pre-registered metric was polling, so the official result
stands. The result is at the boundary. Detail: [SENSITIVITY.md](SENSITIVITY.md) and
`results/bradbury/sensitivity-events.txt` [measured].

## 2. What was measured

- 6 windows on Bradbury, September 28 to 30, 2026, with at least 4 hours between windows and at
  different hours of the day. Each window: 50 tx per contract for wizard (prompt_comparative),
  company (own rule with `json.loads`) and dvB (one word), plus 50 for the control without LLM
  (dvA). 1 s polling.
- V1 only fits. From V2 to V6, chained prediction: the health of the operators measured in window k
  predicts window k+1. 5 windows x 3 contracts = 15 pairs.
- Criterion, fixed before the first window. Both conditions are required: the prediction of
  first-attempt acceptance falls inside the 95% Clopper-Pearson interval of the measured value in at
  least 12 of the 15 pairs, and the mean absolute error of the model is lower than that of the naive
  prediction (the average first-attempt acceptance of the previous windows). The plan also fixed
  that at least 2 windows cross an epoch change on purpose, with results reported with and without
  them.
- Model C (main, the only one judged): per-operator rates of TIMEOUT, DV and leader timeout from the
  previous window (contracts with LLM pooled, 3 fictitious votes at the rate of the rest), DV scaled
  per contract, "type 2 DV" as an event of the attempt, content disagreement per contract,
  committees drawn by stake weight. Version c-1, frozen from V2 to V6.
- Pre-registration at `github.com/randyparrs/probe-exe-preregistration`: each prediction with its
  network snapshot, seed (20260928), 200,000 simulations, SHA-256 of the fitting data and code, and
  the model code in `model/`. The evaluation script was pre-registered before V2. Commits (each one
  pushed before its window ran): 0d392b0 (V2 and model), da60ed8 (evaluation), 66fae4e (V3), f2182af
  (V4), c74467d (V5), 2169845 (V6).
- Metric: accepted at the first attempt according to [METRICS.md](METRICS.md) version 5 (no retries
  and no LEADER_TIMEOUT or VALIDATORS_TIMEOUT in the timeline), over the valid rows.
- Valid rows: a transaction whose execution does not end `FINISHED_WITH_RETURN` is flagged as an
  invalid row and reported apart. When the execution fails, the validators agree on the error, which
  is not agreement on the answer of the model.

## 3. The 15 pairs

| Window | Contract | C predicted | Measured | 95% CI | Result | Naive |
|---|---|---|---|---|---|---|
| V2 | wizard | 80.8 | 40/50 = 80.0 | 66.3-90.0 | inside | 82.0 |
| V2 | company | 55.9 | 26/50 = 52.0 | 37.4-66.3 | inside | 58.0 |
| V2 | dvB | 82.9 | 41/50 = 82.0 | 68.6-91.4 | inside | 84.0 |
| V3 * | wizard | 76.2 | 33/50 = 66.0 | 51.2-78.8 | inside | 81.0 |
| V3 * | company | 58.6 | 10/45 = 22.2 | 11.2-37.1 | **outside** | 55.0 |
| V3 * | dvB | 76.2 | 45/50 = 90.0 | 78.2-96.7 | **outside** | 83.0 |
| V4 | wizard | 73.9 | 36/50 = 72.0 | 57.5-83.8 | inside | 76.0 |
| V4 | company | 37.8 | 13/39 = 33.3 | 19.1-50.2 | inside | 44.1 |
| V4 | dvB | 74.3 | 37/50 = 74.0 | 59.7-85.4 | inside | 85.3 |
| V5 | wizard | 77.2 | 41/50 = 82.0 | 68.6-91.4 | inside | 75.0 |
| V5 | company | 38.9 | 10/44 = 22.7 | 11.5-37.8 | **outside** | 41.4 |
| V5 | dvB | 77.7 | 43/50 = 86.0 | 73.3-94.2 | inside | 82.5 |
| V6 * | wizard | 77.1 | 36/50 = 72.0 | 57.5-83.8 | inside | 76.4 |
| V6 * | company | 32.8 | 31/50 = 62.0 | 47.2-75.3 | **outside** | 37.7 |
| V6 * | dvB | 77.4 | 42/50 = 84.0 | 70.9-92.8 | inside | 83.2 |

\* Window that crossed an epoch change (V3: 165 -> 166; V6: 166 -> 167). In both, dvB and the
control finished before the change; only wizard and company crossed it. Percentages in %. Full
output: `results/bradbury/validation-final.txt`.

## 4. Pre-planned analyses [pre-planned]

Defined in the validation plan and in the pre-registered evaluation script (da60ed8), before seeing
V2 to V6.

- **Without the windows that cross an epoch change** (V2, V4, V5; 9 pairs): 8/9 inside (80%
  threshold: 8) and MAE 4.6 against 7.2 for the naive prediction. With that subset the criterion is
  met [measured]. It does not change the main verdict, which is the one over the 15 pairs.
- **Leader timeout at the first attempt**, predicted against measured: 14 of 15 pairs inside the
  interval; the only one outside is dvB V3 (22.0% predicted, 5/50 measured) [measured].
- **Calibration by bins of 10 points** (C): 70-80% predicted -> 313/400 = 78.2% measured (8 pairs);
  80-90% -> 81.0% (2 pairs); 30-40% -> 54/133 = 40.6% (3 pairs); 50-60% -> 36/95 = 37.9% (2 pairs,
  company V2 and V3) [measured].

## 5. References (they do not change the verdict)

- **B** (secondary: DV as independent votes, with no attempt event): 12/15 inside, MAE 9.4. It would
  meet the criterion, but it was pre-registered next to C as a reference only and is not judged
  [measured].
- **Local only** (tertiary, V3): the local module predicted 100% for the three contracts and in both
  model scenarios; 0/3 inside, MAE 40.6. Locally the committee accepts 300 of 300 runs; on the
  network, first-attempt acceptance was 22 to 90%. **Acceptance cannot be predicted without
  measuring the network**: what lowers it is execution on the nodes (TIMEOUT, DV, leader timeouts),
  not the language model or its answer [measured; the conclusion is inferred].

## 6. Why it failed: regime changes of company

Three of the four pairs outside are company [measured]:

| Window | Accepted with execution error (invalid rows, excluded) | Content disagreement (votes) | First attempt |
|---|---|---|---|
| V1 | 0 | 3.6% | 58% |
| V2 | 0 | 1.5% | 52% |
| V3 (epoch 166) | 5 | 9.0% | 22% |
| V4 | 11 | 7.5% | 33% |
| V5 | 6 | 10.9% | 23% |
| V6 | 0 | 2.1% | 62% |

- After the change to epoch 166, company got worse: tx accepted with `FINISHED_WITH_ERROR` (the
  leader ends with "exit_code 1" and the validators agree on the error), concentrated in 7 operators
  as final leader (table in section 7), and more content disagreement [measured].
  wizard and dvB did not show that effect; company is the only one that parses the JSON of the
  answer in its own code [measured]. A configuration change on those nodes coinciding with the epoch
  is a [hypothesis]: the cause inside a node is not visible from the chain.
- Between V5 (ended 02:38 UTC on the 30th) and V6 (started 13:26 UTC on the 30th) company recovered:
  the 28 tx of V6 sent while still in epoch 166 already show only 1 error [measured]. The recovery
  did not coincide with the change to epoch 167.
- The chained model uses the health of the previous window, so it lags **one step behind** each
  change: it overestimated company in V3 and V5 (it predicted with data from before the drop) and
  underestimated it in V6 (it predicted with data from the drop) [inferred].
- The fourth pair outside (dvB V3, 90% measured against 76.2%) is not attributed to the epoch: dvB
  finished before the change. It coincides with fewer leader timeouts than expected (5/50 against
  22%) [measured].

**Future work** (not applied; model c-1 stays frozen): regime change detection, for example using
the last part of the window, weighting by recency, or marking the prediction as unreliable when the
rate of a contract moves outside its interval between windows.

## 7. Separate findings

- **Contract copy stuck after an epoch change.** Since the move to epoch 166, the company copy
  `0x4cCd16c93eAD8DdF65ddc3646b1fF5FB8b82793d` did not process any tx: 5 in V3 and 1 control tx in
  each of V4, V5 and V6 (outside the metrics, `results/bradbury/probes.jsonl`) ended UNDETERMINED or
  CANCELED with result IDLE, with no votes, after 30 to 45 minutes. An identical copy
  (`0xC8Cc6A...`) worked in the same windows [measured]. It was retired for V4-V6 and replaced by
  `0xb6BDEc0e...`, checked before V4 with one test tx outside the metrics. Sensitivity of company V3
  with and without its 5 tx: 10/45 = 22.2% and 10/40 = 25.0%; outside in both cases. The chain no
  longer serves the data of the canceled tx.
- **Operators with TIMEOUT on all their votes with LLM** [measured]. Votes as validator and timeouts
  as leader (LEADER_TIMEOUT) on the contracts with LLM from V1 to V6, and votes on the control
  without LLM:

  | Declared name | Address | TIMEOUT with LLM | Timeouts as leader | Votes without LLM with TIMEOUT or DV |
  |---|---|---|---|---|
  | BlackNodes | 0xB93a46B843fB32E8Ce392e68eDFE93Faa4a40817 | 198/198 | 66/66 | 0/80 |
  | Blockscope | 0x3f5cAED686336ED9cF3Dede61154B0Cd67Fb9bD7 | 236/236 | 61/61 | 0/53 |
  | Brightlystake | 0xE8fdefdfe18fD8E5B0d576b7CcfC5a29CE43fD7f | 215/215 | 48/48 | 0/48 |
  | StakingCabin | 0x0c526A6af46A038E31dA21C123756Ab2D75f06Bc | 234/234 | 65/65 | 0/58 |
  | Neturion Global | 0xfd811B16001077243e07173ec72a4735FF04C3AA | V1 0/31; V2-V6 154/154 | V1 0/8; V2-V6 30/30 | 0/56 |

  The rest of the operators: 187 TIMEOUT in 4,655 votes with LLM (4.0%). The control without LLM: 0
  TIMEOUT or DV in 1,500 votes. Detail per window in `results/bradbury/network-report-v*.txt`.
- **Company accepted with execution error, by final leader** (V3 to V6; 22 tx in total) [measured]:

  | Declared name | Address | Accepted with error as final leader | Accepted without error as final leader |
  |---|---|---|---|
  | AURORAX | 0xb4Fb7ADc6877a6A16bd131c7c9270834bD3DEf34 | 5 | 0 |
  | FairStaking | 0x3B940A5b4A762583453D9e9Cf0981BE0426A8e79 | 5 | 0 |
  | SenseiNode | 0x422357d87B035e478777C84748BAC834CE2A9597 | 4 | 4 |
  | Finoa Consensus Services | 0xF01877B6Ac60861CA3b134e0E483C482679b4682 | 2 | 1 |
  | ITRocket | 0x77a07271abB443F55be19c357AA35206BeB63E1d | 2 | 4 |
  | pops-team | 0x27276953fa2052A5178Ae5a3D114a3DFB9A2fC98 | 2 | 2 |
  | Validatrium Bradbury | 0x79485eF57aC2055dC83b9E7b2C9Cf184Fc79648E | 2 | 4 |

  There were none in V6 (section 6).
- **Bursts of HTML from the RPC.** In V6 the Bradbury RPC answered HTML pages instead of JSON during
  several bursts. The launcher retried and went on; 200/200 rows, no effect on the data [measured].

## 8. Deviations and operational events

- **Counting rule v5**: fixed after seeing V1 and before the first prediction; it closes a gap in v4
  (LEADER_TIMEOUT with no PROPOSING seen). It applies to the 6 windows; Phase 0 is reported
  under v5 in an annex (`results/bradbury/annex-phase0-v5.txt`).
- **Model variant**: variant A, the model as first specified (a single DV rate per operator pooled
  over the contracts with LLM, with no adjustment per contract), failed inside V1 itself. C, which
  scales that rate by the DV of each contract and treats type 2 DV as an event of the attempt, was
  chosen as the main model before pre-registering V2.
- **Invalid rows**: accepted with `FINISHED_WITH_ERROR`, excluded by the validity rule of section 2
  (company: V3 5, V4 11, V5 6). The accepted ones whose execution result still came back empty were
  read again (`recheck-execution`) and are valid.
- **Stuck copy** replaced from V4 on (section 7).
- **`results/bradbury/execution-recheck-v1.jsonl`**: on 2026-09-28 at 20:48 UTC, while testing
  `scripts/after_window.py`, the re-read of V1 was run again and 13 lines were appended, identical
  in tx and results to the 13 original ones. The SHA-256 pre-registered in V2 corresponds to the
  first 13 lines; those from V3 on, to the full file. The file is published untrimmed and
  `scripts/verify_preregistration.py` detects it and reports it.
- **Local module**: Gemma moved from Crusoe to DeepInfra after the first test run (repeated 429 from
  the provider); those rows were set apart and are not included.
- **Schedule**: V2 started at 23:01 UTC on the 28th (a run launched earlier by mistake was stopped
  without sending anything); V3 and V6 started at 13:26 UTC on the 29th and the 30th, crossing the
  epoch change; V4 (20:47 UTC on the 29th) and V5 (01:32 UTC on the 30th) started more than 4 hours
  after the previous window ended. V3 and V6 lasted close to 3 hours because of the slowness that
  follows an epoch change.

## 9. Costs [measured]

- Bradbury: 0.157 GEN for the 6 windows (1,200 tx) plus 4 control tx.
- OpenRouter (local module): 0.11 USD for 300 runs.

## 10. Publication

**All the fitting data is published, complete, unedited and untrimmed**, so that the SHA-256 values
of the pre-registration can be verified:
- `results/bradbury/campaign-{wizard,company,dvB,dvA}-v{1..6}.jsonl`,
  `results/bradbury/execution-recheck-v*.jsonl`, `results/bradbury/network-snapshots.jsonl`,
  `results/bradbury/network-eligibility.jsonl`, `results/bradbury/probes.jsonl`,
  `results/bradbury/copies.json`, `results/bradbury/campaign-costs.jsonl`;
- `results/local-s1.jsonl`, `results/local-s2.jsonl` (and `results/local-smoke1-s2.jsonl`, the
  discarded test);
- the project code, including `scripts/verify_preregistration.py`. Status as of 2026-09-30: 95
  hashes match exactly and 1 matches by prefix, explained in section 8
  (`results/bradbury/verify-preregistration.txt`).
