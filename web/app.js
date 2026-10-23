const byId = (id) => document.getElementById(id);
const state = { connected: false, busy: false, endpoint: '/mcp', protocol: '2025-11-25', requestId: 0, preview: null, tools: [], server: null, mealPlan: [], planner: null, plannerAttempted: false, persistentState: false };

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
function focusTarget(id, preventScroll = false) {
  const target = byId(id);
  if (!target || !target.isConnected || target.disabled) return;
  target.focus({ preventScroll });
}
function setStage(stage) {
  document.body.dataset.stage = stage;
  byId('preview-restock').textContent = stage === 'done' ? 'Check again' : 'Check ingredients';
  const primary = stage === 'start' ? 'connect' : stage === 'review' ? 'commit-restock' : 'preview-restock';
  for (const id of ['connect', 'preview-restock', 'commit-restock']) byId(id).classList.toggle('primary', id === primary);
  const help = byId('journey-help');
  if (help) help.textContent = {
    start: 'See the meals, check the ingredients, then review what goes on your list.',
    check: 'Start with the meals below. Check what needs adding before changing the list.',
    review: 'Review each addition and its reason. The list changes only when you confirm.',
    done: 'Your list is updated. Check again any time; items already listed will not be added twice.',
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
  byId('run-planner').disabled = busy || !state.connected || !state.planner || state.plannerAttempted;
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
  const startScroll = window.scrollY;
  let focusMoved = false, movedFocusTarget = null, failed = false;
  const trackFocus = (event) => {
    if (event.target !== initiator && event.target !== document.body) { focusMoved = true; movedFocusTarget = event.target; }
  };
  document.addEventListener('focusin', trackFocus);
  setBusy(true);
  status('Checking the household.');
  try { const outcome = await task(); status(typeof outcome === 'string' ? outcome : doneMessage); }
  catch (error) { failed = true; showFailure(id, error); }
  finally {
    document.removeEventListener('focusin', trackFocus);
    setBusy(false);
    // Only the initiating action owns this focus move. Leave a person's new
    // focus alone if they moved to another control while the request ran.
    // If the person scrolled away while waiting, move focus without yanking the page.
    const scrolledAway = Math.abs(window.scrollY - startScroll) > window.innerHeight / 2;
    if (!focusMoved || (movedFocusTarget && !movedFocusTarget.isConnected)) focusTarget(failed ? id : typeof focus === 'function' ? focus() : focus, scrolledAway);
  }
}
function listItems(target, values, format) {
  target.replaceChildren();
  if (!values.length) { target.append(element('p', 'None.')); return; }
  const list = element('ul');
  values.forEach((value) => list.append(element('li', format(value))));
  target.append(list);
}
// Original code-native food illustrations. No photos, third-party assets or remote requests.
function mealArtwork(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const shape = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  const svg = shape('svg', { viewBox: '0 0 280 170', 'aria-hidden': 'true', focusable: 'false' });
  const add = (tag, attrs, parent = svg) => { const node = shape(tag, attrs); parent.append(node); return node; };
  const type = name.toLowerCase().includes('salmon') ? 'salmon' : name.toLowerCase().includes('taco') ? 'tacos' : 'bowl';
  add('rect', { width: 280, height: 170, rx: 18, fill: type === 'salmon' ? '#f3dfd3' : type === 'tacos' ? '#f1e6c9' : '#e3e9d9' });
  add('ellipse', { cx: 142, cy: 127, rx: 104, ry: 25, fill: '#263e3020' });
  add('ellipse', { cx: 140, cy: 91, rx: 108, ry: 65, fill: '#fffdf5', stroke: '#d9d4c3', 'stroke-width': 3 });
  add('ellipse', { cx: 140, cy: 91, rx: 91, ry: 49, fill: '#f5f2e8' });
  if (type === 'salmon') {
    add('path', { d: 'M66 72 Q75 47 102 54 Q126 53 130 83 Q128 110 94 115 Q63 109 66 72Z', fill: '#fffdf8' });
    for (const [x, y] of [[80, 72], [95, 66], [111, 76], [82, 94], [102, 98]]) add('path', { d: `M${x} ${y}l8 2`, stroke: '#dfd7bd', 'stroke-width': 2, 'stroke-linecap': 'round' });
    add('path', { d: 'M113 63 Q132 48 166 58 L187 103 Q165 125 128 116 L110 82Z', fill: '#d9785d', stroke: '#b75b43', 'stroke-width': 2 });
    for (const [x, y] of [[124, 68], [132, 83], [140, 99]]) add('path', { d: `M${x} ${y}q16 -5 32 3`, fill: 'none', stroke: '#f6b59a', 'stroke-width': 4, 'stroke-linecap': 'round' });
    for (const [x, y] of [[190, 69], [208, 85], [199, 104]]) {
      add('path', { d: `M${x} ${y+12}l-6 16`, stroke: '#69864c', 'stroke-width': 7, 'stroke-linecap': 'round' });
      for (const [dx, dy] of [[-9, 0], [4, -6], [11, 5]]) add('circle', { cx: x+dx, cy: y+dy, r: 12, fill: dx < 0 ? '#3f6946' : '#5b7f46' });
    }
    add('path', { d: 'M86 46 Q99 28 115 45 L101 58Z', fill: '#edce65', stroke: '#c7ac49', 'stroke-width': 2 });
  } else if (type === 'tacos') {
    for (const [x, y, angle] of [[83, 62, -13], [150, 75, 12]]) {
      const taco = add('g', { transform: `translate(${x} ${y}) rotate(${angle})` });
      add('path', { d: 'M-20 31 Q-21 -25 34 -26 Q81 -23 82 32Z', fill: '#dfb55e', stroke: '#b98d3f', 'stroke-width': 3 }, taco);
      add('path', { d: 'M-12 24 Q-6 -11 32 -14 Q66 -12 74 24Z', fill: '#698248' }, taco);
      for (const [bx, by] of [[3, 11], [19, -2], [34, 9], [52, 0], [65, 15]]) add('ellipse', { cx: bx, cy: by, rx: 8, ry: 6, fill: '#47372f', transform: `rotate(-20 ${bx} ${by})` }, taco);
      add('path', { d: 'M-12 23 Q25 -2 74 24 L66 42 Q21 49 -12 23Z', fill: '#efd08b', stroke: '#c49c50', 'stroke-width': 2 }, taco);
      add('path', { d: 'M9 11l15 4m15 -13l12 8', stroke: '#b86263', 'stroke-width': 4, 'stroke-linecap': 'round' }, taco);
    }
    add('path', { d: 'M201 117 L224 96 Q239 117 216 132Z', fill: '#8eab50', stroke: '#68823c', 'stroke-width': 2 });
    add('path', { d: 'M207 116l15 -13m-11 18l15 -10', stroke: '#dce6ad', 'stroke-width': 2 });
  } else {
    add('path', { d: 'M69 75 Q140 112 212 75 L195 118 Q140 149 86 118Z', fill: '#668875', stroke: '#3e6354', 'stroke-width': 3 });
    add('ellipse', { cx: 140, cy: 75, rx: 72, ry: 31, fill: '#f0d493', stroke: '#3e6354', 'stroke-width': 3 });
    for (const [x, y, color] of [[98, 69, '#b9684b'], [124, 82, '#5f8049'], [157, 64, '#cf8b54'], [179, 82, '#64864a']]) add('ellipse', { cx: x, cy: y, rx: 16, ry: 10, fill: color });
    add('path', { d: 'M118 44q-8 -9 0 -18m28 16q-8 -9 0 -18m27 23q-8 -9 0 -18', fill: 'none', stroke: '#a6b4a4', 'stroke-width': 3, 'stroke-linecap': 'round' });
  }
  return svg;
}
function renderQuantityScope(mode = state.preview?.quantityMode) {
  const meals = state.mealPlan.slice(0, Number(byId('days').value));
  const measured = mode === 'measured' || mode === 'mixed' || meals.some((meal) => Array.isArray(meal.ingredients));
  const mixed = mode === 'mixed' || (measured && meals.some((meal) => !Array.isArray(meal.ingredients)));
  byId('quantity-note').textContent = measured
    ? `${mixed ? 'Measured amounts plus unmeasured checklist items. ' : 'Stored recipe servings and exact units. '}No scaling, pack-size inference or raw-to-cooked conversion. Review amounts before adding.`
    : 'Adds 1 unit per missing item, not recipe quantities. Check cooking amounts before shopping.';
  byId('quantity-rules').textContent = measured
    ? 'For measured ingredients, the check subtracts pantry stock and the existing list in the exact same unit from the combined recipe need. Only the positive shortfall is added. Other units stay separate; amounts are not converted or scaled. Low staples may have a one-unit floor, shown in the amount details. Every add validates the preview and current state together, atomically. If relevant state changed, nothing is added: review the new amounts and confirm again.'
    : 'The server adds one unit per missing item, not recipe-serving quantities. A name in another unit stays separate and is shown before confirmation. Every add validates the preview and current household state together, atomically. If relevant state changed, nothing is added: review the updated preview and confirm again.';
}
function renderMeals() {
  const target = byId('dinner');
  const open = new Set([...target.querySelectorAll('details[open]')].map((node) => node.dataset.mealKey));
  const focused = target.contains(document.activeElement) ? document.activeElement.closest('details')?.dataset.mealKey : null;
  target.replaceChildren();
  const meals = state.mealPlan.slice(0, Number(byId('days').value));
  if (!meals.length) { target.append(element('p', 'No meals planned yet.')); return; }
  const list = element('ul', undefined, 'meal-list');
  for (const meal of meals) {
    const row = element('li', undefined, 'meal-row meal-card');
    const visual = element('div', undefined, 'meal-art');
    const artwork = Array.isArray(meal.ingredients) ? {
      'Herb chicken, Brussels sprouts and quinoa-walnut pilaf': '/assets/herb-chicken-brussels-quinoa.svg',
      'Steak fajita bowls with cilantro-lime cauliflower rice': '/assets/steak-fajita-cauliflower-bowl.svg',
    }[meal.meal] : undefined;
    if (artwork) {
      const image = element('img'); image.src = artwork; image.alt = ''; image.width = 280; image.height = 170;
      visual.append(image);
    } else visual.append(mealArtwork(meal.meal));
    const body = element('div', undefined, 'meal-card-body');
    body.append(element('span', meal.day, 'meal-day'), element('strong', meal.meal, 'meal-name'));
    if (Number.isInteger(meal.servings) && meal.servings > 0) body.append(element('p', `${meal.servings} servings planned`, 'meal-servings'));
    const details = element('details', undefined, 'meal-check-details');
    details.dataset.mealKey = JSON.stringify([meal.day, meal.meal]); details.open = open.has(details.dataset.mealKey);
    const measured = Array.isArray(meal.ingredients);
    const toggle = element('summary', measured ? 'Ingredients & amounts' : 'Ingredients checked');
    toggle.setAttribute('aria-label', `${measured ? 'Cooking ingredients' : 'Ingredients checked'} for ${meal.meal}`);
    details.append(toggle);
    const ingredients = measured ? meal.ingredients : Array.isArray(meal.missingIngredients) ? meal.missingIngredients : [];
    if (ingredients.length) {
      const checked = element('ul', undefined, measured ? 'recipe-ingredients' : undefined);
      ingredients.forEach((ingredient) => {
        if (measured) {
          const line = element('li');
          line.append(element('span', ingredient.name), element('strong', `${ingredient.quantity} ${ingredient.unit}`, 'recipe-amount'));
          checked.append(line);
        } else checked.append(element('li', ingredient));
      });
      details.append(checked);
      details.append(element('p', measured ? `These cooking amounts are for the stored ${meal.servings}-serving recipe. Shopping additions subtract exact-unit pantry stock and existing list quantities. No serving scaling or unit conversion.` : "This checks the listed ingredients only, not a complete recipe. Cooking amounts aren't calculated."));
      body.append(details);
    } else {
      row.classList.add('meal-card--no-checks');
      body.append(element('p', 'No additional ingredients tracked.', 'meal-checked-note'));
    }
    row.append(visual, body);
    list.append(row);
  }
  target.append(list);
  renderQuantityScope();
  if (focused) {
    const restored = [...target.querySelectorAll('details')].find((node) => node.dataset.mealKey === focused);
    restored?.querySelector('summary').focus({ preventScroll: true });
  }
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
    target.append(groceries.length ? list : element('p', 'Your list is empty. Check the meal plan to get started.'));
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
const itemKey = (item) => `${item.name}|${item.unit}`;
const amountFields = ['quantity', 'requiredQuantity', 'pantryQuantity', 'listedQuantity', 'resultingListQuantity'];
const hasAnyAmounts = (item) => amountFields.some((key) => Object.hasOwn(item, key));
const hasAmounts = (item) => amountFields.every((key) => Number.isFinite(item[key]) && item[key] >= 0);
const addedQuantity = (item) => hasAmounts(item) ? item.quantity : 1;
const previewItemSnapshot = (item) => ({ name: item.name, unit: item.unit, ...Object.fromEntries(amountFields.filter((key) => Number.isFinite(item[key])).map((key) => [key, item[key]])) });
const joinNames = (names) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
function technicalReceipt(id, result) {
  const details = element('details');
  details.append(element('summary', 'Technical receipt'), element('pre', JSON.stringify(result, null, 2)));
  byId(id).append(details);
}
// Explain a rejected (stale) confirmation in household terms: which proposed
// items dropped out or appeared, or that only unrelated list lines changed.
function describeChange(previousKeys, content, previousItems = []) {
  const now = (content.added ?? []).map(itemKey);
  const listed = new Set((content.alreadyListed ?? []).map((item) => item.name));
  const dropped = previousKeys.filter((key) => !now.includes(key)).map((key) => key.split('|')[0]);
  const appeared = now.filter((key) => !previousKeys.includes(key)).map((key) => key.split('|')[0]);
  const parts = [];
  const nowListed = dropped.filter((name) => listed.has(name));
  const noLonger = dropped.filter((name) => !listed.has(name));
  if (nowListed.length) parts.push(`${joinNames(nowListed)} ${nowListed.length === 1 ? 'is' : 'are'} now already on the list`);
  if (noLonger.length) parts.push(`${joinNames(noLonger)} ${noLonger.length === 1 ? 'is' : 'are'} no longer needed`);
  if (appeared.length) parts.push(`${joinNames(appeared)} ${appeared.length === 1 ? 'needs' : 'need'} adding now`);
  const currentItems = new Map((content.coverage ?? content.added ?? []).map((item) => [itemKey(item), item]));
  for (const before of previousItems) {
    const current = currentItems.get(itemKey(before));
    if (!current || !amountFields.some((key) => current[key] !== before[key])) continue;
    parts.push(hasAmounts(current) && current.quantity === 0 && hasAmounts(before) && before.quantity === 0
      ? `${current.name} coverage changed; no addition is needed, but review its amount details`
      : `${current.name} amounts changed: now add ${addedQuantity(current)} ${current.unit} (previously ${addedQuantity(before)} ${before.unit}); review its amount details`);
  }
  return parts.length ? `What changed: ${parts.join('; ')}.` : 'The household state changed. Review the updated amounts and list before confirming.';
}
function renderPreview(result, days, changed = false) {
  state.preview = null;
  const content = changed ? result.structuredContent ?? {} : requireSuccess(result);
  if (content.dryRun !== true) throw new RequestFailure('The server did not identify this response as a dry-run preview. Adding remains disabled.');
  if (typeof content.previewToken !== 'string' || !content.previewToken) throw new RequestFailure('The server did not supply a validated preview. Adding remains disabled.');
  const target = byId('preview'); target.replaceChildren();
  if (changed) target.append(element('p', 'The household changed since your preview. Nothing was added. Review this updated list, then confirm it.', 'changed-notice'));
  const additions = content.added ?? [];
  if (!Array.isArray(additions) || (content.coverage !== undefined && !Array.isArray(content.coverage))) throw new RequestFailure('The server returned unreadable ingredient amounts. Adding remains disabled.');
  const measured = content.quantityMode === 'measured' || content.quantityMode === 'mixed';
  const amountItems = [...additions, ...(content.coverage ?? [])];
  if (amountItems.some((item) => (hasAnyAmounts(item) || measured) && !hasAmounts(item)) || additions.some((item) => hasAmounts(item) && item.quantity <= 0)) throw new RequestFailure('The server did not supply complete ingredient amounts. Adding remains disabled. Check again before confirming.');
  renderQuantityScope(content.quantityMode);
  target.append(element('h3', additions.length ? `${additions.length} items to review` : 'Nothing new to add'));
  if (!additions.length) target.append(element('p', measured ? 'The stored recipe amounts are covered by pantry stock and the list in matching units. Nothing new needs adding.' : 'The checked ingredients are on hand or already listed. This check does not calculate quantities for servings.'));
  const groups = new Map();
  for (const item of additions) {
    const matching = state.mealPlan.slice(0, days).filter((meal) => item.reason.toLowerCase().includes(meal.meal.toLowerCase()));
    const singleMealReason = matching.length === 1 && item.reason.toLowerCase() === `for ${matching[0].meal.toLowerCase()}`;
    const title = measured && matching.length ? 'For the selected meals' : !measured && singleMealReason ? `For ${matching[0].day}` : item.reason.startsWith('for ')
      ? `For ${item.reason.slice(4)}` : 'Running low at home';
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(item);
  }
  for (const [title, items] of groups) {
    const heading = element('p', title, 'preview-section-title');
    if (!measured) heading.title = [...new Set(items.map((item) => item.reason))].join('; ');
    target.append(heading);
    const list = element('ul', undefined, 'preview-items');
    for (const item of items) {
      const line = element('li', undefined, 'preview-item');
      const amounts = element('span', undefined, 'preview-item-meta');
      amounts.append(element('span', `Add ${addedQuantity(item)} ${item.unit}`));
      if (hasAmounts(item) && item.listedQuantity > 0) amounts.append(element('small', `List becomes ${item.resultingListQuantity} ${item.unit}`, 'resulting-quantity'));
      line.append(element('strong', item.name, 'preview-item-name'), amounts);
      list.append(line);
    }
    target.append(list);
  }
  target.append(element('p', `Already listed: ${(content.alreadyListed ?? []).map((item) => `${item.name} (${item.unit})`).join(', ') || 'none'}.`));
  for (const conflict of content.unitConflicts ?? []) {
    const listed = (conflict.listed ?? []).map((line) => `${line.quantity} ${line.unit}`).join(', ');
    const pantry = (conflict.pantry ?? []).map((line) => `${line.quantity} ${line.unit}`).join(', ');
    const proposed = additions.find((item) => item.name === conflict.name && item.unit === conflict.requestedUnit);
    target.append(element('p', `${conflict.name}: ${[listed ? `listed as ${listed}` : '', pantry ? `pantry has ${pantry}` : ''].filter(Boolean).join('; ')}. ${proposed ? `This adds ${addedQuantity(proposed)} ${conflict.requestedUnit} separately. ` : ''}Other units do not count toward recipe coverage and are not converted.`, 'unit-notice'));
  }
  if (measured && Array.isArray(content.coverage) && content.coverage.length) {
    const details = element('details', undefined, 'coverage-details');
    details.append(element('summary', `Ingredient amounts (${content.coverage.length})`));
    const list = element('ul', undefined, 'coverage-items');
    for (const item of content.coverage) {
      const line = element('li');
      line.append(element('strong', item.name));
      line.append(element('p', item.reason, 'coverage-reason'));
      const need = item.checklistOnly === true ? 'Unmeasured checklist item' : item.requiredQuantity === 0 ? 'Low pantry staple' : `Recipe need ${item.requiredQuantity} ${item.unit}`;
      line.append(element('p', `${need} · Pantry ${item.pantryQuantity} ${item.unit} · Already on list ${item.listedQuantity} ${item.unit}.`));
      line.append(element('p', `Add ${item.quantity} ${item.unit}. List after confirmation: ${item.resultingListQuantity} ${item.unit}.${item.lowStockFloor === 1 ? ' A one-unit low-stock floor also applies.' : ''}`));
      list.append(line);
    }
    details.append(list); target.append(details);
  }
  target.append(element('p', additions.length ? 'Nothing has been added.' : 'No change is needed from this check.', 'preview-footnote'));
  byId('commit-restock').textContent = changed ? `Confirm ${additions.length} updated item${additions.length === 1 ? '' : 's'}` : `Add ${additions.length} item${additions.length === 1 ? '' : 's'} to your list`;
  state.preview = { days, token: content.previewToken, count: additions.length, quantityMode: content.quantityMode, keys: additions.map(itemKey), items: (content.coverage ?? additions).map(previewItemSnapshot) };
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
function showPlannerScope(config) {
  const planner = config.planner;
  if (planner && ['mock', 'bedrock'].includes(planner.mode) && planner.endpoint === '/planner/preview' && planner.confirmationRequired === true) {
    state.planner = planner;
    byId('planner-section').hidden = false;
    byId('planner-mode').textContent = planner.mode === 'bedrock'
      ? 'Amazon Bedrock Nova Lite, Ohio. One bounded attempt; fictional data only.'
      : 'Mock model for testing. No AWS calls or model inference.';
  }
  const persistent = config.persistentState === true;
  state.persistentState = persistent;
  byId('scope-summary').textContent = 'Demo household • fictional data';
  byId('scope-detail').textContent = `${persistent ? 'Confirmed changes are saved locally across restarts. Previews must be reviewed again after a restart.' : 'Household changes live in memory and reset when the server restarts.'} No purchases or connected household accounts. ${state.planner?.mode === 'bedrock' ? 'The optional planner sends fictional fixtures to Amazon Bedrock in Ohio; it cannot commit changes.' : state.planner ? 'The optional planner uses a deterministic mock model; no AWS calls or model inference.' : 'No LLM or AWS service is connected.'} This loopback prototype has no authentication and must not be publicly exposed. Preview tokens detect changes; they are not authentication. No native Alexa, devices or live household source is connected.`;
  byId('integration-disclosure').textContent = `Household Brain is a self-hosted MCP prototype for the Alexa+ track. ${state.planner?.mode === 'bedrock' ? 'Optional Bedrock tool orchestration is enabled.' : state.planner ? 'Mock orchestration is enabled; no live AWS inference.' : 'The optional planner is disabled.'} Native Alexa is not connected. Requests are never retried automatically. Adding to the list does not replenish the pantry.`;
}
function renderPlannerEvidence(result) {
  byId('planner-section').classList.add('has-proposal');
  byId('planner-mode').textContent = result.mode === 'bedrock'
    ? 'Bedrock proposal. Planner made no changes.'
    : 'Mock: no inference, AWS or list changes.';
  const target = byId('planner-result'); target.replaceChildren();
  const explanation = typeof result.explanation === 'string' ? result.explanation.trim() : '';
  const excerpt = explanation.length > 300 ? `${explanation.slice(0, 300).replace(/\s+\S*$/u, '')}…` : explanation;
  if (excerpt) target.append(element('p', excerpt, 'planner-explanation'));
  const readTools = [...new Set((result.trace ?? []).map((entry) => entry.tool ?? entry.name).filter((name) => typeof name === 'string'))];
  if (readTools.length) target.append(element('p', 'Read the meal plan and pantry, then checked the additions. You make the final change.', 'planner-trace-summary'));
  const details = element('details');
  details.append(element('summary', 'Full planner explanation and tool activity'));
  details.append(element('p', result.mode === 'bedrock' ? 'Bedrock planner finished. Nothing was added.' : 'Mock planner finished. No AWS call was made. Nothing was added.', 'result-title'));
  details.append(element('p', result.explanation), element('pre', JSON.stringify({ mode: result.mode, trace: result.trace, receipt: result.receipt }, null, 2)));
  target.append(details);
}
async function restorePlannerPreview() {
  if (!state.planner || state.planner.resultEndpoint !== '/planner/result') return;
  const response = await fetch(state.planner.resultEndpoint, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new RequestFailure('The planner receipt is unavailable. Use the ordinary checklist.');
  const result = await response.json();
  if (result.available === true) {
    if (result.mode !== state.planner.mode || !Number.isInteger(result.days) || result.days < 1 || result.days > 7) throw new RequestFailure('The saved planner preview is invalid. Use the ordinary checklist.');
    state.plannerAttempted = true;
    // A previously completed proposal can be reviewed without repeating paid
    // inference. The unchanged MCP commit route still validates current state.
    if (![...byId('days').options].some(option => Number(option.value) === result.days)) return;
    byId('days').value = String(result.days);
    renderMeals(); renderPreview(result.preview, result.days); renderPlannerEvidence(result);
  } else if (result.attempted === true) {
    state.plannerAttempted = true;
    byId('planner-result').replaceChildren(element('p', 'The single planner attempt has already started or failed. It will not run again automatically. Use the ordinary checklist if no result is available.'));
  }
}
byId('connect').addEventListener('click', () => action('restock-result', async () => {
  const configResponse = await fetch('/demo-config.json', { signal: AbortSignal.timeout(10000) });
  if (configResponse.ok) {
    const config = await configResponse.json();
    const endpoint = new URL(config.mcpEndpoint, location.origin);
    if (typeof config.mcpEndpoint !== 'string' || !config.mcpEndpoint.startsWith('/') || endpoint.origin !== location.origin || endpoint.search || endpoint.hash) throw new RequestFailure('The demo configuration must identify a same-origin MCP path.');
    state.endpoint = endpoint.pathname;
    showPlannerScope(config);
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
  byId('connection-state').textContent = 'Household is open';
  byId('connect').textContent = 'Household open';
  byId('connect').hidden = true;
  byId('connection-help').textContent = state.persistentState ? 'Your list is saved locally.' : 'Resets after restart.';
  setStage('check');
  await restorePlannerPreview();
}, 'Here is the dinner plan. Check what needs adding when you are ready.', { focus: 'preview-restock' }));

byId('run-planner').addEventListener('click', () => {
  if (!state.planner || state.plannerAttempted || state.busy || !state.connected) return;
  state.plannerAttempted = true;
  state.preview = null;
  action('planner-result', async () => {
    const days = Number(byId('days').value);
    let response;
    try {
      response = await fetch(state.planner.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }), signal: AbortSignal.timeout(95000) });
    } catch { throw new RequestFailure('The planner response was lost or timed out. No grocery change was requested. It will not run again automatically; the ordinary checklist remains available.'); }
    let result;
    try { result = await response.json(); }
    catch { throw new RequestFailure('The planner returned an unreadable response. Nothing was added. Use the ordinary checklist.'); }
    if (!response.ok || result.error) throw new RequestFailure(`${result.error?.message ?? 'Planner unavailable.'} Nothing was added. Use the ordinary checklist.`);
    if (result.mode !== state.planner.mode || !result.preview || typeof result.explanation !== 'string') throw new RequestFailure('The planner returned an unexpected result. Adding remains disabled.');
    renderPreview(result.preview, days);
    renderPlannerEvidence(result);
  }, 'Planner proposal ready to review.', { focus: 'preview' });
});

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
  technicalReceipt('restock-result', result);
}, 'Ready to review.', { focus: 'preview' }));
byId('commit-restock').addEventListener('click', () => {
  if (!state.preview || state.preview.days !== Number(byId('days').value)) return;
  const { days, token, keys: previousKeys = [], items: previousItems = [] } = state.preview; state.preview = null;
  action('restock-result', async () => {
    const result = await callTool('restock_for_meals', { days, dry_run: false, expected_token: token }, true);
    const content = result.structuredContent ?? {};
    if (result.isError && content.writeApplied === false && content.dryRun === true && (content.previewChanged || content.previewRequired)) {
      renderPreview(result, days, true);
      const notice = byId('preview').querySelector('.changed-notice');
      if (notice) notice.after(element('p', describeChange(previousKeys, content, previousItems), 'change-summary'));
      showResult('restock-result', result, 'No changes made', 'The list changed. Review the updated preview above and confirm again.');
      // Read-only refresh so the visible list matches the updated review. Never retries the write.
      try { await refreshHousehold(); }
      catch {
        state.preview = null;
        byId('commit-restock').textContent = 'Review items before adding';
        setStage('check');
        byId('preview').append(element('p', 'The updated list could not be loaded. Reload the household, then check the items again before confirming.'));
        showResult('restock-result', result, 'No changes made', 'The updated list could not be loaded. Reload the household, then check what to add again.');
        return 'Nothing was added. The updated list could not be loaded. Reload the household and check again.';
      }
      return 'The household changed. Nothing was added. Review and confirm the updated preview.';
    }
    requireSuccess(result);
    const added = (content.added ?? []).length;
    const names = (content.added ?? []).map((item) => item.name);
    showResult('restock-result', result, `${added} item${added === 1 ? '' : 's'} added to your list`, `${names.length ? `Added ${joinNames(names)}. ` : ''}Nothing was purchased and pantry stock has not changed.`);
    byId('restock-result').classList.add('success-summary');
    byId('commit-restock').textContent = 'Added to your list';
    byId('preview').replaceChildren(element('p', `Added to your list. ${state.persistentState ? 'Confirmed changes are saved locally across restarts.' : 'It resets when the server restarts.'} Check again to see whether anything else needs adding.`));
    const refreshed = await refreshAfterWrite('restock-result');
    setStage(refreshed ? 'done' : 'check');
    return refreshed ? `${(content.added ?? []).length} items added. The list and brief are refreshed.` : `${(content.added ?? []).length} items added, but the updated list could not be loaded. Reload the household to see it. Nothing will be added again automatically.`;
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
  byId('preview').replaceChildren(element('p', 'Adding this item changes the list. Check what to add again afterwards.'));
  action('grocery-result', async () => {
    const result = await callTool('groceries_add', { name, quantity, unit }, true);
    showResult('grocery-result', result, 'Grocery receipt'); requireSuccess(result);
    byId('preview').replaceChildren(element('p', 'Your list changed. Check what to add again before adding more.'));
    const refreshed = await refreshAfterWrite('grocery-result');
    if (!refreshed) return 'Item added, but the updated list could not be loaded. Reload the household to see it. It will not be added again automatically.';
  }, 'Item added to the list. Adding it again increases the quantity again.');
});
byId('pantry-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const item = byId('pantry-item').value.trim();
  action('pantry-result', async () => { const result = await callTool('pantry_query', item ? { item } : {}); showResult('pantry-result', result); requireSuccess(result); }, 'Pantry response received.');
});
byId('load-mealplan').addEventListener('click', () => action('mealplan-result', async () => {
  const result = await callTool('mealplan_get'); showResult('mealplan-result', result); requireSuccess(result);
}, 'Here are the planned ingredients.'));
byId('brief-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action('brief-result', refreshBrief, 'Brief response received. These choices are for this request only.');
});
setStage('start');
