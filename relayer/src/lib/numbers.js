export function parseAntelopeAsset(value) {
  const match = /^([0-9]+)(?:\.([0-9]+))? ([A-Z0-9]{1,7})$/.exec(value);
  if (!match) throw new Error(`invalid Antelope asset string: ${value}`);

  const whole = match[1];
  const fractional = match[2] || "";
  return {
    raw: BigInt(`${whole}${fractional}`),
    decimals: fractional.length,
    symbol: match[3],
    display: value
  };
}

export function formatUnits(value, decimals) {
  const raw = BigInt(value);
  const sign = raw < 0n ? "-" : "";
  const magnitude = raw < 0n ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = magnitude / scale;
  const fractional = magnitude % scale;
  if (decimals === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${fractional.toString().padStart(decimals, "0")}`;
}
