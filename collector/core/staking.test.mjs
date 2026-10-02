// node --test collector/core/staking.test.mjs
// The constants of staking.js against the ABI of genlayer-js.

import assert from "node:assert/strict";
import { test } from "node:test";
import { testnetBradbury } from "genlayer-js/chains";
import { encodeAbiParameters, encodeFunctionResult, toEventSelector, toFunctionSelector } from "viem";
import { BANNED_PAGE, EPOCH_ADVANCE_TOPIC, EPOCH_SELECTOR, SELECTOR, STAKING_ADDRESS, callData, decodeAddresses, decodeBanned,
  decodeEpochAdvance, decodeMoniker, decodeValidatorView, toGen, weightOf } from "./staking.js";

const S = testnetBradbury.stakingContract;

test("address, event topic and function selector match the staking ABI", () => {
  assert.equal(STAKING_ADDRESS, S.address);
  const ev = S.abi.find((x) => x.type === "event" && x.name === "EpochAdvance");
  assert.deepEqual(ev.inputs.map((i) => [i.type, !!i.indexed]), [["uint256", false]]);
  assert.equal(EPOCH_ADVANCE_TOPIC, toEventSelector("EpochAdvance(uint256)"));
  const fn = S.abi.find((x) => x.type === "function" && x.name === "epoch");
  assert.equal(fn.inputs.length, 0);
  assert.equal(EPOCH_SELECTOR, toFunctionSelector("epoch()"));
});

const fn = (name) => S.abi.find((x) => x.type === "function" && x.name === name);
const signature = (f) => `${f.name}(${f.inputs.map((i) => i.type).join(",")})`;
const A1 = "0x59dc5e6fd7428c5ee6fc24ae2b99e5860a9c9499", A2 = "0x318128e88e5cc86cd6898f6afe93660c8ea0be8e", NONE = "0x" + "0".repeat(40);

test("selectors of the validator reads match the staking ABI", () => {
  assert.equal(SELECTOR.activeValidators, toFunctionSelector(signature(fn("activeValidators"))));
  assert.equal(SELECTOR.quarantinedValidators, toFunctionSelector(signature(fn("getAllQuarantinedValidators"))));
  assert.equal(SELECTOR.bannedValidators, toFunctionSelector(signature(fn("getAllBannedValidators"))));
  assert.equal(SELECTOR.validatorView, toFunctionSelector(signature(fn("validatorView"))));
  assert.equal(SELECTOR.getIdentity, toFunctionSelector("getIdentity()"));
  assert.equal(callData.validatorView(A1), SELECTOR.validatorView + "0".repeat(24) + A1.slice(2));
  assert.equal(callData.bannedValidators(), SELECTOR.bannedValidators + "0".repeat(64) + BANNED_PAGE.toString(16).padStart(64, "0"));
  assert.deepEqual(fn("validatorView").outputs[0].components.map((c) => c.name),
    ["left", "right", "parent", "eBanned", "ePrimed", "vStake", "vShares", "dStake", "dShares", "vDeposit", "vWithdrawal", "live"]);
});

test("the validator lists, the view and the moniker decode like viem encodes them", () => {
  const list = encodeFunctionResult({ abi: S.abi, functionName: "activeValidators", result: [A1, NONE, A2] });
  assert.deepEqual(decodeAddresses(list), [A1, A2]);                       // empty slots are dropped
  assert.deepEqual(decodeAddresses(encodeFunctionResult({ abi: S.abi, functionName: "getValidatorQuarantineList", result: [] })), []);

  const banned = encodeFunctionResult({ abi: S.abi, functionName: "getAllBannedValidators",
    result: [{ validator: A2, untilEpochBanned: 169n, permanentlyBanned: false }, { validator: A1, untilEpochBanned: 0n, permanentlyBanned: true }] });
  assert.deepEqual(decodeBanned(banned), [{ validator: A2, until: 169, permanent: false }, { validator: A1, until: 0, permanent: true }]);

  const view = encodeFunctionResult({ abi: S.abi, functionName: "validatorView", result: { left: NONE, right: A2, parent: A1, eBanned: 0n, ePrimed: 168n,
    vStake: 42598558768587247825016n, vShares: 1n, dStake: 37019546200545020937n, dShares: 2n, vDeposit: 0n, vWithdrawal: 0n, live: true } });
  assert.deepEqual(decodeValidatorView(view), { bannedEpoch: 0, primedEpoch: 168, selfStake: "42598558768587247825016",
    delegatedStake: "37019546200545020937", live: true });
  assert.equal(decodeValidatorView("0x"), null);

  const strings = ["moniker", "logoUri", "website", "description", "email", "twitter", "telegram", "github"].map((name) => ({ name, type: "string" }));
  const identity = (moniker) => encodeAbiParameters([{ type: "tuple", components: [...strings, { name: "extraCid", type: "bytes" }] }],
    [{ moniker, logoUri: "https://example.org/logo.png", website: "", description: "a node", email: "", twitter: "", telegram: "", github: "", extraCid: "0x" }]);
  assert.equal(decodeMoniker(identity("HusoNode")), "HusoNode");
  assert.equal(decodeMoniker(identity("Node Ωmega 42 with a longer name than one word")), "Node Ωmega 42 with a longer name than one word");
  assert.equal(decodeMoniker(identity("")), null);
  assert.equal(decodeMoniker("0x"), null);
});

test("stake in GEN and selection weight", () => {
  assert.equal(toGen("42598558768587247825016"), 42598.558768);
  assert.equal(toGen(null), null);
  assert.equal(weightOf(100, 0).toFixed(4), Math.sqrt(60).toFixed(4));
  assert.equal(weightOf(100, 100), 10);
});

test("an EpochAdvance log decodes to its epoch, block and time", () => {
  // data, block and time of the start of epoch 168 on Bradbury
  const hex = (n) => "0x" + n.toString(16);
  const log = { data: "0x00000000000000000000000000000000000000000000000000000000000000a8", blockNumber: hex(23282534),
                logIndex: "0x0", blockTimestamp: hex(1790877093) };
  assert.deepEqual(decodeEpochAdvance(log), { epoch: 168, block: 23282534, logIndex: 0, ts: 1790877093 });
});
