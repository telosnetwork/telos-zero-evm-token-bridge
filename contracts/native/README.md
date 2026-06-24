# Telos Zero Native Contracts

This folder contains the native-side MVP contracts.

- `zero.asset`: minimal bridge-issued asset contract with `create`, `issue`, `burn`, and `transfer`.
- `zero.bridge`: bridge lifecycle contract for fresh Zero assets backed by escrowed Telos EVM assets.

Current status:

- The Zero-to-EVM path creates a burn request when a user transfers a fresh bridge asset to `zero.bridge`, then schedules an immediate self-call to release the EVM funds.
- The EVM-to-Zero path has a public `proveetoz` action that verifies fixed proof slots in the Telos EVM bridge contract through `eosio.evm::accountstate`.
- The Zero-to-EVM release path uses the same `relayztoe` logic for both automatic release and manual retry. It verifies a burn request and dispatches `releaseToEvm` through `eosio.evm::raw` from the bridge account's linked EVM address.
- The old `processetoz` action remains gated by `dev_mode` for legacy/manual test harnesses only.
- Production must run with `dev_mode = false`, configure `setevmconf` and `setevmrelay`, use `proveetoz`/`relayztoe` for ordinary processing, and put admin authority under a large governance MSIG.

Production proof setup:

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge setevmconf \
  '["<EVM_BRIDGE_20_BYTES>",0]' \
  -p <governance-msig-admin>@active

cleos -u "$TELOS_ZERO_API" push action zerobridge setevmchain \
  '[41]' \
  -p <governance-msig-admin>@active

cleos -u "$TELOS_ZERO_API" push action zerobridge setevmrelay \
  '["zerobridge"]' \
  -p <governance-msig-admin>@active
```

Use `0` finality delay on testnet when instant finality is active. If governance wants an additional operational delay, set it explicitly rather than treating wall-clock delay as the security boundary.

Use chain ID `41` on Telos EVM testnet and `40` on Telos EVM mainnet.

The EVM bridge constructor-fixed `zeroBridge` address must equal the linked EVM address for `zerobridge`; otherwise `relayztoe` will dispatch the call but the EVM contract will reject it with `NotZeroBridge`.

Build requirement:

- Antelope CDT with `cdt-cpp`/`eosio-cpp` or CMake `find_package(cdt)` support.

Example build:

```sh
mkdir -p build
cd build
cmake -DCMAKE_TOOLCHAIN_FILE=/usr/lib/cmake/cdt/CDTWasmToolchain.cmake ..
make
```

On macOS, the repo-level helper uses Docker/Colima and the official Linux CDT package:

```sh
../../scripts/build-native-docker.sh
```

Permission note:

The bridge account must be able to call `zero.asset::issue` and `zero.asset::burn` inline. In practice, the bridge account needs its contract `eosio.code` permission configured appropriately, and the fresh asset must use the bridge account as issuer.

For automatic Zero-to-EVM release and manual `relayztoe` retries, the bridge account also needs:

- a linked `eosio.evm` account row,
- enough TLOS on that linked EVM address to pay gas,
- active permission containing `zerobridge@eosio.code`, because the transfer handler schedules `relayztoe` as a deferred self-transaction and the release sends `eosio.evm::raw` inline as `zerobridge@active`.

Relayer note:

`proveetoz` and `relayztoe` are intentionally public actions. Production automation should use a finite account permission such as `bridgeops`, linked only to those bridge actions. The key behind that permission improves fallback liveness when automatic release fails or stalls, but it cannot redirect value because the contract verifies EVM storage or native burn state before it mutates bridge balances.

Production admin note:

Examples may use `bridgeadmin` for readability. On mainnet, replace that with the approved large MSIG-controlled admin account/permission; no bridge owner, issuer, or admin authority should be controlled by one person.
