import type { PlannerModel, PlannerModelResponse } from "./planner.js";

/** Deterministic test double, explicitly disclosed in the UI. Never calls AWS. */
export function createMockModel(): PlannerModel {
  let turn = 0;
  return { async converse(): Promise<PlannerModelResponse> {
    turn++;
    const content = turn === 1 ? [
      { toolUse: { toolUseId: "mock-meals", name: "mealplan_get", input: {} } },
      { toolUse: { toolUseId: "mock-pantry", name: "pantry_query", input: {} } },
    ] : turn === 2 ? [
      { toolUse: { toolUseId: "mock-preview", name: "restock_preview", input: {} } },
    ] : [{ text: "I checked the meal plan and pantry, then requested a dry-run checklist. Review the actual additions below. Only your confirmation changes the shopping list. This is a mock model, not an AWS response." }];
    return {
      output: { message: { role: "assistant", content } },
      stopReason: turn < 3 ? "tool_use" : "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  } };
}
