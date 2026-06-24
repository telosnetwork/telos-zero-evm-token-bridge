# Telos Zero <> EVM Token Bridge

This repository contains the contracts and backend/operator tooling for a fresh Telos Zero <> Telos EVM asset bridge.

Target MVP assets:

- Telos EVM `USDC.e` -> fresh Telos Zero `ZUSDC`
- Telos EVM `USDT` -> fresh Telos Zero `ZUSDT`
- Telos EVM `WBTC` -> fresh Telos Zero `ZWBTC`
- Telos Zero `EMPIRES` -> Telos EVM `wEMPIRES` test asset

The bridge is designed around the fact that Telos Zero and Telos EVM share the same underlying chain. Relayers are treated as liveness/UX helpers, not trusted oracles.

## Status

Built now:

- EVM escrow and registry contracts with Foundry tests.
- Native Telos Zero asset contract for fresh bridge assets.
- Native Telos Zero bridge contract with `eosio.evm::accountstate` proof verification for EVM-to-Zero deposits.
- Node operator tools for reconciliation, EVM event scanning, signed Telos Zero request processing, and Zero-to-EVM EVM release processing.
- Production spec in `zero-evm-bridge-production-spec.md`.
- Testnet MVP runbook in `docs/testnet-mvp-runbook.md`.

The UI integration lives separately in the Telos Bridge v3 frontend branch.

Remaining production gates:

- Production ownership/admin must be handed to a large governance MSIG, not a single signer or developer-held account.
- Native WASM/ABI must be rebuilt with CDT and re-deployed; the current macOS Docker/Colima VM was unavailable during this pass.
- The new `proveetoz` path needs chain-level testnet validation against live `eosio.evm::accountstate` rows.
- Zero-to-EVM release still requires the authorized EVM caller to be replaced with a Zero-governed dispatcher before mainnet.
- External pass-through routes, such as Zero -> Telos EVM -> Base, are intentionally outside the MVP.

## Packages

### EVM

Path: `evm`

Contracts:

- `BridgeRegistry`: asset pair registry, limits, pause state.
- `EvmEscrowBridge`: escrow deposits from Telos EVM users and release escrowed tokens for validated Zero burns.

Run:

```sh
cd evm
forge test -vvv
```

### Native Telos Zero

Path: `contracts/native`

Contracts:

- `zero.asset`: minimal fresh asset contract.
- `zero.bridge`: Zero-side burn/request tracker plus `proveetoz`, which verifies fixed EVM proof slots from `eosio.evm::accountstate`.

Build requires Antelope CDT. On this macOS workspace, use the Docker helper:

```sh
cd contracts/native
../../scripts/build-native-docker.sh
```

The verified local build produces `zero.asset.wasm`, `zero.asset.abi`, `zero.bridge.wasm`, and `zero.bridge.abi` in `contracts/native/build`.

### Relayer Tools

Path: `relayer`

Tools:

- `npm test`
- `node src/reconcile.js src/config.local.json`
- `node src/scan-evm-requests.js src/config.local.json`
- `node src/process-evm-requests.js src/config.local.json --dry-run`
- `ZERO_RELAYER_PRIVATE_KEY=... node src/process-evm-requests.js src/config.local.json`
- `ZERO_RELAYER_PRIVATE_KEY=... npm run process:evm:watch`
- `node src/process-zero-requests.js src/config.local.json --dry-run`
- `EVM_RELAYER_PRIVATE_KEY=... node src/process-zero-requests.js src/config.local.json --request-id <id>`
- `EVM_RELAYER_PRIVATE_KEY=... npm run process:zero:watch`

Copy `src/config.example.json` for testnet deployments. `src/config.telos-mainnet-assets.example.json` records the current Telos EVM asset addresses for the target mainnet asset set.

## MVP Flow

EVM to Zero:

1. User calls `EvmEscrowBridge.depositToZero(pairId, amount, zeroReceiver)`.
2. EVM asset is escrowed.
3. Contract emits `EvmToZeroRequested`.
4. Any relayer submits `zero.bridge::proveetoz` with the request hash, receiver, amount, and EVM sender.
5. `zero.bridge` reads the EVM bridge storage from `eosio.evm::accountstate` and issues fresh Zero assets only if the proof fields match.

Zero to EVM:

1. User signs a Telos Zero transfer of `ZUSDC`, `ZUSDT`, `ZWBTC`, or `EMPIRES` to `zero.bridge` with the EVM receiver address in the memo.
2. `zero.bridge` records the burn request and burns the bridge asset.
3. The authorized EVM bridge caller releases escrowed Telos EVM assets through `releaseToEvm`.
4. Production must ensure the authorized EVM caller is backed by same-chain verification, not an operator oracle.

## Production Gates

- Instant finality is live and stable on testnet.
- Native verification can prove EVM escrow records from Telos Zero on testnet with `dev_mode = false`.
- EVM release path can be driven by verified Zero burn state.
- Admin/owner authorities are controlled by the production governance MSIG, with separate narrow emergency pause permissions.
- Daily limits, pause controls, and recovery procedures are reviewed.
- End-to-end testnet runs cover USDC.e, USDT, and WBTC in both directions.
- Independent audit covers EVM Solidity, native C++, permissions, and replay protection.
