-- Store of the collector (Cloudflare D1).
--   npx wrangler d1 execute probe-exe --local --file=schema.sql      (from collector/worker)

-- key/value. cursor: last block whose consensus events are stored. epoch: epoch in effect at the
-- cursor. epoch_back: next block to look at, going backwards, for the start of the oldest known
-- epoch (-1 when found or given up).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- raw consensus events, as decoded from eth_getLogs
CREATE TABLE IF NOT EXISTS events (
  block     INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  ts        INTEGER,            -- block timestamp, seconds
  name      TEXT NOT NULL,
  tx_id     TEXT,               -- null when the event carries a list of transactions
  args      TEXT NOT NULL,      -- JSON
  PRIMARY KEY (block, log_index)
) WITHOUT ROWID;

-- one row per transaction: the state built from its events (collector/core/events.js)
CREATE TABLE IF NOT EXISTS tx (
  tx_id           TEXT PRIMARY KEY,
  recipient       TEXT,         -- contract address; null when the start was not observed
  status          TEXT NOT NULL,-- first | retry | none | pending | partial | unknown
  first_block     INTEGER,
  first_ts        INTEGER,
  last_block      INTEGER,
  last_ts         INTEGER,
  accepted_ts     INTEGER,
  epoch           INTEGER,      -- epoch in effect when the transaction was created
  hour            INTEGER,      -- first_ts / 3600: the bucket of the hourly counters
  sender          TEXT,         -- read only for transactions to a reference contract
  camp            TEXT,         -- reference contract name when sent by the campaign wallet
  leader_timeouts INTEGER NOT NULL DEFAULT 0,   -- before the first acceptance
  rotations       INTEGER NOT NULL DEFAULT 0,
  appeals         INTEGER NOT NULL DEFAULT 0,
  recomputations  INTEGER NOT NULL DEFAULT 0,
  accept_secs     INTEGER,      -- accepted_ts - first_ts
  state           TEXT NOT NULL -- JSON
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tx_first_block ON tx (first_block);
CREATE INDEX IF NOT EXISTS tx_camp ON tx (epoch, hour) WHERE camp IS NOT NULL;

-- hourly counters per contract. camp = 1: sent by the campaign wallet to a reference contract.
-- Transactions in progress = tx - first - retry - none.
CREATE TABLE IF NOT EXISTS contract_hour (
  epoch     INTEGER NOT NULL,
  hour      INTEGER NOT NULL,
  contract  TEXT NOT NULL,
  camp      INTEGER NOT NULL,
  tx        INTEGER NOT NULL DEFAULT 0,
  first     INTEGER NOT NULL DEFAULT 0,   -- accepted at the first attempt
  retry     INTEGER NOT NULL DEFAULT 0,   -- accepted after a retry
  none      INTEGER NOT NULL DEFAULT 0,   -- no consensus
  cancelled INTEGER NOT NULL DEFAULT 0,   -- of those: cancelled, or ended without any vote
  last_ts   INTEGER,
  agree     INTEGER NOT NULL DEFAULT 0,   -- votes revealed on these transactions, by type
  disagree  INTEGER NOT NULL DEFAULT 0,
  dv        INTEGER NOT NULL DEFAULT 0,
  timeout   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (epoch, hour, contract, camp)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS contract_hour_camp ON contract_hour (epoch) WHERE camp = 1;

-- hourly counters per validator. src: net | camp_llm | camp_control.
CREATE TABLE IF NOT EXISTS op_hour (
  epoch           INTEGER NOT NULL,
  hour            INTEGER NOT NULL,
  src             TEXT NOT NULL,
  validator       TEXT NOT NULL,
  votes           INTEGER NOT NULL DEFAULT 0,
  agree           INTEGER NOT NULL DEFAULT 0,
  disagree        INTEGER NOT NULL DEFAULT 0,
  dv              INTEGER NOT NULL DEFAULT 0,   -- deterministic violation
  timeout         INTEGER NOT NULL DEFAULT 0,
  led             INTEGER NOT NULL DEFAULT 0,   -- attempts as leader
  leader_timeouts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (epoch, hour, src, validator)
) WITHOUT ROWID;

-- start of each epoch, from the EpochAdvance event of the staking contract
CREATE TABLE IF NOT EXISTS epochs (
  epoch       INTEGER PRIMARY KEY,
  start_block INTEGER NOT NULL,
  start_ts    INTEGER
) WITHOUT ROWID;

-- every contract that received a transaction. llm: llm | none | na (code not available);
-- null until its code is read.
CREATE TABLE IF NOT EXISTS contracts (
  address    TEXT PRIMARY KEY,
  llm        TEXT,
  checked_ts INTEGER,
  ref_name   TEXT              -- reference contract name, for the copies of the campaign
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS contracts_pending ON contracts (checked_ts) WHERE llm IS NULL;

-- validators: the sets they are in (read every five minutes) and their stake and declared name
-- (a few validators per run). Stakes in wei, as text.
CREATE TABLE IF NOT EXISTS validators (
  address         TEXT PRIMARY KEY,
  moniker         TEXT,
  self_stake      TEXT,
  delegated_stake TEXT,
  live            INTEGER,
  primed_epoch    INTEGER,
  active          INTEGER NOT NULL DEFAULT 0,
  quarantined     INTEGER NOT NULL DEFAULT 0,   -- a quarantine record in effect; expired records do not count
  banned          INTEGER NOT NULL DEFAULT 0,
  banned_until    INTEGER,          -- epoch the ban ends; 0 when the ban is permanent
  info_ts         INTEGER           -- last read of stake and name
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS op_hour_validator ON op_hour (validator, epoch);

-- The eligible set: the validators that are active, not banned and with no quarantine in effect,
-- with their selection weight.
-- One row each time it changes and at each epoch change. block: the block it is in effect from
-- (the start of the epoch, or the block the validator lists were read at).
CREATE TABLE IF NOT EXISTS eligible_set (
  block   INTEGER PRIMARY KEY,
  ts      INTEGER,
  epoch   INTEGER,
  members TEXT NOT NULL             -- JSON: [[address, weight], ...]; weight null until the stake is read
) WITHOUT ROWID;

-- First leader of the campaign transactions against the eligible set in effect at their block,
-- per hour and validator. first: transactions whose first leader was the validator. expected: the
-- sum, over the campaign transactions, of its weight divided by the total weight of the set.
CREATE TABLE IF NOT EXISTS leader_draw (
  epoch     INTEGER NOT NULL,
  hour      INTEGER NOT NULL,
  validator TEXT NOT NULL,
  first     INTEGER NOT NULL DEFAULT 0,
  expected  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (epoch, hour, validator)
) WITHOUT ROWID;

-- what happened, for the Events section: changes of the eligible set, quarantines, bans, and
-- contracts that stall or recover. Epoch changes, campaigns and RPC incidents are
-- not stored here: the API derives them from epochs, tx and runs.
CREATE TABLE IF NOT EXISTS log (
  id   INTEGER PRIMARY KEY,
  ts   INTEGER NOT NULL,
  type TEXT NOT NULL,               -- eligible | quarantined | banned | stalled | recovered
  data TEXT NOT NULL                -- JSON
);
CREATE INDEX IF NOT EXISTS log_ts ON log (ts);

-- Progress of each contract. streak: transactions created in a row while no transaction of the
-- contract received a vote (a vote on any of them resets it). A contract is stalled when the streak
-- reaches five and the fifth one is over an hour old; it recovers at the next vote. One row keeps
-- the last stall of the contract; every stall and recovery is also in `log`.
CREATE TABLE IF NOT EXISTS contract_stall (
  address      TEXT PRIMARY KEY,
  streak       INTEGER NOT NULL DEFAULT 0,
  streak_ts    INTEGER,             -- creation of the first transaction of the streak
  fifth_ts     INTEGER,             -- creation of the fifth one
  since_ts     INTEGER,             -- streak_ts of the last stall
  stalled_ts   INTEGER,             -- when the last stall was detected; null when there was none
  stalled_tx   INTEGER,             -- transactions without a vote when it recovered
  recovered_ts INTEGER              -- first vote after the stall; null while it lasts
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS contract_stall_due ON contract_stall (fifth_ts) WHERE fifth_ts IS NOT NULL;

-- one row per scheduled run: what it read and what it cost
CREATE TABLE IF NOT EXISTS runs (
  ts           INTEGER PRIMARY KEY,  -- scheduled time, seconds
  from_block   INTEGER,
  to_block     INTEGER,
  tip          INTEGER,
  logs         INTEGER NOT NULL,
  txs          INTEGER NOT NULL,
  rpc_calls    INTEGER NOT NULL,     -- HTTP requests to the RPC
  rpc_ms       INTEGER NOT NULL,
  non_json     INTEGER NOT NULL,     -- RPC answers that were not JSON
  rows_written INTEGER,
  error        TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS runs_non_json ON runs (ts) WHERE non_json > 0;
