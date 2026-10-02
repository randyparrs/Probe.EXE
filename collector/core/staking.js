// What the collector needs from Bradbury's staking contract (genlayer-js 1.2.0,
// chains.testnetBradbury.stakingContract). staking.test.mjs checks these values against the ABI.

export const STAKING_ADDRESS = "0x4A4449E617F8D10FDeD0b461CadEf83939E821A5";

// event EpochAdvance(uint256 epoch): emitted when an epoch starts; the number is in the data
export const EPOCH_ADVANCE_TOPIC = "0x98f021e0ecab7c38e92fb55a25d5d8d422d82e26b170cee83568d7d6221353af";

// function epoch() returns (uint256): the current epoch; the RPC also answers it for past blocks
export const EPOCH_SELECTOR = "0x900cf0cf";

// validator sets and data, read with eth_call
export const SELECTOR = {
  activeValidators: "0xd2d49c4b",             // activeValidators() returns (address[])
  quarantinedValidators: "0x510a6f26",        // getAllQuarantinedValidators(uint256 start, uint256 size) returns (tuple[])
  bannedValidators: "0x6461cf56",             // getAllBannedValidators(uint256 start, uint256 size) returns (tuple[])
  validatorView: "0xb83f5b39",                // validatorView(address) returns (tuple of 12 static fields)
  getIdentity: "0x36afc6fa",                  // on the validator's own wallet contract: getIdentity() returns (tuple of strings)
};
export const BANNED_PAGE = 100;

const uint = (n) => BigInt(n).toString(16).padStart(64, "0");
const words = (hex) => hex.slice(2).match(/.{64}/g) ?? [];
const addressOf = (w) => "0x" + w.slice(24);
const ZERO = "0x" + "0".repeat(40);

export const callData = {
  bannedValidators: () => SELECTOR.bannedValidators + uint(0) + uint(BANNED_PAGE),
  quarantinedValidators: () => SELECTOR.quarantinedValidators + uint(0) + uint(BANNED_PAGE),
  validatorView: (validator) => SELECTOR.validatorView + validator.toLowerCase().replace(/^0x/, "").padStart(64, "0"),
};

// address[] -> lowercase addresses, without the empty slots of the active list
export function decodeAddresses(hex) {
  const w = words(hex), at = parseInt(w[0], 16) / 32, n = parseInt(w[at], 16);
  return Array.from({ length: n }, (_, i) => addressOf(w[at + 1 + i])).filter((a) => a !== ZERO);
}

// tuple(address validator, uint256 untilEpochBanned, bool permanentlyBanned)[]: the banned list and
// the quarantine records have this shape
export function decodeBanned(hex) {
  const w = words(hex), at = parseInt(w[0], 16) / 32, n = parseInt(w[at], 16);
  return Array.from({ length: n }, (_, i) => ({ validator: addressOf(w[at + 1 + 3 * i]), until: parseInt(w[at + 2 + 3 * i].slice(48), 16),
    permanent: parseInt(w[at + 3 + 3 * i], 16) === 1 }));
}

// validatorView: (left, right, parent, eBanned, ePrimed, vStake, vShares, dStake, dShares, vDeposit,
// vWithdrawal, live). Stakes are returned as decimal strings in wei.
export function decodeValidatorView(hex) {
  const w = words(hex);
  if (w.length < 12) return null;
  const big = (i) => BigInt("0x" + w[i]).toString();
  return { bannedEpoch: parseInt(w[3].slice(48), 16), primedEpoch: parseInt(w[4].slice(48), 16), selfStake: big(5), delegatedStake: big(7),
           live: parseInt(w[11], 16) === 1 };
}

// Whether a quarantine record applies in an epoch. The staking contract keeps the records after
// they expire: one "until epoch N" stops applying when epoch N starts.
export const inEffect = (record, epoch) => record.permanent || record.until > epoch;

// getIdentity: a tuple whose first member is the moniker (string). null when there is none.
export function decodeMoniker(hex) {
  const w = words(hex);
  if (w.length < 3) return null;
  const tuple = parseInt(w[0], 16) / 32, at = tuple + parseInt(w[tuple], 16) / 32, len = parseInt(w[at], 16);
  if (!(len > 0) || len > 256) return null;
  const bytes = hex.slice(2 + 64 * (at + 1), 2 + 64 * (at + 1) + 2 * len).match(/../g) ?? [];
  if (bytes.length !== len) return null;
  const text = new TextDecoder().decode(Uint8Array.from(bytes, (b) => parseInt(b, 16))).trim();
  return text || null;
}

// selection weight of a validator, from the GenLayer staking documentation: (0.6 x own stake +
// 0.4 x delegated stake) ^ 0.5, with the stakes in GEN
export const ALPHA = 0.6, BETA = 0.5;
export const toGen = (wei) => (wei == null ? null : Number(BigInt(wei) / 10n ** 12n) / 1e6);
export const weightOf = (selfGen, delegatedGen) => Math.pow(ALPHA * selfGen + (1 - ALPHA) * delegatedGen, BETA);

// log of EpochAdvance -> { epoch, block, logIndex, ts }
export function decodeEpochAdvance(log) {
  return { epoch: parseInt(log.data.slice(2, 66), 16), block: Number(log.blockNumber), logIndex: Number(log.logIndex),
           ts: log.blockTimestamp != null ? Number(log.blockTimestamp) : null };
}
