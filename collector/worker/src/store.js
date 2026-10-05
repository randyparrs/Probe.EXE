// D1 store of the collector. Lists travel as one JSON parameter expanded with json_each, so a run
// costs a fixed number of queries whatever the number of events (D1 limits the queries per
// invocation and allows 100 bound parameters per query).

const col = (i) => `json_extract(value, '$[${i}]')`;
const cols = (n) => Array.from({ length: n }, (_, i) => col(i)).join(", ");

const SAVE_EVENTS = `INSERT OR IGNORE INTO events (block, log_index, ts, name, tx_id, args)
  SELECT ${cols(6)} FROM json_each(?1)`;

const SAVE_TXS = `INSERT INTO tx (tx_id, recipient, status, first_block, first_ts, last_block, last_ts, accepted_ts,
    epoch, hour, sender, camp, leader_timeouts, rotations, appeals, recomputations, accept_secs, state)
  SELECT ${cols(18)} FROM json_each(?1) WHERE true
  ON CONFLICT (tx_id) DO UPDATE SET recipient = excluded.recipient, status = excluded.status,
    first_block = excluded.first_block, first_ts = excluded.first_ts, last_block = excluded.last_block,
    last_ts = excluded.last_ts, accepted_ts = excluded.accepted_ts,
    epoch = excluded.epoch, hour = excluded.hour, sender = excluded.sender, camp = excluded.camp,
    leader_timeouts = excluded.leader_timeouts, rotations = excluded.rotations, appeals = excluded.appeals,
    recomputations = excluded.recomputations, accept_secs = excluded.accept_secs, state = excluded.state`;

// the rows carry differences: they are added to what is stored
const SAVE_CONTRACT_HOUR = `INSERT INTO contract_hour (epoch, hour, contract, camp, tx, first, retry, none, cancelled, last_ts,
    agree, disagree, dv, timeout)
  SELECT ${cols(14)} FROM json_each(?1) WHERE true
  ON CONFLICT (epoch, hour, contract, camp) DO UPDATE SET tx = tx + excluded.tx, first = first + excluded.first,
    retry = retry + excluded.retry, none = none + excluded.none, cancelled = cancelled + excluded.cancelled,
    last_ts = max(coalesce(last_ts, 0), excluded.last_ts), agree = agree + excluded.agree,
    disagree = disagree + excluded.disagree, dv = dv + excluded.dv, timeout = timeout + excluded.timeout`;

const SAVE_OP_HOUR = `INSERT INTO op_hour (epoch, hour, src, validator, votes, agree, disagree, dv, timeout, led, leader_timeouts)
  SELECT ${cols(11)} FROM json_each(?1) WHERE true
  ON CONFLICT (epoch, hour, src, validator) DO UPDATE SET votes = votes + excluded.votes, agree = agree + excluded.agree,
    disagree = disagree + excluded.disagree, dv = dv + excluded.dv, timeout = timeout + excluded.timeout,
    led = led + excluded.led, leader_timeouts = leader_timeouts + excluded.leader_timeouts`;

const SAVE_EPOCHS = `INSERT OR IGNORE INTO epochs (epoch, start_block, start_ts) SELECT ${cols(3)} FROM json_each(?1)`;

const SAVE_CONTRACTS = `INSERT OR IGNORE INTO contracts (address, ref_name) SELECT ${cols(2)} FROM json_each(?1)`;

const SAVE_LABELS = `UPDATE contracts SET llm = json_extract(j.value, '$[1]'), checked_ts = ?2
  FROM json_each(?1) AS j WHERE contracts.address = json_extract(j.value, '$[0]')`;

const SAVE_VALIDATOR_SETS = `INSERT INTO validators (address, active, quarantined, banned, banned_until)
  SELECT ${cols(5)} FROM json_each(?1) WHERE true
  ON CONFLICT (address) DO UPDATE SET active = excluded.active, quarantined = excluded.quarantined,
    banned = excluded.banned, banned_until = excluded.banned_until`;

// a value that could not be read keeps what was stored
const SAVE_VALIDATOR_INFO = `UPDATE validators SET moniker = coalesce(json_extract(j.value, '$[1]'), moniker),
    self_stake = coalesce(json_extract(j.value, '$[2]'), self_stake), delegated_stake = coalesce(json_extract(j.value, '$[3]'), delegated_stake),
    live = coalesce(json_extract(j.value, '$[4]'), live), primed_epoch = coalesce(json_extract(j.value, '$[5]'), primed_epoch), info_ts = ?2
  FROM json_each(?1) AS j WHERE validators.address = json_extract(j.value, '$[0]')`;

// an entry carries its own time, or takes the time of the run
const SAVE_LOG = `INSERT INTO log (ts, type, data) SELECT coalesce(${col(2)}, ?2), ${cols(2)} FROM json_each(?1)`;

const STALL_COLUMNS = ["address", "streak", "streak_ts", "fifth_ts", "since_ts", "stalled_ts", "stalled_tx", "recovered_ts"];
const SAVE_STALLS = `INSERT INTO contract_stall (${STALL_COLUMNS.join(", ")})
  SELECT ${cols(STALL_COLUMNS.length)} FROM json_each(?1) WHERE true
  ON CONFLICT (address) DO UPDATE SET ${STALL_COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`;

const SAVE_ELIGIBLE_SETS = `INSERT OR REPLACE INTO eligible_set (block, ts, epoch, members) SELECT ${cols(4)} FROM json_each(?1)`;

// the rows carry differences: they are added to what is stored
const SAVE_LEADER_DRAW = `INSERT INTO leader_draw (epoch, hour, validator, first, expected)
  SELECT ${cols(5)} FROM json_each(?1) WHERE true
  ON CONFLICT (epoch, hour, validator) DO UPDATE SET first = first + excluded.first, expected = expected + excluded.expected`;

// Fails, and with it the whole batch, when the cursor is no longer the one this run started from:
// two runs overlapped and the other one saved first. json() of an invalid text raises an error.
const GUARD = `SELECT CASE WHEN (SELECT value FROM meta WHERE key = 'cursor') IS NOT ?1
  THEN json('cursor moved: another run saved this range first') END`;

const SAVE_META = `INSERT INTO meta (key, value) SELECT ${cols(2)} FROM json_each(?1) WHERE true
  ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

const LOG_RUN = `INSERT OR REPLACE INTO runs
  (ts, from_block, to_block, tip, logs, txs, rpc_calls, rpc_ms, non_json, rows_written, error)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`;

const SUMS = `sum(h.tx) tx, sum(h.first) first, sum(h.retry) retry, sum(h.none) none, sum(h.cancelled) cancelled,
  sum(h.agree) agree, sum(h.disagree) disagree, sum(h.dv) dv, sum(h.timeout) timeout`;

export function d1Store(db) {
  const num = (v) => (v == null ? null : Number(v));
  return {
    // cursor and epoch tracking, the contracts still waiting for their LLM label, and the contracts
    // with five transactions in a row without a vote that are not counted as stalled yet
    async state(codeBatch) {
      const [meta, pending, lastRun, validators, stallsDue, set] = await db.batch([
        db.prepare("SELECT key, value FROM meta"),
        db.prepare("SELECT address FROM contracts WHERE llm IS NULL ORDER BY checked_ts LIMIT ?1").bind(codeBatch),
        db.prepare("SELECT ts FROM runs ORDER BY ts DESC LIMIT 1"),
        db.prepare("SELECT address, active, quarantined, banned, banned_until, info_ts, self_stake, delegated_stake FROM validators"),
        db.prepare(`SELECT ${STALL_COLUMNS.join(", ")} FROM contract_stall
          WHERE fifth_ts IS NOT NULL AND (stalled_ts IS NULL OR recovered_ts IS NOT NULL)`),
        db.prepare("SELECT block, ts, epoch, members FROM eligible_set ORDER BY block DESC LIMIT 1"),
      ]);
      const m = Object.fromEntries(meta.results.map((r) => [r.key, r.value]));
      const last = set.results[0];
      return { cursor: num(m.cursor), cursorTs: num(m.cursor_ts), epoch: num(m.epoch), epochBack: num(m.epoch_back),
               epochBackFloor: num(m.epoch_back_floor), setsTs: num(m.sets_ts), synced: m.synced === "1",
               pendingContracts: pending.results.map((r) => r.address),
               lastRunTs: lastRun.results[0]?.ts ?? null, validators: validators.results, stallsDue: stallsDue.results,
               eligibleSet: last ? { ...last, members: JSON.parse(last.members) } : null };
    },

    // Map of txId -> stored state, for the transactions that already have one
    async loadTx(ids) {
      const txs = new Map();
      if (!ids.length) return txs;
      const { results } = await db.prepare("SELECT tx_id, state FROM tx WHERE tx_id IN (SELECT value FROM json_each(?1))")
        .bind(JSON.stringify(ids)).all();
      for (const row of results) txs.set(row.tx_id, JSON.parse(row.state));
      return txs;
    },

    // progress rows of the given contracts and of the contracts of the given transactions
    async loadStalls(addresses, ids) {
      if (!addresses.length && !ids.length) return [];
      const { results } = await db.prepare(`SELECT ${STALL_COLUMNS.join(", ")} FROM contract_stall
        WHERE address IN (SELECT value FROM json_each(?1))
           OR address IN (SELECT recipient FROM tx WHERE tx_id IN (SELECT value FROM json_each(?2)))`)
        .bind(JSON.stringify(addresses), JSON.stringify(ids)).all();
      return results;
    },

    // everything a run produced, in one transaction; returns the rows written.
    // log: [type, data, ts] (ts optional: the time of the run); stalls: rows of contract_stall;
    // eligibleSets: [{ block, ts, epoch, members }]; leaderDraw: Map "epoch|hour|validator" -> { first, expected }
    async save({ events, txs, contractHour, opHour, epochStarts, newContracts, labels, cursor, epoch, epochBack, epochBackFloor, now,
                 validatorSets = [], validatorInfo = [], log = [], stalls = [], eligibleSets = [], leaderDraw = new Map(),
                 setsRead = false, synced = false, startedAt = null }) {
      const list = [db.prepare(GUARD).bind(startedAt == null ? null : String(startedAt))];
      const add = (sql, rows, ...more) => { if (rows.length) list.push(db.prepare(sql).bind(JSON.stringify(rows), ...more)); };
      add(SAVE_EVENTS, events.map((ev) => [ev.block, ev.logIndex, ev.ts, ev.name, ev.args.txId ?? ev.args.tx_id ?? null, JSON.stringify(ev.args)]));
      add(SAVE_TXS, txs.map(({ tx, status }) => [tx.txId, tx.recipient, status, tx.firstBlock, tx.firstTs, tx.lastBlock, tx.lastTs,
        tx.acceptedTs, tx.epoch ?? null, tx.hour ?? null, tx.sender ?? null, tx.camp ?? null, tx.leaderTimeouts, tx.rotations,
        tx.appeals, tx.recomputations, tx.acceptedTs != null && tx.firstTs != null ? tx.acceptedTs - tx.firstTs : null, JSON.stringify(tx)]));
      add(SAVE_CONTRACT_HOUR, [...contractHour].map(([key, r]) => {
        const [e, hour, contract, camp] = key.split("|");
        return [Number(e), Number(hour), contract, Number(camp), r.tx, r.first, r.retry, r.none, r.cancelled, r.last_ts,
          r.agree, r.disagree, r.dv, r.timeout];
      }));
      add(SAVE_OP_HOUR, [...opHour].map(([key, r]) => {
        const [e, hour, src, validator] = key.split("|");
        return [Number(e), Number(hour), src, validator, r.votes, r.agree, r.disagree, r.dv, r.timeout, r.led, r.leader_timeouts];
      }));
      add(SAVE_EPOCHS, epochStarts.map((a) => [a.epoch, a.block, a.ts]));
      add(SAVE_CONTRACTS, [...newContracts]);
      add(SAVE_LABELS, labels, now);
      add(SAVE_VALIDATOR_SETS, validatorSets);
      add(SAVE_VALIDATOR_INFO, validatorInfo, now);
      add(SAVE_LOG, log.map(([type, data, ts]) => [type, JSON.stringify(data), ts ?? null]), now);
      add(SAVE_STALLS, stalls.map((s) => STALL_COLUMNS.map((c) => s[c] ?? null)));
      add(SAVE_ELIGIBLE_SETS, eligibleSets.map((s) => [s.block, s.ts ?? null, s.epoch ?? null, JSON.stringify(s.members)]));
      add(SAVE_LEADER_DRAW, [...leaderDraw].map(([key, r]) => {
        const [e, hour, validator] = key.split("|");
        return [Number(e), Number(hour), validator, r.first, r.expected];
      }));
      add(SAVE_META, [["cursor", String(cursor)], ["epoch", String(epoch)], ["epoch_back", String(epochBack)],
        ["epoch_back_floor", String(epochBackFloor)], ["synced", synced ? "1" : "0"],
        ...(events.length ? [["cursor_ts", String(events.at(-1).ts)]] : []), ...(setsRead ? [["sets_ts", String(now)]] : [])]);
      const done = await db.batch(list);
      return done.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
    },

    async logRun(run) {
      await db.prepare(LOG_RUN).bind(run.ts, run.from, run.to, run.tip, run.logs, run.txs, run.rpcCalls,
        run.rpcMs, run.nonJson, run.rowsWritten, run.error).run();
    },

    // ---- read side

    // latest transactions whose start was observed, oldest first
    async latestTx(limit) {
      const { results } = await db.prepare(`SELECT tx_id, recipient, status, first_ts FROM tx
        WHERE recipient IS NOT NULL ORDER BY first_block DESC LIMIT ?1`).bind(limit).all();
      return results.reverse();
    },

    async latestRuns(limit) {
      const { results } = await db.prepare("SELECT * FROM runs ORDER BY ts DESC LIMIT ?1").bind(limit).all();
      return results;
    },

    // epochs (newest first), collector state and RPC health over the last hour
    async meta(now) {
      const [meta, epochs, lastOk, rpc] = await db.batch([
        db.prepare("SELECT key, value FROM meta"),
        db.prepare("SELECT epoch, start_block, start_ts FROM epochs ORDER BY epoch DESC LIMIT 30"),
        db.prepare("SELECT ts FROM runs WHERE error IS NULL ORDER BY ts DESC LIMIT 1"),
        db.prepare("SELECT count(*) runs, coalesce(sum(non_json), 0) non_json, coalesce(sum(error IS NOT NULL), 0) failed FROM runs WHERE ts >= ?1").bind(now - 3600),
      ]);
      const m = Object.fromEntries(meta.results.map((r) => [r.key, r.value]));
      const lastRun = lastOk.results[0]?.ts ?? null;
      // while the collector catches up, the data is as recent as the last event it has read
      return { cursor: num(m.cursor), epoch: num(m.epoch), epochs: epochs.results, lastOk: lastRun, rpc: rpc.results[0],
               synced: m.synced === "1", asOf: m.synced === "1" ? lastRun : num(m.cursor_ts), setsTs: num(m.sets_ts) };
    },

    // time of the last campaign transaction seen, looking at the current epoch and the one before
    async lastCampaign(epoch) {
      if (epoch == null) return null;
      return db.prepare("SELECT max(last_ts) ts FROM contract_hour WHERE epoch >= ?1 AND camp = 1").bind(epoch - 1).first("ts");
    },

    // the campaign that the transaction seen at `ts` belongs to: a campaign lasts under an hour, so
    // its transactions are in the hour of `ts` or the one before
    async campaignAround(epoch, ts) {
      return db.prepare(`SELECT count(*) transactions, min(first_ts) started, max(last_ts) last_event, min(epoch) epoch FROM tx
        WHERE camp IS NOT NULL AND epoch >= ?1 AND hour >= ?2`).bind(epoch - 1, Math.floor(ts / 3600) - 1).first();
    },

    // campaign transactions of a view, one row each: what the retries and the latency are computed from
    async campaignTx(filter) {
      const { results } = await db.prepare(`SELECT h.camp, h.status, h.leader_timeouts, h.rotations, h.appeals, h.recomputations, h.accept_secs
        FROM tx h WHERE h.camp IS NOT NULL AND ${filter.sql}`).bind(...filter.params).all();
      return results;
    },

    async validators() {
      const { results } = await db.prepare(`SELECT address, moniker, self_stake, delegated_stake, live, active, quarantined, banned,
        banned_until, info_ts FROM validators`).all();
      return results;
    },

    // votes and leader rounds of each validator in a view, per source (net, camp_llm, camp_control)
    async operatorTotals(filter) {
      const { results } = await db.prepare(`SELECT h.validator, h.src, sum(h.votes) votes, sum(h.agree) agree, sum(h.disagree) disagree,
        sum(h.dv) dv, sum(h.timeout) timeout, sum(h.led) led, sum(h.leader_timeouts) leader_timeouts
        FROM op_hour h WHERE ${filter.sql} GROUP BY h.validator, h.src`).bind(...filter.params).all();
      return results;
    },

    // first leader of the campaign transactions of a view: observed and expected, per validator
    async leaderDraws(filter) {
      const { results } = await db.prepare(`SELECT h.validator, sum(h.first) first, sum(h.expected) expected
        FROM leader_draw h WHERE ${filter.sql} GROUP BY h.validator`).bind(...filter.params).all();
      return results;
    },

    // the same per epoch, from `fromEpoch` on
    async operatorSeries(fromEpoch) {
      const { results } = await db.prepare(`SELECT h.epoch, h.validator, h.src, sum(h.votes) votes, sum(h.dv) dv, sum(h.timeout) timeout,
        sum(h.leader_timeouts) leader_timeouts FROM op_hour h WHERE h.epoch >= ?1 GROUP BY h.epoch, h.validator, h.src`).bind(fromEpoch).all();
      return results;
    },

    // campaign totals per epoch and reference contract, from `fromEpoch` on
    async campaignByEpoch(fromEpoch) {
      const { results } = await db.prepare(`SELECT h.epoch, c.ref_name, ${SUMS}
        FROM contract_hour h JOIN contracts c ON c.address = h.contract
        WHERE h.camp = 1 AND h.epoch >= ?1 GROUP BY h.epoch, c.ref_name ORDER BY h.epoch`).bind(fromEpoch).all();
      return results;
    },

    // votes of each validator on the campaign contracts with LLM calls, in a view
    async campaignVoters(filter) {
      const { results } = await db.prepare(`SELECT h.validator, sum(h.votes) votes, sum(h.timeout) timeout
        FROM op_hour h WHERE ${filter.sql} AND h.src = 'camp_llm' GROUP BY h.validator`).bind(...filter.params).all();
      return results;
    },

    // filter: { sql, params } over the alias h (see viewFilter in index.js)
    async contractTotals(filter) {
      const { results } = await db.prepare(`SELECT h.camp, c.llm, c.ref_name, ${SUMS}
        FROM contract_hour h LEFT JOIN contracts c ON c.address = h.contract
        WHERE ${filter.sql} GROUP BY h.camp, c.llm, c.ref_name`).bind(...filter.params).all();
      return results;
    },

    // totals of one contract in an epoch, over every transaction it received
    async contractEpoch(epoch, contract) {
      return db.prepare(`SELECT coalesce(sum(tx), 0) tx, coalesce(sum(first), 0) first, coalesce(sum(retry), 0) retry, coalesce(sum(none), 0) none
        FROM contract_hour WHERE epoch = ?1 AND contract = ?2`).bind(epoch, contract).first();
    },

    // contracts whose last stall overlaps the time range [from, to), with their last transaction
    async stalled(from, to) {
      const { results } = await db.prepare(`SELECT s.address, s.streak, s.since_ts, s.stalled_ts, s.stalled_tx, s.recovered_ts, c.llm, c.ref_name,
          (SELECT t.tx_id FROM tx t WHERE t.recipient = s.address ORDER BY t.first_block DESC LIMIT 1) last_tx
        FROM contract_stall s LEFT JOIN contracts c ON c.address = s.address
        WHERE s.stalled_ts IS NOT NULL AND s.stalled_ts < ?2 AND (s.recovered_ts IS NULL OR s.recovered_ts >= ?1)
        ORDER BY s.stalled_ts DESC`).bind(from, to).all();
      return results;
    },

    // ---- Events section

    // log entries of the time range [from, to), newest first
    async logRows(from, to, limit) {
      const { results } = await db.prepare(`SELECT id, ts, type, data FROM log WHERE ts >= ?1 AND ts < ?2
        ORDER BY ts DESC, id DESC LIMIT ?3`).bind(from, to, limit).all();
      return results;
    },

    // times of the runs that got an answer from the RPC that was not JSON, oldest first
    async badRuns(from, to) {
      const { results } = await db.prepare("SELECT ts FROM runs WHERE non_json > 0 AND ts >= ?1 AND ts < ?2 ORDER BY ts LIMIT 2000")
        .bind(from, to).all();
      return results.map((r) => r.ts);
    },

    // creation and last event of the campaign transactions created in the hours [fromHour, toHour)
    async campaignTimes(fromEpoch, fromHour, toHour) {
      const { results } = await db.prepare(`SELECT first_ts, last_ts, epoch FROM tx
        WHERE camp IS NOT NULL AND epoch >= ?1 AND hour >= ?2 AND hour < ?3 ORDER BY first_ts`).bind(fromEpoch, fromHour, toHour).all();
      return results;
    },

    // Transactions of an epoch for the data export, in creation order: those created in the block
    // range of the epoch, after the cursor (block and id of the last one of the previous page).
    async exportTx(epoch, fromBlock, toBlock, afterBlock, afterId, limit) {
      const { results } = await db.prepare(`SELECT t.tx_id, t.epoch, t.recipient, t.status, t.first_block, t.first_ts, t.accepted_ts, t.accept_secs,
          t.leader_timeouts, t.rotations, t.appeals, t.recomputations, t.camp, t.state, c.llm
        FROM tx t LEFT JOIN contracts c ON c.address = t.recipient
        WHERE t.first_block >= ?2 AND t.first_block <= ?3 AND t.epoch = ?1 AND t.recipient IS NOT NULL
          AND (t.first_block > ?4 OR (t.first_block = ?4 AND t.tx_id > ?5))
        ORDER BY t.first_block, t.tx_id LIMIT ?6`).bind(epoch, fromBlock, toBlock, afterBlock, afterId, limit).all();
      return results;
    },

    async contractRows(filter, limit) {
      const { results } = await db.prepare(`SELECT h.contract, h.camp, c.llm, c.ref_name, ${SUMS}, max(h.last_ts) last_ts
        FROM contract_hour h LEFT JOIN contracts c ON c.address = h.contract
        WHERE ${filter.sql} GROUP BY h.contract, h.camp ORDER BY tx DESC LIMIT ?${filter.params.length + 1}`)
        .bind(...filter.params, limit).all();
      return results;
    },
  };
}
