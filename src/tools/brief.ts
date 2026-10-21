// Synthetic morning brief, computed from the same demo store the tools write to.
// Weather, calendar and home are fictional fixtures. No live sources are connected.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HouseholdStore, groceryKey, ingredientOnHand, ingredientUnit, norm, SYNTHETIC_DEMO_LABEL } from "../store.js";

export interface BriefPreferences { detail: "headline" | "standard" | "deep"; topics: string[]; }
export interface BriefSource { name: string; summarize(pref: BriefPreferences): Promise<string>; }
class FixtureSource implements BriefSource {
  constructor(public name: string, private block: (pref: BriefPreferences) => string) {}
  async summarize(pref: BriefPreferences) { return this.block(pref); }
}
const weather = new FixtureSource("weather", (p) => p.detail === "headline"
  ? "Sample weather: 68 degrees Fahrenheit, clearing by 10am."
  : "Sample weather: 68 degrees Fahrenheit, low clouds clearing by 10am, high 74 degrees Fahrenheit. Example air quality: good. Example rain risk: none.");
const calendar = new FixtureSource("calendar", () =>
  "Calendar: 2 fictional events. 9:30am sample standup (15m), 2:00pm sample design review (45m). Example focus window: 10:00 to 11:30.");
const home = new FixtureSource("home", () =>
  "Home: fictional doors locked and garage closed. Demo bedroom: 66 degrees Fahrenheit. Simulated vacuum finished its sample run at 06:40. No live device state is available.");

export function householdSource(store: HouseholdStore): BriefSource {
  return {
    name: "household",
    async summarize(pref) {
      const [plan, pantry, groceries, chores] = await Promise.all([store.mealPlan(), store.pantry(), store.groceries(), store.chores()]);
      const tonight = plan[0];
      const low = pantry.filter((p) => p.quantity <= p.lowAt).map((p) => p.name);
      const due = chores.filter((c) => !c.done && c.dueInDays <= 1);
      const parts: string[] = [];
      if (tonight) {
        parts.push(`Dinner ${tonight.day} is ${tonight.meal}`);
        const missing = [...new Set(tonight.missingIngredients.map(norm))].filter((name) => !ingredientOnHand(name, pantry));
        const onList = missing.filter((name) => groceries.some((line) => groceryKey(line) === groceryKey({ name, unit: ingredientUnit(name, pantry) })));
        const toGet = missing.filter((name) => !onList.includes(name));
        if (toGet.length) parts[parts.length - 1] += `, and you still need ${toGet.join(" and ")}`;
        if (onList.length) parts.push(`On the grocery list for dinner: ${onList.join(" and ")}`);
      }
      if (low.length && pref.detail !== "headline") parts.push(`Running low on ${low.join(", ")}`);
      if (due.length) parts.push(`Due today or tomorrow: ${due.map((c) => `${c.name} for ${c.assignee}`).join(", ")}`);
      return parts.length ? `Household: ${parts.join(". ")}.` : "Household: nothing needs attention.";
    },
  };
}

export function registerBriefTools(server: McpServer, store?: HouseholdStore): string[] {
  const sources: BriefSource[] = [...(store ? [householdSource(store)] : []), weather, calendar, home];
  server.registerTool("brief_get", {
    title: "Get the daily brief",
    description: "Builds a synthetic demo morning brief from fictional household, weather, calendar and home fixtures. Reflects grocery and chore changes in the demo store. No live sources are connected.",
    inputSchema: {
      detail: z.enum(["headline", "standard", "deep"]).default("standard").describe("How much detail to speak"),
      topics: z.array(z.string().trim().min(1).transform(norm)).optional().describe("Restrict to these source names; omit for all"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ detail = "standard", topics }) => {
    const pref: BriefPreferences = { detail, topics: topics ?? sources.map((s) => s.name) };
    const picked = sources.filter((s) => pref.topics.includes(s.name));
    if (!picked.length) return {
      content: [{ type: "text", text: `${SYNTHETIC_DEMO_LABEL} No requested topics match. Available sources: ${sources.map((s) => s.name).join(", ")}.` }],
      isError: true, structuredContent: { demo: true, sections: [] },
    };
    const sections = await Promise.all(picked.map((s) => s.summarize(pref)));
    return {
      content: [{ type: "text", text: `${SYNTHETIC_DEMO_LABEL}\nYour morning brief:\n${sections.map((s) => `* ${s}`).join("\n")}` }],
      structuredContent: { demo: true, sections: picked.map((s, i) => ({ source: s.name, text: sections[i] })) },
    };
  });
  server.registerTool("brief_preferences", {
    title: "Brief preferences",
    description: "Lists synthetic demo briefing sources and defaults. No live sources are connected.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const prefs = { demo: true, dataSource: "synthetic fixtures", liveConnections: false, notice: SYNTHETIC_DEMO_LABEL, availableSources: sources.map((s) => s.name), defaultDetail: "standard", spokenAt: "on demand (no scheduler is connected)" };
    return { content: [{ type: "text", text: JSON.stringify(prefs) }], structuredContent: prefs };
  });
  return ["brief_get", "brief_preferences"];
}
