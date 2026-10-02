-- Empties the store of the collector. Everything in it is read from the chain, so the collector
-- rebuilds it from START_BLOCK. Run it before schema.sql when the schema changes:
--   npx wrangler d1 execute probe-exe --local --file=reset.sql      (from collector/worker)
DROP TABLE IF EXISTS meta;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS tx;
DROP TABLE IF EXISTS contract_hour;
DROP TABLE IF EXISTS op_hour;
DROP TABLE IF EXISTS epochs;
DROP TABLE IF EXISTS contracts;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS validators;
DROP TABLE IF EXISTS log;
DROP TABLE IF EXISTS contract_stall;
DROP TABLE IF EXISTS eligible_set;
DROP TABLE IF EXISTS leader_draw;
