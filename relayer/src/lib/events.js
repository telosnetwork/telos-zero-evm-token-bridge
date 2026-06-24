import { addressFromTopic, bytes32FromTopic, readAbiString, readUint256, topicToBigInt } from "./hex.js";

export const TOPICS = {
  evmToZeroRequested: "0xb4dcb091617ca075bed6d6570082906aca5caac3547bae851fc3a6e4cca0bccd",
  zeroToEvmReleased: "0x0f062678ddf4763c7d672a449767362adc7881badca8494e2d051eda1dd2acc2"
};

export function decodeEvmToZeroRequested(log) {
  if (log.topics?.[0]?.toLowerCase() !== TOPICS.evmToZeroRequested) {
    throw new Error("log is not EvmToZeroRequested");
  }
  if (log.topics.length !== 4) throw new Error("EvmToZeroRequested must have 4 topics");

  const data = log.data || "0x";
  return {
    requestId: topicToBigInt(log.topics[1]).toString(),
    pairId: topicToBigInt(log.topics[2]).toString(),
    sender: addressFromTopic(log.topics[3]),
    zeroReceiver: readAbiString(data, Number(readUint256(wordAt(data, 0)))),
    amount: readUint256(wordAt(data, 1)).toString(),
    requestHash: bytes32FromTopic(wordAt(data, 2)),
    blockNumber: Number(topicToBigInt(log.blockNumber)),
    transactionHash: log.transactionHash,
    logIndex: Number(topicToBigInt(log.logIndex))
  };
}

function wordAt(data, wordIndex) {
  const clean = data.startsWith("0x") ? data.slice(2) : data;
  return `0x${clean.slice(wordIndex * 64, wordIndex * 64 + 64)}`;
}
