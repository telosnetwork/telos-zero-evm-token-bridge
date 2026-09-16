import { decodeEvmToZeroRequested, TOPICS } from "./events.js";
import { EvmRpc } from "./rpc.js";

const DEFAULT_MAX_BLOCK_RANGE = 90_000n;

export async function scanEvmRequests(config, range = {}) {
  const rpc = new EvmRpc(config.evm.rpcUrl);
  const chainId = await rpc.chainId();

  if (config.evm.chainId !== undefined && chainId !== config.evm.chainId) {
    throw new Error(`connected to EVM chainId ${chainId}, expected ${config.evm.chainId}`);
  }

  const latestBlock = await rpc.blockNumber();
  if (config.evm.scanFromBlock === "latest") throw new Error("scanFromBlock must be a fixed deployment block or earliest, not latest");
  const fromBlock = parseBlockNumber(range.fromBlock ?? config.evm.scanFromBlock ?? 0, latestBlock);
  const toBlock = minBigInt(parseBlockNumber(range.toBlock ?? config.evm.scanToBlock ?? "latest", latestBlock), latestBlock);

  const maxRange = BigInt(config.evm.maxLogRange ?? DEFAULT_MAX_BLOCK_RANGE);
  if (maxRange <= 0n) throw new Error("maxLogRange must be positive");
  const logs = [];

  for (let start = fromBlock; start <= toBlock; start += maxRange + 1n) {
    const end = minBigInt(start + maxRange, toBlock);
    const chunkLogs = await rpc.getLogs({
      address: config.evm.escrowBridge,
      fromBlock: toHex(start),
      toBlock: toHex(end),
      topics: [TOPICS.evmToZeroRequested]
    });
    logs.push(...chunkLogs);
  }

  const requests = logs.map(decodeEvmToZeroRequested);
  return {
    chainId,
    fromBlock: toHex(fromBlock),
    toBlock: toHex(toBlock),
    count: requests.length,
    requests
  };
}

export function parseBlockNumber(value, latestBlock) {
  if (value === undefined || value === null || value === "" || value === "latest") return latestBlock;
  if (value === "earliest") return 0n;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(`invalid block number: ${value}`);
}

export function toHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function minBigInt(a, b) {
  return a < b ? a : b;
}
