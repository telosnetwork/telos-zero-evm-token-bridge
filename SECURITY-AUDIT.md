# Security Audit Report — Telos Zero ⇆ Telos EVM Token Bridge

**Auditor:** Lead Security Auditor
**Date:** 2026-06-25
**Scope:** EVM contracts (`evm/src/`), native Antelope contracts (`contracts/native/`), relayer (`relayer/src/`), keccak/proof bridging, deployment manifests.
**Codebase posture:** Pre-mainnet / guarded testnet MVP. The repository's own README enumerates explicit production gates (§ "Remaining production gates").

---

## 1. Executive Summary

The Telos Zero ⇆ Telos EVM bridge is built on a genuinely strong primitive in **one** direction: the EVM→Zero leg is *trustless*. The native `zero.bridge::proveetoz` action reads `eosio.evm::accountstate` storage directly on the shared Antelope ledger, re-derives the deterministic phantom-storage proof slots with a byte-for-byte-correct keccak-256 implementation, and independently re-verifies every economically relevant field (pair, amount, sender, receiver-hash, existence) before issuing a fresh Zero asset. The relayer cannot forge a mint on this leg; the worst it can do is waste a transaction. Replay protection is sound in both directions, the EVM proof slots are unforgeable, `SafeTransferLib`/`ReentrancyGuard`/two-step `Owned` are correct, and the keccak implementation matches Solidity exactly.

The **other** direction is the problem. The Zero→EVM leg has **no on-chain proof of a Zero burn**. `releaseToEvm` mints/releases escrow on the sole authority of `msg.sender == zeroBridge` — a hot key held by the relayer. This is the central architectural trust assumption: **whoever holds the `zeroBridge` private key has unilateral custody of the entire EVM escrow balance and unlimited mint authority over every mint/burn pair**, with no daily cap and no Zero-burn verification. The README acknowledges this as a production gate ("must be replaced with a Zero-governed dispatcher before mainnet"), but as written it is a single-key custody model that flatly contradicts the project's stated "relayers are liveness helpers, not trusted oracles" goal. This — and its native-side mirror, the `dev_mode` `processetoz` mint shortcut — define the bridge's true risk profile today.

The second systemic theme is **irreversibility without recovery**: the EVM contract escrows (and for mint/burn pairs, *burns*) tokens at deposit time but has **no refund/rescue function whatsoever**. Several independent, realistic conditions can render an EVM→Zero deposit permanently unprovable on the Zero side — a decimal-mismatched pair, an oversized amount, or a malformed/non-existent receiver name — and in every case the user's funds are irrecoverably lost. The native side has `refundztoe` for the *reverse* direction; the EVM side has no analogue.

### Severity counts

| Severity | Count |
|---|---:|
| Critical | 1 |
| High | 4 |
| Medium | 6 |
| Low | 8 |
| Informational | 13 |

> Note: many of the 30+ raw findings from multiple reviewers describe the **same** root causes. The two dominant duplicates — (a) the `releaseToEvm` single-key trust model and (b) the EVM-vs-Zero decimal-equality requirement — were each surfaced by 4–6 finders and are consolidated here into one finding apiece. The "no EVM rescue path" gap is the common amplifier behind a family of stuck-funds findings and is tracked once as a systemic gap, cross-referenced by each trigger.

---

## 2. Findings

### CRITICAL

---

#### C-1 — `releaseToEvm` releases/mints with no proof of a Zero burn; the `zeroBridge` key is single-key custody of all escrow

**Component:** EVM (`EvmEscrowBridge`) + relayer
**Location:** `evm/src/EvmEscrowBridge.sol:151-171`, gate at `157` / `181-183`, immutable `zeroBridge` at `51,75`; replay map `processedZeroBurns` at `56,161-163`; relayer key binding at `relayer/src/process-zero-requests.js:69-87`
**Category:** Centralization / direct theft & unlimited mint
*(Consolidates: evm-escrow C-1, relayer-trust, cross-cutting, completeness-critic — 4 independent finders, all "critical/high".)*

**Description.** `releaseToEvm` is gated **only** by `onlyZeroBridge` (`msg.sender == zeroBridge`). Every semantically meaningful argument — `pairId`, `amount`, `receiver`, `zeroBurnId`, `zeroSender` — is a free, caller-supplied value. The function performs **no** verification that a corresponding Zero-side burn occurred: no Merkle proof, no signature over Zero state, no `eosio.evm` storage read (in stark contrast to the EVM→Zero leg's `proveetoz`). The only anti-replay control is `processedZeroBurns[zeroBurnId]` (line 161), but `zeroBurnId` is an arbitrary attacker-chosen `bytes32` (only constraint: non-zero, line 160), so an attacker simply supplies a fresh id on each call. On success the contract **mints** brand-new ERC-20 supply (`line 165`, mint/burn pairs) or **transfers escrowed tokens** (`line 167`, escrow pairs) to any address.

Critically, `releaseToEvm` is **not** subject to the daily limit: `_consumeDailyLimit` (`185-190`) is invoked only by `depositToZero` (`line 103`), never by `releaseToEvm`. The only per-call bound is `pair.maxAmount` (`_checkAmount`, `173-175`), and calls can be repeated without any per-day ceiling.

The relayer holds exactly this key: `process-zero-requests.js:78-87` derives the EVM account from `EVM_RELAYER_PRIVATE_KEY` / `ZERO_BRIDGE_EVM_PRIVATE_KEY` / `config.evm.releasePrivateKey` and asserts `account.address == zeroBridge()`.

**Impact.** Whoever controls the `zeroBridge` private key can drain the **entire** escrow balance of every escrow pair and mint **unbounded** supply of every mint/burn pair, with no Zero burn ever occurring and no on-chain rate limit to slow it. This is total loss of all bridged funds, achievable in a single block.

**Exploit scenario.**
1. The relayer key is leaked / sold / coerced, or the relayer operator turns malicious.
2. Attacker calls `releaseToEvm(pairId, pair.maxAmount, attacker, keccak(random_i), "")` repeatedly with distinct random `zeroBurnId` values.
3. Each call passes `onlyZeroBridge`, the fresh-id `processedZeroBurns` check, and `_checkAmount`.
4. Escrow pairs are drained to the attacker; mint/burn pairs mint arbitrary supply. No Zero burn ever happened.

**Remediation.** Before any value-bearing deployment, replace the `onlyZeroBridge` trust gate with a **real proof of the Zero-side burn** — symmetric to `proveetoz`, e.g. verify the `zero.bridge` `ztoe` table / burn record via the same `eosio.evm`/Antelope storage-proof technique, or a Zero-governed threshold/multisig dispatcher. Derive `zeroBurnId` deterministically from the Zero burn transaction so an arbitrary id cannot be minted. As interim defense-in-depth (does **not** substitute for the proof): add a per-pair daily release cap consumed inside `releaseToEvm`, isolate the key in an HSM/remote signer, and monitor `reconcile.js` continuously.

> *Severity rationale:* Rated Critical (not High) because impact is total fund loss / unlimited mint and the mechanics are exact. The "key compromise" precondition is acknowledged, but the design as written *is* the vulnerability: a single hot key is the entire security boundary for one direction of the bridge. The finder split (critical vs high) reflects "documented gate vs. discovered bug" framing; by consistent severity definitions, a single-key custody of all funds is Critical.

---

### HIGH

---

#### H-1 — Decimal-mismatched pairs are silently bricked: `proveetoz` compares raw EVM amount to raw Zero amount with no scaling

**Component:** Native (`zero.bridge`), cross-cutting
**Location:** `contracts/native/zero.bridge/src/zero.bridge.cpp:192-196`; `evm/src/EvmEscrowBridge.sol:209` (stores raw EVM amount); `evm/src/BridgeRegistry.sol:19,21,83` (independent `evmDecimals`/`zeroDecimals`, only `<=36` checks); relayer `relayer/src/process-evm-requests.js:100,113-121` (`convertDecimals`)
**Category:** Latent misconfiguration → permanent fund lock
*(Consolidates 6 finders: evm-escrow, evm-proof-storage, native-proof-verify, relayer-trust, cross-cutting, completeness-critic. Consensus High.)*

**Description.** `depositToZero` writes the **raw EVM-decimal** amount verbatim into proof slot offset 1 (`EvmEscrowBridge.sol:209`). The relayer then **scales** that amount from `evmDecimals` to `zeroDecimals` via `convertDecimals` before submitting the Zero quantity (`process-evm-requests.js:100`). But `proveetoz` performs the integrity check `stored_amount == static_cast<uint64_t>(quantity.amount)` (`zero.bridge.cpp:196`) with **no decimal scaling on the native side**. The pair's `evm_decimals` field is stored (`hpp:84`) but never read in `proveetoz`. Therefore the equality holds **only when `evmDecimals == zeroDecimals`**.

`BridgeRegistry._addPair` validates each decimals field only as `<= 36` with no equality constraint; native `addpair` never compares `evm_decimals` to the Zero symbol precision. The two registries are configured independently. The presence of separate `evmDecimals`/`zeroDecimals` fields plus a `convertDecimals` helper creates the false impression that cross-decimal pairs are supported — they are not.

**Impact.** For any pair where `evmDecimals != zeroDecimals` (e.g. an 18-decimal EVM token mapped to a 6-decimal Zero asset — a normal real-world configuration), **every** legitimate deposit escrows/burns the user's EVM tokens but `proveetoz` reverts with `"EVM amount mismatch"`. Because there is **no EVM-side rescue** (see S-2), the funds are permanently lost. All currently shipped pairs use matching decimals (6/6, 6/6, 8/8, 4/4), which masks the bug today.

**Failure scenario.** Admin registers an 18-dec EVM token ↔ 6-dec Zero asset (accepted by both registries). User deposits `1e18`; relayer scales to `1e6` and submits `1.000000 ZASSET`. `proveetoz` compares `stored_amount=1e18` against `quantity.amount=1e6` → revert, every time. Deposit unrecoverable.

> *Correction applied:* The "operator naively passes raw amount → wrong-value mint" branch some finders described is **not** reachable — the shipped relayer always scales, and the check is exact equality, so a mismatch always *reverts* (fails closed), never silently over-issues.

**Remediation.** Either (a) implement the same decimal scaling inside `proveetoz` (`stored_amount == quantity.amount * 10^(evmDecimals - zeroDecimals)` with exact-divisibility/overflow checks), independent of the relayer; or (b) enforce `evmDecimals == zeroDecimals` at registration on **both** registries (e.g. `require(evm_decimals == zero_symbol.precision())` in `addpair`). Add an EVM-side rescue path (S-2).

---

#### H-2 — EVM→Zero deposit with an invalid/non-existent Antelope receiver name is permanently unrecoverable

**Component:** Cross-cutting (EVM + native)
**Location:** `evm/src/EvmEscrowBridge.sol:101` (length-only check), `106` (`sha256` of raw string), `111-114` (escrow/burn); `contracts/native/zero.bridge/src/zero.bridge.cpp:163` (`receiver` typed `name`), `170` (`is_account`), `205,428-431` (`sha256(name.to_string())`)
**Category:** Missing input validation → permanent fund loss
*(Consolidates: evm-proof-storage, native-proof-verify, cross-cutting, completeness-critic. Consensus High; one panelist Medium.)*

**Description.** `depositToZero` validates only `1 <= bytes(zeroReceiver).length <= 64` and stores `sha256(bytes(zeroReceiver))` over the **raw user string** — no Antelope name format/charset check. On the native side `proveetoz` requires `is_account(receiver)` and `stored_receiver_hash == sha256(receiver.to_string())`, where `receiver` is an Antelope `name` (≤12 chars, charset `.a-z1-5`) whose `to_string()` is always canonical. The two hashes can match **only** if the deposited string is byte-identical to a valid name's canonical form.

Any non-canonical input — uppercase (`"ALICE"`), trailing space (`"alice "`), >12 chars, invalid charset, or a syntactically valid but **not-yet-created** account — can never be reproduced by any `name`. For malformed strings the relayer's Antelope serializer throws before broadcast; for valid-but-nonexistent names `is_account` fails. Either way `proveetoz` can never succeed.

**Impact.** A user typo or a frontend that does not pre-validate strands the deposit permanently. Tokens are escrowed (escrow pairs) or **burned** (mint/burn pairs, `line 113`) at deposit time, and there is **no EVM rescue** (S-2). `refundztoe` only covers the reverse direction. This is unrecoverable loss under ordinary, non-malicious usage with no on-chain guard.

**Remediation.** Validate `zeroReceiver` on-chain in `depositToZero` against the Antelope name charset and `<=12`-byte length, rejecting anything else **before** escrowing. Because format validity cannot guarantee account existence at deposit time, **also** add an EVM-side timeout/governance refund path (S-2).

> *Severity:* High — permanent, total loss of the deposit, realistically triggered by user/frontend error, no guard, no recovery. Bounded to the depositor's own funds (no theft of third parties), which is why it is not Critical.

---

#### H-3 — Native `dev_mode` exposes `processetoz`, an admin mint shortcut that bypasses all EVM proof verification

**Component:** Native (`zero.bridge`)
**Location:** `contracts/native/zero.bridge/src/zero.bridge.cpp:120-158` (`processetoz`), gate at `128-129` (`require_auth(admin)` + `dev_mode`); set at `init` (`31`) and `setdevmode` (`42-47`); deployed manifest `deployments/telos-testnet-mvp.json:17-18` (`admin=trustlessbrg`, `devMode=true`)
**Category:** Centralization / misconfiguration → unbacked mint
*(Consensus Medium across panel; promoted here to High in the merged report because, combined with C-1, it gives the admin a second unbacked-mint primitive on the native side, and the deployed testnet manifest ships with `devMode=true`.)*

**Description.** `processetoz` issues fresh Zero assets to an arbitrary receiver/quantity/`evm_request_id` with **no** `eosio.evm` storage-proof verification (contrast `proveetoz` at `160+`). It is gated only by `require_auth(conf.admin)` and `conf.dev_mode`. `dev_mode` is chosen at `init` and freely re-enabled via `setdevmode(true)`.

**Impact.** If `dev_mode` is true in production (or re-enabled), the admin key becomes an unbacked minter of every bridge asset, fully bypassing the EVM escrow. Chained with C-1, a compromised/malicious admin can mint Zero assets, transfer them to `zero.bridge` to trigger a `ztoe` burn, and have the relayer release real EVM escrow — or simply use C-1 directly. The mitigation is purely operational (README/runbook/spec mandate `dev_mode=false` for production in five places).

**Remediation.** Make `dev_mode=false` an enforced invariant for value-bearing builds: remove `processetoz` from the production build entirely, or gate it behind a compile-time flag, or make `setdevmode(true)` impossible once a "mainnet" flag is set. Bind `admin` to a Telos-governed MSIG. Emit a loud event on every `processetoz` use.

---

#### H-4 — Single-key native governance: `setadmin`/`init`/`pause`/`setdevmode`/`refundztoe` controlled by one mutable admin name with no timelock or MSIG

**Component:** Native (`zero.bridge`)
**Location:** `contracts/native/zero.bridge/src/zero.bridge.cpp:26-68`; `require_admin` at `296-298`; deployed `admin=trustlessbrg` (`deployments/telos-testnet-mvp.json:17`)
**Category:** Centralization / trust assumption
*(Consensus Medium; reported as the dominant native-side centralization vector. Grouped with H-3 as the native counterpart to C-1.)*

**Description.** Every privileged native action resolves to `require_auth(config.admin)` — a single Antelope name set at `init` and reassignable in one `setadmin` action with no two-step handoff, no timelock, and no in-code MSIG requirement. `setdevmode(true)` re-enables the H-3 mint shortcut. The deployed testnet manifest uses a plain account, not an MSIG, with `devMode=true`.

**Impact.** A single compromised/malicious admin key can mint unbacked assets (H-3), repoint `setevmconf`, refund already-released burns (M-2), pause the bridge, or transfer admin away. (Note: `admin` is an *account* name, so its permission could in principle be an MSIG — but the code mandates nothing and the manifest ships a plain EOA.)

**Remediation.** Bind `admin` to a governance MSIG/threshold permission for mainnet. Add a two-step admin handoff and a timelock on `setadmin`/`setdevmode`. See § 3 production gates.

---

### MEDIUM

---

#### M-1 — Oversized EVM deposits (raw amount > `int64`/`uint64` range) are accepted on EVM but permanently unprovable on Zero

**Component:** Cross-cutting
**Location:** `evm/src/BridgeRegistry.sol:85,121` (`maxAmount` is `uint256`, no upper bound near `2^64`); `evm/src/EvmEscrowBridge.sol:173-175,209`; `contracts/native/zero.bridge/src/zero.bridge.cpp:192-196,394-405` (`checksum256_to_uint64`)
**Category:** Latent misconfiguration → permanent fund lock
*(Consolidates: native-proof-verify, evm-proof-storage, cross-cutting, completeness-critic. Consensus Medium.)*

**Description.** EVM amounts are `uint256` and `maxAmount` is admin-set `uint256` with no cap near `2^64`. `proveetoz` decodes the stored amount via `checksum256_to_uint64`, which reverts (`"stored EVM amount is too large"`) for any value ≥ `2^64`; additionally, line 196 compares against `static_cast<uint64_t>(quantity.amount)` where Antelope `asset.amount` is `int64`, so any raw amount > `2^63-1` (~9.22e18) can never match a valid positive quantity. Any deposit above that ceiling escrows/burns on EVM but can never be proven, with no rescue (S-2).

**Impact.** Reachable for high-decimal tokens at modest whole-token counts (an 18-decimal token: ~9.2 tokens). Requires an admin to set `maxAmount` above the `int64` ceiling, which is itself a self-inconsistent config since the `int64` Zero asset can't represent such values — hence Medium, not High. For the shipped 6/8-decimal stablecoins the threshold is astronomically high and unreachable.

**Remediation.** Bound `BridgeRegistry` `maxAmount` (and `minAmount`) to `<= int64.max` after decimal scaling, validated at registration. Add the EVM rescue path (S-2).

---

#### M-2 — Refund/release double-spend: `refundztoe` and `releaseToEvm` share no cross-chain state

**Component:** Cross-cutting (native + EVM)
**Location:** `contracts/native/zero.bridge/src/zero.bridge.cpp:235-255` (`refundztoe`, guarded only by `!itr->refunded`); `evm/src/EvmEscrowBridge.sol:151-171` (independent `processedZeroBurns`); relayer off-chain skip at `relayer/src/lib/ztoe.js:25`
**Category:** Missing on-chain interlock / operational race
*(Consolidates: native-ztoe-asset, cross-cutting, completeness-critic — 3 finders. Consensus Medium; one panelist High, one Low.)*

**Description.** A Zero→EVM burn has two independent settlement paths with **no shared on-chain state**: (1) the relayer calls `releaseToEvm`, setting `processedZeroBurns[zeroBurnId]=true` on EVM; (2) the admin calls `refundztoe`, re-issuing the burned Zero asset and setting `refunded=true` on Zero. The native contract cannot read `processedZeroBurns`, and the EVM contract cannot read `refunded`. The only guard against honoring one burn twice is the relayer's off-chain skip of refunded rows (`ztoe.js:25`) — a TOCTOU snapshot check, not an on-chain invariant, and it only protects the refund-then-release ordering.

**Impact.** A single burn can be both released on EVM and refunded on Zero — double-value payout, breaking the supply invariant. The reverse race (release confirmed, then admin refunds a still-`refunded=false` row believing it stuck) is equally live because `refundztoe` never checks EVM state.

**Scenario.** User burns 100 ZUSDC → relayer's `releaseToEvm` is pending/slow → operator, believing the request stuck (relayer lag), calls `refundztoe` → 100 ZUSDC re-issued → the pending EVM release confirms → user holds both.

> *Severity:* Medium — `refundztoe` is admin-gated (not an unprivileged exploit), but an *honest* admin acting on stale state, or a release/refund race, breaks the supply invariant with no on-chain interlock. The production spec explicitly lists "double refund" as a threat to defend against.

**Remediation.** Require an EVM-verifiable proof that the burn was **not** released before refunding (read `processedZeroBurns` via the same storage-proof technique as `proveetoz`), or use a single canonical cross-chain settlement record. At minimum, gate `refundztoe` behind a long timelock plus proof of non-release.

---

#### M-3 — Unbounded, bridge-paid RAM growth via `ontransfer` ztoe rows (RAM-griefing DoS)

**Component:** Native (`zero.bridge`)
**Location:** `contracts/native/zero.bridge/src/zero.bridge.cpp:272` (`requests.emplace(get_self(), ...)`); no `.erase` anywhere in the contract
**Category:** Availability / griefing
*(Consensus Medium; one panelist Low. The cheap vector is the `ontransfer`/ztoe path specifically.)*

**Description.** `ontransfer` emplaces a `ztoereqs` row with `get_self()` as RAM payer (`line 272`); these rows are required for replay protection and are never erased. An attacker performing repeated minimum-amount Zero→EVM transfers forces permanent, bridge-funded RAM consumption. When RAM is exhausted, the `emplace` fails and bridging halts until governance buys more RAM.

**Impact.** Repeatable griefing/DoS. Two caveats reduce severity from the original claim: (a) each row requires burning at least `min_quantity` of a bridge-issued asset, which the attacker can only obtain by genuinely bridging value from EVM (escrowing real tokens), and the burned asset is **released back** to them on EVM via `releaseToEvm` — so the attacker recycles the same funds, paying mainly recoverable CPU/NET; (b) RAM is a recoverable resource governance can top up. Net: a real availability footgun, not fund loss. (The `proveetoz`/etoz emplace at `217` is **not** a cheap vector — it requires a genuine EVM proof per row.)

**Remediation.** Charge RAM for request rows to the initiating user where possible; or store only a compact hash-keyed replay marker; and add a governance-gated pruning action for finalized rows past finality, plus a per-account pending-request cap (spec § 15).

---

#### M-4 — Cross-registry pairId desynchronization issues the wrong Zero asset (no `evm_token` binding in the proof)

**Component:** Cross-cutting
**Location:** `contracts/native/zero.bridge/src/zero.bridge.cpp:172,186-190,227-232` (binds only `stored_pair_id == pair_id`; `pair.evm_token` never checked); `evm/src/EvmEscrowBridge.sol:107-109` (`requestHash` commits `pairId` but **not** the token address); `evm/src/BridgeRegistry.sol:88` (auto-increment id)
**Category:** Latent misconfiguration
*(Consolidates: native-proof-verify, cross-cutting. Consensus Low–Medium; placed at Medium given the value-error potential, though see note.)*

**Description.** The only cross-chain asset binding is the integer `pairId`. The EVM proof does not contain the token address at all, and `proveetoz` never reads the native pair's `evm_token`. If the EVM registry (auto-incremented ids) and native `addpair` (manually-chosen ids) are configured with the same `pairId` pointing at different assets, a deposit of token A under pairId N mints native pair-N's asset.

**Impact.** Operator misconfiguration during dual registration could over-issue (e.g. cheap token under a pairId whose native pair is a high-value asset). Requires no attacker — but is reachable only via admin error, and the same admin already controls both registries and (via C-1/H-3) can mis-issue directly.

> *Honest assessment:* This is largely a property of any registry-keyed bridge and is partially fail-closed — if the misalignment changes the **symbol**, `proveetoz`'s `quantity.symbol == pair.zero_symbol` and amount checks revert. Silent mis-issuance requires same-symbol/different-decimals collisions. Severity Medium with a strong case for Low.

**Remediation.** Commit `evm_token` into the EVM `requestHash` (or a known proof slot) and assert `stored_evm_token == pair.evm_token` in `proveetoz`. At minimum, have the relayer fetch `BridgeRegistry.getPair(pairId)` at startup and assert token/decimals consistency, and treat pairId synchronization as a critical deployment invariant.

---

#### M-5 — Fee-on-transfer / deflationary tokens cause escrow undercollateralization or bricked deposits

**Component:** EVM
**Location:** `evm/src/EvmEscrowBridge.sol:111-125` (records `amount`, no `balanceOf` delta), `113` (`burn(amount)`); native exact match at `zero.bridge.cpp:196`
**Category:** Latent misconfiguration
*(Consensus Low; original claim High. Downgraded — owner-only trigger, curated standard-token set.)*

**Description.** `depositToZero` records the literal `amount` parameter with no `balanceOf`-before/after delta. For a fee-on-transfer escrow pair, the contract receives less than `amount` but the user is credited the full `amount` on Zero — escrow accrues a deficit, and the last withdrawers' `releaseToEvm` reverts (insolvency). For a mint/burn pair, `burn(amount)` underflow-reverts since `address(this)` received less than `amount`, bricking deposits (atomic revert, no fund loss).

**Impact.** Requires the owner to register a fee-on-transfer/rebasing token (owner-only `addPair`); the intended assets are standard non-fee tokens. Hence Low.

**Remediation.** Measure the received balance via `balanceOf` delta and record/prove that, or reject fee-on-transfer tokens. Document that only standard 1:1 ERC-20s are supported.

---

#### M-6 — `convertDecimals` reverts off-chain on non-divisible down-conversion, stranding dust-bearing deposits

**Component:** Relayer
**Location:** `relayer/src/process-evm-requests.js:113-121`; `relayer/src/lib/ztoe.js:59-67`
**Category:** Latent misconfiguration
*(Consensus Low; listed here as a Medium-adjacent compounding case of H-1. Kept at Low.)*

**Description.** When `evmDecimals > zeroDecimals`, `convertDecimals` throws if the raw amount is not evenly divisible by `10^diff`. `depositToZero` imposes no divisibility constraint, so a deposit carrying sub-Zero-precision dust is accepted/escrowed on EVM but the relayer throws before submitting `proveetoz`. With no EVM rescue (S-2), funds strand. Because the throw is uncaught in the eager candidate-building `.map()`, one dust deposit also **aborts the entire relayer batch run**, blocking all other pending deposits until manually excluded.

**Impact.** Only triggers under intentionally-asymmetric decimals (all shipped configs are symmetric, where `convertDecimals` is a no-op). Low, conditional on H-1's misconfiguration.

**Remediation.** Enforce `evmDecimals == zeroDecimals` (preferred), or reject non-divisible deposits in `depositToZero`, or add an EVM rescue. Wrap each candidate in try/catch so one bad request cannot wedge the batch.

---

### LOW

---

#### L-1 — Scanner defaults to `scanFromBlock=latest` with no cursor persistence; deposits are missed
**Component:** Relayer · **Location:** `relayer/src/lib/scan.js:14-43`; both example configs `scanFromBlock: "latest"`; `relayer/src/watch-evm-requests.js` (fresh process per poll)
*(Consensus Medium; downgraded to Low here because deposits are **recoverable** — EVM proofs persist and processing is idempotent on `requestHash`, so an operator can re-scan from an earlier block.)*

With the shipped config, each poll resolves `[latest, latest]` (a one-block window) and no cursor is persisted, so on a sub-second-block chain ~19/20 blocks of deposits are never scanned. Funds are escrowed but not issued until a manual re-scan. **Fix:** persist a scan cursor (last fully-processed block), resume from `cursor+1`, scan contiguous `[cursor+1, latest-finality]` ranges in a long-lived process; document that `"latest"` is unsafe for production.

#### L-2 — Pair-ID assignment is positionally coupled across EVM scripts, native, and relayer config with no validation
**Component:** Cross-cutting · **Location:** `evm/src/BridgeRegistry.sol:27,88`; `relayer/src/config.example.json:18-53`; `relayer/src/lib/config.js:14-24`
Sequential `nextPairId++` plus hardcoded positional configs; the relayer never cross-checks `evmToken`/decimals against the on-chain registry. A reordered/inserted registration shifts ids. Note: largely **fail-closed** — `proveetoz` re-verifies pairId/symbol/amount, so drift mostly causes reverts (liveness) rather than mis-issuance, except for same-symbol collisions (overlaps M-4). **Fix:** relayer asserts `getPair(pairId)` matches config at startup; or make `addPair` take an explicit pairId.

#### L-3 — No EVM deploy script registers the wEMPIRES mint/burn pair
**Component:** EVM · **Location:** `evm/script/DeployAndRegister.s.sol:23`, `evm/script/RegisterPairs.s.sol:21`; `addMintBurnPair` referenced only in tests; manifest registers pairId 4 out-of-band
The in-repo scripts register only the 3 escrow pairs; wEMPIRES + `addMintBurnPair` were done manually. An operator following the scripts who then mis-registers wEMPIRES via `addPair` (mintBurn=false) would make the bridge escrow-but-not-burn it, and releases would revert. **Fix:** add a script that deploys `BridgeMintBurnERC20` and calls `addMintBurnPair`, or extend `RegisterPairs` with a per-pair mintBurn flag.

#### L-4 — `pair.evm_token` is never verified in `proveetoz` (pairId is the sole binding)
**Component:** Native · **Location:** `zero.bridge.cpp:172,186-190,227-232`
Same root cause as M-4, recorded as the native-side defense-in-depth observation. **Fix:** as M-4.

#### L-5 — Relayer accepts the `zeroBridge` release key from a plaintext JSON config field
**Component:** Relayer · **Location:** `relayer/src/process-zero-requests.js:69-76`
`config.evm.releasePrivateKey` is an accepted source for the highest-privilege bridge key (C-1). `.gitignore` covers `.env*`/`*.local.json` but **not** `config.json`, so an operator who inlines the key could commit it. The address-match check (`78-87`) is good but only prevents using the wrong key, not exposing the right one. **Fix:** drop `config.evm.releasePrivateKey`; require env/secret-manager only; move signing behind an HSM.

#### L-6 — Unmaintained `eosjs ^22.1.0`; private keys held in-process plaintext
**Component:** Crypto/deps · **Location:** `relayer/package.json:18-21`; `relayer/src/lib/zero.js:7`; `relayer/src/process-evm-requests.js:152-157`
Abandoned dependency line + raw WIF/EVM keys in process memory with caret version ranges and no remote-signer abstraction. Per C-1, these keys equal full bridge custody. **Fix:** pin exact versions, add `npm audit`/lockfile review to CI, migrate to a maintained library (`@wharfkit/antelope`) and an HSM/remote signer.

#### L-7 — EVM RPC is fully trusted for proof reads and event scanning (single source)
**Component:** Relayer · **Location:** `relayer/src/lib/rpc.js:7-39`; `relayer/src/lib/scan.js:24-31`
Single RPC, no quorum/TLS-pinning. On the production `proveetoz` path this is benign (native re-verifies on-chain), so the real residual is availability: a withholding/MITM'd RPC can drop deposit logs (compounds L-1) or waste txns. *(The "induce unbacked mints" angle belongs to H-3/dev-mode, not RPC trust.)* **Fix:** self-hosted node, TLS pinning, multi-RPC agreement for log scanning; keep `proveetoz` as the only production path.

#### L-8 — `zero.asset` mint-exclusivity depends entirely on off-chain deploy discipline; `refundztoe` assumes `zerobridge` is the issuer
**Component:** Native (`zero.asset` / `zero.bridge`) · **Location:** `contracts/native/zero.asset/src/zero.asset.cpp:6-46`; `zero.bridge.cpp:249-254`
`create` records an arbitrary caller-supplied issuer; `issue` requires `require_auth(st.issuer)`. There is no on-chain coupling forcing `issuer == zerobridge` — a wrong issuer at `create`, or extra keys on the asset account, breaks bridge-exclusive minting. Relatedly, `refundztoe` dispatches `issue` with `zerobridge` authority, which only works if `zerobridge` is the issuer (true for the EVM-origin pairs; for a Zero-origin external token like EMPIRES it either reverts or requires granting `zerobridge` unbounded mint authority over a third-party token). **Fix:** verify post-deploy that every bridge asset has `issuer == zerobridge` and the asset account has no extra authorities; track the asset model (escrow vs zero-origin) per pair and choose the correct refund primitive.

---

### INFORMATIONAL

| ID | Title | Location | Note |
|---|---|---|---|
| I-1 | No release-side daily limit (`_consumeDailyLimit` only in `depositToZero`) | `EvmEscrowBridge.sol:103,185-190` vs `151-171` | Defense-in-depth gap that amplifies C-1; a daily cap on releases would only throttle, not prevent, a key-compromise drain (and could harm liveness). Folded into C-1's remediation. |
| I-2 | Daily-limit fixed UTC window allows ~2× across midnight | `EvmEscrowBridge.sol:185-190` | Standard fixed-window limiter property; minor. |
| I-3 | `ZeroToEvmReleased` emits unvalidated `zeroSender`/`zeroBurnId` | `EvmEscrowBridge.sol:68-70,170` | Off-chain reconcilers must not treat these as proof-of-burn; downstream of C-1. |
| I-4 | Asymmetric pause: deposits accepted on EVM while Zero paused | `EvmEscrowBridge.sol:96` vs `zero.bridge.cpp:169` | Strands in-flight deposits during divergent pause; recoverable on unpause (terminal only via S-2). Pause both sides together. |
| I-5 | Deposit-then-Zero-pause/deactivate strands funds (no EVM refund) | `EvmEscrowBridge.sol:93-128`; `zero.bridge.cpp:169,309-314` | Admin-recoverable (no `rmpair` exists; reactivate + re-prove); real gap is S-2. |
| I-6 | `refundztoe` not covered by pause; skips active-pair check | `zero.bridge.cpp:235-255` | Net-neutral, idempotent (`refunded` flag); skipped active-check is intentional so deactivated pairs remain refundable. Decide explicitly whether refunds run while paused. |
| I-7 | `ontransfer` reverts all inbound transfers without a 42-char `0x` memo | `zero.bridge.cpp:257-266,316-324` | Safe-fail; bridge account can't receive arbitrary tokens (note: TLOS/CPU/RAM funding uses system actions, unaffected). Optionally resolve pair before validating memo. |
| I-8 | Finality check compares EVM `block.timestamp` to native wall-clock; default delay 0 | `zero.bridge.cpp:207-215`; `EvmEscrowBridge.sol:122,125` | Security boundary is the finalized shared-chain storage read, not the delay; `finality_delay_sec` is an optional buffer. No exploitable impact. |
| I-9 | `createdAt` width divergence (`uint64` struct vs `uint256` proof slot) | `EvmEscrowBridge.sol:122` vs `213` | Diverges only above year ~584 billion. Cosmetic. |
| I-10 | Relayer trusts unindexed event data instead of re-reading proof storage | `relayer/src/lib/events.js:8-26`; `scan.js:26-35` | Mitigated by `proveetoz` on-chain re-verification; restates the intended trust model. Optionally cross-check `requestProofs(requestHash)`. |
| I-11 | Many spec-mandated controls unimplemented (`removepair`, `recover`, per-direction pause, per-account pending cap) | `zero.bridge.hpp:32-63` vs spec §11/§15 | Scope/spec gap, not a vuln; the missing per-account cap weakens M-3 defenses, missing `recover` compounds S-2. (Structured `bridge:v1:` memo is *preferred*, not mandated — bare 0x is spec-compliant.) |
| I-12 | Deployed testnet manifest: single-account owner/admin + `devMode=true` | `deployments/telos-testnet-mvp.json:8-18,86-90` | Documented testnet posture; restates C-1/H-3/H-4 production gates. |
| I-13 | Compiler/pragma posture sound; no overflow concerns | `evm/foundry.toml:5-7`; `^0.8.24` everywhere, no `unchecked` | Verified correct. Optionally pin library pragmas to `=0.8.24`. |

**Verified-correct (positive results, no action required):**
- **Phantom-storage slot derivation is byte-for-byte identical between Solidity and C++** (`EvmEscrowBridge.sol:192-215` ↔ `zero.bridge.cpp:361-392`; keccak constant, buffer layout, field offsets, big-endian carry all match; independently re-derived against known-answer vectors). *Recommendation: add a committed cross-language known-answer test to guard future edits.*
- **Proof slots are unforgeable on EVM** — only `_storeRequestProof` (called solely from `depositToZero` after real escrow/burn) writes them; no `delegatecall`/arbitrary-write; `exists=1` cannot be set without a real deposit (`EvmEscrowBridge.sol:50-57,196-215`).
- **`proveetoz` permissionless is safe** — every economic field re-verified against authenticated `eosio.evm` storage; asset issued to proof-bound receiver, not caller; `byevmreq` replay guard sound (`zero.bridge.cpp:160-233`).
- **`checksum256_to_uint64` correctly fails closed** on values ≥ `2^64` (`zero.bridge.cpp:394-405`) — the mechanism behind M-1's safe-fail.
- **`make_burn_id` / `processedZeroBurns` replay protection sound** in both directions (`zero.bridge.cpp:326-329`; `EvmEscrowBridge.sol:161-163`).
- **Keccak-256 is correct Ethereum keccak** (legacy padding, not SHA3); `SafeTransferLib`, `ReentrancyGuard`, two-step `Owned`, and `BridgeMintBurnERC20` mint/burn semantics all correct.
- **Trusting relayer-supplied `evm_request_id` without recomputing `requestHash`** is sound — the slot location is itself a function of the hash, so a forged id reads empty slots and fails the `exists` gate.

---

## 3. Systemic / Design Observations

### 3.1 The trust model is the bridge's security
The bridge is **asymmetric by design**: EVM→Zero is trustless (real proof in `proveetoz`), but Zero→EVM is fully trusted (C-1). This single asymmetry — plus its native mirror (H-3 `dev_mode` + H-4 single admin) — accounts for the entire critical/high risk surface. The architecture's stated goal ("relayers are liveness helpers, not trusted oracles") is met in one direction and violated in the other. **Until `releaseToEvm` verifies an actual Zero burn, the relayer *is* a trusted oracle with custody of all funds.**

### 3.2 Irreversibility without recovery — the systemic amplifier (S-2)
`EvmEscrowBridge` escrows (and for mint/burn pairs **burns**) tokens at deposit time but exposes **no** withdraw/rescue/refund/cancel function — the only owner lever is `setPaused`, and the only token exit is `releaseToEvm` (the reverse-direction mint). The native side has `refundztoe`; the EVM side has nothing symmetric. This gap converts at least four otherwise-recoverable conditions into **permanent fund loss**: decimal mismatch (H-1), oversized amount (M-1), bad receiver name (H-2), and (terminally, if prolonged) divergent pause/retire (I-4/I-5). The production spec itself lists "Failed native transfer → EVM refund/recovery" as a *requirement* (spec lines 159, 594–595), so this is a gap against the project's own design, not an accepted tradeoff.

**Required before mainnet:** add a governed, time-locked EVM-side refund keyed by `requestHash` — refund (re-mint for mint/burn pairs) a deposit that remains unproven on Zero beyond a finality+grace window, marking it consumed to preclude later double-processing if Zero ever proves it.

### 3.3 Decimal handling is half-built
Separate `evmDecimals`/`zeroDecimals` registry fields and a relayer `convertDecimals` helper imply cross-decimal support, but the on-chain verifier (`proveetoz`) does no scaling (H-1). Either implement on-chain scaling or enforce equal decimals on both registries; do not ship dead fields that lull operators into assuming scaling exists.

### 3.4 Cross-chain state has no shared ledger
`refunded` (Zero) and `processedZeroBurns` (EVM) are independent (M-2); pairId↔token mapping is unbound (M-4); the two registries' limits/decimals/pause are independently configured (H-1, M-1, I-4). The bridge relies on out-of-band operator discipline for every cross-chain invariant. A single canonical settlement record or cross-chain proof for the Zero→EVM leg would dissolve M-2 and most of the latent-misconfig class at once.

### 3.5 Production gates (must be closed before any value-bearing deployment)
Tying to the README's own list and these findings:
1. **Replace the `onlyZeroBridge` dispatcher with on-chain Zero-burn verification** (C-1) — the load-bearing gate.
2. **`dev_mode=false` enforced in the production build; remove/compile-gate `processetoz`** (H-3).
3. **Move `admin` and EVM `owner` to a governance MSIG** with two-step handoff + timelock (H-4).
4. **Add an EVM-side refund/recovery path** (S-2) and enforce decimal equality or on-chain scaling (H-1).
5. Bound `maxAmount` to the `int64` ceiling (M-1); add release-side rate limits (I-1); validate `zeroReceiver` on-chain (H-2); persist a relayer scan cursor (L-1); cross-check pair config against the on-chain registry (L-2/M-4); move signing keys to an HSM (L-5/L-6).

---

## 4. Appendix: Checked-and-Cleared

Candidates investigated and found to be **non-issues** or accepted tradeoffs:

| Candidate | Verdict & one-line rationale |
|---|---|
| `zero.asset::transfer` notifies recipients before mutating balances ("non-standard ordering") | **Non-issue.** Antelope `require_recipient` is not a synchronous EVM-style callback — notified handlers run only *after* the transfer action returns with balances committed, so no intermediate state is observable and no reentrancy/mis-accounting is possible. |
| No finality/reorg handling on EVM scan; relayer could prove a reorged-out deposit | **Non-issue.** EVM and Zero are the *same* Antelope ledger. `proveetoz` reads `eosio.evm` storage and issues atomically on that one chain; any reorg removing the deposit removes the later `proveetoz` (and its issue + dedup row) along with it. No unbacked supply can persist. |
| Phantom-storage slot derivation might diverge between Solidity and C++ | **Cleared (verified correct).** Re-derived byte-for-byte against known-answer keccak vectors; identical. |
| EVM proof slots could be forged / collide with declared storage | **Cleared.** Only `_storeRequestProof` writes them, no arbitrary-write path, keccak-derived slots cannot collide with low declared slots. |
| `proveetoz` permissionless might enable theft/front-running | **Cleared.** Asset issued to the proof-bound receiver (not caller); every field re-verified against authenticated storage; replay-guarded. |
| Keccak might be SHA3 (wrong padding) | **Cleared.** Empty-string digest confirms legacy Keccak padding; correct Ethereum keccak-256. |
| `SafeTransferLib` mishandling missing-return-value tokens | **Cleared (correct).** Standard Solady/Solmate pattern; minor note that it does not assert token has code, gated by trusted owner registration (info). |
| Replay protection weakness | **Cleared.** Sound in both directions; `byevmreq` and `processedZeroBurns` correct. |
| Compiler/overflow concerns | **Cleared.** `^0.8.24`, checked arithmetic, no `unchecked` blocks. |
| `createdAt` width divergence as a real bug | **Accepted tradeoff (info).** Diverges only at impossible timestamps. |
| `ontransfer` rejecting unpaired/bad-memo transfers as a vulnerability | **Accepted design (info).** Safe atomic revert; standard Antelope deposit-via-transfer behavior. |
| Wall-clock finality delay as a security flaw | **Cleared.** Security boundary is the finalized shared-chain storage read, not the wall-clock delay (which is an optional buffer, default 0 under instant finality). |