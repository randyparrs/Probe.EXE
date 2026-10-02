# Probe.EXE

Probe.EXE measures how reliably Intelligent Contracts that call an LLM reach consensus on GenLayer's
Bradbury testnet, per operator and over time. It is a public network health page,
[probe-exe.pages.dev](https://probe-exe.pages.dev), with every number traceable to its source.

## What it does today

- **Daily campaign** (`collector/campaign/`, `.github/workflows/campaign.yml`): once a day, at an hour
  that rotates across 8 slots, it sends calls to reference contracts (three that call an LLM and one
  control that does not, `collector/campaign/contracts.json`) and follows each transaction until it is
  accepted or ends without consensus. It records every vote, the committee and the leader of every
  attempt, the epoch and the eligible validator set, and afterwards the consensus events of its own
  transactions. An external cron (cron-job.org) triggers the workflow; the campaign uses a testnet-only
  wallet.
- **Passive collector** (`collector/worker/`, `collector/core/`): a Cloudflare Worker that runs every
  minute, reads the consensus events of every transaction on the network and the validator lists of
  the staking contract, and keeps them in a D1 database. It only reads the chain.
- **Page** (`probe-static/`, `pages/`): static files plus one function that serves the read-only API
  of the collector from the page's own address. "How it works" on the page explains every number.
- **Daily data files** (`collector/export/`, `.github/workflows/export.yml`): every transaction the
  page has observed, in the `data` branch.

How the parts fit together and how each number gets to the page:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). `npm test` runs the tests of the collector, the API and
the export.

## Phases

The documents in `docs/` and the data in `results/` refer to two phases of measurements:

- **Phase 0** (September 25 to 28, 2026): exploratory campaigns on Bradbury. They fixed how
  outcomes are counted ([docs/METRICS.md](docs/METRICS.md), versions 1 to 4).
- **Phase 1** (September 28 to 30, 2026): validation of the prediction model over six windows, with
  pre-registered predictions ([docs/VALIDATION-REPORT.md](docs/VALIDATION-REPORT.md),
  [docs/SENSITIVITY.md](docs/SENSITIVITY.md)).

## Data and pre-registration

`results/` holds the measurement data cited in `docs/`. The predictions of Phase 1 were
pre-registered with the SHA-256 of the data and code they used.

**Pre-registered files are published unmodified**: every file whose SHA-256 is listed in the
pre-registration is published byte for byte, as it was when its hash was recorded. Some of them
mention internal working notes that are not part of this repository. Third-party files that cannot
be redistributed are obtained from their original at the exact commit, with their SHA-256
(`contracts/SOURCES.md`).

There is one exception: `harness/contracts.py`. The pre-registered file carried four lines
taken from a repository with no license, so it is published with those lines replaced by markers.
`python harness/restore_contracts.py` downloads the original at the exact commit, puts the lines
back and checks that the result has the pre-registered SHA-256.

Two things in `results/` are in Spanish and are published as they were recorded:

- Run tags starting with `prueba` (Spanish for "test") mark test runs. They are kept in the raw
  data unmodified and are not used in any of the published analyses.
- `results/bradbury/validation-final.txt` is the literal output of the frozen evaluation script,
  which labels the metric version as METRICAS v5 (Spanish). It is published unmodified.

## Data files

The [`data` branch](https://github.com/randyparrs/Probe.EXE/tree/data) holds every transaction the
page has observed, one pair of files per epoch: `epoch-N.csv` and `epoch-N.jsonl`, listed in
`index.json` (`{ updated, files: [{ epoch, csv, jsonl, rows }] }`). A workflow writes them once a day
(`.github/workflows/export.yml`, `collector/export/export.mjs`) from the public API of the page:
`GET /api/export?epoch=N` returns 200 transactions per page and a `next` value to pass as `&after=`
for the following page. The epoch in progress is rewritten every day. A closed epoch is rewritten
only when its rows changed (a transaction that ended after the epoch closed), and the commit message
says what changed.

One row per transaction, in creation order. Times are Unix seconds (UTC).

| Column | Meaning |
|---|---|
| `tx_id` | Transaction id on GenLayer. |
| `epoch` | Epoch in effect when the transaction was created. |
| `contract` | Address of the contract the transaction calls. |
| `llm` | `llm`: the contract code contains an LLM call (`exec_prompt`, `prompt_comparative` or `prompt_non_comparative`). `none`: it does not. `na`: the code could not be read. Empty: not read yet. |
| `campaign` | Name of the reference contract when the transaction was sent by the campaign wallet to one of its copies. Empty for every other transaction. |
| `created` | Time of the block that created the transaction. |
| `created_block` | Number of that block. |
| `status` | `first`: accepted at the first attempt. `retry`: accepted after a retry. `none`: ended without consensus (validators timeout, undetermined, cancelled, or an acceptance overturned by an appeal). `pending`: no decision yet. `unknown`: a round ended and its result was not observed. |
| `accepted` | Time of the first real acceptance. Empty when there was none. |
| `accept_seconds` | `accepted` minus `created`. |
| `leader_timeouts` | Leader timeouts before the first acceptance. |
| `rotations` | Leader rotations before the first acceptance. |
| `appeals` | Appeals started before the first acceptance. |
| `recomputations` | Times the transaction was sent back to be executed again, before the first acceptance. |
| `votes_agree` | Votes revealed as AGREE, over all its attempts. |
| `votes_disagree` | Votes revealed as DISAGREE. |
| `votes_dv` | Votes revealed as DETERMINISTIC_VIOLATION (execution divergence). |
| `votes_timeout` | Votes revealed as TIMEOUT. |

The JSON Lines file has the same fields and one more, `attempts`: the list of attempts of the
transaction, each with its `leader`, whether the leader timed out (`leader_timeout`), the `result`
of the round (`agree`, `disagree`, `timeout`, `dv`, `no_majority`, `majority_agree`,
`majority_disagree`, `idle`, or null when the round did not end) and its `votes` as pairs of
validator address and vote (`agree`, `disagree`, `timeout`, `dv`, `not_voted`).

The counting rules are in [docs/METRICS.md](docs/METRICS.md). Transactions that started before the
page began observing (2026-10-01) are not exported.

## API

The page serves a read-only JSON API from its own address. It needs no key and can be called from
any origin. It returns counts and rates; the intervals shown on the page are computed from the
counts (Clopper-Pearson, `probe-static/stats.js`).

| Endpoint | Returns |
|---|---|
| `GET /api/meta` | Last update per source, current epoch, list of epochs, RPC state. |
| `GET /api/tape` | The last 40 network transactions with their result. |
| `GET /api/overview?view=` | First-attempt acceptance of the campaign (with LLM and control) and of the network, votes by type, retry causes, time to acceptance, validator counts, last campaign. |
| `GET /api/contracts?view=` | Reference contracts, every contract of the network with its LLM label, and contracts that stopped making progress. |
| `GET /api/operators?view=` | One row per validator: votes by type on campaign contracts with LLM, on the control and on the whole network, leader rounds and leader timeouts, status, stake, selection weight, first-leader counts against the expected ones, and a series by epoch. |
| `GET /api/events?view=&type=&before=` | The event log, 50 per page. `type`: `epochs`, `validators`, `contracts`, `campaigns` or `rpc`. `before`: the `next` value of the previous page. |
| `GET /api/badge/{contract}.svg` | An SVG badge with the first-attempt acceptance of a contract in the current epoch, colored like the health labels of the page. |
| `GET /api/export?epoch=&after=` | Every transaction of an epoch with its attempts and votes, 200 per page. `after`: the `next` value of the previous page. Columns: see Data files. |

`view` is `epoch:168` (one epoch) or `24h` (the last 24 hours); without it the answer is for the
current epoch.

```bash
curl "https://probe-exe.pages.dev/api/operators?view=epoch:168"
```

A badge can be embedded in any README or page; the Contracts section of the page has a `[badge]`
button on each contract that copies this Markdown:

```markdown
[![Probe.EXE first attempt](https://probe-exe.pages.dev/api/badge/0x27490261a2d0BEfb37A136C7eabE38f402aDB008.svg)](https://probe-exe.pages.dev/#f2)
```

Responses are cached: 60 seconds for `/api/meta` and `/api/tape`, 300 seconds for the rest. Requests
answered from the cache are not limited. Requests that are not in the cache are limited to 120 per
minute from one address; over the limit the API answers 429 with a `Retry-After` header. For bulk
use, take the daily data files instead.

## Not in this version

Alerts are out of scope for this version. The read-only API of the page is meant to let others build
them.

Future work: the latency of the transactions that cross an epoch change, as part of the summary of
each epoch change in Events.

## License

MIT
