import { assertHexAddress } from "./hex.js";
import { parseAntelopeAsset } from "./numbers.js";
import { getTableRows } from "./zero.js";

export async function getZeroToEvmRequests(apiUrl, bridgeAccount) {
  const rows = [];
  let lowerBound;

  do {
    const payload = await getTableRows(apiUrl, {
      code: bridgeAccount,
      scope: bridgeAccount,
      table: "ztoereqs",
      limit: 1000,
      lower_bound: lowerBound
    });
    rows.push(...(payload.rows || []));
    lowerBound = payload.more ? payload.next_key : undefined;
  } while (lowerBound);

  return rows;
}

export function buildZeroToEvmRelease(config, request) {
  if (request.refunded === true || request.refunded === 1) return null;

  const pair = config.pairs.find((candidate) => String(candidate.pairId) === String(request.pair_id));
  if (!pair) throw new Error(`No pair configured for Zero request ${request.request_id} pair ${request.pair_id}`);

  const quantity = parseAntelopeAsset(request.quantity);
  if (quantity.symbol !== pair.zeroSymbol) {
    throw new Error(`Zero request ${request.request_id} symbol ${quantity.symbol} does not match pair ${pair.zeroSymbol}`);
  }
  if (quantity.decimals !== pair.zeroDecimals) {
    throw new Error(`Zero request ${request.request_id} decimals ${quantity.decimals} do not match pair ${pair.zeroDecimals}`);
  }

  assertHexAddress(request.evm_receiver, `Zero request ${request.request_id} EVM receiver`);

  const amount = convertDecimals(quantity.raw, pair.zeroDecimals, pair.evmDecimals);
  return {
    request,
    pair,
    burnId: normalizeBurnId(request.burn_id),
    amount,
    receiver: request.evm_receiver,
    zeroSender: request.sender
  };
}

export function normalizeBurnId(value) {
  const clean = String(value || "").replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`invalid Zero burn id: ${value}`);
  }
  return `0x${clean}`;
}

export function convertDecimals(raw, fromDecimals, toDecimals) {
  if (fromDecimals === toDecimals) return raw;
  if (fromDecimals < toDecimals) return raw * 10n ** BigInt(toDecimals - fromDecimals);
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  if (raw % divisor !== 0n) {
    throw new Error(`amount ${raw} cannot be converted from ${fromDecimals} to ${toDecimals} decimals without rounding`);
  }
  return raw / divisor;
}
