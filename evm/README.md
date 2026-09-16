# Telos EVM Bridge Contracts

This Foundry package contains the Telos EVM side of the Zero <> EVM bridge MVP.

## Contracts

- `BridgeRegistry`: governed pair registry for EVM token, fresh Zero asset ID, decimals, limits, and active state.
- `EvmEscrowBridge`: escrows supported EVM tokens for EVM -> Zero deposits, writes fixed storage proof records for native verification, and releases escrowed tokens for verified Zero -> EVM burns.

## Test

```shell
forge test -vvv
```

## Format

```shell
forge fmt
```

## Deploy

Set:

- `BRIDGE_OWNER`
- `ZERO_BRIDGE_EVM_ADDRESS`

```shell
forge script script/Deploy.s.sol:Deploy --rpc-url <telos-evm-rpc> --broadcast
```

After deployment, add governed pairs through `BridgeRegistry.addPair`.

To register pairs against an existing registry:

```shell
forge script script/RegisterPairs.s.sol:RegisterPairs --rpc-url <telos-evm-rpc> --broadcast
```

## Production Notes

- `BRIDGE_OWNER` must be a large governance MSIG or an EVM owner contract controlled by that MSIG. It must not be a single EOA.
- `ZERO_BRIDGE_EVM_ADDRESS` must not be a developer wallet in production. It is constructor-fixed and should be controlled by the trust-minimized Zero-side verification/dispatch path or an approved interim testnet harness.
- The registry address is also constructor-fixed; governance can manage pairs/limits through `BridgeRegistry`, but cannot silently swap the bridge to a different registry.
- `depositToZero` stores a fixed-slot request proof keyed by `requestHash`. The native bridge reads those slots through `eosio.evm::accountstate`.
- Pair limits should start conservatively, especially for WBTC.
- The escrow bridge is intentionally simple: no swaps, no external-chain routing, no price logic.

## Audit fixes and recovery

Pair registration validates deployed token code and actual decimals. Transfers require exact balance deltas; fee-on-transfer and rebasing assets are unsupported. Native names must be canonical, and amounts must convert exactly into supported native units. Deposit and release budgets are separate per-pair counters, both bounded by `dailyLimit` in fixed UTC-day buckets.

`requestDepositRefund(requestId)` records the original depositor's cancellation intent. Only the native dispatcher can complete `refundDeposit`, after native verification that the request has not minted. Recovery remains available while paused. Proof offset 5 encodes unknown/mintable/cancelled/refunded as 0/1/2/3, and the existing proof getter reports `exists` only for 1. `processedZeroBurns` retains mapping slot 6.

These contracts are not upgradeable. Existing deployments do not acquire these fixes by publishing this code. See [audit remediation](../docs/audit-remediation.md) for the protocol, regressions, and reviewed migration requirement.
