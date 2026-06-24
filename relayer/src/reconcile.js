#!/usr/bin/env node
import { getCurrencySupply } from "./lib/antelope.js";
import { loadConfig } from "./lib/config.js";
import { readErc20Balance, readErc20Decimals, readErc20TotalSupply } from "./lib/erc20.js";
import { formatUnits, parseAntelopeAsset } from "./lib/numbers.js";
import { EvmRpc } from "./lib/rpc.js";

const config = await loadConfig(process.argv[2]);
const rpc = new EvmRpc(config.evm.rpcUrl);
const chainId = await rpc.chainId();

if (config.evm.chainId !== undefined && chainId !== config.evm.chainId) {
  throw new Error(`connected to EVM chainId ${chainId}, expected ${config.evm.chainId}`);
}

const rows = [];

for (const pair of config.pairs) {
  const escrowRaw = await readErc20Balance(rpc, pair.evmToken, config.evm.escrowBridge);
  const onchainDecimals = await readErc20Decimals(rpc, pair.evmToken);
  if (onchainDecimals !== pair.evmDecimals) {
    throw new Error(`${pair.evmSymbol || pair.evmToken} decimals mismatch: config ${pair.evmDecimals}, chain ${onchainDecimals}`);
  }

  const zeroSupply =
    pair.zeroSupply !== undefined
      ? parseAntelopeAsset(pair.zeroSupply)
      : await getCurrencySupply(config.zero?.apiUrl, pair.zeroContract, pair.zeroSymbol);

  const zeroRaw = zeroSupply?.raw ?? null;
  const mode = pair.reconcileMode || pair.model || "exact-escrow";
  const zeroRawInEvmDecimals =
    zeroRaw === null ? null : convertDecimals(zeroRaw, zeroSupply.decimals, pair.evmDecimals);

  let evmSupplyRaw = null;
  let invariant = "escrow == zeroSupply";
  let deltaRaw = zeroRawInEvmDecimals === null ? null : escrowRaw - zeroRawInEvmDecimals;
  let status = deltaRaw === null ? "UNKNOWN" : deltaRaw === 0n ? "OK" : "MISMATCH";

  if (mode === "evm-origin-escrow" || mode === "escrow-backing") {
    invariant = "escrow >= zeroSupply";
    status = deltaRaw === null ? "UNKNOWN" : deltaRaw >= 0n ? "OK" : "UNDERBACKED";
  } else if (mode === "zero-origin-mint-burn" || mode === "mint-burn-supply") {
    if (!pair.zeroInitialSupply) {
      throw new Error(`${pair.zeroSymbol} mint/burn reconciliation requires pair.zeroInitialSupply`);
    }
    evmSupplyRaw = await readErc20TotalSupply(rpc, pair.evmToken);
    const initialSupply = parseAntelopeAsset(pair.zeroInitialSupply);
    const initialRaw = convertDecimals(initialSupply.raw, initialSupply.decimals, pair.evmDecimals);
    const combinedRaw = zeroRawInEvmDecimals === null ? null : zeroRawInEvmDecimals + evmSupplyRaw;
    invariant = "zeroSupply + evmSupply == zeroInitialSupply";
    deltaRaw = combinedRaw === null ? null : combinedRaw - initialRaw;
    status = deltaRaw === null ? "UNKNOWN" : deltaRaw === 0n ? "OK" : "MISMATCH";
  } else if (mode !== "exact-escrow") {
    throw new Error(`Unknown reconcileMode for ${pair.zeroSymbol}: ${mode}`);
  }

  rows.push({
    pairId: pair.pairId,
    evmSymbol: pair.evmSymbol || pair.evmToken,
    zeroSymbol: pair.zeroSymbol,
    invariant,
    evmEscrow: formatUnits(escrowRaw, pair.evmDecimals),
    evmSupply: evmSupplyRaw === null ? "" : formatUnits(evmSupplyRaw, pair.evmDecimals),
    zeroSupply: zeroRaw === null ? "unavailable" : formatUnits(zeroRaw, zeroSupply.decimals),
    delta: deltaRaw === null ? "unavailable" : formatUnits(deltaRaw, pair.evmDecimals),
    status
  });
}

console.table(rows);

const mismatches = rows.filter((row) => row.status !== "OK");
if (mismatches.length > 0) {
  process.exitCode = 2;
}

function convertDecimals(raw, fromDecimals, toDecimals) {
  if (fromDecimals === toDecimals) return raw;
  if (fromDecimals < toDecimals) return raw * 10n ** BigInt(toDecimals - fromDecimals);

  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  if (raw % divisor !== 0n) {
    throw new Error(`amount ${raw} cannot be converted from ${fromDecimals} to ${toDecimals} decimals without rounding`);
  }
  return raw / divisor;
}
