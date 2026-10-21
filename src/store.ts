// Synthetic fixtures only. No household credentials or live controls are connected.
export const SYNTHETIC_DEMO_LABEL = "Synthetic demo: fictional household data.";

export interface PantryItem { name: string; quantity: number; unit: string; lowAt: number; }
export interface GroceryLine { name: string; quantity: number; unit: string; addedBy: string; }
export interface Chore { name: string; assignee: string; dueInDays: number; done: boolean; }
export interface MealPlanEntry { day: string; meal: string; servings: number; missingIngredients: string[]; }
export interface EnsureGroceriesResult { added: GroceryLine[]; alreadyListed: GroceryLine[]; list: GroceryLine[]; }

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
  mealPlan(): Promise<MealPlanEntry[]>;
  chores(): Promise<Chore[]>;
  /** Exact name, or a unique one-direction partial match across open and done chores. */
  logChore(name: string): Promise<Chore | null>;
}

export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
function requireName(value: string, field: string): string {
  const result = norm(value);
  if (!result) throw new Error(`${field} must not be blank.`);
  return result;
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
  const unit = requireName(line.unit, "Unit");
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error("Quantity must be finite and positive.");
  const addedBy = line.addedBy.trim();
  if (!addedBy) throw new Error("Added by must not be blank.");
  return { name, unit, quantity: line.quantity, addedBy };
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
  async pantry() { return structuredClone(this.pantryItems); }
  async groceries() { return structuredClone(this.groceryLines); }
  async addGrocery(line: GroceryLine) {
    const normalized = normalizedLine(line);
    const existing = this.groceryLines.find((entry) => groceryKey(entry) === groceryKey(normalized));
    if (existing) {
      const total = existing.quantity + normalized.quantity;
      if (!Number.isFinite(total)) throw new Error("Combined quantity is too large.");
      existing.quantity = total;
    } else this.groceryLines.push(normalized);
    return structuredClone(this.groceryLines);
  }
  async ensureGroceries(lines: GroceryLine[]): Promise<EnsureGroceriesResult> {
    const normalized = [...new Map(lines.map(normalizedLine).map((line) => [groceryKey(line), line])).values()];
    const added: GroceryLine[] = [];
    const alreadyListed: GroceryLine[] = [];
    // No await between the check and insertion: this batch is atomic in this process.
    for (const line of normalized) {
      const existing = this.groceryLines.find((entry) => groceryKey(entry) === groceryKey(line));
      if (existing) alreadyListed.push(existing);
      else { this.groceryLines.push(line); added.push(line); }
    }
    return structuredClone({ added, alreadyListed, list: this.groceryLines });
  }
  async mealPlan() { return structuredClone(this.meal); }
  async chores() { return structuredClone(this.choreList); }
  async logChore(name: string) {
    const matches = matchChores(this.choreList, requireName(name, "Chore name"));
    if (matches.length !== 1) return null;
    matches[0].done = true;
    return structuredClone(matches[0]);
  }
}
