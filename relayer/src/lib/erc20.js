import { encodeAddressArg, readUint256 } from "./hex.js";

const SELECTORS = {
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd"
};

export async function readErc20Balance(rpc, token, account) {
  const data = SELECTORS.balanceOf + encodeAddressArg(account);
  return readUint256(await rpc.ethCall(token, data));
}

export async function readErc20Decimals(rpc, token) {
  return Number(readUint256(await rpc.ethCall(token, SELECTORS.decimals)));
}

export async function readErc20TotalSupply(rpc, token) {
  return readUint256(await rpc.ethCall(token, SELECTORS.totalSupply));
}
