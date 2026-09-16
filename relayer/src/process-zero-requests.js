#!/usr/bin/env node
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./lib/config.js";
import { buildZeroToEvmRelease, getZeroToEvmRequests } from "./lib/ztoe.js";
import { getAbi, makeZeroApi } from "./lib/zero.js";
import { parseArgs } from "./lib/requests.js";

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
const dryRun = options.dryRun || process.env.ZERO_TO_EVM_RELAYER_DRY_RUN === "1" || process.env.EVM_RELAYER_DRY_RUN === "1";
const requestFilter = options.requestId || process.env.ZERO_TO_EVM_REQUEST_ID;
if (!zeroApiUrl || !bridgeAccount || !evmRpcUrl || !escrowBridge) throw new Error("Native and EVM bridge endpoints/accounts are required");
const mode = process.env.ZERO_TO_EVM_RELAY_MODE || config.zero?.zeroToEvmRelayMode || "auto";
if (!["auto", "native", "evm-key"].includes(mode)) throw new Error(`Unknown relay mode ${mode}`);
const nativeMode = mode !== "evm-key";
if (nativeMode) {
  const abi = await getAbi(zeroApiUrl, bridgeAccount);
  if (!abi.actions.some(action => action.name === "relayztoe")) throw new Error("Native relayztoe is unavailable; legacy evm-key mode must be explicitly selected for old deployments");
}
const chain = { id: Number(config.evm.chainId), name: "Telos EVM", nativeCurrency: { name: "TLOS", symbol: "TLOS", decimals: 18 }, rpcUrls: { default: { http: [evmRpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(evmRpcUrl) });
if (await publicClient.getChainId() !== chain.id) throw new Error("EVM chain ID does not match config");
const rows = await getZeroToEvmRequests(zeroApiUrl, bridgeAccount);
const candidates = [];
const results = [];
for (const row of rows) {
  if (requestFilter && String(row.request_id) !== String(requestFilter)) continue;
  try {
    const release = buildZeroToEvmRelease(config, row);
    if (!release) continue;
    if (!await publicClient.readContract({ address: escrowBridge, abi: EVM_BRIDGE_ABI, functionName: "processedZeroBurns", args: [release.burnId] })) candidates.push(release);
  } catch (error) { results.push({ requestId: row.request_id, status: "failed", error: error.message }); }
}
let submit;
if (!dryRun && candidates.length) {
  if (nativeMode) {
    const authorization = {
      actor: process.env.ZERO_TO_EVM_RELAYER_ACCOUNT || config.zero.zeroToEvmAuthorization?.actor || process.env.ZERO_RELAYER_ACCOUNT || config.zero.authorization?.actor,
      permission: process.env.ZERO_TO_EVM_RELAYER_PERMISSION || config.zero.zeroToEvmAuthorization?.permission || process.env.ZERO_RELAYER_PERMISSION || config.zero.authorization?.permission || "active"
    };
    if (!authorization.actor) throw new Error("Missing native Zero-to-EVM relayer actor");
    const keys = (process.env.ZERO_TO_EVM_RELAYER_PRIVATE_KEYS || process.env.ZERO_TO_EVM_RELAYER_PRIVATE_KEY || process.env.ZERO_RELAYER_PRIVATE_KEYS || process.env.ZERO_RELAYER_PRIVATE_KEY || "").split(",").map(key => key.trim()).filter(Boolean);
    if (!keys.length) throw new Error("ZERO_TO_EVM_RELAYER_PRIVATE_KEY is required for native relay");
    const { api } = makeZeroApi(zeroApiUrl, keys);
    submit = async candidate => {
      const result = await api.transact({ actions: [{ account: bridgeAccount, name: "relayztoe", authorization: [authorization], data: { request_id: String(candidate.request.request_id) } }] }, { blocksBehind: 3, expireSeconds: 120, broadcast: true, sign: true });
      if (result.processed?.receipt?.status !== "executed") throw new Error("Native relay was not confirmed executed");
      return result.transaction_id;
    };
  } else {
    const value = process.env.EVM_RELAYER_PRIVATE_KEY || process.env.ZERO_BRIDGE_EVM_PRIVATE_KEY;
    if (!value) throw new Error("EVM_RELAYER_PRIVATE_KEY is required for explicit legacy mode");
    const account = privateKeyToAccount(value.startsWith("0x") ? value : `0x${value}`);
    const dispatcher = await publicClient.readContract({ address: escrowBridge, abi: EVM_BRIDGE_ABI, functionName: "zeroBridge" });
    if (account.address.toLowerCase() !== dispatcher.toLowerCase()) throw new Error("Legacy key does not match zeroBridge");
    const wallet = createWalletClient({ account, chain, transport: http(evmRpcUrl) });
    submit = async candidate => {
      const hash = await wallet.writeContract({ address: escrowBridge, abi: EVM_BRIDGE_ABI, functionName: "releaseToEvm", args: [BigInt(candidate.pair.pairId), candidate.amount, candidate.receiver, candidate.burnId, candidate.zeroSender] });
      if ((await publicClient.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("EVM release reverted");
      return hash;
    };
  }
}
for (const candidate of candidates) {
  try {
    results.push({ requestId: candidate.request.request_id, status: dryRun ? "dry_run" : "processed", mode: nativeMode ? "native" : "evm-key",
      ...(dryRun ? {} : { transactionId: await submit(candidate) }) });
  } catch (error) { results.push({ requestId: candidate.request.request_id, status: "failed", error: error.message }); }
}
const failed = results.some(result => result.status === "failed");
console.log(JSON.stringify({ status: failed ? "partial_failure" : dryRun ? "dry_run" : "processed", results }, null, 2));
if (failed) process.exitCode = 1;
