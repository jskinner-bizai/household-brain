// Isolated headless Chrome test with a mock model. Never opens a foreground tab.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createDemoHttpServer } from '../dist/server.js';
import { FileStore } from '../dist/file-store.js';
import { createMockModel } from '../dist/mock-model.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await pause(80); }
  throw new Error(`Timed out: ${label}`);
}
const directory = await mkdtemp(join(tmpdir(), 'household-ui-mock-'));
const statePath = join(directory, 'household.snapshot.json');
const profile = join(directory, 'browser');
let store, server, chrome, socket;
async function start(planner) {
  store = await FileStore.open(statePath);
  server = createDemoHttpServer({ store, persistentState: true,
    ...(planner ? { planner: { model: createMockModel(), mode: 'mock' } } : {}) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; }
  if (store) { await store.close(); store = undefined; }
}
try {
  const base = await start(true);
  const executable = process.env.CHROME_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  chrome.on('error', error => { console.error(error.message); });
  const port = await until(async () => {
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { return false; }
  }, 'isolated headless browser');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(target => target.type === 'page'); assert.ok(target);
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  let id = 0; const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed');
    return result.result.value;
  };
  await command('Page.navigate', { url: base });
  await until(() => evaluate('document.readyState === "complete" && Boolean(document.getElementById("connect"))'), 'app load');
  await evaluate('document.getElementById("connect").click()');
  await until(() => evaluate('document.getElementById("connection-state").textContent === "Household is open"'), 'MCP connection');
  assert.equal((await store.groceries()).length, 1);
  await evaluate('document.getElementById("run-planner").click()');
  await until(() => evaluate('document.getElementById("commit-restock").disabled === false'), 'mock proposal');
  assert.match(await evaluate('document.getElementById("planner-result").textContent'), /Mock planner finished/);
  assert.equal((await store.groceries()).length, 1, 'model cannot mutate');
  // Reload retains the completed proposal without a new model run.
  await command('Page.reload');
  await until(() => evaluate('document.readyState === "complete" && Boolean(document.getElementById("connect"))'), 'reload');
  await evaluate('document.getElementById("connect").click()');
  await until(() => evaluate('document.getElementById("commit-restock").disabled === false'), 'retained proposal');
  assert.equal((await store.groceries()).length, 1);
  assert.equal(await evaluate('document.getElementById("run-planner").disabled'), true);
  // This automated click is a MOCK UI test, never evidence of human live approval.
  await evaluate('document.getElementById("commit-restock").click()');
  await until(() => evaluate('document.getElementById("grocery-count").textContent === "7 items"'), 'mock confirmation');
  assert.equal((await store.groceries()).length, 7);
  assert.equal(await evaluate('document.getElementById("commit-restock").disabled'), true);
  const proof = await (await fetch(`${base}/planner/result`)).json();
  assert.equal(proof.receipt.modelRequests, 3);
  await stop();
  const restarted = await start(false);
  await command('Page.navigate', { url: restarted });
  await until(() => evaluate('document.readyState === "complete" && Boolean(document.getElementById("connect"))'), 'restarted app');
  await evaluate('document.getElementById("connect").click()');
  await until(() => evaluate('document.getElementById("grocery-count").textContent === "7 items"'), 'persistent list after restart');
  assert.equal((await store.groceries()).length, 7);
  assert.match(await evaluate('document.getElementById("scope-detail").textContent'), /saved locally across restarts/);
  if (process.env.UI_SMOKE_SCREENSHOT) {
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.UI_SMOKE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  console.log(JSON.stringify({ mode: 'mock', awsRequests: 0, foregroundInteraction: false,
    realMcpReadsAndPreview: true, modelRequests: 3, groceriesBeforeConfirmation: 1,
    groceriesAfterAutomatedMockConfirmation: 7, groceriesAfterRestart: 7,
    retainedPreviewWithoutRepeatedInference: true, humanLiveApprovalProven: false }));
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill(); await Promise.race([once(chrome, 'exit'), pause(3000)]); }
  await stop();
  // Only this test's resolved, newly-created Temp directory can be removed.
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => {});
}
