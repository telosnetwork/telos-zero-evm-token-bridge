# Telos Zero <> EVM Relayer Tools

This package contains operator tooling for the MVP.

It does not decide bridge validity. Its current jobs are:

- reconcile EVM escrow balances against fresh Zero asset supply,
- scan `EvmToZeroRequested` logs for testnet operations,
- push pending EVM-to-Zero requests to the Telos Zero bridge account when a signer is configured,
- scan native `zero.bridge::ztoereqs` rows and retry the public `relayztoe` action for old or stalled Zero-to-EVM requests,
- provide a small place to add production watchers around the native `proveetoz` verification path.

## Setup

```sh
cp src/config.example.json src/config.local.json
npm install
npm test
npm run reconcile
```

`src/config.example.json` is a testnet/deployment template with placeholder EVM addresses. `src/config.telos-mainnet-assets.example.json` records the current Telos EVM assets targeted by the MVP, but still needs the deployed bridge and fresh Zero asset contract accounts before it is runnable.

## Processing EVM-to-Zero Requests

Preview pending requests without signing or broadcasting:

```sh
npm run process:evm -- --dry-run
```

Process a specific request after loading the configured Zero authority key into the environment:

```sh
export ZERO_RELAYER_PRIVATE_KEY="..."
npm run process:evm -- --request-id 4
```

Process every unprocessed request found in the configured scan window:

```sh
export ZERO_RELAYER_PRIVATE_KEY="..."
npm run process:evm
```

Keep processing new requests:

```sh
export ZERO_RELAYER_PRIVATE_KEY="..."
npm run process:evm:watch
```

Set `ZERO_RELAYER_POLL_MS` to tune the polling interval. The default is 10000ms.

The configured authorization defaults to `zero.authorization` in `src/config.local.json`, and can be overridden with `ZERO_RELAYER_ACCOUNT` and `ZERO_RELAYER_PERMISSION`. `ZERO_RELAYER_PRIVATE_KEYS` accepts a comma-separated list when an action needs more than one signature.

The processor action `auto` selects `proveetoz` and fails if the deployed ABI lacks it. Development `processetoz` must be selected explicitly and still requires the native contract to have development minting enabled. It is not a production fallback.

## Durable discovery and recovery

Set `evm.scanFromBlock` to the fixed deployment block. The default is `0`; `"latest"` is rejected because it skips events between polls. `evm.scanOverlapBlocks` defaults to 120. Omit `scanToBlock` for normal watching.

The EVM processor persists its scan cursor and unresolved requests together before submitting transactions. The state path is `ZERO_RELAYER_STATE_FILE`, then `zero.stateFile`, then `<config-path>.state.json`. Put it on persistent storage and use one worker per state file. A changed bridge/chain identity requires a separate file. The `.lock` file prevents concurrent writers; after an unclean shutdown, first establish that the old worker is stopped before removing its stale lock. Corrupt state fails closed. Restore a backup or deliberately rescan from the deployment block to rebuild it; never skip forward past unresolved work.

Each request is isolated. Failures remain in `pending` with `attempts` and `lastError`, while later requests continue. Partial failure exits with status 1; monitor that result and the pending queue. `--request-id` limits submissions while preserving other discovered requests. `--dry-run` neither sends transactions nor changes durable state.

For an unissued deposit, its original EVM sender may call `requestDepositRefund(requestId)`. The processor observes the cancellation status and submits `refundetoz` instead of minting. Recovery does not require a usable native destination account. It requires both patched contracts; existing non-upgradeable EVM deployments cannot acquire this protocol in place. The native contract rejects a refund if issuance already occurred. See the [cancellation protocol and rollout requirements](../docs/audit-remediation.md).

## Retrying Zero-to-EVM Requests

Preview native burn requests without signing or broadcasting:

```sh
npm run process:zero -- --dry-run
```

Retry a specific native burn request on Telos EVM:

```sh
export ZERO_TO_EVM_RELAYER_PRIVATE_KEY="..."
npm run process:zero -- --request-id 4
```

Keep watching for stalled native burn requests:

```sh
export ZERO_TO_EVM_RELAYER_PRIVATE_KEY="..."
npm run process:zero:watch
```

With a zero finality delay, the bridge dispatches releases inline from the token transfer handler; failed execution rolls back that user transfer. With a positive delay, this processor releases committed pending burns once eligible. `ZERO_TO_EVM_RELAY_MODE=auto` selects native `relayztoe` and fails if unavailable. Legacy `evm-key` mode is opt-in and has no automatic fallback.

In native mode, the private key only signs the Telos Zero transaction that calls `relayztoe` as a retry. It does not need bridge account authority, and it cannot choose the receiver or amount. The bridge contract reads its own burn row, verifies replay state against `processedZeroBurns`, builds the EVM calldata, and dispatches `eosio.evm::raw`.

For hosted automation, configure a finite native permission such as `bridgeops` and link it only to `zero.bridge::proveetoz`, `zero.bridge::relayztoe`, and `zero.bridge::refundetoz`. The testnet config uses this shape so the liveness key is not an admin, token, or deploy key.

The configured authorization defaults to `zero.zeroToEvmAuthorization`, then `zero.authorization`, and can be overridden with `ZERO_TO_EVM_RELAYER_ACCOUNT` and `ZERO_TO_EVM_RELAYER_PERMISSION`.

Explicit `ZERO_TO_EVM_RELAY_MODE=evm-key` still requires `EVM_RELAYER_PRIVATE_KEY` to resolve to the EVM bridge contract's configured `zeroBridge()` dispatcher address. Use it only for old test deployments that do not expose `relayztoe`.

## Production Boundary

For the same-chain bridge design, a relayer should only improve liveness and UX. Production EVM-to-Zero mint validity comes from `zero.bridge::proveetoz` reading `eosio.evm::accountstate`, not from an operator process saying that a deposit happened.

For Zero-to-EVM, production validity comes from the automatic `zero.bridge::relayztoe` release logic reading native burn state and EVM replay state before dispatching `releaseToEvm` from the bridge account's linked EVM address. The relayer is only a fallback liveness actor.

Reconciliation currently excludes pending deposit and withdrawal liabilities and does not pin a common block across native and EVM reads. Its `OK` is a supply comparison, not a full solvency or liveness guarantee. See the remaining monitoring gate in [audit remediation](../docs/audit-remediation.md).
