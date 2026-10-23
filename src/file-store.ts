// Single-process durable store for fictional demo data. No cloud services involved.
import { constants } from "node:fs";
import { FileHandle, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import {
  HouseholdState, HouseholdStore, MemoryStore, PantryItem, GroceryLine, Chore,
  MealPlanEntry, EnsureGroceriesResult, RestockResult, GROCERY_LINE_LIMIT,
  NAME_LIMIT, UNIT_LIMIT, groceryKey, normalizedQuantity,
  normalizedText, norm, validatedRecipeIngredients,
} from "./store.js";

export const FILE_STATE_VERSION = 1;
export const MAX_STATE_FILE_BYTES = 512 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const pathKey = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    throw new Error("Invalid household snapshot structure");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid snapshot ${label}`);
  normalizedText(value, label, max);
  return value;
}
function number(value: unknown, label: string, zeroAllowed = false): number {
  if (typeof value !== "number") throw new Error(`Invalid snapshot ${label}`);
  if (zeroAllowed && value === 0) return 0;
  return normalizedQuantity(value);
}
function array<T>(value: unknown, max: number, item: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Household snapshot array exceeds its limit");
  return value.map(item);
}
function unique<T>(values: T[], key: (value: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) throw new Error("Duplicate household snapshot entries");
  return values;
}

/** Validate persisted input instead of trusting a type assertion or resetting corrupt data. */
function validateState(value: unknown): HouseholdState {
  const state = record(value, ["pantryItems", "groceryLines", "meal", "choreList"]);
  const pantryItems = unique(array<PantryItem>(state.pantryItems, 200, value => {
    const item = record(value, ["name", "quantity", "unit", "lowAt"]);
    return { name: text(item.name, NAME_LIMIT, "pantry name"), unit: text(item.unit, UNIT_LIMIT, "pantry unit"), quantity: number(item.quantity, "pantry quantity", true), lowAt: number(item.lowAt, "low stock threshold", true) };
  }), groceryKey);
  const groceryLines = unique(array<GroceryLine>(state.groceryLines, GROCERY_LINE_LIMIT, value => {
    const item = record(value, ["name", "quantity", "unit", "addedBy"]);
    return { name: text(item.name, NAME_LIMIT, "grocery name"), unit: text(item.unit, UNIT_LIMIT, "grocery unit"), quantity: number(item.quantity, "grocery quantity"), addedBy: text(item.addedBy, NAME_LIMIT, "grocery author") };
  }), groceryKey);
  const meal = array<MealPlanEntry>(state.meal, 7, value => {
    const hasIngredients = !!value && typeof value === "object" && Object.hasOwn(value, "ingredients");
    const item = record(value, ["day", "meal", "servings", "missingIngredients", ...(hasIngredients ? ["ingredients"] : [])]);
    if (!Number.isInteger(item.servings) || (item.servings as number) < 1 || (item.servings as number) > 1000) throw new Error("Invalid snapshot servings");
    return { day: text(item.day, UNIT_LIMIT, "meal day"), meal: text(item.meal, 160, "meal name"), servings: item.servings as number, missingIngredients: array(item.missingIngredients, 200, value => text(value, NAME_LIMIT, "ingredient")), ...(hasIngredients ? { ingredients: validatedRecipeIngredients(item.ingredients) } : {}) };
  });
  const choreList = unique(array<Chore>(state.choreList, 200, value => {
    const item = record(value, ["name", "assignee", "dueInDays", "done"]);
    if (typeof item.done !== "boolean" || !Number.isInteger(item.dueInDays) || Math.abs(item.dueInDays as number) > 36500) throw new Error("Invalid snapshot chore status");
    return { name: text(item.name, NAME_LIMIT, "chore name"), assignee: text(item.assignee, NAME_LIMIT, "chore assignee"), dueInDays: item.dueInDays as number, done: item.done };
  }), value => norm(value.name));
  return { pantryItems, groceryLines, meal, choreList };
}

// Check every ancestor, including Windows junctions. O_NOFOLLOW additionally
// protects the final component on platforms that implement that flag.
async function safeDirectory(directory: string, create: boolean): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  for (const component of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || !isMissing(error)) throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Household state path must not traverse links or non-directories");
  }
  if (pathKey(await realpath(directory)) !== pathKey(resolve(directory))) throw new Error("Household state directory must be a canonical path without links");
}
async function regularInfo(path: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error("Household state files must be regular files without links");
  return info;
}
async function readBounded(path: string, limit: number): Promise<Buffer> {
  await safeDirectory(dirname(path), false);
  const before = await regularInfo(path);
  if (before.size > limit) throw new Error("Household state file exceeds its byte limit");
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isFile() || held.nlink !== 1 || held.ino !== before.ino || held.dev !== before.dev) throw new Error("Household state file changed while opening");
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) throw new Error("Household state file exceeds its byte limit");
    const after = await regularInfo(path);
    if (after.ino !== held.ino || after.dev !== held.dev || after.size !== used) throw new Error("Household state file changed while reading");
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}
function decode(bytes: Buffer): HouseholdState {
  const document = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), ["version", "syntheticDemo", "state"]);
  if (document.version !== FILE_STATE_VERSION || document.syntheticDemo !== true) throw new Error("Unsupported household snapshot version or demo type");
  return validateState(document.state);
}
function encode(candidate: HouseholdState): Buffer {
  const bytes = Buffer.from(JSON.stringify({ version: FILE_STATE_VERSION, syntheticDemo: true, state: validateState(candidate) }) + "\n", "utf8");
  if (bytes.length > MAX_STATE_FILE_BYTES) throw new Error("Household state file exceeds its byte limit");
  return bytes;
}

/**
 * One writer process per state path. A .lock file is acquired with O_EXCL and
 * never broken automatically, even after a crash. This deliberately rejects a
 * second instance rather than pretending a process-local queue is a file lock.
 * Put demo state in a private local directory; Node does not provide portable
 * directory-handle-relative operations to defend against a hostile OS user
 * replacing ancestors between checks. This is not public household storage.
 */
export class FileStore implements HouseholdStore {
  private readonly memory: MemoryStore;
  private active = new Set<Promise<unknown>>();
  private closing = false;
  private closePromise?: Promise<void>;
  private constructor(
    private readonly path: string,
    private readonly lock: FileHandle,
    private readonly lockToken: Buffer,
    initialState: HouseholdState,
    private diskBytes: Buffer | undefined,
  ) {
    this.memory = new MemoryStore({ initialState, beforePublish: candidate => this.writeSnapshot(candidate) });
  }
  static async open(statePath: string, initialState?: HouseholdState): Promise<FileStore> {
    if (typeof statePath !== "string" || !statePath.trim() || statePath.length > 1024) throw new Error("A bounded household state path is required");
    // Detach before the first await. A seed is used only for a missing snapshot;
    // existing bytes always win and are never replaced by a new fixture.
    const seed = initialState === undefined ? undefined : structuredClone(initialState);
    const path = resolve(statePath);
    const name = basename(path);
    if (!name || name === "." || name === ".." || /[\x00-\x1f:]/.test(name) || /[. ]$/.test(name)) throw new Error("Invalid household state filename");
    await safeDirectory(dirname(path), true);
    const lockPath = `${path}.lock`;
    let lock: FileHandle;
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Household state is already open or has a stale lock; close the owning process before manually recovering its lock");
      throw error;
    }
    const token = Buffer.from(`${process.pid}:${randomBytes(24).toString("hex")}\n`);
    let store: FileStore | undefined;
    try {
      await lock.writeFile(token);
      await lock.sync();
      let bytes: Buffer | undefined;
      try { bytes = await readBounded(path, MAX_STATE_FILE_BYTES); }
      catch (error) { if (!isMissing(error)) throw error; }
      const state = bytes ? decode(bytes) : seed === undefined ? new MemoryStore().snapshot() : validateState(seed);
      store = new FileStore(path, lock, token, state, bytes);
      if (!bytes) await store.writeSnapshot(state);
      return store;
    } catch (error) {
      try {
        if ((await readBounded(lockPath, 512)).equals(token)) await unlink(lockPath);
      } catch { /* Keep an unrecognized lock; never remove another owner's file. */ }
      await lock.close();
      throw error;
    }
  }
  private async verifyLock(): Promise<void> {
    const held = await this.lock.stat();
    const current = await regularInfo(`${this.path}.lock`);
    if (held.ino !== current.ino || held.dev !== current.dev
        || !(await readBounded(`${this.path}.lock`, 512)).equals(this.lockToken)) throw new Error("Household state writer lock was lost");
  }
  private async writeSnapshot(candidate: HouseholdState): Promise<void> {
    const bytes = encode(candidate);
    await safeDirectory(dirname(this.path), false);
    await this.verifyLock();
    let current: Buffer | undefined;
    try { current = await readBounded(this.path, MAX_STATE_FILE_BYTES); }
    catch (error) { if (!isMissing(error)) throw error; }
    if (Boolean(current) !== Boolean(this.diskBytes) || (current && !current.equals(this.diskBytes!))) throw new Error("Household state changed outside its owning store; refusing to overwrite it");
    const temporary = `${this.path}.${randomBytes(16).toString("hex")}.tmp`;
    let renamed = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      await safeDirectory(dirname(this.path), false);
      await this.verifyLock();
      try { await regularInfo(this.path); }
      catch (error) { if (!isMissing(error)) throw error; }
      // Atomic replacement is the commit point. Do not throw after it succeeds:
      // MemoryStore must publish exactly the state now committed to disk.
      await rename(temporary, this.path);
      renamed = true;
      this.diskBytes = bytes;
    } finally {
      if (!renamed) await unlink(temporary).catch(() => {});
    }
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Household file store is closed"));
    const task = operation();
    this.active.add(task);
    task.then(() => this.active.delete(task), () => this.active.delete(task));
    return task;
  }
  pantry(): Promise<PantryItem[]> { return this.run(() => this.memory.pantry()); }
  groceries(): Promise<GroceryLine[]> { return this.run(() => this.memory.groceries()); }
  mealPlan(): Promise<MealPlanEntry[]> { return this.run(() => this.memory.mealPlan()); }
  chores(): Promise<Chore[]> { return this.run(() => this.memory.chores()); }
  addGrocery(line: GroceryLine): Promise<GroceryLine[]> { return this.run(() => this.memory.addGrocery(line)); }
  ensureGroceries(lines: GroceryLine[]): Promise<EnsureGroceriesResult> { return this.run(() => this.memory.ensureGroceries(lines)); }
  restockForMeals(days: number, dryRun: boolean, expectedToken?: string): Promise<RestockResult> { return this.run(() => this.memory.restockForMeals(days, dryRun, expectedToken)); }
  logChore(name: string): Promise<Chore | null> { return this.run(() => this.memory.logChore(name)); }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    return this.closePromise = (async () => {
      await Promise.allSettled([...this.active]);
      try { await this.verifyLock(); await unlink(`${this.path}.lock`); }
      finally { await this.lock.close(); }
    })();
  }
}
