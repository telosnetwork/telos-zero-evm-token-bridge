# Audit remediation — 16 September 2026

These changes address the seven findings reviewed against `2db28416558fe6c6b42b5587dce1355df4b09531`. They change source code and tests; they do not update any deployed bridge.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| H-01: completed withdrawal refunded | Refund checks both authoritative EVM replay storage and native dispatch/completion state. Completed, dispatching, and refunded states exclude each other. Legacy rows are protected by the EVM flag even without a new status row. | Native completed → refund, refund → release, unauthorized/repeated refund, legacy completion |
| H-02: inconsistent decimals | Proof amount is decoded as uint128 and compared with the checked native-to-EVM conversion. Deposits reject rounding dust and amounts outside the native asset range. | Native 8/6 normalization and inflation rejection, amounts above uint64, uint128 overflow; Solidity dust/range tests |
| M-01: unusable destination / blocked queue | Validate canonical native names before escrow/burn, isolate each relayer request, retain failed requests, and add depositor-requested recovery for deposits that have not minted. | Solidity invalid names and refund lifecycle; native cancellation/mint exclusion; actual CLI poison-request isolation |
| M-02: positive delay blocks withdrawal creation | Positive delay commits the burn/request; `relayztoe` releases it after the delay. Zero delay retains atomic inline dispatch. | Native durable burn, before/at-delay release, failure rollback |
| M-03: no daily release cap | Add a separate per-pair UTC-day release counter, bounded by the registry's `dailyLimit`. | Multiple releases, exhausted cap, next UTC day, revert restores replay/counter |
| M-04: watcher skips deposits | Scan from a fixed start, persist the cursor and unresolved requests atomically before submission, overlap subsequent scans, and lock out concurrent writers. | Actual CLI historical discovery, restart with advanced cursor, dry-run, state identity/lock |
| M-05: native retry mode absent | Native `relayztoe` submission is the default and uses documented native signer variables and permissions. Legacy EVM-key mode requires explicit selection. | Actual CLI serializes and signs `relayztoe` without an EVM key |

## Additional hardening

After every native EVM dispatch, a self-authorized inline action verifies the expected EVM terminal flag. If EVM execution returned normally without completing, the native transaction aborts, rolling back native state and transactional `eosio.evm` changes, including its gas charge. Repeated failed public retries are covered by the native emulator. Zero and bridge-self EVM destinations are rejected before burning. Dynamic string calldata padding is aligned to the ABI payload, excluding the four-byte selector.

Token registration requires deployed code, matching on-chain decimals, EVM precision at most 36, and native precision at most 18. Exact balance changes are checked on deposits, burns, releases, and refunds. Fee-on-transfer tokens are rejected; rebasing and other asynchronously changing balance models remain unsupported. Registered assets and any upgrade authority still require governance review.

Development minting cannot be re-enabled after it is disabled. The configured native proof contract address/scope cannot be changed after initial configuration. Governance can still change limits, pause, manage authority, and deploy native code; this is not protection against a compromised code-upgrade authority. The mock mint/burn token's owner retains its existing bridge-setting power and is not a production trust model.

## Deposit cancellation protocol

The six fixed proof slots retain their locations. Offset 5 is now a status word: `0` unknown, `1` mintable, `2` cancellation requested, `3` refunded. The existing `requestProofs(...).exists` getter returns true only for status 1.

1. The original EVM depositor calls `requestDepositRefund(requestId)`. This prevents subsequent native proof issuance for that request.
2. Anyone submits native `refundetoz(evm_request_number, evm_request_id)`, using the numeric EVM request ID and its bytes32 hash. The relayer does this automatically for unresolved requests with status 2.
3. The native contract verifies there is no `etozreqs` issuance record for the hash and dispatches `refundDeposit(requestId, requestHash)` through its linked EVM sender. Solidity binds the number/hash and returns the recorded amount to the recorded depositor.
4. Native `checkrefund` requires status 3, otherwise the transaction rolls back. Replay attempts fail.

If issuance already happened, cancellation cannot return funds: the native issuance record wins and blocks the refund. The recipient can bridge the issued native assets back normally. A refund request is not a promise that a refund is still possible.

Recovery remains available while the bridge or pair is paused, and does not consume the release budget. It reverses a recorded unissued deposit, rather than paying a new withdrawal. Recovering blocked/blacklisted tokens still depends on that token permitting the return transfer.

## Rollout and compatibility

The Solidity contracts are not upgradeable. Obtain reviewed new deployments of both EVM contracts and a new native bridge/account configuration for the complete remediation, with the EVM dispatcher fixed to the new native account's linked EVM address. Do not overwrite deployment manifests to suggest existing contracts contain these changes.

The native patch preserves the serialized existing request/config/pair rows and introduces `ztoestatus` separately. `processedZeroBurns` remains at mapping slot 6. The EVM system config's revision field is read as an optional binary extension. Existing native deployments may receive the compatible native fixes, but that does not add cancellation, new deposit validation, or daily release limits to an old EVM contract. New cancellation requires both patched sides. Test any native upgrade against a snapshot of its actual deployed tables before rollout.

Drain and reconcile the old deployment under its own addresses and replay history before migration. Never copy pending requests, escrow balances, or replay records into a new bridge ad hoc. A separate reviewed migration must account for outstanding native supply, deposits, burns, refunds, token issuer changes, and any existing liabilities. The fixed proof identity intentionally disallows repointing an initialized native bridge to a replacement EVM contract.

Use matching pair IDs, token addresses, symbols, precisions, and modes on both sides. Confirm those values and actual token behavior before enabling transfers. Set `dev_mode = false` at initialization. Link the finite relayer permission to `proveetoz`, `relayztoe`, and the new `refundetoz`; do not grant it bridge/admin authority. The bridge's existing `active` permission with its `eosio.code` must also permit its self-check actions.

## Verification

From the repository root:

```sh
cd evm
forge test -vv
cd ../relayer
npm ci --ignore-scripts
npm test
cd ../contracts/native/test
npm ci --ignore-scripts
CDT_CPP=/path/to/cdt-cpp bash build.sh
npm test
```

The CI workflow repeats these suites with Foundry 1.7.1, Solidity 0.8.24, Antelope CDT 4.1.1, and Node 22. Native dependencies are locked. The native suite runs the compiled production WASM in VeRT 0.3.24. `compiler-builtins.cjs` supplies four missing generic 128-bit shift imports in the test VM. `mock.evm.cpp` models the EVM tables and transactional success/failure of `raw`; it does not execute Solidity. Solidity runs independently under Foundry. Never deploy `mock.evm`.

Before deploying these fixes to a value-bearing bridge, run the real native/EVM integration suite on the exact Telos runtime and permissions: successful zero-delay transfers, positive-delay requests, normalized amounts in both precision directions, refund versus release/mint ordering, replay, insufficient gas, empty escrow, paused/blacklisting tokens, release caps, and repeated failed public retries. Check linked-account nonce and gas balance before/after each failed dispatch to establish full rollback on that runtime. These live integration checks were not run as part of the local remediation.

The existing reconciliation CLI compares token balances and circulating supply; it is not a complete pending-liability or consistent-block solvency monitor. Its `OK` result does not prove all pending deposits/burns are accounted for. A production monitor must additionally reconcile pending issuance, pending releases, completed payouts and refunds at a consistent chain state. This operational accounting expansion and deployed authority/bytecode verification remain production gates.
