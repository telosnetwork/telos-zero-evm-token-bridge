# Telos Zero <> EVM Relayer Tools

This package contains operator tooling for the MVP.

It does not decide bridge validity. Its current jobs are:

- reconcile EVM escrow balances against fresh Zero asset supply,
- scan `EvmToZeroRequested` logs for testnet operations,
- push pending EVM-to-Zero requests to the Telos Zero bridge account when a signer is configured,
- scan native `zero.bridge::ztoereqs` rows and trigger the public `relayztoe` action when the deployed bridge ABI supports it,
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

The processor action is normally `auto`: it uses `proveetoz` when that action exists in the deployed Zero bridge ABI, otherwise it falls back to the current testnet/dev `processetoz` action.

## Processing Zero-to-EVM Requests

Preview native burn requests without signing or broadcasting:

```sh
npm run process:zero -- --dry-run
```

Release a specific native burn request on Telos EVM:

```sh
export ZERO_TO_EVM_RELAYER_PRIVATE_KEY="..."
npm run process:zero -- --request-id 4
```

Keep processing new native burn requests:

```sh
export ZERO_TO_EVM_RELAYER_PRIVATE_KEY="..."
npm run process:zero:watch
```

The processor defaults to `ZERO_TO_EVM_RELAY_MODE=auto`: it uses the public native `relayztoe` action when the deployed ABI exposes it, otherwise it falls back to the legacy testnet `evm-key` release mode.

In native mode, the private key only signs the Telos Zero transaction that calls `relayztoe`. It does not need bridge account authority, and it cannot choose the receiver or amount. The bridge contract reads its own burn row, verifies replay state against `processedZeroBurns`, builds the EVM calldata, and dispatches `eosio.evm::raw`.

For hosted automation, configure a finite native permission such as `bridgeops` and link it only to `zero.bridge::proveetoz` and `zero.bridge::relayztoe`. The testnet config uses this shape so the liveness key is not an admin, token, or deploy key.

The configured authorization defaults to `zero.zeroToEvmAuthorization`, then `zero.authorization`, and can be overridden with `ZERO_TO_EVM_RELAYER_ACCOUNT` and `ZERO_TO_EVM_RELAYER_PERMISSION`.

Legacy fallback mode still requires `EVM_RELAYER_PRIVATE_KEY` to resolve to the EVM bridge contract's configured `zeroBridge()` dispatcher address. Use it only for old test deployments that do not expose `relayztoe`.

## Production Boundary

For the same-chain bridge design, a relayer should only improve liveness and UX. Production EVM-to-Zero mint validity comes from `zero.bridge::proveetoz` reading `eosio.evm::accountstate`, not from an operator process saying that a deposit happened.

For Zero-to-EVM, production validity comes from `zero.bridge::relayztoe` reading native burn state and EVM replay state before dispatching `releaseToEvm` from the bridge account's linked EVM address. The relayer is only a liveness actor.
