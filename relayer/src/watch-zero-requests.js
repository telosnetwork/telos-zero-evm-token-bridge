#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const processorPath = fileURLToPath(new URL("./process-zero-requests.js", import.meta.url));
const configPath = process.argv[2] || "src/config.local.json";
const intervalMs = Number(
  process.env.ZERO_TO_EVM_RELAYER_POLL_MS ||
  process.env.ZERO_RELAYER_POLL_MS ||
  process.argv[3] ||
  10_000
);

if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
  throw new Error("poll interval must be at least 1000ms");
}

console.log(JSON.stringify({
  status: "watching",
  direction: "zero-to-evm",
  configPath,
  intervalMs
}));

while (true) {
  await runProcessorOnce();
  await delay(intervalMs);
}

function runProcessorOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [processorPath, configPath], {
      env: process.env,
      stdio: "inherit"
    });

    child.on("error", (error) => {
      console.error(JSON.stringify({
        status: "processor_spawn_failed",
        direction: "zero-to-evm",
        error: error.message
      }));
      resolve();
    });

    child.on("exit", (code, signal) => {
      if (code && code !== 0) {
        console.error(JSON.stringify({
          status: "processor_failed",
          direction: "zero-to-evm",
          code,
          signal
        }));
      }
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
