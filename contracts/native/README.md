# Telos Zero Native Contracts

This folder contains the native-side MVP contracts.

- `zero.asset`: minimal bridge-issued asset contract with `create`, `issue`, `burn`, and `transfer`.
- `zero.bridge`: bridge lifecycle contract for fresh Zero assets backed by escrowed Telos EVM assets.

Current status:

- The Zero-to-EVM path creates a burn request when a user transfers a fresh bridge asset to `zero.bridge`.
- The EVM-to-Zero path has a public `proveetoz` action that verifies fixed proof slots in the Telos EVM bridge contract through `eosio.evm::accountstate`.
- The old `processetoz` action remains gated by `dev_mode` for legacy/manual test harnesses only.
- Production must run with `dev_mode = false`, configure `setevmconf`, use `proveetoz` for ordinary EVM-to-Zero processing, and put admin authority under a large governance MSIG.

Production proof setup:

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge setevmconf \
  '["<EVM_BRIDGE_20_BYTES>",0]' \
  -p <governance-msig-admin>@active
```

Use `0` finality delay on testnet when instant finality is active. If governance wants an additional operational delay, set it explicitly rather than treating wall-clock delay as the security boundary.

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

Production admin note:

Examples may use `bridgeadmin` for readability. On mainnet, replace that with the approved large MSIG-controlled admin account/permission; no bridge owner, issuer, or admin authority should be controlled by one person.
