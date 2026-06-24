#!/usr/bin/env node
import { getCurrencySupply } from "./lib/antelope.js";
import { loadConfig } from "./lib/config.js";
import { readErc20Balance, readErc20Decimals } from "./lib/erc20.js";
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
  const deltaRaw = zeroRaw === null ? null : escrowRaw - zeroRaw;

  rows.push({
    pairId: pair.pairId,
    evmSymbol: pair.evmSymbol || pair.evmToken,
    zeroSymbol: pair.zeroSymbol,
    evmEscrow: formatUnits(escrowRaw, pair.evmDecimals),
    zeroSupply: zeroRaw === null ? "unavailable" : formatUnits(zeroRaw, zeroSupply.decimals),
    delta: deltaRaw === null ? "unavailable" : formatUnits(deltaRaw, pair.evmDecimals),
    status: deltaRaw === null ? "UNKNOWN" : deltaRaw === 0n ? "OK" : "MISMATCH"
  });
}

console.table(rows);

const mismatches = rows.filter((row) => row.status !== "OK");
if (mismatches.length > 0) {
  process.exitCode = 2;
}
