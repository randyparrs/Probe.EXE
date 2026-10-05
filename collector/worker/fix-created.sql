-- One-off correction: a transaction counts as created when it enters consensus (NewTransaction),
-- see "Created" in docs/METRICS.md. For every stored transaction whose NewTransaction event is
-- stored, it sets the block and time of creation, the time to acceptance and the wait in the queue
-- from the stored events (0 without CreatedTransaction: the chain emits it only for a transaction
-- that waits). The epoch, the hour and the hourly counters already used NewTransaction
-- and do not change. Running it again changes nothing. From collector/worker:
--   npx wrangler d1 execute probe-exe --remote --yes --file=fix-created.sql
UPDATE tx SET first_block = n.block, first_ts = n.ts,
  accept_secs = CASE WHEN tx.accepted_ts IS NULL THEN NULL ELSE tx.accepted_ts - n.ts END,
  state = json_set(tx.state, '$.firstBlock', n.block, '$.firstTs', n.ts, '$.createdBlock', c.block,
    '$.createdTs', c.ts, '$.queueSecs', CASE WHEN c.ts IS NULL THEN 0 ELSE n.ts - c.ts END,
    '$.queued', json('false'))
FROM (SELECT tx_id, min(block) block, min(ts) ts FROM events WHERE name = 'NewTransaction' GROUP BY tx_id) n
  LEFT JOIN (SELECT tx_id, min(block) block, min(ts) ts FROM events WHERE name = 'CreatedTransaction' GROUP BY tx_id) c
    ON c.tx_id = n.tx_id
WHERE tx.tx_id = n.tx_id;
