#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { strip0x } from "./lib/hex.js";
import { scanEvmRequests, parseBlockNumber, toHex } from "./lib/scan.js";
import { getAbi, getProcessedEvmRequestIds, makeZeroApi } from "./lib/zero.js";
import { EvmRpc } from "./lib/rpc.js";
import { acquireStateLock, loadState, saveState } from "./lib/state.js";
import { buildEvmToZeroAction, parseArgs, readProofStatus } from "./lib/requests.js";

const configPath = process.argv[2];
const config = await loadConfig(configPath);
const options = parseArgs(process.argv.slice(3));
const zeroApiUrl = process.env.ZERO_API_URL || config.zero?.apiUrl;
const bridgeAccount = config.zero?.bridgeAccount;
if (!zeroApiUrl || !bridgeAccount) throw new Error("zero.apiUrl and zero.bridgeAccount are required");
const dryRun = options.dryRun || process.env.ZERO_RELAYER_DRY_RUN === "1";
const requestFilter = options.requestId || process.env.ZERO_REQUEST_ID;
const stateFile = process.env.ZERO_RELAYER_STATE_FILE || config.zero.stateFile || `${configPath}.state.json`;
const unlock = dryRun ? async () => {} : await acquireStateLock(stateFile);
try {
  await processRequests();
} finally {
  await unlock();
}

async function processRequests() {
  if (config.evm.scanFromBlock === "latest") throw new Error("scanFromBlock must be a fixed deployment block or earliest, not latest");
  const start = parseBlockNumber(config.evm.scanFromBlock ?? 0, 0n);
  const identity = `${config.evm.chainId}:${config.evm.escrowBridge.toLowerCase()}:${bridgeAccount}`;
  const state = await loadState(stateFile, identity, toHex(start));
  const overlap = BigInt(config.evm.scanOverlapBlocks ?? 120);
  if (overlap < 0n) throw new Error("scanOverlapBlocks must be non-negative");
  const resume = BigInt(state.nextBlock) - overlap;
  const scan = await scanEvmRequests(config, { fromBlock: toHex(resume > start ? resume : start) });
  const processed = await getProcessedEvmRequestIds(zeroApiUrl, bridgeAccount);
  for (const request of scan.requests) {
    const hash = strip0x(request.requestHash).toLowerCase();
    if (!processed.has(hash)) state.pending[hash] ??= request;
  }
  for (const hash of Object.keys(state.pending)) if (processed.has(hash)) delete state.pending[hash];
  if (BigInt(scan.toBlock) + 1n > BigInt(state.nextBlock)) state.nextBlock = toHex(BigInt(scan.toBlock) + 1n);
  // Commit discovery and pending work together BEFORE sending any transactions.
  if (!dryRun) await saveState(stateFile, state);
  const abi = await getAbi(zeroApiUrl, bridgeAccount);
  const actions = new Set(abi.actions.map(action => action.name));
  const action = config.zero.processorAction && config.zero.processorAction !== "auto" ? config.zero.processorAction : "proveetoz";
  if (!actions.has(action)) throw new Error(`${bridgeAccount} does not expose ${action}; development processing must be selected explicitly`);
  const authorization = {
    actor: process.env.ZERO_RELAYER_ACCOUNT || config.zero.authorization?.actor || config.zero.relayerAccount,
    permission: process.env.ZERO_RELAYER_PERMISSION || config.zero.authorization?.permission || config.zero.relayerPermission || "active"
  };
  if (!authorization.actor) throw new Error("Missing native relayer authorization actor");
  const keys = (process.env.ZERO_RELAYER_PRIVATE_KEYS || process.env.ZERO_RELAYER_PRIVATE_KEY || "").split(",").map(key => key.trim()).filter(Boolean);
  const pending = Object.entries(state.pending).filter(([,request]) => !requestFilter || request.requestId === String(requestFilter));
  if (!dryRun && pending.length && !keys.length) throw new Error("ZERO_RELAYER_PRIVATE_KEY is required to submit pending requests");
  const api = dryRun || !pending.length ? null : makeZeroApi(zeroApiUrl, keys).api;
  const rpc = new EvmRpc(config.evm.rpcUrl);
  const results = [];
  for (const [hash, request] of pending) {
    try {
      const proofStatus = await readProofStatus(rpc, config.evm.escrowBridge, request.requestHash);
      if (proofStatus === 3) {
        delete state.pending[hash];
        results.push({ requestId: request.requestId, status: "refunded" });
      } else {
        let name = action;
        let data;
        if (proofStatus === 2) {
          if (!actions.has("refundetoz")) throw new Error("Native bridge does not expose refundetoz");
          name = "refundetoz";
          data = { evm_request_number: request.requestId, evm_request_id: hash };
        } else if (proofStatus === 1) {
          data = buildEvmToZeroAction(config, request);
        } else {
          throw new Error(`Request proof unavailable (status ${proofStatus})`);
        }
        if (dryRun) results.push({ requestId: request.requestId, status: "dry_run", action: name, data });
        else {
          const result = await api.transact({ actions: [{ account: bridgeAccount, name, authorization: [authorization], data }] }, {
            blocksBehind: Number(process.env.ZERO_RELAYER_BLOCKS_BEHIND || 3),
            expireSeconds: Number(process.env.ZERO_RELAYER_EXPIRE_SECONDS || 120), broadcast: true, sign: true
          });
          if (result.processed?.receipt?.status !== "executed") throw new Error("Native transaction was not confirmed executed");
          delete state.pending[hash];
          results.push({ requestId: request.requestId, status: "processed", action: name, transactionId: result.transaction_id });
        }
      }
    } catch (error) {
      request.attempts = (request.attempts || 0) + 1;
      request.lastError = error.message;
      results.push({ requestId: request.requestId, status: "failed", error: error.message });
    }
    if (!dryRun) await saveState(stateFile, state);
  }
  const failed = results.filter(result => result.status === "failed").length;
  console.log(JSON.stringify({ status: failed ? "partial_failure" : dryRun ? "dry_run" : "processed", fromBlock: scan.fromBlock, toBlock: scan.toBlock,
    pending: Object.keys(state.pending).length, results }, null, 2));
  if (failed) process.exitCode = 1;
}
