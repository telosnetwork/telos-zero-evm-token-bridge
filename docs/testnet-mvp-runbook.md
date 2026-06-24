# Testnet MVP Runbook

This runbook is for the first end-to-end testnet loop using mock Telos EVM ERC-20s and fresh Telos Zero assets.

Testnet already has instant finality enabled for this bridge work. Run the normal EVM-to-Zero path with `dev_mode = false` and `zero.bridge::proveetoz`; keep `processetoz` only for isolated legacy harness debugging.

## 1. Build Native Contracts

```sh
colima start
./scripts/build-native-docker.sh
```

Outputs:

- `contracts/native/build/zero.asset.wasm`
- `contracts/native/build/zero.asset.abi`
- `contracts/native/build/zero.bridge.wasm`
- `contracts/native/build/zero.bridge.abi`

## 2. Deploy EVM Mock Tokens

Create `packages/evm/.env.testnet` from `packages/evm/.env.example`.

Set at minimum:

```sh
TELOS_EVM_RPC=<testnet-evm-rpc>
DEPLOYER_PRIVATE_KEY=<testnet-deployer-key>
MOCK_INITIAL_HOLDER=<funded-test-wallet>
```

Deploy mock tokens:

```sh
cd packages/evm
source .env.testnet
forge script script/DeployMocks.s.sol:DeployMocks \
  --rpc-url "$TELOS_EVM_RPC" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
```

Copy the deployed mock token addresses into:

- `USDC_EVM_TOKEN`
- `USDT_EVM_TOKEN`
- `WBTC_EVM_TOKEN`

## 3. Deploy EVM Bridge and Register Pairs

Fill:

```sh
BRIDGE_OWNER=<large-msig-owned-or-test-owner-evm-address>
ZERO_BRIDGE_EVM_ADDRESS=<authorized-zero-dispatcher-evm-address>
```

For initial testnet this dispatcher can be a controlled test harness address. It must not be treated as production architecture for the Zero-to-EVM leg.

Production owner assumption: `BRIDGE_OWNER` must be a large governance MSIG or an EVM owner contract controlled by that MSIG. Testnet may use a single account only as a temporary harness.

Deploy:

```sh
forge script script/DeployAndRegister.s.sol:DeployAndRegister \
  --rpc-url "$TELOS_EVM_RPC" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
```

Record the deployed `BridgeRegistry` and `EvmEscrowBridge` addresses.

If the registry and bridge were deployed separately, set `REGISTRY_ADDRESS` and run:

```sh
forge script script/RegisterPairs.s.sol:RegisterPairs \
  --rpc-url "$TELOS_EVM_RPC" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
```

### Optional: Deploy EVM Contracts From a Zero Key

Telos supports a native-to-EVM execution path through `eosio.evm::raw`. A Telos Zero account can use its linked EVM address as the EVM sender, provided the linked EVM address exists and has enough TLOS on EVM to pay gas.

This means the MVP can be deployed from a Telos Zero-controlled authority instead of a standalone EVM private key.

High-level flow:

1. Create or confirm the linked EVM address for the Telos Zero deployer account.
2. Fund that linked EVM address with testnet TLOS on Telos EVM.
3. Build the Solidity deployment transaction using the linked EVM address nonce, gas price, gas limit, constructor args, and bytecode.
4. Submit the serialized EVM transaction through `eosio.evm::raw` signed by the Telos Zero account.
5. Repeat for registry, bridge, mock tokens, and pair registration calls.

Important implications:

- The EVM contract `msg.sender` is the linked EVM address.
- Constructor/admin ownership should be set to the intended governance/test owner, not accidentally left as a throwaway deploy address.
- Gas failures still happen on the EVM side; the linked EVM address needs TLOS.
- For production, this is a good governance path only if the Zero account is controlled by the approved large MSIG. For MVP, a single testnet Zero account is enough as a harness.

## 4. Deploy Native Contracts

Use Telos testnet native CLI tooling. Command names vary by installation; examples below use `cleos`.

Deploy `zero.asset` to each fresh asset account:

```sh
cleos -u "$TELOS_ZERO_API" set contract usdc.bridge contracts/native/build zero.asset.wasm zero.asset.abi -p usdc.bridge@active
cleos -u "$TELOS_ZERO_API" set contract usdt.bridge contracts/native/build zero.asset.wasm zero.asset.abi -p usdt.bridge@active
cleos -u "$TELOS_ZERO_API" set contract wbtc.bridge contracts/native/build zero.asset.wasm zero.asset.abi -p wbtc.bridge@active
```

Deploy `zero.bridge`:

```sh
cleos -u "$TELOS_ZERO_API" set contract zerobridge contracts/native/build zero.bridge.wasm zero.bridge.abi -p zerobridge@active
```

Allow `zerobridge` to issue/burn inline through its contract code:

```sh
cleos -u "$TELOS_ZERO_API" set account permission zerobridge active --add-code -p zerobridge@owner
```

## 5. Create Fresh Zero Assets

```sh
cleos -u "$TELOS_ZERO_API" push action usdc.bridge create '["zerobridge","1000000000.000000 ZUSDC"]' -p usdc.bridge@active
cleos -u "$TELOS_ZERO_API" push action usdt.bridge create '["zerobridge","1000000000.000000 ZUSDT"]' -p usdt.bridge@active
cleos -u "$TELOS_ZERO_API" push action wbtc.bridge create '["zerobridge","21000.00000000 ZWBTC"]' -p wbtc.bridge@active
```

## 6. Initialize Native Bridge

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge init '["bridgeadmin","eosio.evm",false]' -p zerobridge@active
```

For production, replace `bridgeadmin` with the approved large MSIG-controlled admin account or permission.

`false` keeps the admin-only `processetoz` path disabled. The EVM-to-Zero proof path does not require dev mode.

Configure the deployed EVM bridge contract for proof reads. The native contract resolves the EVM account scope from `eosio.evm::account` and stores it in `evmconfig`.

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge setevmconf '["<EVM_BRIDGE_20_BYTES>",0]' -p bridgeadmin@active
```

The second argument is an optional finality delay in seconds. Use `0` on Telos testnet with instant finality enabled unless governance intentionally chooses an additional operational delay.

Set the EVM chain ID used when `relayztoe` serializes the raw EVM transaction:

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge setevmchain '[41]' -p bridgeadmin@active
```

Use `41` for Telos EVM testnet and `40` for Telos EVM mainnet.

Configure the native account that will be used as the EVM sender for Zero-to-EVM release dispatch:

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge setevmrelay '["zerobridge"]' -p bridgeadmin@active
```

The bridge account must have a linked `eosio.evm` wallet and enough EVM TLOS for gas before automatic Zero-to-EVM release or `relayztoe` retry can work. The EVM `EvmEscrowBridge` must be deployed with `ZERO_BRIDGE_EVM_ADDRESS` equal to that linked EVM address.

## 7. Register Native Pairs

Use the deployed EVM token addresses from step 2. The `checksum160` value should be the 20-byte EVM address without `0x` if your CLI does not accept `0x` prefixed values.

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge addpair '[1,"usdc.bridge","6,ZUSDC","<USDC_EVM_TOKEN_20_BYTES>",6,"1.000000 ZUSDC","10000.000000 ZUSDC"]' -p bridgeadmin@active
cleos -u "$TELOS_ZERO_API" push action zerobridge addpair '[2,"usdt.bridge","6,ZUSDT","<USDT_EVM_TOKEN_20_BYTES>",6,"1.000000 ZUSDT","10000.000000 ZUSDT"]' -p bridgeadmin@active
cleos -u "$TELOS_ZERO_API" push action zerobridge addpair '[3,"wbtc.bridge","8,ZWBTC","<WBTC_EVM_TOKEN_20_BYTES>",8,"0.00010000 ZWBTC","1.00000000 ZWBTC"]' -p bridgeadmin@active
```

The `bridgeadmin@active` examples are testnet placeholders. Mainnet pair registration must go through the production governance MSIG.

## 8. Smoke Test EVM to Zero

1. Approve the EVM bridge to spend mock `USDC.e`.
2. Call `depositToZero(1, 1000000, "<zero-account>")`.
3. Confirm `EvmToZeroRequested` emitted and record `requestHash`, `sender`, `amount`, and `zeroReceiver`.
4. Call `proveetoz` on `zerobridge` with the EVM request hash and matching fields:

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge proveetoz \
  '[1,"<REQUEST_HASH>","<zero-account>","1.000000 ZUSDC","<EVM_SENDER_20_BYTES>"]' \
  -p "$ZERO_RELAYER"
```

5. Confirm fresh `ZUSDC` supply and receiver balance increase.
6. Repeat with `dev_mode = false` for USDT, WBTC, and the EMPIRES mint/burn pair.

## 9. Smoke Test Zero to EVM

1. Transfer `1.000000 ZUSDC` to `zerobridge` with the EVM receiver address in memo.
2. Confirm a `ztoereqs` row exists and the Zero asset supply decreased.
3. Confirm the inline release runs in the same user transaction and `processedZeroBurns(burnId)` becomes true.
4. If an older or stalled request was created without an EVM release, retry with the public native relay action:

```sh
cleos -u "$TELOS_ZERO_API" push action zerobridge relayztoe '[<REQUEST_ID>]' -p "$ZERO_TO_EVM_RELAYER"
```

5. Confirm `eosio.evm::raw` executed, the EVM bridge emitted `ZeroToEvmReleased`, escrow balance decreased, receiver token balance increased, and `processedZeroBurns(burnId)` is true.

## 10. Configure a Finite Liveness Permission

`proveetoz` and `relayztoe` are public liveness actions. A hosted relayer key should not be an admin key; it only needs permission to submit those two bridge actions. With inline Zero-to-EVM release enabled, `relayztoe` is primarily a fallback for old/stalled requests or operational retry cases.

```sh
cleos -u "$TELOS_ZERO_API" set account permission relayrunner bridgeops \
  '{"threshold":1,"keys":[{"key":"<RELAYER_PUBLIC_KEY>","weight":1}],"accounts":[],"waits":[]}' \
  active -p relayrunner@active

cleos -u "$TELOS_ZERO_API" set action permission relayrunner zerobridge proveetoz bridgeops -p relayrunner@active
cleos -u "$TELOS_ZERO_API" set action permission relayrunner zerobridge relayztoe bridgeops -p relayrunner@active
```

Then configure:

- `zero.authorization.actor = "relayrunner"`
- `zero.authorization.permission = "bridgeops"`
- `zero.zeroToEvmAuthorization.actor = "relayrunner"`
- `zero.zeroToEvmAuthorization.permission = "bridgeops"`

## 11. Reconcile

Copy the relayer config:

```sh
cp packages/relayer/src/config.example.json packages/relayer/src/config.local.json
```

Fill:

- `evm.rpcUrl`
- `evm.escrowBridge`
- EVM token addresses
- Zero API URL
- Zero asset contract accounts
- `zero.zeroToEvmAuthorization` for the liveness relayer account that will submit `relayztoe`

Run:

```sh
cd packages/relayer
npm test
node src/reconcile.js src/config.local.json
node src/scan-evm-requests.js src/config.local.json
node src/process-zero-requests.js src/config.local.json --dry-run
```

## Exit Criteria

- EVM contracts deploy and pair registration succeeds.
- Native contracts deploy and pair registration succeeds.
- USDC.e mock completes both directions.
- USDT mock completes both directions.
- WBTC mock completes both directions with 8-decimal accounting.
- Reconciliation reports `OK` after each completed round trip.
- `proveetoz` succeeds with `dev_mode = false` by reading live `eosio.evm::accountstate` storage.
- `relayztoe` succeeds from a non-bridge relayer account, with the EVM release sent from the bridge account's linked EVM address.
- All remaining operator-only assumptions are listed before any production design review.
