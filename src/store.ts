// Synthetic fixtures only. No household credentials or live controls are connected.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SYNTHETIC_DEMO_LABEL = "Synthetic demo: fictional household data.";
export const NAME_LIMIT = 80;
export const UNIT_LIMIT = 40;
export const GROCERY_LINE_LIMIT = 200;
export const MIN_QUANTITY = 0.001;
export const MAX_QUANTITY = 10_000;

export interface PantryItem { name: string; quantity: number; unit: string; lowAt: number; }
export interface GroceryLine { name: string; quantity: number; unit: string; addedBy: string; }
export interface Chore { name: string; assignee: string; dueInDays: number; done: boolean; }
export interface MealPlanEntry { day: string; meal: string; servings: number; missingIngredients: string[]; }
export interface EnsureGroceriesResult { added: GroceryLine[]; alreadyListed: GroceryLine[]; list: GroceryLine[]; }
export interface RestockItem { name: string; unit: string; reason: string; }
export interface RestockUnitConflict { name: string; requestedUnit: string; listed: { quantity: number; unit: string }[]; }
export interface RestockResult {
  dryRun: boolean; previewToken: string; added: RestockItem[]; alreadyListed: RestockItem[];
  unitConflicts: RestockUnitConflict[]; writeApplied: boolean;
  previewRequired?: boolean; previewChanged?: boolean;
}

/** A complete transaction candidate; persistence must succeed before publication. */
export interface HouseholdState {
  pantryItems: PantryItem[];
  groceryLines: GroceryLine[];
  meal: MealPlanEntry[];
  choreList: Chore[];
}
export interface MemoryStoreOptions {
  initialState?: HouseholdState;
  beforePublish?: (candidate: HouseholdState) => Promise<void>;
}

export interface HouseholdStore {
  pantry(): Promise<PantryItem[]>;
  groceries(): Promise<GroceryLine[]>;
  addGrocery(line: GroceryLine): Promise<GroceryLine[]>;
  /**
   * Atomically insert absent normalized name+unit pairs without incrementing existing
   * quantities. Validate the whole batch before any mutation. Persistent adapters must
   * preserve this guarantee across concurrent callers, using conditional writes or a
   * transaction rather than a separate read followed by unconditional additions.
   */
  ensureGroceries(lines: GroceryLine[]): Promise<EnsureGroceriesResult>;
  /**
   * Preview or atomically validate and commit a restock plan. Every commit requires
   * the token issued by a preview of the same decision-relevant state and days.
   * A missing/stale token returns a fresh read-only plan and never writes. Adapters
   * must serialize ALL relevant writes with snapshot validation and batch insertion.
   * Tokens are optimistic concurrency control, not authentication or authorization.
   */
  restockForMeals(days: number, dryRun: boolean, expectedToken?: string): Promise<RestockResult>;
  mealPlan(): Promise<MealPlanEntry[]>;
  chores(): Promise<Chore[]>;
  /** Exact name, or a unique one-direction partial match across open and done chores. */
  logChore(name: string): Promise<Chore | null>;
}

export const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
export function normalizedText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  if (value.length > maxLength * 4 + 32) throw new Error(`${field} input is too long.`);
  const result = norm(value);
  if (!result) throw new Error(`${field} must not be blank.`);
  // Visible Unicode letters, accents, punctuation and symbols are supported.
  // Control/format and default-ignorable characters are excluded deliberately,
  // including bidi overrides, joiners and variation selectors. This also excludes
  // some legitimate emoji/text sequences; it is not complete spoof prevention.
  // Do not silently strip invisible text into a different stored identity.
  const hidden = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
  if (hidden.test(value) || hidden.test(result)) throw new Error(`${field} must not contain control or invisible characters.`);
  if ([...result].length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters after normalization.`);
  return result;
}
function requireName(value: string, field: string): string { return normalizedText(value, field, NAME_LIMIT); }
export function normalizedQuantity(value: number): number {
  if (!Number.isFinite(value) || value < MIN_QUANTITY || value > MAX_QUANTITY) throw new Error(`Quantity must be finite and positive, between ${MIN_QUANTITY} and ${MAX_QUANTITY}.`);
  const scaled = value * 1000;
  if (Math.abs(scaled - Math.round(scaled)) > 0.000001) throw new Error("Quantity supports at most three decimal places.");
  return Math.round(scaled) / 1000;
}
export const groceryKey = (line: { name: string; unit: string }) => JSON.stringify([norm(line.name), norm(line.unit)]);

// A longer spoken phrase must not match a shorter stored name, such as a negation.
export function looseMatch(spoken: string, stored: string): boolean {
  const name = norm(spoken);
  return !!name && norm(stored).includes(name);
}
export function matchChores(chores: Chore[], spoken: string): Chore[] {
  const name = norm(spoken);
  if (!name) return [];
  const exact = chores.filter((chore) => norm(chore.name) === name);
  return exact.length ? exact : chores.filter((chore) => looseMatch(name, chore.name));
}

function normalizedLine(line: GroceryLine): GroceryLine {
  const name = requireName(line.name, "Item name");
  const unit = normalizedText(line.unit, "Unit", UNIT_LIMIT);
  const quantity = normalizedQuantity(line.quantity);
  const addedBy = normalizedText(line.addedBy, "Added by", NAME_LIMIT);
  return { name, unit, quantity, addedBy };
}

// Meal fixtures have no required quantities. Exact positive stock means on hand;
// restocking requests one unit per missing ingredient, without claiming serving coverage.
export function ingredientUnit(name: string, pantry: PantryItem[]): string {
  return norm(pantry.find((item) => norm(item.name) === norm(name))?.unit ?? "each");
}
export function ingredientOnHand(name: string, pantry: PantryItem[]): boolean {
  return pantry.some((item) => norm(item.name) === norm(name) && item.quantity > 0);
}

export class MemoryStore implements HouseholdStore {
  private stateQueue: Promise<void> = Promise.resolve();
  private previewNonce = randomBytes(32).toString("hex");
  private withStateLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.stateQueue.then(operation);
    this.stateQueue = result.then(() => {}, () => {});
    return result;
  }
  private pantryItems: PantryItem[] = [
    { name: "oat milk", quantity: 1, unit: "carton", lowAt: 1 },
    { name: "eggs", quantity: 4, unit: "each", lowAt: 6 },
    { name: "coffee beans", quantity: 340, unit: "g", lowAt: 200 },
    { name: "rice", quantity: 1500, unit: "g", lowAt: 400 },
    { name: "blueberries", quantity: 0, unit: "pack", lowAt: 1 },
  ];
  private groceryLines: GroceryLine[] = [{ name: "blueberries", quantity: 2, unit: "pack", addedBy: "Maya (fictional)" }];
  private meal: MealPlanEntry[] = [
    { day: "tonight", meal: "sheet-pan salmon with rice and greens", servings: 4, missingIngredients: ["salmon fillets", "broccoli"] },
    { day: "tomorrow", meal: "black bean tacos", servings: 4, missingIngredients: ["tortillas", "limes"] },
    { day: "Wednesday", meal: "leftovers night", servings: 4, missingIngredients: [] },
  ];
  private choreList: Chore[] = [
    { name: "take out recycling", assignee: "Maya (fictional)", dueInDays: 1, done: false },
    { name: "water the plants", assignee: "Leo (fictional)", dueInDays: 2, done: false },
    { name: "refill dog bowl", assignee: "Dad (fictional)", dueInDays: 0, done: false },
  ];
  constructor(private readonly options: MemoryStoreOptions = {}) {
    if (options.initialState) this.publish(structuredClone(options.initialState));
  }
  /** Returns detached data for a durable adapter's initial snapshot. */
  snapshot(): HouseholdState {
    return structuredClone({ pantryItems: this.pantryItems, groceryLines: this.groceryLines, meal: this.meal, choreList: this.choreList });
  }
  private publish(candidate: HouseholdState): void {
    this.pantryItems = candidate.pantryItems;
    this.groceryLines = candidate.groceryLines;
    this.meal = candidate.meal;
    this.choreList = candidate.choreList;
  }
  private async commit(candidate: HouseholdState): Promise<void> {
    // Never expose a candidate, even to readers, until its durable write succeeds.
    // A rejected write leaves both the published state and preview token unchanged.
    await this.options.beforePublish?.(structuredClone(candidate));
    this.publish(candidate);
  }
  async pantry() { return structuredClone(this.pantryItems); }
  async groceries() { return structuredClone(this.groceryLines); }
  async addGrocery(line: GroceryLine) {
    const normalized = normalizedLine(line);
    return this.withStateLock(async () => {
      const candidate = this.snapshot();
      const existing = candidate.groceryLines.find((entry) => groceryKey(entry) === groceryKey(normalized));
      if (existing) {
        const total = Math.round((existing.quantity + normalized.quantity) * 1000) / 1000;
        if (!Number.isFinite(total) || total > MAX_QUANTITY) throw new Error("Combined quantity is too large; the limit is 10000 per name and unit.");
        existing.quantity = total;
      } else {
        if (candidate.groceryLines.length >= GROCERY_LINE_LIMIT) throw new Error(`The grocery list is limited to ${GROCERY_LINE_LIMIT} lines.`);
        candidate.groceryLines.push(normalized);
      }
      await this.commit(candidate);
      return structuredClone(candidate.groceryLines);
    });
  }
  async ensureGroceries(lines: GroceryLine[]): Promise<EnsureGroceriesResult> {
    return this.withStateLock(async () => {
      const candidate = this.snapshot();
      const result = this.ensureGroceriesUnlocked(candidate, lines);
      if (result.added.length) await this.commit(candidate);
      return result;
    });
  }
  private ensureGroceriesUnlocked(candidate: HouseholdState, lines: GroceryLine[]): EnsureGroceriesResult {
    if (lines.length > GROCERY_LINE_LIMIT) throw new Error(`A grocery batch is limited to ${GROCERY_LINE_LIMIT} lines.`);
    const normalized = [...new Map(lines.map(normalizedLine).map((line) => [groceryKey(line), line])).values()];
    const newCount = normalized.filter((line) => !candidate.groceryLines.some((entry) => groceryKey(entry) === groceryKey(line))).length;
    if (candidate.groceryLines.length + newCount > GROCERY_LINE_LIMIT) throw new Error(`The grocery list is limited to ${GROCERY_LINE_LIMIT} lines.`);
    const added: GroceryLine[] = [];
    const alreadyListed: GroceryLine[] = [];
    // Validate the whole batch and capacity before the first mutation. No await
    // between checks and insertion; caller also owns the per-store state lock.
    for (const line of normalized) {
      const existing = candidate.groceryLines.find((entry) => groceryKey(entry) === groceryKey(line));
      if (existing) alreadyListed.push(existing);
      else { candidate.groceryLines.push(line); added.push(line); }
    }
    return structuredClone({ added, alreadyListed, list: candidate.groceryLines });
  }
  async restockForMeals(days: number, dryRun: boolean, expectedToken?: string): Promise<RestockResult> {
    if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error("Meals to cover must be an integer from 1 to 7.");
    if (typeof dryRun !== "boolean") throw new Error("dryRun must be a boolean.");
    return this.withStateLock(async () => {
      // Reads may be asynchronous for an adapter, so the lock is held across the
      // entire snapshot. All MemoryStore writers acquire this same lock.
      const [plan, pantry, list] = await Promise.all([this.mealPlan(), this.pantry(), this.groceries()]);
      const token = createHash("sha256").update(JSON.stringify({ nonce: this.previewNonce, days, plan, pantry, list })).digest("hex");
      const wanted = new Map<string, RestockItem>();
      for (const meal of plan.slice(0, days)) {
        for (const ingredient of meal.missingIngredients) {
          if (ingredientOnHand(ingredient, pantry)) continue;
          const item = { name: requireName(ingredient, "Ingredient"), unit: normalizedText(ingredientUnit(ingredient, pantry), "Unit", UNIT_LIMIT), reason: `for ${meal.meal}` };
          wanted.set(groceryKey(item), item);
        }
      }
      for (const item of pantry.filter((entry) => entry.quantity <= entry.lowAt)) {
        const candidate = { name: requireName(item.name, "Item name"), unit: normalizedText(item.unit, "Unit", UNIT_LIMIT), reason: "running low" };
        if (!wanted.has(groceryKey(candidate))) wanted.set(groceryKey(candidate), candidate);
      }
      const alreadyListed = [...wanted.values()].filter((item) => list.some((line) => groceryKey(item) === groceryKey(line)));
      const added = [...wanted.values()].filter((item) => !alreadyListed.includes(item));
      const unitConflicts = added.flatMap((item) => {
        const otherUnits = list.filter((line) => norm(line.name) === item.name && norm(line.unit) !== item.unit);
        return otherUnits.length ? [{ name: item.name, requestedUnit: item.unit, listed: otherUnits.map(({ quantity, unit }) => ({ quantity, unit })) }] : [];
      });
      const preview: RestockResult = { dryRun: true, previewToken: token, added, alreadyListed, unitConflicts, writeApplied: false };
      if (dryRun) return structuredClone(preview);
      if (typeof expectedToken !== "string" || !/^[a-f0-9]{64}$/.test(expectedToken)) return structuredClone({ ...preview, previewRequired: true });
      if (!timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expectedToken, "hex"))) return structuredClone({ ...preview, previewChanged: true });
      // Snapshot validation and all-or-nothing insertion share this lock. Nothing
      // can interleave after the token check or bypass it on the MCP commit route.
      const candidate = this.snapshot();
      const result = this.ensureGroceriesUnlocked(candidate, [...wanted.values()].map((item) => ({ name: item.name, unit: item.unit, quantity: 1, addedBy: "restock (synthetic Household Brain)" })));
      if (result.added.length) await this.commit(candidate);
      return structuredClone({ ...preview, dryRun: false, added: result.added.map((line) => wanted.get(groceryKey(line))!), alreadyListed: result.alreadyListed.map((line) => wanted.get(groceryKey(line))!), writeApplied: result.added.length > 0 });
    });
  }
  async mealPlan() { return structuredClone(this.meal); }
  async chores() { return structuredClone(this.choreList); }
  async logChore(name: string) {
    const normalized = requireName(name, "Chore name");
    return this.withStateLock(async () => {
      const candidate = this.snapshot();
      const matches = matchChores(candidate.choreList, normalized);
      if (matches.length !== 1) return null;
      matches[0].done = true;
      await this.commit(candidate);
      return structuredClone(matches[0]);
    });
  }
}
