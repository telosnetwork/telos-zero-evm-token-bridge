import { parseAntelopeAsset } from "./numbers.js";

export async function getCurrencySupply(apiUrl, tokenContract, symbolCode) {
  if (!apiUrl || !tokenContract || !symbolCode) return null;

  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/chain/get_currency_stats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: tokenContract, symbol: symbolCode })
  });

  if (!response.ok) {
    throw new Error(`Zero RPC get_currency_stats failed: ${response.status} ${response.statusText}`);
  }

  const stats = await response.json();
  const row = stats[symbolCode];
  if (!row || !row.supply) return null;

  return parseAntelopeAsset(row.supply);
}
