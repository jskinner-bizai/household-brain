import { test, TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rename, rm, rmdir, symlink, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { FileStore, MAX_STATE_FILE_BYTES } from "../file-store.js";
import { MemoryStore } from "../store.js";

const testStores = new WeakMap<TestContext, FileStore[]>();

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "household-file-store-"));
  t.after(async () => {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Refusing cleanup outside the test temporary root");
    // Node runs after hooks in registration order; release locks before cleanup.
    for (const store of testStores.get(t) ?? []) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, path: join(directory, "household.json") };
}
async function useStore(t: TestContext, path: string) {
  const store = await FileStore.open(path);
  const stores = testStores.get(t) ?? [];
  stores.push(store);
  testStores.set(t, stores);
  return store;
}

test("file store persists the complete synthetic household and invalidates old preview tokens after restart", async t => {
  const { path } = await temporary(t);
  const first = await useStore(t, path);
  await first.addGrocery({ name: "apples", unit: "each", quantity: 2, addedBy: "test" });
  await first.logChore("recycling");
  const oldPreview = await first.restockForMeals(2, true);
  const expected = { pantry: await first.pantry(), groceries: await first.groceries(), meals: await first.mealPlan(), chores: await first.chores() };
  await first.close();
  const second = await useStore(t, path);
  assert.deepEqual({ pantry: await second.pantry(), groceries: await second.groceries(), meals: await second.mealPlan(), chores: await second.chores() }, expected);
  const stale = await second.restockForMeals(2, false, oldPreview.previewToken);
  assert.equal(stale.previewChanged, true);
  assert.equal(stale.writeApplied, false);
  assert.deepEqual(await second.groceries(), expected.groceries);
  const committed = await second.restockForMeals(2, false, stale.previewToken);
  assert.equal(committed.writeApplied, true);
  const repeatedPreview = await second.restockForMeals(2, true);
  const repeated = await second.restockForMeals(2, false, repeatedPreview.previewToken);
  assert.equal(repeated.writeApplied, false);
  assert.deepEqual(repeated.added, []);
});

test("a second store instance is refused until the owning instance closes", async t => {
  const { path } = await temporary(t);
  const first = await useStore(t, path);
  try { await assert.rejects(FileStore.open(path), /already open|stale lock/); }
  finally { await first.close(); }
  const second = await useStore(t, path);
  assert.equal((await second.groceries()).length, 1);
});

test("concurrent restock confirmations and conditional additions never duplicate quantities", async t => {
  const { path } = await temporary(t);
  const store = await useStore(t, path);
  const preview = await store.restockForMeals(2, true);
  const results = await Promise.all(Array.from({ length: 20 }, () => store.restockForMeals(2, false, preview.previewToken)));
  assert.equal(results.filter(value => value.writeApplied).length, 1);
  assert.equal(results.filter(value => value.previewChanged).length, 19);
  await Promise.all(Array.from({ length: 20 }, () => store.ensureGroceries([{ name: "apples", unit: "each", quantity: 1, addedBy: "test" }])));
  assert.equal((await store.groceries()).find(value => value.name === "apples")?.quantity, 1);
  const disk = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(disk.state.groceryLines, await store.groceries());
});

test("a failed durable write leaves MemoryStore readers and preview decisions unchanged", async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const store = new MemoryStore({ beforePublish: async () => { entered(); await blocked; throw new Error("simulated disk failure"); } });
  const before = store.snapshot();
  const preview = await store.restockForMeals(1, true);
  const write = store.addGrocery({ name: "apples", unit: "each", quantity: 1, addedBy: "test" });
  await enteredPromise;
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await store.groceries(), before.groceryLines);
  release();
  await assert.rejects(write, /simulated disk failure/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.restockForMeals(1, true)).previewToken, preview.previewToken);
});

test("a filesystem write failure cannot publish in-memory changes, and recovery uses the prior disk snapshot", async t => {
  const { path, directory } = await temporary(t);
  const store = await useStore(t, path);
  const before = await store.groceries();
  const backup = join(directory, "snapshot.saved");
  await rename(path, backup);
  await mkdir(path);
  await assert.rejects(store.addGrocery({ name: "apples", unit: "each", quantity: 1, addedBy: "test" }), /regular files/);
  assert.deepEqual(await store.groceries(), before);
  await rmdir(path);
  await rename(backup, path);
  await store.addGrocery({ name: "apples", unit: "each", quantity: 1, addedBy: "test" });
  assert.equal((await store.groceries()).find(value => value.name === "apples")?.quantity, 1);
  assert.equal((await readdir(directory)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("corrupt, unsupported, oversized and invalid snapshots fail closed without replacing their bytes", async t => {
  const { path, directory } = await temporary(t);
  const valid = { version: 1, syntheticDemo: true, state: new MemoryStore().snapshot() };
  const invalidDuplicate = structuredClone(valid);
  invalidDuplicate.state.groceryLines.push({ ...invalidDuplicate.state.groceryLines[0] });
  const invalidQuantity = structuredClone(valid);
  invalidQuantity.state.groceryLines[0].quantity = -1;
  const tooMany = structuredClone(valid);
  tooMany.state.choreList = Array.from({ length: 201 }, (_, index) => ({ name: `chore ${index}`, assignee: "test", dueInDays: 0, done: false }));
  for (const bytes of [
    Buffer.from("{broken"), Buffer.from(JSON.stringify({ ...valid, version: 99 })),
    Buffer.from(JSON.stringify(invalidDuplicate)), Buffer.from(JSON.stringify(invalidQuantity)),
    Buffer.from(JSON.stringify(tooMany)), Buffer.alloc(MAX_STATE_FILE_BYTES + 1, "x"),
    Buffer.from([0xff, 0xfe]),
  ]) {
    await writeFile(path, bytes);
    await assert.rejects(FileStore.open(path));
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await readdir(directory)).includes("household.json.lock"), false);
  }
});

test("external file edits are preserved and cannot be silently overwritten by an old store", async t => {
  const { path } = await temporary(t);
  const store = await useStore(t, path);
  const before = await store.groceries();
  const bytes = Buffer.from("{externally changed}");
  await writeFile(path, bytes);
  await assert.rejects(store.addGrocery({ name: "apples", unit: "each", quantity: 1, addedBy: "test" }), /changed outside/);
  assert.deepEqual(await store.groceries(), before);
  assert.deepEqual(await readFile(path), bytes);
});

test("state hard links are rejected without changing their target", async t => {
  const { directory, path } = await temporary(t);
  const original = join(directory, "original.json");
  const bytes = Buffer.from(JSON.stringify({ version: 1, syntheticDemo: true, state: new MemoryStore().snapshot() }));
  await writeFile(original, bytes);
  await link(original, path);
  await assert.rejects(FileStore.open(path), /regular files/);
  assert.deepEqual(await readFile(original), bytes);
});

test("state symbolic links are never followed", async t => {
  const { directory, path } = await temporary(t);
  const original = join(directory, "original.json");
  const bytes = Buffer.from("do not change");
  await writeFile(original, bytes);
  try { await symlink(original, path, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("The OS does not permit unprivileged file symlinks"); return; }
    throw error;
  }
  await assert.rejects(FileStore.open(path), /regular files/);
  assert.deepEqual(await readFile(original), bytes);
});

test("ancestor junctions or symbolic links are never traversed", async t => {
  const { directory } = await temporary(t);
  const target = join(directory, "target");
  const alias = join(directory, "alias");
  await mkdir(target);
  try { await symlink(target, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("The OS does not permit unprivileged directory links"); return; }
    throw error;
  }
  await assert.rejects(FileStore.open(join(alias, "state.json")), /must not traverse links/);
  assert.deepEqual(await readdir(target), []);
});

test("close drains accepted writes, rejects new operations and releases the lock once", async t => {
  const { path } = await temporary(t);
  const store = await useStore(t, path);
  const writes = Array.from({ length: 10 }, (_, index) => store.ensureGroceries([{ name: `item ${index}`, unit: "each", quantity: 1, addedBy: "test" }]));
  const closing = store.close();
  assert.equal(store.close(), closing);
  await assert.rejects(store.groceries(), /closed/);
  await Promise.all(writes);
  await closing;
  const reopened = await useStore(t, path);
  assert.equal((await reopened.groceries()).length, 11);
});
