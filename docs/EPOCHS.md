# Epoch changes on Bradbury

Start of each epoch from 164 to 169, read from the staking contract of GenLayer Bradbury
(`0x4A4449E617F8D10FDeD0b461CadEf83939E821A5`): the block of its `EpochAdvance(uint256 epoch)`
event, the time of that block and the transaction that emitted it. Read on 2026-10-02.

| Epoch | Start block | Start (UTC) | Transaction of the `EpochAdvance` event | Duration |
|---|---|---|---|---|
| 164 | 22690410 | 2026-09-24 16:25:50 | `0xf228141685ef5925f023066dc38e09022c16f173363cbc4358f9046c2e2b6c61` | 3 d 21 h 16 min |
| 165 | 23069435 | 2026-09-28 13:41:51 | `0x74d7a7cb01ba0caa241251d6fa72509d3f5d28333ef31c8709693eadd5fff3c8` | 1 d 0 h 4 min |
| 166 | 23140935 | 2026-09-29 13:45:51 | `0x849b4cc584ae999980f63ab14fdab19a1eb40f94e262a6a7e0d857975572d217` | 1 d 0 h 2 min |
| 167 | 23212962 | 2026-09-30 13:47:51 | `0x10a1aa55f121f68327531b472ed96f63c5caacd1c45ad8d5123e2abaf253943e` | 1 d 4 h 3 min |
| 168 | 23282534 | 2026-10-01 17:51:33 | `0x93a2fd57c1e76028b4e23c63ec032c2d8ba6ab9df1c013dd78313ca2918fd768` | 1 d 0 h 2 min |
| 169 | 23351944 | 2026-10-02 17:53:34 | `0x642294221637a0a3c8e217500d40adc5ecb54c1f805acfd7fbd5427925882901` | in progress when read |

The duration of an epoch is the start of the next one minus its own start. An epoch lasts at least
24 hours (`epochMinDuration` of the staking contract) and ends when the next `EpochAdvance` is
emitted, so it can run longer: epoch 164 lasted 3 days 21 hours.

## How to read it again

- `eth_getLogs` on the staking contract with the topic of `EpochAdvance`
  (`0x98f021e0ecab7c38e92fb55a25d5d8d422d82e26b170cee83568d7d6221353af`); the epoch number is in the
  data of the log. The RPC answers ranges of up to about 2,000 blocks.
- `epoch()` (selector `0x900cf0cf`) with `eth_call` at a past block returns the epoch in effect at
  that block, which narrows the range to ask the logs for.
- `eth_getBlockByNumber` gives the time of the block.

The collector reads the same event every minute and keeps the start of each epoch in its `epochs`
table (`collector/core/staking.js`, `collector/worker/src/collect.js`). The page shows them in the
top bar, in the `View` selector and in Events.
