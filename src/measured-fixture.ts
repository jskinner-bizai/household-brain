// Authorized factual recipe ingredients; pantry/list/chores are fictional demo fixtures.
// No personal health metrics, preferences, notes or live household connection.
import { MemoryStore, groceryKey, type HouseholdState, type MealPlanEntry } from "./store.js";

export const RECIPE_FACTS_VERIFIED_ON = "2026-10-23";
const recipeMeals: MealPlanEntry[] = [
  {
    "day": "tonight",
    "meal": "Herb chicken, Brussels sprouts and quinoa-walnut pilaf",
    "servings": 4,
    "missingIngredients": [],
    "ingredients": [
      {
        "name": "Bone-in chicken thighs",
        "quantity": 8,
        "unit": "each"
      },
      {
        "name": "Brussels sprouts",
        "quantity": 2,
        "unit": "lb"
      },
      {
        "name": "Cooked quinoa",
        "quantity": 2,
        "unit": "cup"
      },
      {
        "name": "Walnuts",
        "quantity": 0.5,
        "unit": "cup"
      },
      {
        "name": "Extra-virgin olive oil",
        "quantity": 4,
        "unit": "tbsp"
      },
      {
        "name": "Fresh rosemary",
        "quantity": 1,
        "unit": "tbsp"
      },
      {
        "name": "Fresh thyme",
        "quantity": 1,
        "unit": "tbsp"
      },
      {
        "name": "Garlic cloves",
        "quantity": 4,
        "unit": "each"
      }
    ]
  },
  {
    "day": "tomorrow",
    "meal": "Steak fajita bowls with cilantro-lime cauliflower rice",
    "servings": 4,
    "missingIngredients": [],
    "ingredients": [
      {
        "name": "Flank steak",
        "quantity": 1.5,
        "unit": "lb"
      },
      {
        "name": "Bell peppers",
        "quantity": 3,
        "unit": "each"
      },
      {
        "name": "Onions",
        "quantity": 2,
        "unit": "each"
      },
      {
        "name": "Shredded cabbage",
        "quantity": 2,
        "unit": "cup"
      },
      {
        "name": "Cauliflower rice",
        "quantity": 6,
        "unit": "cup"
      },
      {
        "name": "Avocados",
        "quantity": 2,
        "unit": "each"
      },
      {
        "name": "Limes",
        "quantity": 2,
        "unit": "each"
      },
      {
        "name": "Fresh cilantro",
        "quantity": 0.25,
        "unit": "cup"
      },
      {
        "name": "Avocado oil",
        "quantity": 2,
        "unit": "tbsp"
      },
      {
        "name": "Ground cumin",
        "quantity": 2,
        "unit": "tsp"
      },
      {
        "name": "Mild paprika",
        "quantity": 1,
        "unit": "tsp"
      },
      {
        "name": "Garlic cloves",
        "quantity": 2,
        "unit": "each"
      }
    ]
  },
  {
    "day": "next day",
    "meal": "leftovers night",
    "servings": 4,
    "missingIngredients": [],
    "ingredients": []
  }
];

/** A fresh fictional fixture, never an observation of the person's real pantry. */
export function measuredDemoState(): HouseholdState {
  const state = new MemoryStore().snapshot();
  state.meal = structuredClone(recipeMeals);
  const required = new Map<string, { name: string; quantity: number; unit: string; lowAt: number }>();
  for (const meal of recipeMeals) for (const ingredient of meal.ingredients ?? []) {
    const key = groceryKey(ingredient), previous = required.get(key);
    required.set(key, { name: ingredient.name, unit: ingredient.unit,
      quantity: (previous?.quantity ?? 0) + ingredient.quantity, lowAt: 0 });
  }
  // Deliberate synthetic partial stock makes six measured shortfalls visible.
  const partial = new Map<string, number>([
    [groceryKey({ name: "Bone-in chicken thighs", unit: "each" }), 4],
    [groceryKey({ name: "Brussels sprouts", unit: "lb" }), 1],
    [groceryKey({ name: "Flank steak", unit: "lb" }), 0.5],
    [groceryKey({ name: "Bell peppers", unit: "each" }), 1],
    [groceryKey({ name: "Cauliflower rice", unit: "cup" }), 3],
    [groceryKey({ name: "Garlic cloves", unit: "each" }), 4],
  ]);
  for (const [key, quantity] of partial) {
    const item = required.get(key); if (!item) throw new Error("Recipe fixture identity mismatch");
    item.quantity = quantity;
  }
  state.pantryItems = [
    ...required.values(),
    { name: "oat milk", quantity: 2, unit: "carton", lowAt: 1 },
    { name: "eggs", quantity: 12, unit: "each", lowAt: 6 },
    { name: "coffee beans", quantity: 340, unit: "g", lowAt: 200 },
    { name: "rice", quantity: 1500, unit: "g", lowAt: 400 },
    { name: "blueberries", quantity: 0, unit: "pack", lowAt: 1 },
  ];
  state.groceryLines = [{ name: "blueberries", quantity: 2, unit: "pack", addedBy: "fictional household" }];
  return state;
}
