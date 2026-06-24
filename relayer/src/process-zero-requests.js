#!/usr/bin/env node
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./lib/config.js";
import { buildZeroToEvmRelease, getZeroToEvmRequests } from "./lib/ztoe.js";

const EVM_BRIDGE_ABI = parseAbi([
  "function zeroBridge() view returns (address)",
  "function processedZeroBurns(bytes32) view returns (bool)",
  "function releaseToEvm(uint256 pairId,uint256 amount,address receiver,bytes32 zeroBurnId,string zeroSender)"
]);

const config = await loadConfig(process.argv[2]);
const options = parseArgs(process.argv.slice(3));
const zeroApiUrl = process.env.ZERO_API_URL || config.zero?.apiUrl;
const bridgeAccount = config.zero?.bridgeAccount;
const evmRpcUrl = process.env.EVM_RPC_URL || config.evm?.rpcUrl;
const escrowBridge = process.env.EVM_ESCROW_BRIDGE || config.evm?.escrowBridge;
const dryRun = options.dryRun || process.env.EVM_RELAYER_DRY_RUN === "1";
const requestFilter = options.requestId || process.env.ZERO_TO_EVM_REQUEST_ID;

if (!zeroApiUrl) throw new Error("config.zero.apiUrl or ZERO_API_URL is required");
if (!bridgeAccount) throw new Error("config.zero.bridgeAccount is required");
if (!evmRpcUrl) throw new Error("config.evm.rpcUrl or EVM_RPC_URL is required");
if (!escrowBridge) throw new Error("config.evm.escrowBridge or EVM_ESCROW_BRIDGE is required");

const chain = {
  id: Number(config.evm?.chainId || process.env.EVM_CHAIN_ID || 41),
  name: config.evm?.name || "Telos EVM",
  nativeCurrency: { name: "TLOS", symbol: "TLOS", decimals: 18 },
  rpcUrls: { default: { http: [evmRpcUrl] } }
};

const publicClient = createPublicClient({ chain, transport: http(evmRpcUrl) });
const rows = await getZeroToEvmRequests(zeroApiUrl, bridgeAccount);
const candidates = [];

for (const row of rows) {
  if (requestFilter && String(row.request_id) !== String(requestFilter)) continue;
  const release = buildZeroToEvmRelease(config, row);
  if (!release) continue;
  const processed = await publicClient.readContract({
    address: escrowBridge,
    abi: EVM_BRIDGE_ABI,
    functionName: "processedZeroBurns",
    args: [release.burnId]
  });
  if (!processed) candidates.push(release);
}

console.log(JSON.stringify({
  status: dryRun ? "dry_run" : candidates.length ? "ready" : "nothing_to_process",
  bridgeAccount,
  escrowBridge,
  count: candidates.length,
  requests: candidates.map((candidate) => ({
    requestId: candidate.request.request_id,
    pairId: candidate.pair.pairId,
    zeroSender: candidate.zeroSender,
    receiver: candidate.receiver,
    amount: candidate.amount.toString(),
    quantity: candidate.request.quantity,
    burnId: candidate.burnId
  }))
}, null, 2));

if (dryRun || candidates.length === 0) process.exit(0);

const privateKey = normalizePrivateKey(
  process.env.EVM_RELAYER_PRIVATE_KEY ||
  process.env.ZERO_BRIDGE_EVM_PRIVATE_KEY ||
  config.evm?.releasePrivateKey
);
if (!privateKey) {
  throw new Error("EVM_RELAYER_PRIVATE_KEY or ZERO_BRIDGE_EVM_PRIVATE_KEY is required to release Zero-to-EVM requests");
}

const account = privateKeyToAccount(privateKey);
const expectedDispatcher = await publicClient.readContract({
  address: escrowBridge,
  abi: EVM_BRIDGE_ABI,
  functionName: "zeroBridge",
});

if (account.address.toLowerCase() !== expectedDispatcher.toLowerCase()) {
  throw new Error(`EVM relayer key resolves to ${account.address}, but bridge requires zeroBridge ${expectedDispatcher}`);
}

const walletClient = createWalletClient({ account, chain, transport: http(evmRpcUrl) });
const results = [];

for (const candidate of candidates) {
  const hash = await walletClient.writeContract({
    address: escrowBridge,
    abi: EVM_BRIDGE_ABI,
    functionName: "releaseToEvm",
    args: [
      BigInt(candidate.pair.pairId),
      candidate.amount,
      candidate.receiver,
      candidate.burnId,
      candidate.zeroSender
    ]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  results.push({
    requestId: candidate.request.request_id,
    burnId: candidate.burnId,
    transactionHash: hash,
    status: receipt.status
  });
}

console.log(JSON.stringify({ status: "processed", results }, null, 2));

function normalizePrivateKey(value) {
  if (!value) return undefined;
  const clean = String(value).trim();
  if (!clean) return undefined;
  return clean.startsWith("0x") ? clean : `0x${clean}`;
}

function parseArgs(args) {
  const parsed = { dryRun: false, requestId: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--request-id") parsed.requestId = args[++index];
    else if (arg.startsWith("--request-id=")) parsed.requestId = arg.slice("--request-id=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
