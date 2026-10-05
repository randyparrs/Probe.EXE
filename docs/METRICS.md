# Metric definitions (versions 1 to 6)

How Probe.EXE counts consensus outcomes of Intelligent Contracts on GenLayer Bradbury (testnet,
chain 4221). Every version was written before the run it applies to, unless it says otherwise. A
later change is a new version: results already measured are never rewritten, and a re-read of old
data with a newer rule is reported apart, marked as made after seeing the data.

Paths under `results/`, `scripts/`, `contracts/`, `harness/` and `tests/` are relative to the root of
this repository. Intervals are 95% Clopper-Pearson (`harness/stats.py`).

| Version | Date | What it fixes |
|---|---|---|
| 1 | 2026-09-27 | Unit of measurement, measurement result, metrics per transaction and per vote, local runs |
| 2 | 2026-09-27 | Committee and majority confirmed, report with and without timeouts, limit of the local model |
| 2.1 | 2026-09-27 | Corrections after the first campaign: "first attempt" replaces "round 0", retry causes |
| 3 | 2026-09-27 | DETERMINISTIC_VIOLATION experiment: control without LLM, result hashes per vote |
| 4 | 2026-09-27 | Vote categories and subtypes of execution divergence, per-operator rates |
| 5 | 2026-09-28 | First attempt also excludes any leader or validators timeout seen in the timeline |
| 6 | 2026-09-30 | First attempt counted from consensus events instead of polling (public page) |

Versions 1 to 4 were written for Phase 0 (exploratory campaigns). Version 5 is the one of Phase 1,
the validation of the prediction model ([VALIDATION-REPORT.md](VALIDATION-REPORT.md)). The public
page uses version 6. The phases are defined in the README of this repository.

## Versions 1 and 2 (2026-09-27): base definitions

Fixed before the run of 50 calls per contract. Version 2 is version 1 of the same day plus three
adjustments: the committee, the report with and without timeouts, and the limit of the local model.

### Design

- Contracts (`contracts/bradbury/`, written for the v0.2 runner): `wizard_of_coin`
  (`prompt_comparative`), `company_naming` (own rule, `run_nondet` with sandbox) and `tribunal`
  (`prompt_non_comparative`). Origin and license of each one: `contracts/SOURCES.md`. The original
  of tribunal has no license, so the contract and its evidence input are not in this repository:
  `contracts/bradbury/port_tribunal.py` builds both from the original and checks their SHA-256.
- Fixed input, the same on Bradbury and locally (`harness/contracts.py`):
  - wizard: `ask_for_coin(WIZARD_REQUEST)`.
  - company: `score_alignment("Stripe", "Online payment processing platform for internet businesses")`.
  - tribunal: `file_complaint(<accused>, "sku-widget-9000", <evidence>)`, with the evidence built by
    `contracts/bradbury/port_tribunal.py`, and then `resolve_dispute(<id>)`. Only `resolve_dispute` is measured. The accused address is not
    part of the prompt, so changing it does not change the input of the LLM.
- n = 50 measured calls per contract on Bradbury and 50 passes per contract locally.
- wizard: if a call hands over the coin (`have_coin` becomes false), later calls to that copy no
  longer use the LLM. That copy is retired and the call is counted; the next ones go to another copy.

### Bradbury: the unit is one transaction

Each transaction is followed from submission to its **measurement result**, the first of:

- `ACCEPTED`: there was consensus. FINALIZED is not awaited (the following ~30 min are the appeal
  window, not part of consensus).
- **No consensus**: `UNDETERMINED` (rotations exhausted), `VALIDATORS_TIMEOUT` with no new round in
  10 min, `LEADER_TIMEOUT` with `rotationsLeft = 0` and no progress in 10 min, or 45 min without
  ACCEPTED.

Metrics per transaction (each with its interval over n = 50):

1. **Accepted in round 0**: ACCEPTED with `lastRound.round = 0` (replaced in version 2.1).
2. **Accepted after rotation**: ACCEPTED with round > 0, with the distribution by round.
3. **No consensus**, as defined above.
4. **Cause of each observed rotation**: `LEADER_TIMEOUT` (the leader delivered no result) or a
   majority against (the round ends without ACCEPTED by votes). Only for the rounds the watcher
   gets to see.
5. **Latency to ACCEPTED**: seconds from `createdTimestamp` to the first read in ACCEPTED, and
   `lastVoteTimestamp - createdTimestamp` (chain data). Median, p90 and maximum.

Metrics per vote (deciding round, 5 votes per transaction, 250 per contract):

6. Share of `AGREE`, `DISAGREE`, `TIMEOUT` and `DETERMINISTIC_VIOLATION`, each one apart, with its
   interval. The 5 votes of a transaction share the leader, so they are not independent: the
   interval per vote is indicative. Conclusions rest on the metrics per transaction.
7. Votes revealed in non-deciding rounds (before a rotation) are recorded apart and not mixed with
   the deciding round.

Meaning of each vote (rule of `_set_vote`, `backend/node/base.py` of genlayer-studio c9407295):
`TIMEOUT` = the VM of the validator ended by timeout or internal error; `DISAGREE` = its
non-deterministic block returned false; `DETERMINISTIC_VIOLATION` = there was no non-deterministic
disagreement but its result, state or messages differ from the leader's; `AGREE` = it matches.

### Committee and majority (version 2, confirmed)

Data from the first 9 transactions measured on Bradbury:

- Each round has 5 voters (`roundValidators`) and **the leader is one of them**:
  `roundValidators[leaderIndex] == lastLeader` in all 9, and the leader votes `AGREE` on its own
  result in every one that reached a vote.
- "3 initial validators, 5 voted" does not exist: genlayer-js 1.2.0 shows `initialRotations` (3) in
  the field `numOfInitialValidators` when the Bradbury transaction does not carry it. The client
  sends 5 initial validators and 3 maximum rotations (chain defaults).

Decision rule (`determine_consensus_from_votes` in `backend/consensus/utils.py` and
`backend/consensus/decisions.py` of genlayer-studio c9407295; Bradbury nodes run genlayer-node,
which is not public, and the same rule is assumed):

- `AGREE > 5/2` (3 of 5, the leader included): accepted.
- `DISAGREE` (+ `IDLE`) `> 5/2`: majority against. `TIMEOUT > 5/2`: `validators_timeout`.
- Any other case: no majority. `DETERMINISTIC_VIOLATION` adds neither for nor against.
- Majority against or no majority: the leader rotates while rotations remain (3); once exhausted,
  `undetermined`.
- Consistent with the measurements: a transaction accepted with 3 AGREE + 1 TIMEOUT + 1
  DETERMINISTIC_VIOLATION.

Local committee, the same: leader + 4 validators; the leader counts as `AGREE`; accepted if at least
2 of the 4 validators accept (3 of 5). No rotations locally: the first round is measured.

### Bradbury with and without timeouts (version 2)

Each Bradbury metric is reported in two ways:

- **(a) everything together**, as the network decided it.
- **(b) without infrastructure**: per vote, shares are computed over the votes that are not
  `TIMEOUT` (AGREE, DISAGREE and DETERMINISTIC_VIOLATION); per transaction, rounds that ended in
  `LEADER_TIMEOUT` do not count as a rotation, so "accepted in the first round with content" =
  accepted in the first round whose leader delivered a result. Transactions in which no leader
  delivered a result are excluded from (b), and their number is reported.
- The difference (a) - (b) is reported as the part of the disagreement that is infrastructure
  (validator and leader timeouts). **The comparison with local runs is made against (b).**

### Local: the unit is one pass

One pass = the leader executes the call once and 4 validators re-execute it (committee of 5 as on
Bradbury), same model for all (Llama 3.3 70B through OpenRouter), GenVM temperature and templates
(`harness/genvm_llm.py`).

Metrics per pass (n = 50):

1. **Committee agreement**: at least 2 of the 4 validators accept (3 of 5 counting the leader). It
   is the local analogue of "accepted in round 0".
2. **Leader error**: the execution of the leader raises an exception.

Metrics per vote (200 per contract), each rejection with its reason:

- Accept: the validator accepts.
- Judge rejection: the judge template (`EqComparative` / `EqNonComparativeValidator`) returned
  `result: false`.
- Judge without result: the judge did not return a boolean `result` (GenVM reads it as false).
- Rule rejection: the contract's own rule returned false (company: score difference > 3).
- Invalid JSON: the answer of the model could not be parsed (in the contract code or in the JSON
  parsing of GenVM).
- Provider error: OpenRouter failed after the retries.
- Other error: any other exception; the text is kept.

The latency of each call to the model is recorded.

Expected correspondence with Bradbury (a hypothesis to test, not an assumption of the analysis):
judge rejection, rule rejection and judge without result -> `DISAGREE`; invalid JSON on the validator
-> `DETERMINISTIC_VIOLATION` or `DISAGREE` depending on where it is raised; locally there is no
`TIMEOUT` (GenVM has no time limit there), so it is compared against the recorded latency.

### Local against Bradbury

Per contract: local committee agreement against "accepted in round 0" on Bradbury, with both
intervals. A difference is declared when the intervals do not overlap. With n = 50 the half-width of
the interval is up to ~14 points (worst case, p = 0.5).

### Known limits (version 2)

- **Models**: locally every validator (and the leader) uses the same model. On Bradbury each
  validator uses its own model and provider, configured on its node and not visible in the
  transaction. Local agreement is that of a homogeneous committee; on Bradbury the committee is
  heterogeneous.
- **Timeouts**: Bradbury has leader and validator timeouts; local runs do not (the latency of each
  call is recorded, with no cut).
- **Majority rule**: taken from the public code of genlayer-studio; Bradbury nodes run genlayer-node
  (not public). The measured data are consistent with that rule.
- **Non-deciding rounds**: only the votes the watcher manages to read while the round is in progress
  are seen (every 5 s); `getTransaction` only returns the current round.

### Execution

- Parallel: 4 deployed copies of each contract (the transaction queue is per contract); calls are
  spread across copies. A single signer: submissions go out in series (nonce) and tracking runs in
  parallel.
- Cost: with parallel submissions the balance difference cannot be attributed to one transaction;
  the total cost per contract is reported.

## Version 2.1 (2026-09-27): corrections made AFTER seeing the data of campaign 1

These corrections were made after seeing the data of campaign 1 (50 tx per contract), not before:
the counting of version 2 did not describe well what happened on the network. They do not change
what was measured, only how it is counted; the report (`scripts/campaign_report.py`) shows both
readings where there is ambiguity. **Version 2.1 is frozen**: the repeat of tribunal (campaign 2) is
analyzed with these same rules. The only difference in campaign 2 is the polling interval (point 6),
which is part of the execution, not of the counting.

1. **The round index does not count attempts.** Leader rotations can happen inside round 0 (company
   #20: 4 proposals in "round 0") and an appeal after a validators timeout skips several indexes.
   "Accepted in round 0" is replaced by **accepted at the first attempt**: a single proposal in the
   timeline and no rotation or appeal.
2. **`VALIDATORS_TIMEOUT` triggers an appeal** (APPEAL_COMMITTING, APPEAL_REVEALING) and the next
   round is voted by a larger committee (11, then 17). Once (tribunal #49) the transaction stayed in
   `VALIDATORS_TIMEOUT` with no appeal (more than 1 h): it counts as no consensus.
3. **Cause of each retry**: `LEADER_TIMEOUT` or `VALIDATORS_TIMEOUT` if they were seen; **votes**
   only if revealed votes were seen in the round that failed; otherwise **unclassified** (polling
   every 5 s can miss a short timeout or a failed round). `getRoundData` does not solve it: a
   rotation overwrites the data of the round.
4. **(b) is reported as a range**: minimum = version 2 literal (only LEADER_TIMEOUT is
   infrastructure; unclassified counts as content); maximum = LEADER_TIMEOUT, VALIDATORS_TIMEOUT and
   unclassified are infrastructure, without the transactions with no consensus by
   VALIDATORS_TIMEOUT.
5. **State numbering**: genlayer-js 1.2.0 matches Bradbury (READY_TO_FINALIZE = 11 before FINALIZED;
   VALIDATORS_TIMEOUT = 12 followed by an appeal; LEADER_TIMEOUT = 13 followed by a new proposal).
   The newer client (consensus v0.6) numbers states differently and does not read Bradbury. State 14
   has no name in any client; by its position (between COMMITTING and a decision) it is inferred to
   be LEADER_REVEALING.
6. For the next run: polling every 1 to 2 s to lower the unclassified retries. Reason: in tribunal,
   11 of 19 retries were unclassified and the comparison with local runs depends on them. RPC limit
   measured before campaign 2 (`scripts/rpc_ratelimit.mjs`): each `getTransaction` is 2 HTTP
   requests; at 1, 2, 4 and 8 `getTransaction` per second (up to 14.5 HTTP requests/s), 0 errors,
   median latency ~0.4 s. It was not pushed further so as not to load a public RPC. Campaign 2: 1 s
   polling with 4 copies = ~4 `getTransaction`/s. Effective resolution ~1.4 s.
7. Also reported, per contract: how many transactions went through an appeal (APPEAL_* states) and
   the size of the committee that decided. Reason: appeals change the committee (5 -> 11 -> 17) and
   with it the meaning of the per-vote shares.

### Validity of rows (not a counting rule)

Rows that did not measure what they claim to measure are excluded, and the report says how many and
which. Campaign 1, tribunal: 4 rows (#3, #21, #31, #47) sent `resolve_dispute` to a dispute already
resolved (the launcher read `list_disputes` right after ACCEPTED and the node still returned the old
list). The contract rejects with UserError, the validators agree on the error and the transaction
ends ACCEPTED without calling the LLM. Tribunal campaign 1 is left with 46 valid transactions. Fixed
in the launcher for campaign 2 (it waits for the new id and marks `invalidMeasurement` if the
resolve does not end FINISHED_WITH_RETURN).

From Phase 1 on, the rule is general: a transaction whose execution does not end
`FINISHED_WITH_RETURN` is flagged as an invalid row and reported apart.

## Version 3 (2026-09-27): DETERMINISTIC_VIOLATION experiment (fixed BEFORE running)

Goal: find where the `DETERMINISTIC_VIOLATION` (DV) votes come from. Campaigns 1 and 2 are reported
separately; the difference between them is a finding and they are not pooled.

**Contracts** (`contracts/dv/`, v0.2 runner `1j12s63`, same state write: they store a label and add
one call; same input: the fixed review `DV_REVIEW` of `scripts/bradbury_campaign.mjs`):

- **A** `dv_a_deterministic.py`: no LLM and no non-deterministic block; the label comes from counting
  words. It measures the base DV rate of the network.
- **B** `dv_b_word.py`: one LLM call, a one-word answer from a closed list (positive/negative), no
  JSON and no parsing; leader and validators compare the word inside `gl.vm.run_nondet`.
- **C** `dv_c_json.py`: one LLM call with a JSON answer parsed with `json.loads` inside
  `gl.vm.run_nondet` (the pattern of company); validators compare the parsed label.

**Execution**: 50 tx per contract, 1 s polling, the three in parallel in the same time window. 2
copies per contract (6 in flight at once = ~6 `getTransaction`/s, within the 8/s measured without
errors). Campaign `dv1` (`results/bradbury/campaign-dv{A,B,C}-dv1.jsonl`). Counting of attempts,
causes and row validity: version 2.1 unchanged.

**Recorded per transaction** (in addition to version 2.1):

- At each change of the timeline, the vote and the **result hash of each voter** and the index of
  the leader (so the rounds that fail before rotating are kept too).
- The non-deterministic output of the leader (`eqBlocksOutputs`) and `txExecutionHash`.
- The identity of each validator: the operator name the validator declares. **The GenVM version of
  the nodes is not visible** on chain or in genlayer-js (`getValidatorInfo` gives identity, stake
  and status, no version).

**Metrics**:

1. **DV rate per vote**: DV votes / votes with content (AGREE + DISAGREE + DV) over **all the
   revealed votes observed** (deciding round and failed rounds). Main metric.
2. **Transactions with at least one DV** in any observed round / 50.
3. Version 2.1 metrics per contract: accepted at the first attempt, after retry, no consensus,
   causes, votes by category, latency.
4. **Hashes in the rounds with DV**: whether the DV voters share one hash (a single alternative to
   the leader's result) or have different hashes; whether the DV hash matches the fixed hash of
   TIMEOUT.
5. **DV per operator**: DV / votes of each operator; concentration is flagged if 2 operators or
   fewer add up to at least half of the DV.

**Reading (fixed before running)**:

- **A with DV** (at least one DV in A): there is DV from the network, independent of the LLM. Its
  rate is the base against which B and C are compared.
- **A without DV and only C with DV**, with the interval of C above those of A and B (no overlap):
  the DV comes from the parsing in the contract.
- **B above A** (no overlap): DV appears with the LLM even with no parsing.
- Overlapping intervals: no evidence of a difference with n = 50.
- If the DV voters of a round share a hash, they computed the same alternative result (the leader is
  the different one); if they differ, each validator diverges on its own.

**Earlier reference** (campaigns 1 and 2, context only, not part of the experiment): 49 DV votes in
15 of 24 validators, including 4 `genlayerlabs-validator-*` nodes; the highest: AURORAX, 11 of 40
votes (28%).

**Limits**: the GenVM version of each node cannot be seen, so the hypothesis "nodes with different
versions" cannot be confirmed or ruled out directly; A is the indirect test. The result hash does
not say what each validator computed, only whether it matches.

## Version 4 (2026-09-27): final campaign (fixed BEFORE running)

**Composition**: wizard and company with 2 copies each and control A (`dv_a_deterministic.py`, no
LLM) with 1 copy, same time window, 1 s polling, 50 tx per contract, campaign `final`. 5 tx in
flight; A finishes fast, so polling stays at ~5 to 7 `getTransaction`/s, under the tested maximum of
8/s.
**Tribunal is not repeated**: on the current Bradbury node `emit_transfer` does not deliver value
(genlayerlabs/genvm-manager issue #20), so the 1 GEN bond of each complaint is not recovered.
Tribunal is reported with campaigns 1 and 2, separately. It is a limit of the network, not of the
method.

Counting of attempts, retry causes and row validity: version 2.1 unchanged.

**Vote categories** (over all the revealed votes observed: deciding round and failed rounds; one
vote per voter and per attempt):

- **Content disagreement**: `DISAGREE`.
- **Execution divergence**, in four subcategories:
  - **Type 1 DV, a single validator**: a `DETERMINISTIC_VIOLATION` vote in a round with at least one
    `AGREE`, with a result hash different from that of the `AGREE` votes.
  - **Type 2 DV, everyone against the leader**: a round with no validator `AGREE`, with 2 or more DV
    votes sharing one hash. Every DV vote of that round counts.
  - **TIMEOUT**: a `TIMEOUT` vote.
  - **Untyped DV**: any other DV (for example a single DV with no `AGREE` in the round, or DV votes
    with different hashes and no `AGREE`).
- `AGREE`.

Also, per transaction: **LEADER_TIMEOUT** (number of retries caused by a leader timeout, as in
version 2.1).

**Metrics per contract**:

1. Share of votes in each category and subcategory over the total of observed votes.
2. Content disagreement rate = DISAGREE / total votes.
3. Execution divergence rate = (type 1 DV + type 2 DV + untyped DV + TIMEOUT) / total.
4. Transactions with at least one retry by LEADER_TIMEOUT / 50.
5. Per transaction (version 2.1): accepted at the first attempt, after retry, no consensus, and the
   cause of each retry, where a retry "by votes" is split into: **content** (there was a revealed
   DISAGREE in the round that failed), **type 2 DV** (the failed round has the type 2 pattern) or
   **unclassified votes**.
6. Latency to ACCEPTED (median, p90, max).

**Per operator** (declared name; the GenVM version is not visible): total votes, DV, TIMEOUT, with
the DV rate and the TIMEOUT rate of each operator and its interval. An operator is flagged when the
lower bound of its interval exceeds the rate of all the other operators together.

**Control A**: 0 DV and 0 TIMEOUT are expected (version 3: 0/250). If A shows execution divergence
in this window, it is reported as present without LLM in that window and subtracted as a reference
when reading the others.

**Wording of conclusions**: "content disagreement" and "execution divergence" are used. Divergence
is not attributed to infrastructure: the cause inside the node is a hypothesis (the GenVM version
and the LLM provider of each node are not visible).

**Earlier data**: not rewritten. A re-read of campaigns 1, 2 and dv1 with version 4 goes apart
(`results/bradbury/annex-reread-v4.txt`), as a secondary analysis marked "after seeing the data".
Limit of that re-read: campaigns 1 and 2 did not store hashes in the rounds that failed (only in the
deciding round), so there the DV type of a failed round can only be inferred from the vote pattern,
without comparing hashes.

## Version 5 (2026-09-28): first attempt (fixed BEFORE the first prediction)

Fixed after seeing window V1 and before pre-registering the prediction of V2. It applies to the 6
windows of Phase 1 (V1 included). Phase 0 is not rewritten: its difference is reported in an annex.

- **Accepted at the first attempt (v5)** = ACCEPTED, with no retries according to `attempts()` of
  version 2.1, **and with no LEADER_TIMEOUT or VALIDATORS_TIMEOUT in the timeline**.
- Reason [measured]: `attempts()` only counts a retry if it sees a new PROPOSING. When the leader
  times out in 3 to 8 s, the next PROPOSING can pass between two 1 s polls, and the transaction
  counted as accepted at the first attempt although the chain showed LEADER_TIMEOUT. V1: wizard 1,
  dvB 4; in Phase 0, campaign `final`: wizard 1; campaign 1 (5 s polling): wizard 5 (92% -> 82%)
  and company 1; the rest 0 (annex `results/bradbury/annex-phase0-v5.txt`).
- In the retry causes, that case appears as `LEADER_TIMEOUT (no PROPOSING seen)`.
- Code: `attempts_v5()` in `scripts/campaign_report.py` (the `attempts()` of versions 2.1 and 4 does
  not change).

## Version 6 (2026-09-30): counting from consensus events

For the public page. Phase 1 stays on version 5. The page counts
with version 6 since 2026-10-01.

**Source.** The events of the Bradbury consensus contract, read with `eth_getLogs`, instead of
polling `getTransaction`. Verified against the launcher on the 200 transactions of window V6: the
vote counts by type match exactly in 182, and in the other 18 the events carry more votes, never
fewer (rounds and appeals that 1 s polling did not get to see). Events also show canceled
transactions that `getTransaction` no longer returns.

- `VoteRevealed(txId, validator, voteType, isLastVote, result)`. `voteType`: 0 NOT_VOTED, 1 AGREE, 2
  DISAGREE, 3 TIMEOUT, 4 DETERMINISTIC_VIOLATION. `result` (on the last vote): 0 IDLE, 1 AGREE, 2
  DISAGREE, 3 TIMEOUT, 4 DETERMINISTIC_VIOLATION, 5 NO_MAJORITY, 6 MAJORITY_AGREE, 7
  MAJORITY_DISAGREE.
- Leader and attempts: `TransactionActivated(txId, leader)`, `TransactionLeaderRotated(txId,
  newLeader)`, `TransactionLeaderTimeout(txId)` (charged to the leader in place),
  `TransactionReceiptProposed(txId, validators)` (the committee), `AppealStarted`,
  `TransactionNeedsRecomputation`, `TransactionUndetermined`, `TransactionCancelled`.

**Rule.**

- The `TransactionAccepted` event marks the end of a round, not consensus: it is also emitted when
  the round ends by validators timeout. The result of the round is in the last revealed vote
  (`VoteRevealed` with `isLastVote`, same block). A round is a real acceptance only when that result
  is AGREE (or MAJORITY_AGREE).
- **Accepted at the first attempt**: the first real acceptance comes after exactly one proposal and
  with no leader timeout, leader rotation, appeal, recomputation or validators-timeout round before
  it. Accepted otherwise: **after retry**.
- **The final decision rules**: a transaction whose last decision is a validators timeout, an
  undetermined result or a cancellation is **no consensus**, also when it had been accepted before
  and an appeal overturned it. An appeal that confirms the acceptance keeps its classification.
- No decision yet: **in progress**. A transaction whose start was not observed is partial and is not
  classified. A round end whose result was not seen is read from the chain.

**Retry causes** that events can count: leader timeout, no majority (the leader was rotated),
appeal, and recomputation.

**Version 5 against version 6** [measured]: on the 728 valid transactions with LLM of windows V2 to
V6, both agree on 721. The 7 differences are failed attempts that 1 s polling did not see (a leader
timeout in under 3 s, a rotation, or a validators timeout followed by an appeal); polling counted
them as first attempts. Detail in [SENSITIVITY.md](SENSITIVITY.md).

Code: `collector/core/events.js`.

## Rules of the page (2026-10-02)

The page counts transactions with version 6. These are its other rules, with the constants that
implement them.

- **Views.** A view is one epoch or the last 24 hours. A transaction belongs to the epoch and the
  clock hour in which it was created; "last 24 hours" counts whole clock hours, so it can include up
  to one hour more.
- **Created.** A transaction emits `NewTransaction` when it enters consensus. One that has to wait
  behind earlier transactions of the same contract also emits `CreatedTransaction` when it is sent;
  one that enters at once does not (measured: 25 of 25 transactions in 6,000 blocks on 2026-10-05
  emitted only `NewTransaction`). The transaction counts as created when it enters consensus: its
  block, time, epoch and hour, and the time to acceptance, start at `NewTransaction`. The wait is
  kept apart (`queue_seconds` in the data files, 0 for a transaction that entered at once). Before this rule the block and time
  of creation were those of `CreatedTransaction` while the epoch and hour were those of
  `NewTransaction`; 2 of 3,459 transactions waited across an epoch change and were missing from
  the data files. The stored transactions were corrected.
- **Queued.** A transaction that was sent and has not entered consensus. `CreatedTransaction` does
  not carry the recipient, so it is read once from the transaction that sent it. A queued
  transaction counts as in progress in the epoch and hour of the block that sent it, and moves to
  those where it enters consensus. One cancelled before entering ends as no consensus. Measured
  case: after a transaction of a copy of company_naming stayed undetermined for 24 hours
  (2026-09-29 to 2026-09-30), the next transactions sent to that copy emitted only
  `CreatedTransaction`, and one was cancelled when the first one closed.
- **Campaign transaction.** Sent by the campaign wallet to a copy of a reference contract. Any other
  transaction to those contracts counts only as network.
- **Health labels.** HEALTHY: first-attempt acceptance of 90% or more. DEGRADED: 70 to 90%. FAILING:
  below 70%. Fixed thresholds chosen by this project; they apply to acceptance rates, never to an
  operator. The badge of a contract uses the same thresholds.
- **Above rest.** An operator is marked when the lower bound of the 95% Clopper-Pearson interval of
  its timeout rate on campaign contracts with LLM calls is above the rate of all other operators in
  the view. With fewer than 10 such votes it is shown as "Too few votes to compare" and is never
  marked (`MIN_VOTES` in `probe-static/data.js`).
- **Eligible validator.** In the active list of the staking contract, not in its banned list and
  with no quarantine in effect. The quarantine records are kept after they expire: one "until epoch
  N" stops applying when epoch N starts (`inEffect` in `collector/core/staking.js`).
- **Committee selection check.** The first leader of each campaign transaction against the eligible
  set in effect at its block, with a chi-square goodness-of-fit test. The eligible set is stored
  each time its validators change and at each epoch change; a change that is not an epoch change is
  seen with up to 5 minutes of delay.
- **Stalled contract.** Five transactions in a row without a vote on any transaction of the
  contract, the fifth one over 60 minutes old (`STALL_STREAK`, `STALL_SECONDS` in
  `collector/worker/src/collect.js`). A transaction that stays idle or queued counts as one
  without a vote.
  The contract recovers at the next vote.
- **Campaigns.** Running: one of its transactions had an event in the last 10 minutes. Two
  campaigns: campaign transactions created more than 30 minutes apart. Failed: the 3-hour slot of
  the day ended more than 30 minutes ago and no campaign transaction was seen in it
  (`CAMPAIGN_RUNNING_SECONDS`, `CAMPAIGN_GAP_SECONDS`, `CAMPAIGN_GRACE_SECONDS` in
  `collector/worker/src/api.js`).
- **RPC incident.** Opens when two runs of the collector in a row get an answer that is not JSON and
  closes after five clean runs. Other errors are not counted (`RPC_OPEN_RUNS`, `RPC_CLOSE_RUNS`).
- **Stale data.** A block of the page is marked when its source has not been updated for 10 minutes
  ([NET] and [CHAIN]) or 30 hours ([CAMP]) (`STALE_S` in `probe-static/data.js`).
- **Accepted with execution error.** Versions 4 and 5 counted these apart from the execution result
  of each transaction. Consensus events do not carry that result, so the page does not separate
  them: they count as accepted.
