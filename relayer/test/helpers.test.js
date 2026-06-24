import assert from "node:assert/strict";
import test from "node:test";
import { decodeEvmToZeroRequested, TOPICS } from "../src/lib/events.js";
import { formatUnits, parseAntelopeAsset } from "../src/lib/numbers.js";
import { buildZeroToEvmRelease, normalizeBurnId } from "../src/lib/ztoe.js";

test("parses Antelope asset strings", () => {
  assert.deepEqual(parseAntelopeAsset("123.456789 ZUSDC"), {
    raw: 123456789n,
    decimals: 6,
    symbol: "ZUSDC",
    display: "123.456789 ZUSDC"
  });
});

test("formats signed token units", () => {
  assert.equal(formatUnits(123456789n, 6), "123.456789");
  assert.equal(formatUnits(-5000000n, 6), "-5.000000");
});

test("decodes EvmToZeroRequested logs", () => {
  const requestHash = `0x${"ab".repeat(32)}`;
  const log = {
    topics: [
      TOPICS.evmToZeroRequested,
      word(1n),
      word(2n),
      `0x${"0".repeat(24)}1234567890abcdef1234567890abcdef12345678`
    ],
    data: [
      "0x",
      strip(word(96n)),
      strip(word(1000000n)),
      strip(requestHash),
      strip(word(5n)),
      Buffer.from("alice").toString("hex").padEnd(64, "0")
    ].join(""),
    blockNumber: "0xa",
    transactionHash: `0x${"cd".repeat(32)}`,
    logIndex: "0x0"
  };

  assert.deepEqual(decodeEvmToZeroRequested(log), {
    requestId: "1",
    pairId: "2",
    sender: "0x1234567890abcdef1234567890abcdef12345678",
    zeroReceiver: "alice",
    amount: "1000000",
    requestHash,
    blockNumber: 10,
    transactionHash: log.transactionHash,
    logIndex: 0
  });
});

test("builds Zero-to-EVM release data from ztoereqs rows", () => {
  const config = {
    pairs: [{
      pairId: 1,
      evmSymbol: "USDC.e",
      evmToken: "0x1234567890abcdef1234567890abcdef12345678",
      evmDecimals: 6,
      zeroContract: "zusdcbridge1",
      zeroSymbol: "ZUSDC",
      zeroDecimals: 6
    }]
  };
  const release = buildZeroToEvmRelease(config, {
    request_id: 7,
    burn_id: "ab".repeat(32),
    pair_id: 1,
    sender: "alice",
    quantity: "1.250000 ZUSDC",
    evm_receiver: "0x1234567890abcdef1234567890abcdef12345678",
    refunded: 0
  });

  assert.equal(release.amount, 1250000n);
  assert.equal(release.burnId, `0x${"ab".repeat(32)}`);
  assert.equal(release.receiver, "0x1234567890abcdef1234567890abcdef12345678");
  assert.equal(release.zeroSender, "alice");
});

test("normalizes burn ids", () => {
  assert.equal(normalizeBurnId(`0x${"cd".repeat(32)}`), `0x${"cd".repeat(32)}`);
  assert.throws(() => normalizeBurnId("nope"), /invalid Zero burn id/);
});

function word(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function strip(value) {
  return value.slice(2);
}
