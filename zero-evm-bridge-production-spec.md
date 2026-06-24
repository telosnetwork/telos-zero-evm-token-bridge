# Telos Zero <> EVM Asset Bridge Production Spec

Status: Draft v0.1
Date: 2026-06-23
Audience: Telos engineering, security reviewers, BP/governance operators

Implementation snapshot:

- MVP scaffold exists in this workspace.
- EVM escrow/registry contracts exist in `packages/evm` and pass the current Foundry unit tests.
- Native Telos Zero contracts exist in `contracts/native`; `zero.bridge::proveetoz` now implements EVM-to-Zero proof verification against `eosio.evm::accountstate`, but still requires CDT rebuild and live chain-level integration testing.
- Relayer/operator tooling exists in `packages/relayer` and is read-only by design at this stage.
- Production remains blocked on native WASM rebuild, live testnet proof validation, Zero-to-EVM dispatcher hardening, audit, and governance handoff.

## 1. Purpose

Build a production-grade bridge for moving assets between Telos Zero, the Antelope/native layer, and Telos EVM without relying on liquidity pools or off-chain custodians.

The old `telos-token-bridge` repository should be treated as prior art only. It proves that native contracts can interact with `eosio.evm` state and calls, but it is not suitable as a production base without a full redesign.

## 2. Goals

- Support deterministic asset movement between native Telos and Telos EVM.
- Preserve total supply across both environments through lock/unlock or burn/mint invariants.
- Use post-instant-finality assumptions explicitly instead of inheriting 2022-era timing assumptions.
- Make every bridge operation idempotent, replay-safe, auditable, and recoverable.
- Keep token-pair registration governed, rate-limited, and easy to pause.
- Provide complete end-to-end tests across native contracts, EVM contracts, and `eosio.evm` calls before mainnet deployment.
- Produce reproducible deployments with verified source, no hardcoded private keys, and clear governance handoff.

## 3. Non-Goals

- External-chain pass-through routing is not required for MVP. A later UX extension may route from Telos Zero through Telos EVM to external EVM chains such as Base.
- General message passing.
- Liquidity-pool routing.
- UI specification, except for operational requirements the UI must expose.
- Supporting arbitrary ERC-20 contracts that cannot safely mint/burn or escrow under the bridge model.

## 4. Core Design Choice

Use a message-based bridge with explicit operation records on both sides.

Do not rely on scanning Solidity dynamic-array storage layouts from native code as the primary production mechanism. That pattern is fragile across compiler versions, storage refactors, proxy patterns, and EVM upgrades.

Preferred design:

- EVM side emits bridge requests and stores canonical request records in a stable mapping keyed by request ID.
- Native side reads only fixed, documented storage slots or uses an EVM precompile/system-supported query path if available.
- Native side calls EVM through `eosio.evm::raw` or its post-EVM3 equivalent only after compatibility has been revalidated.
- Every Zero-to-EVM and EVM-to-Zero transfer has a canonical request ID, request hash, status, and finalization record.

If a stable Telos Zero-to-EVM read API is not available after the instant-finality/EVM3 stack is finalized, the bridge should pause at design review and choose a different primitive rather than shipping storage-layout introspection.

## 5. Trust Model

The target design is a same-chain, trustless bridge between two execution environments that settle through the same Telos consensus system.

Unlike external-chain bridges, this design should not require validators, signers, custodians, light-client committees, liquidity providers, or price oracles to attest that an event happened elsewhere. Telos Zero and Telos EVM are different execution environments, but they are not independent consensus domains for this purpose.

The production bridge may be marketed as trustless only if the deployed contracts prove source-side state on-chain and privileged accounts cannot mint, release, or confiscate funds during normal operation.

Trusted components:

- Telos Zero consensus and producer schedule.
- `eosio.evm` execution correctness.
- Governance/admin accounts used to register pairs, pause pairs, upgrade contracts, and recover stuck operations, but not to approve ordinary transfers. Production governance is assumed to be a large MSIG, not one individual signer.
- The correctness of the EVM backing tokens and fresh Telos Zero token contracts.

Untrusted components:

- Public relayers/notifiers.
- Frontends.
- Token owners requesting registration.
- User-provided memos, receiver strings, and token metadata.

Relayers may trigger processing, but they must never be trusted for correctness. On-chain contracts must independently verify all processable state.

Trustless normal-flow requirements:

- EVM-to-Zero minting must be possible only after the EVM bridge contract has escrowed the backing token.
- Zero-to-EVM release must be possible only after the Telos Zero representation has been burned or otherwise removed from circulating supply.
- No off-chain signature, oracle report, database row, API response, or relayer claim may be sufficient to move funds.
- Admin/governance may pause, register pairs, set limits, and perform audited recovery, but must not be able to mint unbacked Zero assets or release escrowed EVM assets outside a transparent emergency process.
- All supply and escrow invariants must be externally reconcilable from on-chain state.

### Oracle and Relayer Model

The bridge should not require a trusted oracle for correctness.

Because this bridge is Telos Zero <> Telos EVM, both sides ultimately settle through the same Telos consensus system. The bridge should verify source-side state directly through `eosio.evm` or an approved post-EVM3 equivalent, then execute the destination-side state transition on-chain.

This does not eliminate the need for relayers or notifiers. It eliminates the need to trust them.

Allowed relayer role:

- Detect finalized bridge requests.
- Submit processing transactions.
- Retry stuck requests.
- Pay transaction costs and collect configured fees, if any.

Forbidden oracle role:

- Assert that a deposit happened without on-chain verification.
- Assert token prices.
- Assert exchange rates.
- Decide whether a request is valid.
- Act as a multisig/custodian for normal bridge flow.

Oracle-free launch is blocked unless the production implementation can prove all of the following on-chain:

- The EVM asset was escrowed before minting the Telos Zero representation.
- The Telos Zero representation was burned before releasing escrowed EVM assets.
- The source request is finalized.
- The request ID has not already been processed.
- The amount, token pair, receiver, and direction match the canonical request.

If post-IF/EVM3 changes remove or weaken native contract access to EVM state, the design must stop and choose a new trust-minimized proof path. Falling back to a trusted off-chain oracle should be treated as a separate product with a different risk model.

### Future Pass-Through Routes

The MVP should focus on the same-chain Telos Zero <> Telos EVM bridge. A later UX extension can support a one-signature route from Telos Zero to an external EVM chain, with Base as the first example.

Example route:

```
Telos Zero ZUSDC -> Telos EVM USDC.e -> Base USDC
```

This is a composite route with two different trust boundaries:

- Telos Zero -> Telos EVM: same-chain bridge; target design is trustless normal flow.
- Telos EVM -> Base: external bridge route; inherits the trust, delivery, liquidity, fee, and finality assumptions of the external protocol, such as Stargate or LayerZero.

The full Zero -> Base route should not be described as same-chain trustless. Only the Zero <> Telos EVM leg has that property.

One-signature user flow:

1. User signs a single Telos Zero transaction transferring a fresh bridge asset to the Zero bridge contract.
2. The transaction includes a structured route intent, such as destination chain, destination receiver, token, amount, maximum fee, minimum amount out, deadline, and route ID.
3. The Zero bridge validates and burns/retires the fresh Zero asset.
4. The bridge releases the EVM backing asset to a Telos EVM route executor contract.
5. A relayer triggers the Telos EVM route executor to call the approved external bridge protocol.
6. The external protocol delivers the asset to the destination chain, for example Base.

Example structured intent:

```
route:v1;to=base;token=USDC;receiver=0x...;min_out=990000;max_fee=10000;deadline=...
```

The route executor must enforce the user intent on-chain:

- Destination chain must match the requested chain.
- Destination receiver must match exactly.
- Token and amount must match the approved pair.
- Fee must not exceed `max_fee`.
- Expected destination amount must not fall below `min_out`.
- Request must execute before `deadline`.
- Failed or expired route requests must be refundable.

Relayer role for pass-through routing:

- Fetch live external bridge quotes.
- Submit execution transactions on Telos EVM.
- Optionally sponsor gas and recover fees from the configured route fee.
- Retry failed execution if the request remains valid.

The relayer must not take custody in the default design. If a future "solver fill" model pays the user on Base before final settlement, that is a separate product with a different trust and credit-risk model.

Current route planning note:

- Current Telos bridge route code includes Base support for USDC and WBTC.
- USDT -> Base was not visible in the current route map reviewed for this draft and must be reverified or added before being promised.
- Every external route must run live quote and no-spend route-smoke checks before launch.

## 6. Instant Finality Requirements

Instant finality should be treated as a settlement improvement, not a substitute for bridge correctness.

Before launch, verify:

- Native chain is running the intended Telos Zero/Savanna version.
- `eosio.evm` behavior used by the bridge is unchanged or formally updated.
- `raw`, account lookup, account state access, nonce handling, gas accounting, and failure semantics are tested on the post-IF stack.
- Reorg/finality assumptions are documented in exact block/finality terms.
- Bridge processing waits for the correct finality condition for each direction.

Expected post-IF policy:

- Zero-to-EVM: process after native finality is reached.
- EVM-to-Zero: process after the EVM transaction is included in finalized Telos Zero state.
- No bridge operation should depend on wall-clock delays as its security boundary.

## 7. Asset Model

Each bridge pair must define:

- Native token contract account.
- Native symbol code and precision.
- Native issuer, if relevant.
- EVM token address.
- EVM decimals.
- Bridge mode: EVM escrow + fresh Zero mint/burn, native escrow + EVM mint/burn, native burn/mint + EVM escrow, or dual escrow.
- Minimum amount.
- Maximum single transfer.
- Daily/global rate limits.
- Fee policy.
- Admin/pause policy.

Default production mode:

- EVM-to-Zero: escrow the approved current EVM asset in the EVM bridge, then mint a fresh Telos Zero representation.
- Zero-to-EVM: burn the fresh Telos Zero representation, then release the escrowed current EVM asset.

The initial native assets should be newly issued Telos Zero assets, not legacy pToken-era native assets. The bridge must be the only mint/burn authority for these fresh native representations, or that authority must be held by a governance-controlled permission that only the bridge can invoke for routine operation.

Only use native escrow for assets that already exist and are explicitly approved for that model. That is not the preferred launch model for USDC, USDT, or WBTC.

## 8. Initial Asset Set

Initial user-facing assets:

- USDC
- USDT
- WBTC

These names must be treated as product labels until governance approves exact native and EVM token identities. The EVM side should use the current non-legacy EVM assets listed below. The Telos Zero side should use newly created native representations, not old native pTokens or `tokens.swaps` assets.

Recommended initial pair candidates:

| User-facing asset | EVM backing asset | EVM address | EVM decimals | Fresh Telos Zero asset | Native account | Native precision | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| USDC | `USDC.e` | `0xF1815bd50389c46847f0Bda824eC8da914045D14` | 6 | TBD, candidate symbol `ZUSDC` | Namespace account, for example `<asset>.<namespace>` | 6 | Backed 1:1 by escrowed EVM `USDC.e`. |
| USDT | `USDT` | `0x674843C06FF83502ddb4D37c2E09C01cdA38cbc8` | 6 | TBD, candidate symbol `ZUSDT` | Namespace account, for example `<asset>.<namespace>` | 6 | Backed 1:1 by escrowed current EVM `USDT`. |
| WBTC | `WBTC` | `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c` | 8 | TBD, candidate symbol `ZWBTC` | Namespace account, for example `<asset>.<namespace>` | 8 | Backed 1:1 by escrowed EVM `WBTC`; caps should be especially conservative. |

Recommended namespace model:

- Register a dedicated Telos Zero namespace for bridge-issued assets before deploying any asset contracts.
- Put all fresh bridge assets under that namespace, for example `usdc.<namespace>`, `usdt.<namespace>`, and `wbtc.<namespace>`.
- Reserve adjacent names needed for operations, such as bridge, registry, fee, pause, and recovery accounts.
- Use the namespace as the public trust boundary: assets outside it are not official products of this bridge.
- Keep namespace ownership under governance, not a developer key.
- Delegate only the minimum required active permissions to bridge contracts.
- Publish the namespace policy before launch so wallets, explorers, and users can distinguish official bridge-issued assets from lookalikes.

Legacy assets that should not be silently selected:

- Legacy `USDC`: `0x8D97Cea50351Fb4329d591682b148D43a0C3611b`
- Legacy `USDT`: `0x975Ed13fa16857E83e7C493C7741D556eaaD4A3f`
- Native `PUSDC`: `usdc.ptokens`
- Native `PUSDT`: `usdt.ptokens`
- Native `PBTC`: `btc.ptokens`
- Native `USDT`: `tokens.swaps`

Fresh Telos Zero asset requirements:

- New token contract/account per asset or a shared audited bridge-asset contract.
- Symbol/account names approved before deployment; namespace-qualified names are preferred.
- Mint/burn authority controlled by bridge/governance only.
- Max supply set high enough for plausible bridge TVL but bounded and governance-approved.
- Metadata must clearly state each asset is backed by escrowed EVM tokens.
- No migration from legacy native assets unless a separate migration spec is approved.

Initial launch policy:

- Launch one pair first, then add the other two after reconciliation remains clean.
- Prefer USDC first because both sides use 6 decimals and it has the clearest stablecoin product expectation.
- Set low initial caps for all three assets, with WBTC caps denominated conservatively because unit value is high.
- Require final issuer/backing review before publishing these as "USDC", "USDT", or "WBTC" to users.
- Require live on-chain stat and bytecode checks immediately before testnet and mainnet deployment.

## 9. Accounting Invariants

For each pair:

```
native_minted_by_bridge - native_burned_by_bridge = native_current_supply
evm_escrow_balance_adjusted_for_decimals = native_current_supply
processed_request_ids are unique
released_or_minted_amount equals canonical_request_amount_after_decimal_normalization
```

Every conversion must use integer arithmetic only.

Decimal conversion rules:

- Let `native_precision` be the native token precision.
- Let `evm_decimals` be the ERC-20 decimals.
- Define `common_decimals = min(native_precision, evm_decimals)` unless a pair-specific scaling policy is approved.
- Reject transfers that cannot be represented exactly on the destination side.
- Never use floating-point math or `pow(double)` in contract code.
- Never subtract unsigned decimal values unless order has already been checked.

Example:

```
if evm_decimals >= native_precision:
  evm_amount = native_amount * 10^(evm_decimals - native_precision)
else:
  require(native_amount % 10^(native_precision - evm_decimals) == 0)
  evm_amount = native_amount / 10^(native_precision - evm_decimals)
```

The reverse conversion must be the exact inverse.

## 10. Request Lifecycle

Every request has:

- `id`
- `direction`
- `source_chain_context`
- `source_tx_id`
- `sender`
- `receiver`
- `pair_id`
- `source_amount`
- `destination_amount`
- `fee`
- `created_at_block`
- `finality_reference`
- `status`
- `request_hash`

Statuses:

- `created`
- `finalized_source`
- `processing`
- `completed`
- `failed`
- `refundable`
- `refunded`
- `cancelled_by_admin`

State transitions must be one-way except for explicitly audited recovery transitions.

Idempotency:

- Processing a completed request must be a no-op.
- Processing a failed request must not double-mint or double-release.
- Refunds must have independent IDs and cannot reuse request array length or mutable ordering as identity.

## 11. Native Contract Requirements

Native contract responsibilities:

- Receive fresh bridge-issued Telos Zero assets for Zero-to-EVM transfers, then burn/retire them or otherwise remove them from circulating supply.
- Validate memo/receiver format.
- Create Zero-to-EVM request records.
- Read or verify finalized EVM-to-Zero escrow/deposit requests.
- Mint fresh Telos Zero representations only for valid, unprocessed EVM escrow requests.
- Call EVM bridge functions only through the approved `eosio.evm` path.
- Maintain request, refund, pair, config, and pause tables.
- Expose read-only tables for indexers, monitors, and operations.

Required native actions:

- `init`
- `setconfig`
- `setadmin`
- `pause`
- `unpause`
- `addpair`
- `setevmconf`
- `pausepair`
- `unpausepair`
- `removepair`
- `processztoe`
- `proveetoz`
- `refund`
- `recover`
- `setlimits`

Required notify handler:

- On transfer of a fresh bridge-issued Telos Zero asset to the bridge account, burn/retire the asset and create a Zero-to-EVM request if the pair is active.

Native contract must not expose admin-only mint/release shortcuts during normal production operation. Any retained compatibility action such as `processetoz` must be disabled with `dev_mode = false` before value-bearing deployment.

## 12. EVM Contract Requirements

EVM contracts:

- `BridgeRegistry`
- `EvmBridge`
- Optional `BridgeableERC20` base implementation.

`BridgeRegistry` responsibilities:

- Store pair metadata in mappings keyed by pair ID, EVM token, and Telos Zero asset identity.
- Validate pair uniqueness.
- Support pause/unpause.
- Expose stable getters for native-side verification.

`EvmBridge` responsibilities:

- Escrow current EVM tokens for EVM-to-Zero transfers.
- Release escrowed EVM tokens for completed Zero-to-EVM transfers.
- Store request records in stable, fixed-slot proof storage keyed by `requestHash`.
- Enforce fees, min/max amounts, pair active state, receiver validation, and rate limits.
- Accept callbacks only from the authorized Telos Zero bridge EVM address.
- Fix the registry and authorized Zero bridge EVM addresses at construction for the guarded launch; governance may manage registry pairs/limits, but must not be able to silently swap the bridge to a different registry or dispatcher.
- Emit complete events for every state transition.

EVM contracts must use:

- Current Solidity compiler pinned in config.
- OpenZeppelin dependencies pinned and reviewed.
- Reentrancy guards where external token calls occur.
- SafeERC20 for escrow mode.
- Explicit custom errors or clear revert reasons.
- No hardcoded private keys.
- No owner-only hot wallet for production governance.

## 13. Receiver Validation

Native account receiver validation:

- 1-12 characters.
- Valid Antelope name character set only: `a-z`, `1-5`, and dot rules if dots are allowed.
- Reject empty strings.
- Reject names that cannot receive the target token.

EVM receiver validation:

- Must be a valid 20-byte address.
- Reject zero address unless explicitly used for burn semantics, which this bridge should not expose as a receiver.

Memo validation:

- Zero-to-EVM transfer memo must be exactly the destination EVM address or a versioned structured memo.
- Prefer structured memo format:

```
bridge:v1:<evm_address>
```

The parser must reject ambiguous or extra data.

## 14. Fees and Resource Funding

Fees must be explicit and pair-independent unless governance configures otherwise.

Fee policy must cover:

- EVM gas for callback/finalization.
- Native CPU/NET/RAM operational costs.
- Refund processing.
- Relayer incentives, if any.

Contracts must not forward arbitrary overpayment without a documented reason.

Any fee recipient must be governance-controlled and auditable.

## 15. Limits and Circuit Breakers

Required controls:

- Global pause.
- Per-pair pause.
- Per-direction pause.
- Per-account pending request limit.
- Per-request min and max amount.
- Per-pair rolling daily cap.
- Emergency pause controlled by a narrow emergency permission.
- Governance-controlled unpause after incident review.

Emergency pause may be fast. Unpause should be slower and require stronger authorization.

## 16. Governance and Permissions

Production permissions must use Telos governance-controlled accounts, not developer keys.

Recommended model:

- `bridge.admin`: large slow governance MSIG for upgrades, pair addition/removal, ownership changes, fee changes, cap increases, and any authority handoff.
- `bridge.ops`: limited operational permission for pausing and processing recovery.
- `bridge.emergency`: pause-only permission with tight monitoring.
- `bridge.code`: contract self-permission only where required.

The large MSIG should control native admin permissions, fresh-asset issuer/owner authorities, EVM `BRIDGE_OWNER`, namespace ownership, and any upgrade authority. Routine relayers must not be members of the trust model; they only submit provable transactions.

Threshold guidance:

- Pair additions, cap increases, owner changes, upgrades, and recovery mints/releases require the large MSIG.
- Emergency pause may use a smaller, faster permission, but unpause returns to the large MSIG.
- Testnet single-signer harnesses must be replaced before value-bearing launch.

All privileged actions must emit events/log rows and be visible to monitors.

## 17. Upgrade Policy

Initial mainnet release should avoid upgradeable EVM proxies unless there is a strong reason.

If upgradeability is used:

- Proxy admin must be governance-controlled.
- Implementation must be verified.
- Upgrade delay must be defined.
- Emergency upgrade path must be separately documented.
- Storage-layout tests are mandatory.

Native contract upgrades must include:

- ABI diff.
- WASM hash.
- Table migration plan.
- Rollback plan where possible.
- Replay/idempotency test pass.

## 18. Relayers and Processing

Anyone may call processing actions if the on-chain checks are sufficient.

A first-party relayer can exist for liveness, but contracts must not trust relayer assertions.

Relayer responsibilities:

- Watch source-side bridge events/tables.
- Wait for finality policy.
- Trigger destination-side process action.
- Retry idempotently.
- Alert on stuck, failed, or refundable requests.

Relayer must not hold custody of bridged funds.

## 19. Observability

Required dashboards/alerts:

- Pending requests by direction and pair.
- Oldest pending request age.
- Failed and refundable requests.
- EVM escrow balances vs Telos Zero minted supply.
- Pair cap utilization.
- Pause state.
- EVM gas failures.
- Native CPU/NET/RAM failures.
- Callback failures.
- Duplicate processing attempts.
- Source/destination amount mismatch.

Public status page should show user-relevant bridge health without exposing sensitive operator details.

## 20. Security Requirements

Mandatory reviews:

- Internal engineering review.
- Threat model review.
- External smart-contract audit for native and EVM contracts.
- Deployment/permissions review.
- Incident-response drill.

Threats to explicitly test:

- Double processing.
- Replay across directions or pairs.
- Decimal truncation/magnification.
- Receiver spoofing through malformed memo.
- Token contract malicious behavior.
- Reentrancy.
- Paused pair bypass.
- Storage-layout drift.
- EVM nonce race.
- CPU/gas griefing.
- Request flooding.
- Refund theft or double refund.
- Governance key compromise.
- Post-upgrade storage/table corruption.

## 21. Test Plan

Unit tests:

- Native action auth.
- Native transfer parsing.
- Native pair validation.
- Native decimal conversion.
- Native refund and recovery.
- EVM pair registration.
- EVM bridge request creation.
- EVM callbacks.
- EVM pause/limit behavior.
- EVM reentrancy and malicious token behavior.

Integration tests:

- Zero-to-EVM happy path.
- EVM-to-Zero happy path.
- Both paths under non-matching decimals.
- Failed EVM mint -> native refund.
- Failed native transfer -> EVM refund/recovery.
- Duplicate relayer call.
- Paused global and paused pair.
- Request flooding.
- Post-instant-finality finality wait.
- EVM nonce contention.
- Contract upgrade simulation if upgradeable.
- Future pass-through route intent validation, including max fee, min amount out, deadline, exact receiver, and refund after failed external execution.
- Future Zero -> Telos EVM -> Base route smoke tests for each supported asset before enabling that route in UI.

End-to-end environment:

- Local Telos Zero/Savanna node.
- Local `eosio.evm`.
- Local EVM RPC.
- Deployed native and EVM bridge contracts.
- Automated relayer.
- Deterministic seed accounts and tokens.

Mainnet launch is blocked until end-to-end tests pass in CI.

## 22. MVP Start Criteria

The MVP can be built before instant finality is enabled on mainnet. Telos testnet is the first target environment for proof-mode testing because instant finality is already enabled there for this work.

Do not wait for mainnet IF to start engineering work if the MVP is scoped to:

- Local development.
- Private devnet.
- Public testnet experiments.
- No production value.
- No irreversible governance handoff.

MVP assumptions:

- Build the contracts around the intended post-IF finality model.
- Keep finality waits/configuration abstracted behind a small bridge-finality module.
- Treat `eosio.evm` read/call behavior as a compatibility surface with tests, not as an informal assumption.
- Use current Telos testnet behavior for early integration tests, then rerun the same tests on any materially changed mainnet IF/EVM stack.
- Avoid architecture that depends on old wall-clock delay assumptions or pre-IF irreversibility timing.

Production remains blocked until:

- `eosio.evm` read/call semantics are revalidated on instant-finality testnet.
- Native/EVM nonce, gas, failure, and finality tests pass on the instant-finality testnet stack.
- Governance approves the final deployment hashes, namespace, token identities, and launch caps.

## 23. Testnet-First MVP Plan

Use Telos testnet as the first shared integration environment.

Testnet goals:

- Prove same-chain EVM escrow -> Zero mint and Zero burn -> EVM release mechanics.
- Prove native contract access to `eosio.evm` state/calls with the new architecture.
- Exercise the relayer as an untrusted liveness agent.
- Validate the fresh namespace/asset model before mainnet name registration.
- Produce repeatable deployment scripts, ABI/WASM hashes, EVM addresses, and route-smoke outputs.
- Establish the reconciliation dashboard before value is at risk.

Testnet scope:

- One asset first: USDC candidate path.
- Fresh testnet Zero asset under a test namespace.
- Testnet EVM escrow token can be a mock ERC-20 first, then a current testnet-listed token if available.
- Conservative caps, even on testnet, so limit logic is exercised from day one.
- Relayer running in retry/idempotency mode.

Testnet deliverables:

- Native bridge contract and token/asset contract.
- EVM registry and escrow bridge contracts.
- Deployment scripts for both sides.
- Pair-registration script.
- Relayer/notifier.
- End-to-end test suite.
- Reconciliation script: EVM escrow balance vs Zero minted supply.
- Runbook for pausing, refunding, and recovering a stuck request.

Testnet exit criteria:

- 100 successful EVM-to-Zero and Zero-to-EVM transfers across varied amounts.
- Duplicate relayer calls are harmless.
- Failed/expired requests refund correctly.
- Pause/unpause works globally and per pair.
- Decimal conversion has property/invariant tests.
- Reconciliation remains exact after the transfer campaign.
- Same test suite can be rerun after IF/Savanna stack changes.

## 24. Deployment Plan

Phase 0: Design validation

- Confirm post-IF `eosio.evm` read/call behavior.
- Validate the fixed-slot `requestHash` proof primitive used by `EvmEscrowBridge` and `zero.bridge::proveetoz`.
- Review bridge accounting with security team.

Phase 1: Prototype

- Build one native token <> one ERC-20 pair.
- Start with the USDC candidate pair unless governance prefers a lower-risk internal test asset.
- No mainnet value.
- Full local E2E tests.

Phase 2: Public testnet

- Deploy production-mode contracts.
- No test-only actions.
- Verified EVM source.
- Published native ABI/WASM hashes.
- Run relayer and monitors.
- Run adversarial tests.

Phase 3: Audit and freeze

- External audit.
- Fixes and retest.
- Governance permission rehearsal.
- Incident-response rehearsal.

Phase 4: Mainnet guarded launch

- One low-risk asset pair.
- Conservative caps.
- Public status page.
- Emergency pause staffed.
- Daily reconciliation.

Phase 5: Expansion

- Add pairs only after reconciliation history is clean.
- Increase caps gradually.
- Publish pair-level risk notes.

Phase 6: External pass-through UX

- Add Zero -> Telos EVM -> external chain route intents after MVP bridge stability is proven.
- Start with one route, preferably Zero USDC -> Telos EVM USDC.e -> Base USDC, subject to live route verification.
- Keep route executors non-custodial by default.
- Publish a separate trust-boundary note for the external bridge leg.
- Add route-specific emergency disable switches.

## 25. Launch Criteria

Do not launch mainnet until all are true:

- Production contracts do not expose test-only actions.
- No hardcoded private keys or developer-owned production admin.
- Production owner/admin/issuer authorities are controlled by the approved large MSIG, not by a single signer.
- Native and EVM source are reproducibly built.
- EVM source is verified.
- Native WASM/ABI hashes are published.
- Full E2E test suite passes in CI.
- Instant-finality compatibility tests pass.
- External audit issues are resolved or explicitly accepted by governance.
- Monitoring and emergency pause are live.
- Reconciliation tooling can prove supply invariants.
- Governance has approved initial pairs, limits, permissions, and rollback plan.
- The exact USDC/USDT/WBTC EVM backing assets, fresh Telos Zero asset identities, issuer/backing assumptions, decimals, and user-facing names have been approved and published.
- Any enabled external pass-through route has a published trust-boundary note, current route-smoke evidence, fee/refund policy, and a route-specific pause switch.

## 26. Open Questions

- Should the fixed-slot `requestHash` proof primitive remain the long-term EVM-to-Zero verification interface, or be wrapped by a system-supported helper if EVM3 adds one?
- Should the bridge support only the three approved current EVM assets at launch, or allow additional escrowed ERC-20s later?
- Which account will own native bridge administration?
- What namespace should be registered for official bridge-issued Telos Zero assets?
- Which governance process approves new pairs?
- What relayer incentive model is needed, if any?
- Should the guarded mainnet launch use USDC first, or a non-systemically important test asset?
- What final Telos Zero account names and symbol codes should be used for the fresh USDC, USDT, and WBTC representations?
- Should legacy native pTokens and legacy LayerZero USDC/USDT be explicitly blocked in the UI and registry?
- Should Zero -> Base pass-through launch with only USDC first, before WBTC and any USDT route?
- Should pass-through relayers be permissionless from day one, or should the first guarded release use an allowlisted executor with transparent limits?
- What maximum acceptable pending request age should trigger incident response?

## 27. References

- Prior prototype: https://github.com/telosnetwork/telos-token-bridge
- Bridgeable token template: https://github.com/telosnetwork/erc20-bridgeable
- Native-to-EVM raw call example: https://github.com/telosnetwork/native-to-evm-transaction
- Telos token metadata baseline: https://github.com/telosnetwork/token-list
- Telos EVM system contract account: `eosio.evm`
