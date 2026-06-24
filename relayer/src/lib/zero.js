import { Api, JsonRpc } from "eosjs";
import { JsSignatureProvider } from "eosjs/dist/eosjs-jssig.js";
import { TextDecoder, TextEncoder } from "node:util";

export function makeZeroApi(apiUrl, privateKeys) {
  const rpc = new JsonRpc(apiUrl, { fetch });
  const signatureProvider = new JsSignatureProvider(privateKeys);
  const api = new Api({
    rpc,
    signatureProvider,
    textDecoder: new TextDecoder(),
    textEncoder: new TextEncoder()
  });
  return { api, rpc };
}

export async function getAbi(apiUrl, account) {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/chain/get_abi`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_name: account })
  });
  if (!response.ok) {
    throw new Error(`Zero RPC get_abi failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  if (!payload.abi) {
    throw new Error(`Zero RPC get_abi did not return an ABI for ${account}`);
  }
  return payload.abi;
}

export async function getTableRows(apiUrl, request) {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/chain/get_table_rows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: true, ...request })
  });
  if (!response.ok) {
    throw new Error(`Zero RPC get_table_rows failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`Zero RPC get_table_rows error: ${payload.error.message || JSON.stringify(payload.error)}`);
  }
  return payload;
}

export async function getProcessedEvmRequestIds(apiUrl, bridgeAccount) {
  const rows = [];
  let lowerBound;

  do {
    const payload = await getTableRows(apiUrl, {
      code: bridgeAccount,
      scope: bridgeAccount,
      table: "etozreqs",
      limit: 1000,
      lower_bound: lowerBound
    });
    rows.push(...(payload.rows || []));
    lowerBound = payload.more ? payload.next_key : undefined;
  } while (lowerBound);

  return new Set(rows.map((row) => String(row.evm_request_id).toLowerCase()));
}
