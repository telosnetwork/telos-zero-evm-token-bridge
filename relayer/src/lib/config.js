import fs from "node:fs/promises";
import { assertHexAddress } from "./hex.js";

export async function loadConfig(path) {
  if (!path) {
    throw new Error("Usage: node <script> <config.json>");
  }

  const config = JSON.parse(await fs.readFile(path, "utf8"));
  if (!config.evm?.rpcUrl) throw new Error("config.evm.rpcUrl is required");
  if (!Number.isSafeInteger(config.evm.chainId) || config.evm.chainId <= 0) throw new Error("config.evm.chainId must be a positive safe integer");
  if (config.evm.escrowBridge) assertHexAddress(config.evm.escrowBridge, "config.evm.escrowBridge");
  if (!Array.isArray(config.pairs) || config.pairs.length === 0) throw new Error("config.pairs must not be empty");

  for (const pair of config.pairs) {
    if (!Number.isInteger(pair.pairId) || pair.pairId <= 0) throw new Error("pair.pairId must be positive");
    assertHexAddress(pair.evmToken, `pair ${pair.pairId} evmToken`);
    if (!pair.zeroSymbol) throw new Error(`pair ${pair.pairId} zeroSymbol is required`);
    if (!Number.isInteger(pair.evmDecimals) || pair.evmDecimals < 0 || pair.evmDecimals > 36) {
      throw new Error(`pair ${pair.pairId} evmDecimals must be an integer between 0 and 36`);
    }
    if (!Number.isInteger(pair.zeroDecimals) || pair.zeroDecimals < 0 || pair.zeroDecimals > 18) {
      throw new Error(`pair ${pair.pairId} zeroDecimals must be an integer between 0 and 18`);
    }
  }

  return config;
}
