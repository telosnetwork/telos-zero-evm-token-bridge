# Telos Zero <> EVM Token Bridge

This repository contains the contracts and backend/operator tooling for a fresh Telos Zero <> Telos EVM asset bridge.

Target MVP assets:

- Telos EVM `USDC.e` -> fresh Telos Zero `ZUSDC`
- Telos EVM `USDT` -> fresh Telos Zero `ZUSDT`
- Telos EVM `WBTC` -> fresh Telos Zero `ZWBTC`
- Telos Zero `EMPIRES` -> Telos EVM `wEMPIRES` test asset

The bridge is designed around the fact that Telos Zero and Telos EVM share the same underlying chain. Relayers are treated as liveness/UX helpers, not trusted oracles.

## Status

The source includes the [September 2026 audit fixes](docs/audit-remediation.md), with regression tests and rollout requirements. Existing deployment records describe older contracts; these changes have not been deployed. The EVM fixes require new contracts and a reviewed migration.

Built now:

- EVM escrow and registry contracts with Foundry tests.
- Native Telos Zero asset contract for fresh bridge assets.
- Native Telos Zero bridge contract with `eosio.evm::accountstate` proof verification for EVM-to-Zero deposits and permissionless native dispatch for Zero-to-EVM releases through `eosio.evm::raw`.
- Node operator tools for reconciliation, EVM event scanning, signed Telos Zero request processing, and permissionless Zero-to-EVM relay triggering.
- Production spec in `zero-evm-bridge-production-spec.md`.
- Testnet MVP runbook in `docs/testnet-mvp-runbook.md`.

The UI integration lives separately in the Telos Bridge v3 frontend branch.

Testnet live now:

- Native bridge is deployed on Telos testnet with `dev_mode = false`.
- EVM bridge is deployed with `zeroBridge` set to the bridge account's linked EVM address.
- Zero-to-EVM release is driven through `relayztoe` and `eosio.evm::raw`; no reusable EVM relayer private key is needed.
- Hosted testnet relayer uses `tbrgrelay111@bridgeops`, a finite liveness permission linked to the bridge proof/relay actions.

Remaining production gates:

- Mainnet ownership/admin must be handed to a large governance MSIG, not a single signer or developer-held account.
- Mainnet deployment must repeat the linked bridge-account EVM sender setup under MSIG control.
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
- `zero.bridge`: Zero-side burn/request tracker plus `proveetoz`, which verifies fixed EVM proof slots from `eosio.evm::accountstate`, and `relayztoe`, which dispatches validated releases through `eosio.evm::raw`.

Build requires Antelope CDT. On macOS, use the Docker helper:

```sh
cd contracts/native
../../scripts/build-native-docker.sh
```

The verified local build produced `zero.asset.wasm`, `zero.asset.abi`, `zero.bridge.wasm`, and `zero.bridge.abi` in `contracts/native/build`.

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
- `ZERO_TO_EVM_RELAYER_PRIVATE_KEY=... node src/process-zero-requests.js src/config.local.json --request-id <id>`
- `ZERO_TO_EVM_RELAYER_PRIVATE_KEY=... npm run process:zero:watch`

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
3. Any relayer calls `zero.bridge::relayztoe(request_id)`.
4. `zero.bridge` verifies the burn row, replay state, limits, and finality, then calls `eosio.evm::raw` from the bridge account's linked EVM address to execute `releaseToEvm`.
5. A self-authorized native check verifies EVM completion; failure rolls back the native transaction and transactional EVM changes. With a positive finality delay, the burn remains pending until a later eligible `relayztoe`.
6. The relayer key only pays to submit `relayztoe`; it is not trusted to release or redirect funds.

## Production Gates

- Instant finality is live and stable on testnet.
- Native verification can prove EVM escrow records from Telos Zero on testnet with `dev_mode = false`.
- EVM release path is driven by `relayztoe` and a linked bridge-account EVM sender, with no reusable EVM relayer private key.
- Hosted relayers use a finite native permission such as `bridgeops`, linked only to `zero.bridge::proveetoz`, `zero.bridge::relayztoe`, and `zero.bridge::refundetoz`.
- Admin/owner authorities are controlled by the production governance MSIG, with separate narrow emergency pause permissions.
- Daily limits, pause controls, and recovery procedures are reviewed.
- End-to-end testnet runs cover USDC.e, USDT, and WBTC in both directions.
- Independent audit covers EVM Solidity, native C++, permissions, and replay protection.
