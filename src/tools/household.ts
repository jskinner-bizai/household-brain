// Household Brain tools: pantry, groceries, meal plan, chores, summary, restock.
// Voice-first: every text reply is written to be spoken by Alexa+; structuredContent
// carries the same data for cards. Tool names are snake_case because LLM tool-calling
// APIs (Bedrock Converse, Anthropic, OpenAI) reject dots, and Alexa's own examples use it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HouseholdStore, MemoryStore, groceryKey, ingredientOnHand, ingredientUnit, looseMatch, matchChores, norm, SYNTHETIC_DEMO_LABEL } from "../store.js";

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const nameSchema = z.string().trim().min(1, "Must not be blank").transform(norm);
const demoText = (text: string) => ({ content: [{ type: "text" as const, text: `${SYNTHETIC_DEMO_LABEL} ${text}` }] });

export function registerHouseholdTools(server: McpServer, store: HouseholdStore = new MemoryStore()): string[] {
  server.registerTool(
    "pantry_query",
    {
      title: "Check the pantry",
      description: "Look up synthetic demo pantry stock by item, or get what's low. No live household data.",
      inputSchema: {
        item: nameSchema.optional().describe("Item name to check, e.g. 'eggs'. Omit to hear what's low."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item }) => {
      const items = await store.pantry();
      if (item && norm(item)) {
        const found = items.find((p) => looseMatch(item, p.name));
        const text = found
          ? `You have ${found.quantity} ${found.unit} of ${found.name}.`
          : `There's no ${norm(item)} listed in the pantry. Want me to add it to the grocery list?`;
        return { ...demoText(text), structuredContent: { demo: true, item: found ?? null } };
      }
      const low = items.filter((p) => p.quantity <= p.lowAt);
      const text = low.length
        ? `Running low: ${low.map((p) => `${p.name} (${p.quantity} ${p.unit} left)`).join(", ")}. Say "restock" to put them on the grocery list.`
        : "Pantry looks healthy. Nothing is running low.";
      return { ...demoText(text), structuredContent: { demo: true, low } };
    }
  );

  server.registerTool(
    "groceries_add",
    {
      title: "Add to grocery list",
      description: "Add an item to the synthetic demo grocery list. Different units stay separate. No purchases or live household changes.",
      inputSchema: {
        name: nameSchema.describe("Item to add"),
        quantity: z.number().finite().positive().default(1).describe("How many"),
        unit: nameSchema.default("each").describe("Unit, e.g. pack, carton, each"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, quantity, unit }) => {
      const lines = await store.addGrocery({ name, quantity, unit, addedBy: "demo voice client (simulated Alexa+)" });
      const text = `Added ${quantity} ${unit} of ${norm(name)}. The list now has ${plural(lines.length, "item")}.`;
      return { ...demoText(text), structuredContent: { demo: true, list: lines } };
    }
  );

  server.registerTool(
    "mealplan_get",
    {
      title: "What's for dinner",
      description: "Reads the synthetic demo meal plan and its ingredient checklist. No live household data.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const plan = await store.mealPlan();
      const spoken = plan.map((m) => `${m.day}: ${m.meal}${m.missingIngredients.length ? `, still need ${m.missingIngredients.join(" and ")}` : ""}`);
      const text = `Here's the plan. ${spoken.join(". ")}.`;
      return { ...demoText(text), structuredContent: { demo: true, plan } };
    }
  );

  server.registerTool(
    "chore_log",
    {
      title: "Log a chore",
      description: "Mark a synthetic demo chore done by exact or unambiguous partial name. No live household changes.",
      inputSchema: { chore: nameSchema.describe("The chore that was finished") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chore }) => {
      const before = await store.chores();
      const matches = matchChores(before, chore);
      if (matches.length > 1) return {
        ...demoText(`Multiple chores match "${chore}": ${matches.map((c) => c.name).join(", ")}. Please use the full chore name.`),
        isError: true, structuredContent: { demo: true, logged: null, matches },
      };
      const match = matches[0];
      const logged = match ? await store.logChore(match.name) : null;
      const list = await store.chores();
      const dueSoon = list.filter((c) => !c.done && c.dueInDays <= 1);
      const parts: string[] = [];
      parts.push(logged ? `${match?.done ? "Already logged" : "Logged"}: ${logged.name}.` : `I couldn't find a chore called "${norm(chore)}".`);
      if (dueSoon.length) parts.push(`Still due soon: ${dueSoon.map((c) => `${c.name} (${c.assignee})`).join(", ")}.`);
      return { ...demoText(parts.join(" ")), ...(!logged ? { isError: true } : {}), structuredContent: { demo: true, logged, dueSoon } };
    }
  );

  server.registerTool(
    "household_summary",
    {
      title: "Household summary",
      description: "One synthetic demo view of low pantry stock, groceries, tonight's meal and open chores. No live household data.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [pantry, groceries, plan, chores] = await Promise.all([
        store.pantry(), store.groceries(), store.mealPlan(), store.chores(),
      ]);
      const low = pantry.filter((p) => p.quantity <= p.lowAt).map((p) => p.name);
      const open = chores.filter((c) => !c.done);
      const text = [
        low.length ? `Pantry low: ${low.join(", ")}.` : "Pantry is stocked.",
        `Grocery list has ${plural(groceries.length, "item")}.`,
        `Tonight: ${plan[0]?.meal ?? "nothing planned"}.`,
        open.length ? `Open chores: ${open.map((c) => `${c.name} (${c.assignee})`).join(", ")}.` : "All chores done.",
      ].join(" ");
      return { ...demoText(text), structuredContent: { demo: true, low, groceryCount: groceries.length, tonight: plan[0] ?? null, openChores: open } };
    }
  );

  // The multi-step workflow: one spoken request reads the meal plan and pantry,
  // works out what's missing, de-dupes against the list, and writes the adds.
  server.registerTool(
    "restock_for_meals",
    {
      title: "Restock for upcoming meals",
      description:
        "Checks synthetic demo meals and pantry, then ensures one unit of each missing ingredient or low staple is on the demo grocery list. Exact name and unit pairs are deduplicated. Use dry_run to preview. Ingredient quantities for servings are not modeled. No purchases or live changes.",
      inputSchema: {
        days: z.number().int().min(1).max(7).default(2).describe("How many planned meals ahead to cover, starting tonight"),
        dry_run: z.boolean().default(false).describe("If true, only say what would be added"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ days, dry_run }) => {
      const [plan, pantry, list] = await Promise.all([store.mealPlan(), store.pantry(), store.groceries()]);
      const wanted = new Map<string, { name: string; unit: string; reason: string }>();
      for (const m of plan.slice(0, days)) {
        for (const ing of m.missingIngredients) {
          if (ingredientOnHand(ing, pantry)) continue;
          const item = { name: norm(ing), unit: ingredientUnit(ing, pantry), reason: `for ${m.meal}` };
          wanted.set(groceryKey(item), item);
        }
      }
      for (const p of pantry.filter((p) => p.quantity <= p.lowAt)) {
        const item = { name: norm(p.name), unit: norm(p.unit), reason: "running low" };
        if (!wanted.has(groceryKey(item))) wanted.set(groceryKey(item), item);
      }
      const previewAlready = [...wanted.values()].filter((w) => list.some((l) => groceryKey(w) === groceryKey(l)));
      const result = dry_run ? undefined : await store.ensureGroceries([...wanted.values()].map((w) => ({
        name: w.name, quantity: 1, unit: w.unit, addedBy: "restock (synthetic Household Brain)",
      })));
      const already = result ? result.alreadyListed.map((line) => wanted.get(groceryKey(line))!) : previewAlready;
      const toAdd = result ? result.added.map((line) => wanted.get(groceryKey(line))!) : [...wanted.values()].filter((w) => !previewAlready.includes(w));
      const verb = dry_run ? "I'd add" : "Added";
      const text = toAdd.length
        ? `${verb} ${plural(toAdd.length, "item")}: ${toAdd.map((w) => w.name).join(", ")}.${already.length ? ` Already on the list: ${already.map((w) => w.name).join(", ")}.` : ""}`
        : "The ingredient checklist is covered: items are on hand or already on the list. Quantities for servings are not modeled.";
      return { ...demoText(text), structuredContent: { demo: true, dryRun: dry_run, added: toAdd, alreadyListed: already } };
    }
  );

  return ["pantry_query", "groceries_add", "mealplan_get", "chore_log", "household_summary", "restock_for_meals"];
}
