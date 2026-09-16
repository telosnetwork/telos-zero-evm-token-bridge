import { encodeAbiParameters, keccak256 } from "viem";
import { strip0x } from "./hex.js";
import { formatUnits } from "./numbers.js";
import { convertDecimals } from "./ztoe.js";

const PROOF_SLOT = "0xf981179bb6ca7bacd9c09fc7ee84e06aaea9dc6e23314fa01335b762685e87c1";

export function assertCanonicalZeroName(value) {
  if (typeof value !== "string" || !/^[.1-5a-z]{1,13}$/.test(value) || value.endsWith(".") ||
      (value.length === 13 && !/[1-5a-j]/.test(value[12]))) {
    throw new Error(`Invalid canonical native receiver: ${value}`);
  }
}

export function buildEvmToZeroAction(config, request) {
  assertCanonicalZeroName(request.zeroReceiver);
  const pair = config.pairs.find((candidate) => String(candidate.pairId) === String(request.pairId));
  if (!pair) throw new Error(`No pair configured for request ${request.requestId} pair ${request.pairId}`);
  const zeroRaw = convertDecimals(BigInt(request.amount), pair.evmDecimals, pair.zeroDecimals);
  if (zeroRaw <= 0n || zeroRaw > (1n << 62n) - 1n) throw new Error("Amount exceeds native asset range");
  return {
    pair_id: pair.pairId,
    evm_request_id: strip0x(request.requestHash).toLowerCase(),
    receiver: request.zeroReceiver,
    quantity: `${formatUnits(zeroRaw, pair.zeroDecimals)} ${pair.zeroSymbol}`,
    evm_sender: strip0x(request.sender).toLowerCase()
  };
}

export async function readProofStatus(rpc, bridge, requestHash) {
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [requestHash, PROOF_SLOT])));
  const slot = `0x${((base + 5n) % (1n << 256n)).toString(16).padStart(64, "0")}`;
  return Number(BigInt(await rpc.call("eth_getStorageAt", [bridge, slot, "latest"])));
}

export function parseArgs(args) {
  const options = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") options.dryRun = true;
    else if (args[i] === "--request-id") options.requestId = args[++i];
    else if (args[i].startsWith("--request-id=")) options.requestId = args[i].slice(13);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (options.requestId !== undefined && !/^[0-9]+$/.test(options.requestId)) throw new Error("request-id must be an unsigned integer");
  if (args.includes("--request-id") && options.requestId === undefined) throw new Error("request-id requires a value");
  return options;
}
