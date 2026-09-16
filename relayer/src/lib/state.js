import fs from "node:fs/promises";
import path from "node:path";

export async function acquireStateLock(filename) {
  await fs.mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  const lock = `${filename}.lock`;
  let handle;
  try {
    handle = await fs.open(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Relayer state is locked: ${lock}; stop the previous worker before removing a stale lock`);
    throw error;
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => { await handle.close(); await fs.unlink(lock); };
}

export async function loadState(filename, identity, startBlock) {
  let state;
  try { state = JSON.parse(await fs.readFile(filename, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, identity, nextBlock: startBlock, pending: {} };
  }
  if (state.version !== 1 || state.identity !== identity || !state.pending || typeof state.pending !== "object" ||
      Array.isArray(state.pending) || !/^0x[0-9a-f]+$/i.test(state.nextBlock || "")) {
    throw new Error("Invalid relayer state or state belongs to a different bridge; use a separate stateFile");
  }
  return state;
}

export async function saveState(filename, state) {
  const absolute = path.resolve(filename);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, absolute);
}
