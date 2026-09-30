# Probe.EXE

**Work in progress.** Probe.EXE measures how reliably Intelligent Contracts that call an LLM reach
consensus on GenLayer's Bradbury testnet, per operator and over time. The goal is a public network
health page with every number traceable to its source.

## What it does today

- **Daily campaign** (`collector/campaign/`, `.github/workflows/campaign.yml`): once a day, at an hour
  that rotates across 8 slots, it sends calls to reference contracts (three that call an LLM and one
  control that does not, `collector/campaign/contracts.json`) and follows each transaction until it is
  accepted or ends without consensus. It records every vote, the committee and the leader of every
  attempt, the epoch and the eligible validator set, and afterwards the consensus events of its own
  transactions. An external cron (cron-job.org) triggers the workflow; the campaign uses a testnet-only
  wallet.
- Results are kept as workflow artifacts for now.

## Coming next

- A passive observer (Cloudflare Worker) that reads the consensus events of every transaction on the
  network, and a shared data store.
- The public health page.

## License

MIT
