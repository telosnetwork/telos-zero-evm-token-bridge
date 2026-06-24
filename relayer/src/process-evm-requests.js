#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { strip0x } from "./lib/hex.js";
import { formatUnits } from "./lib/numbers.js";
import { scanEvmRequests } from "./lib/scan.js";
import { getAbi, getProcessedEvmRequestIds, makeZeroApi } from "./lib/zero.js";

const config = await loadConfig(process.argv[2]);
const options = parseArgs(process.argv.slice(3));
const zeroApiUrl = process.env.ZERO_API_URL || config.zero?.apiUrl;
const bridgeAccount = config.zero?.bridgeAccount;

if (!zeroApiUrl) throw new Error("config.zero.apiUrl or ZERO_API_URL is required");
if (!bridgeAccount) throw new Error("config.zero.bridgeAccount is required");

const scan = await scanEvmRequests(config);
const abi = await getAbi(zeroApiUrl, bridgeAccount);
const action = resolveProcessorAction(config, abi);
const authorization = resolveAuthorization(config, action);
const processed = await getProcessedEvmRequestIds(zeroApiUrl, bridgeAccount);
const requestFilter = options.requestId || process.env.ZERO_REQUEST_ID;
const privateKeys = parsePrivateKeys();
const dryRun = options.dryRun || process.env.ZERO_RELAYER_DRY_RUN === "1";

const candidates = scan.requests
  .filter((request) => !requestFilter || request.requestId === String(requestFilter))
  .filter((request) => !processed.has(strip0x(request.requestHash).toLowerCase()))
  .map((request) => buildActionData(config, request));

if (candidates.length === 0) {
  console.log(JSON.stringify({
    status: "nothing_to_process",
    action,
    fromBlock: scan.fromBlock,
    toBlock: scan.toBlock,
    scanned: scan.count,
    requestFilter: requestFilter || null
  }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify({
  status: dryRun ? "dry_run" : "ready",
  action,
  authorization,
  fromBlock: scan.fromBlock,
  toBlock: scan.toBlock,
  count: candidates.length,
  requests: candidates.map(({ request, data }) => ({
    requestId: request.requestId,
    pairId: request.pairId,
    zeroReceiver: request.zeroReceiver,
    quantity: data.quantity,
    requestHash: request.requestHash,
    transactionHash: request.transactionHash
  }))
}, null, 2));

if (dryRun) process.exit(0);

if (privateKeys.length === 0) {
  throw new Error(
    "ZERO_RELAYER_PRIVATE_KEY or ZERO_RELAYER_PRIVATE_KEYS is required to push Zero transactions. " +
    `Configured authorization is ${authorization.actor}@${authorization.permission}.`
  );
}

const { api } = makeZeroApi(zeroApiUrl, privateKeys);
const results = [];

for (const candidate of candidates) {
  const result = await api.transact({
    actions: [{
      account: bridgeAccount,
      name: action,
      authorization: [authorization],
      data: candidate.data
    }]
  }, {
    blocksBehind: Number(process.env.ZERO_RELAYER_BLOCKS_BEHIND || 3),
    expireSeconds: Number(process.env.ZERO_RELAYER_EXPIRE_SECONDS || 120),
    broadcast: true,
    sign: true
  });

  results.push({
    requestId: candidate.request.requestId,
    requestHash: candidate.request.requestHash,
    transactionId: result.transaction_id,
    processed: result.processed?.receipt?.status || "unknown"
  });
}

console.log(JSON.stringify({ status: "processed", action, results }, null, 2));

function buildActionData(config, request) {
  const pair = config.pairs.find((candidate) => String(candidate.pairId) === request.pairId);
  if (!pair) throw new Error(`No pair configured for request ${request.requestId} pair ${request.pairId}`);

  const zeroRaw = convertDecimals(BigInt(request.amount), pair.evmDecimals, pair.zeroDecimals);
  return {
    request,
    data: {
      pair_id: pair.pairId,
      evm_request_id: strip0x(request.requestHash).toLowerCase(),
      receiver: request.zeroReceiver,
      quantity: `${formatUnits(zeroRaw, pair.zeroDecimals)} ${pair.zeroSymbol}`,
      evm_sender: strip0x(request.sender).toLowerCase()
    }
  };
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

function resolveProcessorAction(config, abi) {
  if (config.zero?.processorAction && config.zero.processorAction !== "auto") {
    return config.zero.processorAction;
  }

  const actions = new Set((abi.actions || []).map((entry) => entry.name));
  if (actions.has("proveetoz")) return "proveetoz";
  if (actions.has("processetoz")) return "processetoz";
  throw new Error(`${bridgeAccount} ABI has neither proveetoz nor processetoz`);
}

function resolveAuthorization(config, action) {
  const actor =
    process.env.ZERO_RELAYER_ACCOUNT ||
    config.zero?.authorization?.actor ||
    config.zero?.relayerAccount ||
    (action === "processetoz" ? config.zero?.admin : undefined);
  const permission =
    process.env.ZERO_RELAYER_PERMISSION ||
    config.zero?.authorization?.permission ||
    config.zero?.relayerPermission ||
    "active";

  if (!actor) {
    throw new Error(`Missing Zero authorization actor for ${action}; set ZERO_RELAYER_ACCOUNT or config.zero.authorization.actor`);
  }
  return { actor, permission };
}

function parsePrivateKeys() {
  return (process.env.ZERO_RELAYER_PRIVATE_KEYS || process.env.ZERO_RELAYER_PRIVATE_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
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
