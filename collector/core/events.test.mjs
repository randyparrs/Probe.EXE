// node --test collector/core/events.test.mjs
// Decoder and per-transaction state on raw consensus logs of two real Bradbury transactions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VOTE, apply, decodeLog, newTx, queue, status, txIdsOf } from "./events.js";

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

test("no acceptance: undetermined is pending until finalized, then no consensus", () => {
  const tx = newTx("0x" + "cd".repeat(32));
  apply(tx, { name: "NewTransaction", args: { txId: tx.txId, recipient: "0x" + "11".repeat(20), activator: "0x" + "22".repeat(20) }, block: 1, logIndex: 0, ts: 1 });
  assert.equal(status(tx), "pending");
  apply(tx, { name: "TransactionUndetermined", args: { txId: tx.txId }, block: 2, logIndex: 0, ts: 2 });
  assert.equal(status(tx), "pending");            // an appeal can still follow
  apply(tx, { name: "TransactionFinalized", args: { txId: tx.txId }, block: 3, logIndex: 0, ts: 3 });
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
  assert.equal(status(tx), "pending");            // not finalized: an appeal can still follow
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
  assert.equal(status(tx), "pending");
  roundEnd(tx, 1, 7);
  assert.equal(status(tx), "first");              // confirmed by the appeal
  apply(tx, ev("TransactionUndetermined", {}, 8));
  apply(tx, ev("TransactionFinalized", {}, 9));
  assert.equal(status(tx), "none");               // overturned and finalized
});

test("a queued transaction counts as created when it enters consensus; the wait is kept apart", () => {
  const tx = newTx(ID);
  apply(tx, ev("CreatedTransaction", { txSlot: "0" }, 100));
  queue(tx, "0x" + "11".repeat(20));
  assert.equal(status(tx), "queued");
  assert.deepEqual([tx.firstBlock, tx.createdBlock, tx.queueSecs], [100, 100, null]);
  apply(tx, ev("NewTransaction", { recipient: "0x" + "11".repeat(20), activator: "0x" + "22".repeat(20) }, 160));
  assert.equal(status(tx), "pending");
  assert.deepEqual([tx.firstBlock, tx.firstTs, tx.createdTs, tx.queueSecs, tx.queued], [160, 160, 100, 60, false]);
});

test("a queued transaction cancelled before entering consensus ends as no consensus", () => {
  const tx = newTx(ID);
  apply(tx, ev("CreatedTransaction", { txSlot: "0" }, 100));
  queue(tx, "0x" + "11".repeat(20));
  apply(tx, ev("TransactionCancelled", {}, 300));
  assert.equal(status(tx), "none");
  assert.equal(tx.queueSecs, null);
});

test("a transaction that enters consensus at once emits no CreatedTransaction: no wait", () => {
  const tx = newTx(ID);
  apply(tx, ev("NewTransaction", { recipient: "0x" + "11".repeat(20), activator: "0x" + "22".repeat(20) }, 7));
  assert.deepEqual([status(tx), tx.firstBlock, tx.createdBlock, tx.queueSecs], ["pending", 7, null, 0]);
});

// recorded logs of three real transactions, one per rule of 2026-10-05
const v6 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v6-rules.json"), "utf8"));
// the states of one transaction after each of its events, in chain order
function replay(id) {
  const tx = newTx(id), states = [];
  for (const log of v6.logs) {
    const e = decodeLog(log);
    if (!e || !txIdsOf(e).includes(id)) continue;
    apply(tx, e);
    states.push({ name: e.name, status: status(tx) });
  }
  return { tx, states };
}

test("recorded: a transaction finalized with no real acceptance is no consensus, pending before", () => {
  const { tx, states } = replay(v6.finalizedWithoutAcceptance);
  assert.equal(tx.acceptedBlock, null);
  assert.deepEqual(states.slice(-1), [{ name: "TransactionFinalized", status: "none" }]);
  assert.ok(states.slice(0, -1).every((s) => s.status === "pending"));
});

test("recorded: after a validators timeout it stays pending while an appeal can follow, then the appeal decides", () => {
  const { tx, states } = replay(v6.appealAfterValidatorsTimeout);
  assert.ok(tx.validatorsTimeouts > 0 && tx.appeals > 0);
  assert.ok(!states.some((s) => s.status === "none"));          // never counted as no consensus on the way
  assert.equal(status(tx), "retry");
});

test("recorded: a vote revealed after a rotation belongs to the attempt whose committee has the voter", () => {
  const { tx } = replay(v6.voteAfterRotation);
  const revealed = v6.logs.map(decodeLog).filter((e) => e && e.name === "VoteRevealed" && e.args.txId === v6.voteAfterRotation).length;
  assert.ok(tx.rotations > 0);
  assert.equal(tx.attempts.reduce((n, a) => n + a.votes.length, 0), revealed);
  for (const a of tx.attempts.filter((x) => x.validators)) assert.ok(a.votes.every(([v]) => a.validators.includes(v)));
  assert.ok(tx.attempts.filter((x) => x.validators).every((a) => a.result != null));   // each round has its result
});
