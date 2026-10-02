# Sensitivity analysis of the validation: counting from consensus events

2026-09-30. Separate analysis of the Phase 1 validation, made after seeing the data. **It does not rewrite the validation**:
the pre-registered result is still the one in [VALIDATION-REPORT.md](VALIDATION-REPORT.md) (C did
not pass, 11/15, with the polling metric, [METRICS.md](METRICS.md) version 5). Tags: **[measured]**,
**[inferred]**.
Data: `results/bradbury/sensitivity-events-tx.json` (one row per tx of V2 to V6 with its state
according to the consensus events, and the final state read from the chain for those the events do
not resolve) and `results/bradbury/sensitivity-events.txt` (output of
`scripts/sensitivity_events.py`). Everything comes from chain reads, at no cost in GEN. Paths are
relative to the root of this repository.

## 1. Prior correction: what the `TransactionAccepted` event means

A first reading of the events of window 6 stated that 9 tx that polling gave up on "were accepted by
the chain later". **That was a misreading of the event and is withdrawn.** [measured]:

- `TransactionAccepted` marks the end of a round, not consensus. It is also emitted when the round
  ends by validators timeout (the state that polling sees as VALIDATORS_TIMEOUT).
- The result of the round is in the last revealed vote (`VoteRevealed` with `isLastVote`), emitted
  in the same block right after: AGREE when there was consensus, TIMEOUT when there was not.
- Example: company #29 of V5. Events: "Accepted" at 18 s; polling: VALIDATORS_TIMEOUT at 19 s; final
  state on chain: FINALIZED with result IDLE after 8 rounds.

The rule by events ([METRICS.md](METRICS.md) version 6) was corrected: a round is an acceptance only
if its result is AGREE; the final decision rules (an acceptance overturned by an appeal is no
consensus).

## 2. Question: the tx that polling gave up on at 45 min

In V2 to V6, polling cut 13 tx at its 45 min limit (V3: 6, V5: 1, V6: 6). Final state on chain
[measured]: **all 13 ended without consensus** (9 appear on chain as FINALIZED with result IDLE; the
other 4 are without consensus according to their events: a round with no agreement, UNDETERMINED or,
for company #29 of V5, FINALIZED with result IDLE).
None was accepted, at the first attempt or later. Those tx do not change any pair of window 6 or the
final result.

## 3. Full recount from events (both directions)

To avoid looking at one side only, the 728 valid tx with LLM of V2 to V6 were recounted from events
[measured]:

- Polling and events agree on **721 of 728**.
- The 7 differences go in the same direction: polling counted them as accepted at the first attempt
  and the events show a failed attempt before, which 1 s polling did not get to see: a leader
  timeout in under 3 s (dvB V3 #35 and #36, dvB V4 #47), a leader rotation (company V3 #13, V6 #33
  and #44) or a validators timeout followed by an appeal (dvB V6 #13). In dvB V3 #35 and #36 the
  leaders that timed out are two of the operators with TIMEOUT on 100% of their votes with LLM.
- No tx that was not accepted according to polling turned out accepted according to the events.

First attempt per pair, polling (v5) against events:

| Pair | C predicted | v5 (validation) | From events | Changes |
|---|---|---|---|---|
| V3 company | 58.6 | 10/45 = 22.2% outside | 9/45 = 20.0% outside | no |
| **V3 dvB** | 76.2 | 45/50 = 90.0% **outside** | 43/50 = 86.0% **inside** | **yes** |
| V4 dvB | 74.3 | 37/50 = 74.0% inside | 36/50 = 72.0% inside | no |
| V6 company | 32.8 | 31/50 = 62.0% outside | 29/50 = 58.0% outside | no |
| V6 dvB | 77.4 | 42/50 = 84.0% inside | 41/50 = 82.0% inside | no |
| the other 10 | | same | same | no |

Criterion:

| | Pairs inside | MAE of C | Naive MAE | Criterion |
|---|---|---|---|---|
| Validation (v5, polling), the official result | 11/15 | 9.5 | 10.0 | does not pass |
| Sensitivity (first attempt from events) | 12/15 | 9.1 | 9.7 | would be met |

## 4. Reading

- The official result does not change: the pre-registered metric was v5 by polling, and with it C
  did not pass.
- The result is at the boundary: a single pair (dvB V3) changes side because of 2 tx in which
  polling did not see a leader timeout. Counting from events, which detects those failed attempts,
  the criterion would be met (12/15) [measured]. It is a post-hoc analysis, not a validation: it was
  not pre-registered.
- The naive prediction used is the pre-registered one (v5 average of the previous windows); it was
  not recomputed from events.
- 1 s polling undercounts failed attempts when a leader times out in less than one polling interval:
  7 of 728 tx (1.0%) in these windows [measured]. Rule v5 already corrected a similar case; the
  events close the gap. It is one more reason to measure the public page from events
  ([METRICS.md](METRICS.md) version 6).
- The tx of V1 were not recounted: V1 only fits and has no pairs.
