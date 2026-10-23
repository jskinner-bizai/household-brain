const byId = (id) => document.getElementById(id);
const state = { connected: false, busy: false, endpoint: '/mcp', protocol: '2025-11-25', requestId: 0, preview: null, tools: [], server: null, mealPlan: [] };

class RequestFailure extends Error {
  constructor(message, uncertain = false) { super(message); this.uncertain = uncertain; }
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function status(text, error = false) {
  byId('status').textContent = text;
  byId('status').classList.toggle('error', error);
}
function focusTarget(id) {
  const target = byId(id);
  if (!target || !target.isConnected || target.disabled) return;
  target.focus();
}
function setStage(stage) {
  document.body.dataset.stage = stage;
  byId('preview-restock').textContent = stage === 'done' ? 'Check again' : 'Check what to add';
  const primary = stage === 'start' ? 'connect' : stage === 'review' ? 'commit-restock' : 'preview-restock';
  for (const id of ['connect', 'preview-restock', 'commit-restock']) byId(id).classList.toggle('primary', id === primary);
  const help = byId('journey-help');
  if (help) help.textContent = {
    start: 'Open the sample household to see the dinner plan and what is already on the list.',
    check: 'Start with the meals below. Check what needs adding before changing the list.',
    review: 'Review each addition and its reason. The list changes only when you confirm.',
    done: 'Your sample list is below. Check again any time; items already listed will not be added twice.',
  }[stage];
  for (const [number, current] of [[1, stage === 'start'], [2, stage === 'check' || stage === 'review'], [3, stage === 'done']]) {
    const step = byId(`journey-step-${number}`);
    if (step) step.classList.toggle('is-current', current);
    const link = document.querySelector(`.journey-nav a[href="#journey-step-${number}"]`);
    if (link) {
      if (current) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    }
  }
}
function setBusy(busy) {
  state.busy = busy;
  byId('connect').disabled = busy || state.connected;
  document.querySelectorAll('[data-action]').forEach((button) => { button.disabled = busy || !state.connected; });
  byId('commit-restock').disabled = busy || !state.connected || !state.preview || state.preview.count === 0 || state.preview.days !== Number(byId('days').value);
  byId('days').disabled = busy;
  document.querySelectorAll('button[data-chore]').forEach((button) => { button.disabled = busy || !state.connected; });
  byId('main').setAttribute('aria-busy', String(busy));
}
async function rpc(method, params = {}, { notification = false, write = false } = {}) {
  const body = { jsonrpc: '2.0', method, params };
  if (!notification) body.id = ++state.requestId;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (method !== 'initialize') headers['MCP-Protocol-Version'] = state.protocol;
  let response;
  try { response = await fetch(state.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); }
  catch { throw new RequestFailure('Connection failed or timed out before a response was received.', write); }
  if (notification && response.ok) return null;
  let payload;
  try { payload = await response.json(); }
  catch { throw new RequestFailure(`The server returned an unreadable response (HTTP ${response.status}).`, write); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RequestFailure('The server returned an unexpected response.', write);
  if (payload.error) throw new RequestFailure(`Server error ${payload.error.code}: ${payload.error.message}`, write && (response.status >= 500 || payload.error.code === -32603));
  if (!response.ok) throw new RequestFailure(`Request failed (HTTP ${response.status}).`, write);
  if (payload.id !== body.id || !Object.hasOwn(payload, 'result')) throw new RequestFailure('The server returned an unexpected response.', write);
  return payload.result;
}
async function callTool(name, args = {}, write = false) {
  if (!state.tools.some((tool) => tool.name === name)) throw new RequestFailure(`The connected server did not advertise ${name}.`);
  return rpc('tools/call', { name, arguments: args }, { write });
}
function resultText(result) { return (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n'); }
function displayText(result) { return resultText(result).replace(/^Synthetic demo: fictional household data\.\s*/i, ''); }
function showResult(id, result, title, summary) {
  const target = byId(id);
  target.replaceChildren();
  target.classList.remove('success-summary');
  target.classList.toggle('error', Boolean(result.isError));
  if (title) target.append(element('p', title, 'result-title'));
  const text = summary ?? displayText(result);
  if (text) target.append(element('p', text, 'response-text'));
  if (result.content || result.structuredContent) {
    const details = element('details');
    details.append(element('summary', 'Technical receipt'), element('pre', JSON.stringify(result, null, 2)));
    target.append(details);
  }
}
function requireSuccess(result) {
  if (result.isError) {
    const error = new RequestFailure(resultText(result) || 'The tool reported an error.');
    error.toolResult = result;
    throw error;
  }
  return result.structuredContent ?? {};
}
function showFailure(id, error) {
  const target = byId(id);
  target.classList.remove('success-summary');
  target.classList.add('error');
  const message = error.uncertain
    ? `${error.message} This change may have gone through. Reload the household and check the list before trying again. Nothing will be retried automatically.`
    : error.message;
  if (error.toolResult) showResult(id, error.toolResult, 'Tool error response');
  else target.replaceChildren(element('p', message));
  if (error.uncertain) state.preview = null;
  if (state.connected && !state.preview) setStage('check');
  status(error.uncertain ? 'We could not confirm that change. Reload the household, then check the list. Do not add it again yet.' : error.message, true);
}
async function action(id, task, doneMessage, { focus = id } = {}) {
  if (state.busy) return;
  const initiator = document.activeElement;
  let focusMoved = false, movedFocusTarget = null, failed = false;
  const trackFocus = (event) => {
    if (event.target !== initiator && event.target !== document.body) { focusMoved = true; movedFocusTarget = event.target; }
  };
  document.addEventListener('focusin', trackFocus);
  setBusy(true);
  status('Checking the sample household…');
  try { const outcome = await task(); status(typeof outcome === 'string' ? outcome : doneMessage); }
  catch (error) { failed = true; showFailure(id, error); }
  finally {
    document.removeEventListener('focusin', trackFocus);
    setBusy(false);
    // Only the initiating action owns this focus move. Leave a person's new
    // focus alone if they moved to another control while the request ran.
    if (!focusMoved || (movedFocusTarget && !movedFocusTarget.isConnected)) focusTarget(failed ? id : typeof focus === 'function' ? focus() : focus);
  }
}
function listItems(target, values, format) {
  target.replaceChildren();
  if (!values.length) { target.append(element('p', 'None.')); return; }
  const list = element('ul');
  values.forEach((value) => list.append(element('li', format(value))));
  target.append(list);
}
function renderMeals() {
  const target = byId('dinner');
  target.replaceChildren();
  const meals = state.mealPlan.slice(0, Number(byId('days').value));
  if (!meals.length) { target.append(element('p', 'No meals planned in this sample.')); return; }
  const list = element('ul', undefined, 'meal-list');
  for (const meal of meals) {
    const row = element('li', undefined, 'meal-row');
    row.append(element('span', meal.day, 'meal-day'), element('strong', meal.meal, 'meal-name'));
    list.append(row);
  }
  target.append(list);
}
function renderSummary(summary) {
  renderMeals();
  listItems(byId('low-pantry'), summary.low ?? [], (name) => name);
  const groceries = summary.groceries;
  if (Array.isArray(groceries)) {
    const target = byId('grocery-list'); target.replaceChildren();
    const list = element('ul', undefined, 'grocery-items');
    for (const line of groceries) {
      const row = element('li', undefined, 'grocery-line');
      row.append(element('span', line.name, 'grocery-name'), element('span', `${line.quantity} ${line.unit}`, 'grocery-quantity'));
      list.append(row);
    }
    target.append(groceries.length ? list : element('p', 'Your sample list is empty. Check the meal plan to get started.'));
    const count = byId('grocery-count');
    if (count) count.textContent = `${groceries.length} item${groceries.length === 1 ? '' : 's'}`;
  }
  else byId('grocery-list').replaceChildren(element('p', `${summary.groceryCount ?? 0} grocery lines. This server does not expose the full list in its read-only summary.`));
  const chores = byId('chores');
  chores.replaceChildren();
  if (!(summary.openChores ?? []).length) chores.append(element('p', 'All demo chores are done.'));
  for (const chore of summary.openChores ?? []) {
    const row = element('div', undefined, 'chore-row');
    const label = element('div');
    label.append(element('strong', chore.name), element('span', `${chore.assignee}; due in ${chore.dueInDays} day${chore.dueInDays === 1 ? '' : 's'}`, 'item-meta'));
    const button = element('button', `Mark ${chore.name} done`);
    button.type = 'button'; button.dataset.chore = chore.name; button.disabled = state.busy;
    button.addEventListener('click', () => action('chore-result', async () => {
      const result = await callTool('chore_log', { chore: chore.name }, true);
      showResult('chore-result', result, 'Chore response');
      requireSuccess(result);
      const refreshed = await refreshAfterWrite('chore-result');
      return refreshed ? 'Chore marked done. The list and brief are refreshed.' : 'Chore response received. The refresh failed; inspect the receipt and refresh household state.';
    }, 'Chore marked done. The list and brief are refreshed.'));
    row.append(label, button); chores.append(row);
  }
}
function briefArguments() {
  return { detail: byId('brief-detail').value, topics: [...document.querySelectorAll('#brief-topics input:checked')].map((input) => input.value) };
}
async function refreshBrief() {
  const result = await callTool('brief_get', briefArguments());
  showResult('brief-result', result);
  requireSuccess(result);
}
async function refreshHousehold() {
  const result = await callTool('household_summary');
  const summary = requireSuccess(result);
  if (!state.mealPlan.length && summary.tonight) state.mealPlan = [summary.tonight];
  // A confirmed list read remains useful even if the separate meal-plan read fails.
  renderSummary(summary);
  const plan = requireSuccess(await callTool('mealplan_get'));
  if (!Array.isArray(plan.plan)) throw new RequestFailure('The meal plan could not be read. Reload the household before checking additions.');
  state.mealPlan = plan.plan;
  renderMeals();
  await refreshBrief();
}
async function refreshAfterWrite(resultId) {
  try { await refreshHousehold(); return true; }
  catch (error) {
    byId(resultId).append(element('p', `The change was confirmed, but the updated household could not be loaded: ${error.message} Reload the household to see the latest list. The change will not be sent again automatically.`));
    return false;
  }
}
function renderPreview(result, days, changed = false) {
  const content = changed ? result.structuredContent ?? {} : requireSuccess(result);
  if (content.dryRun !== true) throw new RequestFailure('The server did not identify this response as a dry-run preview. Adding remains disabled.');
  if (typeof content.previewToken !== 'string' || !content.previewToken) throw new RequestFailure('The server did not supply a validated preview. Adding remains disabled.');
  const target = byId('preview'); target.replaceChildren();
  if (changed) target.append(element('p', 'The household changed since your preview. Nothing was added. Review this updated list, then confirm it.', 'changed-notice'));
  const additions = content.added ?? [];
  target.append(element('h3', additions.length ? `${additions.length} things to add to your list` : 'Nothing new to add'));
  if (!additions.length) target.append(element('p', 'The checked ingredients are on hand or already listed. This check does not calculate quantities for servings.'));
  const groups = new Map();
  for (const item of additions) {
    const title = item.reason.startsWith('for ')
      ? `For ${item.reason.slice(4)}` : 'Running low at home';
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(item);
  }
  for (const [title, items] of groups) {
    target.append(element('p', title, 'preview-section-title'));
    const list = element('ul', undefined, 'preview-items');
    for (const item of items) {
      const line = element('li', undefined, 'preview-item');
      line.append(element('strong', item.name, 'preview-item-name'), element('span', `1 ${item.unit}`, 'preview-item-meta'));
      list.append(line);
    }
    target.append(list);
  }
  target.append(element('p', `Already listed: ${(content.alreadyListed ?? []).map((item) => `${item.name} (${item.unit})`).join(', ') || 'none'}.`));
  for (const conflict of content.unitConflicts ?? []) {
    const listed = (conflict.listed ?? []).map((line) => `${line.quantity} ${line.unit}`).join(', ');
    target.append(element('p', `${conflict.name} is already listed as ${listed}; this checklist adds 1 ${conflict.requestedUnit}. Units are not converted.`, 'unit-notice'));
  }
  target.append(element('p', additions.length ? 'Nothing has been added yet. Add these items only if the list looks right.' : 'No change is needed from this check.', 'preview-footnote'));
  const details = element('details');
  details.append(element('summary', 'Technical receipt'), element('pre', JSON.stringify(result, null, 2)));
  target.append(details);
  byId('commit-restock').textContent = changed ? `Confirm ${additions.length} updated item${additions.length === 1 ? '' : 's'}` : `Add ${additions.length} item${additions.length === 1 ? '' : 's'} to sample list`;
  state.preview = { days, token: content.previewToken, count: additions.length };
  setStage(additions.length ? 'review' : 'done');
}
function renderTopics(preferences) {
  const target = byId('brief-topics'); target.replaceChildren();
  for (const topic of preferences.availableSources ?? []) {
    const label = element('label', undefined, 'topic-choice');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.value = topic; checkbox.checked = topic === 'household';
    label.append(checkbox, document.createTextNode(topic.charAt(0).toUpperCase() + topic.slice(1)));
    target.append(label);
  }
}
function renderTools(tools) {
  byId('tool-heading').textContent = `Discovered tools (${tools.length})`;
  const target = byId('tool-details'); target.replaceChildren();
  for (const tool of tools) {
    const record = element('div', undefined, 'tool-record');
    record.append(element('h4', tool.name), element('p', tool.description ?? ''));
    const details = element('details');
    details.append(element('summary', 'Definition and annotations'), element('pre', JSON.stringify(tool, null, 2)));
    record.append(details); target.append(record);
  }
}
byId('connect').addEventListener('click', () => action('restock-result', async () => {
  const configResponse = await fetch('/demo-config.json', { signal: AbortSignal.timeout(10000) });
  if (configResponse.ok) {
    const config = await configResponse.json();
    const endpoint = new URL(config.mcpEndpoint, location.origin);
    if (typeof config.mcpEndpoint !== 'string' || !config.mcpEndpoint.startsWith('/') || endpoint.origin !== location.origin || endpoint.search || endpoint.hash) throw new RequestFailure('The demo configuration must identify a same-origin MCP path.');
    state.endpoint = endpoint.pathname;
  } else if (configResponse.status !== 404) throw new RequestFailure(`Could not load the demo configuration (HTTP ${configResponse.status}).`);
  const initialized = await rpc('initialize', { protocolVersion: state.protocol, capabilities: {}, clientInfo: { name: 'household-brain-local-web-client', version: '1.0.0' } });
  if (typeof initialized.protocolVersion !== 'string') throw new RequestFailure('The initialize response did not supply a protocol revision.');
  state.protocol = initialized.protocolVersion; state.server = initialized.serverInfo;
  await rpc('notifications/initialized', {}, { notification: true });
  const inventory = await rpc('tools/list');
  if (!Array.isArray(inventory.tools)) throw new RequestFailure('The server did not return a tool inventory.');
  state.tools = inventory.tools;
  const healthResult = await callTool('health');
  const preferencesResult = await callTool('brief_preferences');
  const health = requireSuccess(healthResult), preferences = requireSuccess(preferencesResult);
  byId('health-details').textContent = JSON.stringify(health, null, 2);
  byId('preference-details').textContent = JSON.stringify(preferences, null, 2);
  byId('protocol-details').textContent = JSON.stringify({ endpoint: state.endpoint, protocolVersion: state.protocol, serverInfo: state.server, transport: 'Stateless Streamable HTTP; real JSON-RPC calls' }, null, 2);
  renderTopics(preferences); renderTools(state.tools);
  await refreshHousehold();
  state.connected = true;
  byId('connection-state').textContent = 'Sample household is open';
  byId('connect').textContent = 'Household open';
  byId('connection-help').textContent = 'The plan and list below come from the same local household.';
  setStage('check');
}, 'Here is the dinner plan. Check what needs adding when you are ready.', { focus: 'preview-restock' }));

byId('days').addEventListener('change', () => {
  state.preview = null;
  byId('commit-restock').textContent = 'Review items before adding';
  byId('preview').replaceChildren(element('p', 'You changed the number of meals. Check the new plan before adding anything.'));
  if (state.connected) { renderMeals(); setStage('check'); }
  setBusy(state.busy);
});
byId('preview-restock').addEventListener('click', () => action('restock-result', async () => {
  state.preview = null;
  setStage('check');
  const days = Number(byId('days').value);
  const result = await callTool('restock_for_meals', { days, dry_run: true });
  byId('restock-result').replaceChildren();
  byId('restock-result').classList.remove('error', 'success-summary');
  renderPreview(result, days);
}, 'Check complete. Review the items and their reasons before adding.', { focus: 'preview' }));
byId('commit-restock').addEventListener('click', () => {
  if (!state.preview || state.preview.days !== Number(byId('days').value)) return;
  const { days, token } = state.preview; state.preview = null;
  action('restock-result', async () => {
    const result = await callTool('restock_for_meals', { days, dry_run: false, expected_token: token }, true);
    const content = result.structuredContent ?? {};
    if (result.isError && content.writeApplied === false && content.dryRun === true && (content.previewChanged || content.previewRequired)) {
      renderPreview(result, days, true);
      showResult('restock-result', result, 'No changes made', 'The list changed. Review the updated preview above and confirm again.');
      return 'The household changed. Nothing was added. Review and confirm the updated preview.';
    }
    requireSuccess(result);
    const added = (content.added ?? []).length;
    showResult('restock-result', result, `${added} item${added === 1 ? '' : 's'} added to the sample list`, 'See your updated shopping list below. Nothing was purchased and pantry stock has not changed.');
    byId('restock-result').classList.add('success-summary');
    byId('commit-restock').textContent = 'Added to sample list';
    byId('preview').replaceChildren(element('p', 'These additions are saved to the running sample list. Check again to see whether anything else needs adding.'));
    const refreshed = await refreshAfterWrite('restock-result');
    setStage(refreshed ? 'done' : 'check');
    return refreshed ? `${(content.added ?? []).length} items added. The list and brief are refreshed.` : `${(content.added ?? []).length} items added. The refresh failed; inspect the receipt and refresh household state.`;
  }, 'Restock response received.', { focus: () => state.preview ? 'preview' : 'restock-result' });
});
byId('refresh-state').addEventListener('click', () => action('restock-result', async () => {
  await refreshHousehold();
  state.preview = null;
  byId('preview').replaceChildren(element('p', 'The household is reloaded. Check what needs adding before changing the list.'));
  setStage('check');
}, 'Household reloaded. No change was requested.', { focus: 'status' }));
byId('grocery-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = byId('grocery-name').value.trim(), unit = byId('grocery-unit').value.trim(), quantity = Number(byId('grocery-quantity').value);
  if (!name || name.normalize('NFKC').length > 80 || !unit || unit.normalize('NFKC').length > 40 || /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(name + unit) || !Number.isFinite(quantity) || quantity < 0.001 || quantity > 10000) { status('Use an item of up to 80 characters, a unit of up to 40, and a quantity from 0.001 to 10,000. Invisible control characters are not accepted.', true); return; }
  if (state.busy) return;
  state.preview = null;
  setStage('check');
  byId('preview').replaceChildren(element('p', 'A grocery write was requested. Read the current state and preview restock again before adding.'));
  action('grocery-result', async () => {
    const result = await callTool('groceries_add', { name, quantity, unit }, true);
    showResult('grocery-result', result, 'Grocery receipt'); requireSuccess(result);
    byId('preview').replaceChildren(element('p', 'The grocery list changed. Preview restock again before adding.'));
    const refreshed = await refreshAfterWrite('grocery-result');
    if (!refreshed) return 'Grocery response received. The refresh failed; inspect the receipt and refresh household state.';
  }, 'Grocery list updated. Submitting the form again adds the quantity again.');
});
byId('pantry-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const item = byId('pantry-item').value.trim();
  action('pantry-result', async () => { const result = await callTool('pantry_query', item ? { item } : {}); showResult('pantry-result', result); requireSuccess(result); }, 'Pantry response received.');
});
byId('load-mealplan').addEventListener('click', () => action('mealplan-result', async () => {
  const result = await callTool('mealplan_get'); showResult('mealplan-result', result); requireSuccess(result);
}, 'Fixture ingredient checklist received.'));
byId('brief-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action('brief-result', refreshBrief, 'Brief response received. These choices are for this request only.');
});
setStage('start');
