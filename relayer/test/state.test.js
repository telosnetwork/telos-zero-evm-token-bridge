import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireStateLock, loadState, saveState } from "../src/lib/state.js";
import { parseBlockNumber } from "../src/lib/scan.js";

test("durable state excludes concurrent writers and rejects reuse for another bridge", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-state-"));
  const file = path.join(dir, "worker.json");
  try {
    const unlock = await acquireStateLock(file);
    try {
      await assert.rejects(acquireStateLock(file), /state is locked/);
      const state = await loadState(file, "bridge-a", "0x0");
      state.nextBlock = "0xb";
      state.pending.request = { requestId: "1", attempts: 2 };
      await saveState(file, state);
      assert.deepEqual(await loadState(file, "bridge-a", "0x0"), state);
      await assert.rejects(loadState(file, "bridge-b", "0x0"), /different bridge/);
    } finally { await unlock(); }
    const unlockAgain = await acquireStateLock(file);
    await unlockAgain();
    await fs.writeFile(file, "{truncated");
    await assert.rejects(loadState(file, "bridge-a", "0x0"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("scan boundaries never silently round unsafe numeric input", () => {
  assert.throws(() => parseBlockNumber(Number.MAX_SAFE_INTEGER + 1, 0n), /invalid block/);
  assert.throws(() => parseBlockNumber(-1n, 0n), /invalid block/);
  assert.equal(parseBlockNumber("9007199254740993", 0n), 9007199254740993n);
});
