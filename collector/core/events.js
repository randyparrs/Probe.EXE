// Consensus events of GenLayer Bradbury: a small decoder with no dependencies (it also runs in a
// Cloudflare Worker, where CPU time per run is limited) and the per-transaction state built from
// the events.
//
// Counting rule (events). The TransactionAccepted event marks the end of a round, not consensus:
// it is also emitted when the round ends by validators timeout. The result of the round is in the
// last revealed vote (VoteRevealed with isLastVote, emitted in the same block). A round is a real
// acceptance only when that result is AGREE (or MAJORITY_AGREE).
// - "accepted at the first attempt": the first real acceptance comes after exactly one proposal
//   (TransactionReceiptProposed) and no leader timeout, leader rotation, appeal, recomputation or
//   validators-timeout round before it; accepted otherwise: "after retry".
// - The final state decides: a transaction whose last decision is a validators timeout, an
//   undetermined result or a cancellation is "no consensus", also when it had been accepted before
//   and an appeal overturned it. An appeal that confirms the acceptance keeps its classification.
// - Anything without a decision yet is "pending".
//
// Creation. A transaction emits CreatedTransaction when it is sent and NewTransaction when it enters
// consensus; both come in the same block unless the contract has a queue. The transaction counts as
// created when it enters consensus (NewTransaction): its block, time, epoch and hour, and the time to
// acceptance, start there. The wait in between is kept apart (queueSecs). A transaction that was sent
// and has not entered consensus is "queued"; one cancelled before entering ends as no consensus.

import TABLE from "./consensus-events.js";

export const CONSENSUS_ADDRESS = TABLE.address;
export const VOTE = ["NOT_VOTED", "AGREE", "DISAGREE", "TIMEOUT", "DETERMINISTIC_VIOLATION"];
export const RESULT = ["IDLE", "AGREE", "DISAGREE", "TIMEOUT", "DETERMINISTIC_VIOLATION", "NO_MAJORITY",
  "MAJORITY_AGREE", "MAJORITY_DISAGREE"];

const word = (data, i) => data.slice(2 + 64 * i, 66 + 64 * i);
const toAddress = (w) => "0x" + w.slice(24);
const toNumber = (w) => parseInt(w.slice(48), 16);  // uint8 / uint64 / small uint256, bool as 0 or 1

function value(type, w) {
  if (type === "address") return toAddress(w);
  if (type === "bytes32") return "0x" + w;
  if (type === "bool") return toNumber(w) === 1;
  if (type === "uint256") return BigInt("0x" + w).toString();
  return toNumber(w);
}

// log: { topics, data, blockNumber, logIndex, blockTimestamp?, transactionHash? } as returned by
// eth_getLogs. Returns { name, args, block, logIndex, ts, evmHash } or null for an event that is
// not in the table. evmHash is the EVM transaction that emitted the log.
export function decodeLog(log) {
  const def = TABLE.events[log.topics[0]];
  if (!def) return null;
  const args = {};
  let topic = 1, slot = 0;
  for (const input of def.inputs) {
    if (input.indexed) {
      args[input.name] = value(input.type, log.topics[topic++].slice(2));
    } else if (input.type.endsWith("[]")) {
      const at = parseInt(word(log.data, slot++), 16) / 32;
      const n = parseInt(word(log.data, at), 16);
      const item = input.type.slice(0, -2);
      args[input.name] = Array.from({ length: n }, (_, k) => value(item, word(log.data, at + 1 + k)));
    } else {
      args[input.name] = value(input.type, word(log.data, slot++));
    }
  }
  return { name: def.name, args, block: Number(log.blockNumber), logIndex: Number(log.logIndex),
           ts: log.blockTimestamp != null ? Number(log.blockTimestamp) : null, evmHash: log.transactionHash ?? null };
}

// Transaction ids an event refers to (TransactionNeedsRecomputation carries a list).
export function txIdsOf(ev) {
  if (Array.isArray(ev.args.txIds)) return ev.args.txIds;
  const id = ev.args.txId ?? ev.args.tx_id;
  return id ? [id] : [];
}

export function newTx(txId) {
  return { txId, recipient: null, activator: null, firstBlock: null, firstTs: null, lastBlock: null, lastTs: null,
           createdBlock: null, createdTs: null,  // CreatedTransaction: when it was sent
           queued: false,    // sent, not in consensus yet: the recipient was read from the sending transaction
           queueSecs: null,  // NewTransaction minus CreatedTransaction, when both were seen
           proposals: 0, leaderTimeouts: 0, rotations: 0, appeals: 0, recomputations: 0, validatorsTimeouts: 0,
           acceptedBlock: null, acceptedTs: null, firstAttempt: null,
           decision: null,  // last of "accepted" | "validators_timeout" | "not_accepted" | "undetermined" | "cancelled"
           undetermined: false, cancelled: false, finalized: false,
           roundEnd: null,   // a TransactionAccepted event still waiting for the result of its round
           lastResult: null, // { block, result } of the last isLastVote not yet matched to a round end
           attempts: [] };   // { leader, timedOut, validators, votes: [[validator, voteType]], result }
}

const AGREE_RESULTS = new Set([1, 6]);  // RESULT: AGREE, MAJORITY_AGREE
const current = (tx) => tx.attempts[tx.attempts.length - 1];
function attempt(tx, leader) {
  tx.attempts.push({ leader: leader ?? null, timedOut: false, validators: null, votes: [], result: null });
}

// A round ended (TransactionAccepted) with `result` (from the last revealed vote of the round).
function roundEnded(tx, result, block, ts) {
  if (AGREE_RESULTS.has(result)) {
    if (tx.acceptedBlock == null) {
      tx.acceptedBlock = block; tx.acceptedTs = ts;
      tx.firstAttempt = tx.proposals === 1 && tx.leaderTimeouts === 0 && tx.rotations === 0 && tx.appeals === 0
        && tx.recomputations === 0 && tx.validatorsTimeouts === 0;
    }
    tx.decision = "accepted";
  } else {
    if (tx.acceptedBlock == null) tx.validatorsTimeouts++;
    tx.decision = result === 3 ? "validators_timeout" : "not_accepted";
  }
}

// A transaction sent and not in consensus yet: its recipient, read from the sending transaction.
export function queue(tx, recipient) {
  tx.recipient = recipient; tx.queued = true;
  return tx;
}

// Applies one event (in chain order) to the state of its transaction. Until NewTransaction is seen,
// firstBlock and firstTs are those of the first event seen (CreatedTransaction when it was observed).
export function apply(tx, ev) {
  if (tx.firstBlock == null) { tx.firstBlock = ev.block; tx.firstTs = ev.ts; }
  tx.lastBlock = ev.block; tx.lastTs = ev.ts;
  const open = tx.acceptedBlock == null;
  switch (ev.name) {
    case "CreatedTransaction":
      tx.createdBlock = ev.block; tx.createdTs = ev.ts; break;
    case "NewTransaction":
      tx.recipient = ev.args.recipient; tx.activator = ev.args.activator; tx.queued = false;
      tx.firstBlock = ev.block; tx.firstTs = ev.ts;
      if (tx.createdTs != null && ev.ts != null) tx.queueSecs = ev.ts - tx.createdTs;
      break;
    case "TransactionActivated":
      attempt(tx, ev.args.leader); break;
    case "TransactionLeaderRotated":
      if (open) tx.rotations++;
      attempt(tx, ev.args.newLeader); break;
    case "TransactionLeaderTimeout":
      if (open) tx.leaderTimeouts++;
      if (current(tx)) current(tx).timedOut = true;
      break;
    case "TransactionReceiptProposed":
      if (open) tx.proposals++;
      if (!current(tx) || current(tx).validators) attempt(tx, current(tx)?.leader);
      current(tx).validators = ev.args.validators;
      break;
    case "VoteRevealed":
      if (!current(tx)) attempt(tx, null);
      current(tx).votes.push([ev.args.validator, ev.args.voteType]);
      if (ev.args.isLastVote) {
        current(tx).result = ev.args.result;
        if (tx.roundEnd && tx.roundEnd.block === ev.block) {
          roundEnded(tx, ev.args.result, tx.roundEnd.block, tx.roundEnd.ts);
          tx.roundEnd = null;
        } else {
          tx.lastResult = { block: ev.block, result: ev.args.result };
        }
      }
      break;
    case "AppealStarted":
      if (open) tx.appeals++;
      break;
    case "TransactionNeedsRecomputation":
      if (open) tx.recomputations++;
      break;
    case "TransactionAccepted":
      if (tx.lastResult && tx.lastResult.block === ev.block) {
        roundEnded(tx, tx.lastResult.result, ev.block, ev.ts);
        tx.lastResult = null;
      } else {
        tx.roundEnd = { block: ev.block, ts: ev.ts };  // its result arrives with the last vote of the block
      }
      break;
    case "TransactionUndetermined": tx.undetermined = true; tx.decision = "undetermined"; break;
    case "TransactionCancelled": tx.cancelled = true; tx.decision = "cancelled"; break;
    case "TransactionFinalized": tx.finalized = true; break;
    default: break;
  }
  return tx;
}

// "first" | "retry" | "none" | "pending"; "queued" when it was sent and has not entered consensus;
// "partial" when the transaction started before the observed range (its NewTransaction event was not
// seen, so its attempts cannot be counted); "unknown" when a round ended but its result was not seen
// (to be read from the chain).
export function status(tx) {
  if (tx.roundEnd) return "unknown";
  if (tx.decision && tx.decision !== "accepted") return "none";
  if (tx.queued) return "queued";
  if (tx.recipient == null) return "partial";
  if (tx.decision === "accepted") return tx.firstAttempt ? "first" : "retry";
  return "pending";
}
