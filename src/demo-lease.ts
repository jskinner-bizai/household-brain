import { mkdir, open, lstat, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { PlannerProgress } from "./planner.js";

/** A consumed attempt stays consumed after errors, lost responses, and restarts. */
export async function reserveDemoRun(path: string): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(JSON.stringify({
      version: 1, status: "attempt-reserved", startedAt: new Date().toISOString(),
      modelId: "amazon.nova-lite-v1:0", region: "us-east-2",
      maximumModelRequests: 6, maximumOutputTokensPerRequest: 1024,
      maximumGrossUsd: 1, syntheticDataOnly: true,
    }) + "\n", "utf8");
    await handle.sync();
  } catch {
    // Never delete an uncertain reservation or automatically try another file.
    throw new Error("The approved demo attempt is already reserved, or its receipt cannot be saved. No automatic retry is allowed. Review the local receipt before requesting a new attempt.");
  } finally { await handle?.close(); }
}

/** Safe usage evidence only. A failed journal update stops the model loop. */
export function createDemoJournal(receiptPath: string, beforeWrite?: () => Promise<void>): (progress: PlannerProgress) => Promise<void> {
  const target = `${resolve(receiptPath)}.progress.json`;
  let expected: Buffer | undefined;
  let queue: Promise<void> = Promise.resolve();
  const write = async (bytes: Buffer) => {
    await beforeWrite?.();
    let current: Buffer | undefined;
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192) throw new Error("Invalid demo progress file.");
      current = await readFile(target);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (Boolean(current) !== Boolean(expected) || (current && !current.equals(expected!))) throw new Error("Demo progress changed outside this run.");
    const temporary = `${target}.${randomBytes(12).toString("hex")}.tmp`;
    let renamed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      renamed = true; expected = bytes;
    } finally { if (!renamed) await unlink(temporary).catch(() => {}); }
  };
  return progress => {
    // Capture now, then serialize validation and replacement. Cancellation may
    // race a pending fs operation, but can never publish an older journal last.
    const bytes = Buffer.from(JSON.stringify(progress) + "\n", "utf8");
    if (bytes.length > 8192) return Promise.reject(new Error("Demo progress exceeds its bound."));
    const task = queue.then(() => write(bytes));
    queue = task.catch(() => {});
    return task;
  };
}
