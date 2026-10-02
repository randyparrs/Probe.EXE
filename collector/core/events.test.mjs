// node --test collector/core/events.test.mjs
// Decoder and per-transaction state on raw consensus logs of two real Bradbury transactions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VOTE, apply, decodeLog, newTx, status, txIdsOf } from "./events.js";

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "two-transactions.json"), "utf8"));

function build() {
  const txs = new Map();
  for (const log of fx.logs) {
    const ev = decodeLog(log);
    for (const id of txIdsOf(ev)) {
      if (!txs.has(id)) txs.set(id, newTx(id));
      apply(txs.get(id), ev);
    }
  }
  return txs;
}

test("every fixture log decodes to a known event with a block and a timestamp", () => {
  for (const log of fx.logs) {
    const ev = decodeLog(log);
    assert.ok(ev && ev.name, "known event");
    assert.ok(ev.block > 0 && ev.ts > 0);
  }
});

test("a control transaction accepted at the first attempt", () => {
  const tx = build().get(fx.firstAttempt.toLowerCase());
  assert.equal(status(tx), "first");
  assert.equal(tx.proposals, 1);
  assert.equal(tx.leaderTimeouts, 0);
  const a = tx.attempts.at(-1);
  assert.equal(a.validators.length, 5);
  assert.equal(a.votes.length, 5);
  assert.ok(a.votes.every(([validator, vote]) => /^0x[0-9a-f]{40}$/.test(validator) && VOTE[vote] === "AGREE"));
  assert.match(tx.recipient, /^0x[0-9a-f]{40}$/);
  assert.ok(tx.acceptedTs >= tx.firstTs);
});

test("a transaction accepted after a leader timeout is not a first attempt", () => {
  const tx = build().get(fx.afterLeaderTimeout.toLowerCase());
  assert.equal(status(tx), "retry");
  assert.equal(tx.leaderTimeouts, 1);
  assert.ok(tx.attempts.some((a) => a.timedOut && a.leader));
});

test("a transaction whose start was not observed is partial", () => {
  const tx = newTx("0x" + "ab".repeat(32));
  apply(tx, { name: "TransactionFinalized", args: { txId: tx.txId }, block: 10, logIndex: 0, ts: 1 });
  assert.equal(status(tx), "partial");
});

test("no acceptance: undetermined is no consensus, otherwise pending", () => {
  const tx = newTx("0x" + "cd".repeat(32));
  apply(tx, { name: "NewTransaction", args: { txId: tx.txId, recipient: "0x" + "11".repeat(20), activator: "0x" + "22".repeat(20) }, block: 1, logIndex: 0, ts: 1 });
  assert.equal(status(tx), "pending");
  apply(tx, { name: "TransactionUndetermined", args: { txId: tx.txId }, block: 2, logIndex: 0, ts: 2 });
  assert.equal(status(tx), "none");
});

// synthetic sequences: the round result arrives with the last revealed vote of the block
const ID = "0x" + "ef".repeat(32);
const V = "0x" + "55".repeat(20);
const ev = (name, args = {}, block = 1) => ({ name, args: { txId: ID, ...args }, block, logIndex: 0, ts: block });
const start = () => {
  const tx = newTx(ID);
  for (const e of [ev("NewTransaction", { recipient: "0x" + "11".repeat(20), activator: "0x" + "22".repeat(20) }),
                   ev("TransactionActivated", { leader: "0x" + "33".repeat(20) }, 2),
                   ev("TransactionReceiptProposed", { validators: [] }, 3)]) apply(tx, e);
  return tx;
};
const roundEnd = (tx, result, block) => {  // chain order: TransactionAccepted, then the last vote
  apply(tx, ev("TransactionAccepted", {}, block));
  apply(tx, ev("VoteRevealed", { validator: V, voteType: 1, isLastVote: true, result }, block));
};

test("TransactionAccepted counts as acceptance only when the round result is AGREE", () => {
  const tx = start();
  apply(tx, ev("TransactionAccepted", {}, 4));
  assert.equal(status(tx), "unknown");            // round ended, result not seen yet
  apply(tx, ev("VoteRevealed", { validator: V, voteType: 1, isLastVote: true, result: 1 }, 4));
  assert.equal(status(tx), "first");
});

test("a round that ends by validators timeout is not an acceptance", () => {
  const tx = start();
  roundEnd(tx, 3, 4);                             // TIMEOUT
  assert.equal(status(tx), "none");
  assert.equal(tx.acceptedBlock, null);
  apply(tx, ev("AppealStarted", { appellant: V, bond: "0", validators: [] }, 5));
  roundEnd(tx, 1, 6);                             // the appeal ends in AGREE
  assert.equal(status(tx), "retry");              // accepted, but not at the first attempt
});

test("an acceptance overturned by an appeal ends as no consensus; a confirmed one keeps its class", () => {
  const tx = start();
  roundEnd(tx, 1, 4);
  assert.equal(status(tx), "first");
  apply(tx, ev("AppealStarted", { appellant: V, bond: "0", validators: [] }, 5));
  apply(tx, ev("TransactionUndetermined", {}, 6));
  assert.equal(status(tx), "none");
  roundEnd(tx, 1, 7);
  assert.equal(status(tx), "first");
});
