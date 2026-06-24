export function assertHexAddress(value, label = "address") {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value || "")) {
    throw new Error(`${label} must be a 20-byte 0x-prefixed EVM address`);
  }
}

export function strip0x(value) {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function encodeAddressArg(address) {
  assertHexAddress(address);
  return strip0x(address).toLowerCase().padStart(64, "0");
}

export function readUint256(hex) {
  const clean = strip0x(hex || "0x0");
  if (clean.length === 0) return 0n;
  return BigInt(`0x${clean.padStart(64, "0").slice(0, 64)}`);
}

export function topicToBigInt(topic) {
  return BigInt(topic || "0x0");
}

export function addressFromTopic(topic) {
  const clean = strip0x(topic);
  return `0x${clean.slice(-40)}`;
}

export function bytes32FromTopic(topic) {
  const clean = strip0x(topic);
  return `0x${clean.padStart(64, "0").slice(0, 64)}`;
}

export function readAbiString(data, byteOffset) {
  const clean = strip0x(data);
  const lengthWordStart = byteOffset * 2;
  const length = Number(BigInt(`0x${clean.slice(lengthWordStart, lengthWordStart + 64) || "0"}`));
  const valueStart = lengthWordStart + 64;
  const valueHex = clean.slice(valueStart, valueStart + length * 2);
  return Buffer.from(valueHex, "hex").toString("utf8");
}

export function toBlockTag(value) {
  if (value === undefined || value === null || value === "") return "latest";
  if (value === "latest" || value === "earliest" || value === "pending") return value;
  if (typeof value === "number") return `0x${value.toString(16)}`;
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (/^0x[0-9a-fA-F]+$/.test(value)) return value;
  if (/^[0-9]+$/.test(value)) return `0x${BigInt(value).toString(16)}`;
  throw new Error(`invalid block tag: ${value}`);
}
