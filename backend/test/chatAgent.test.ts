import { describe, expect, it } from "vitest";
import {
  runLightweightAgentLoop,
  type ChatAgent,
} from "../src/services/chatAgent";
import type {
  GetAdditionalContextInput,
  TableauContextProvider,
} from "../src/tableau/contextProvider";
import type { AgentEvaluation, AgentPlan } from "../src/types/agent";
import type { ChatRequest } from "../src/types/chat";

const datasourceName = "Tableau Public Per Day(2025/04-)";
const favoritesRankingQuestion =
  "2026\u5e745\u6708\u306b\u6700\u3082Favorite\u3092\u96c6\u3081\u305fViz\u3092\u30e9\u30f3\u30ad\u30f3\u30b0\u5f62\u5f0f\u3067\u898b\u305b\u3066\u304f\u3060\u3055\u3044\u3002";
const explicitTop10FavoritesQuestion =
  "\u95a2\u9023\u30c7\u30fc\u30bf\u30bd\u30fc\u30b9\u306e\u30e1\u30bf\u30c7\u30fc\u30bf\u3092\u78ba\u8a8d\u3057\u305f\u3046\u3048\u3067Favorite\u6570\u3092\u96c6\u8a08\u3057\u3066\u304f\u3060\u3055\u3044\u3002";
const refinedFavoritesFollowUpQuestion =
  "\u95a2\u9023\u30c7\u30fc\u30bf\u30bd\u30fc\u30b9\u306e\u30e1\u30bf\u30c7\u30fc\u30bf\u3068Favorite\u6570\u3092\u78ba\u8a8d\u3057\u30012026\u5e745\u6708\u306eTop10\u3092\u96c6\u8a08\u3057\u3066\u304f\u3060\u3055\u3044\u3002";

const request: ChatRequest = {
  question: favoritesRankingQuestion,
  dashboardContext: {
    dashboardName: "Statistics",
    workbookName: "Tableau Public Insights",
    worksheets: [{ name: "Views" }],
    filters: [],
    parameters: [],
    dataSources: [{ name: datasourceName }],
    capturedAt: "2026-06-04T00:00:00.000Z",
  },
  clientContext: {
    source: "tableau-extension",
    appVersion: "0.1.0",
  },
};

describe("runLightweightAgentLoop", () => {
  it("passes the original semantic interpretation while keeping the rewritten planning question", async () => {
    const inputs: GetAdditionalContextInput[] = [];
    const contextProvider: TableauContextProvider = {
      name: "tableau-mcp",
      async getAdditionalContext(input) {
        inputs.push(input);
        return {
          provider: "tableau-mcp",
          warnings: [],
          mcpExecutionDebug: {
            intent: "data_analysis",
            intentConfidence: 0.91,
            answerableFromDashboardContext: false,
            needsMcp: true,
            maxToolCalls: 4,
            plannedTools: ["list-datasources", "query-datasource"],
            blockedTools: [],
            executedTools: ["list-datasources"],
            skippedTools: [],
            toolCallCount: 1,
            replanUsed: false,
            timingMs: { planning: 1, execution: 2 },
          },
        };
      },
    };
    const plan: AgentPlan = {
      intent: "data_analysis",
      confidence: 0.92,
      normalizedQuestion:
        "2026\u5e745\u6708\u306eFavorite\u6570\u304c\u9ad8\u3044Viz\u3092Top10\u307e\u3067\u96c6\u8a08\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
      needsMcp: true,
      answerStyle: "ranking",
      reasonBrief:
        "The original request is ambiguous, so make the ranking target explicit.",
      requiredEvidence: ["datasource-backed aggregate ranking"],
    };
    const agent: ChatAgent = {
      name: "stub-agent",
      shouldRun() {
        return true;
      },
      async createPlan() {
        return { plan, source: "heuristic" };
      },
      async evaluateContext() {
        return undefined;
      },
    };

    const result = await runLightweightAgentLoop({
      agent,
      contextProvider,
      request,
      recentHistory: [],
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.question).toBe(request.question);
    expect(inputs[0]?.planningQuestion).toBe(plan.normalizedQuestion);
    expect(inputs[0]?.questionInterpretation?.metricIntent).toBe("favorites");
    expect(inputs[0]?.questionInterpretation?.topN).toBe(1);
    expect(inputs[0]?.questionInterpretation?.period?.label).toBe(
      "2026\u5e745\u6708",
    );
    expect(inputs[0]?.questionInterpretation?.investigationQuestion).toBe(
      plan.normalizedQuestion,
    );
    expect(inputs[0]?.intentHint?.intent).toBe("data_analysis");
    expect(result.promptContext.investigationQuestion).toBe(
      plan.normalizedQuestion,
    );
    expect(result.debug?.planSource).toBe("heuristic");
  });

  it("keeps the original metric intent across follow-up passes and merges results", async () => {
    const inputs: GetAdditionalContextInput[] = [];
    let callCount = 0;
    const contextProvider: TableauContextProvider = {
      name: "tableau-mcp",
      async getAdditionalContext(input) {
        inputs.push(input);
        callCount += 1;
        if (callCount === 1) {
          return {
            provider: "tableau-mcp",
            warnings: ["metadata missing"],
            datasourceFieldProfiles: [],
            mcpExecutionDebug: {
              intent: "metadata_lookup",
              intentConfidence: 0.81,
              answerableFromDashboardContext: false,
              needsMcp: true,
              maxToolCalls: 5,
              plannedTools: ["list-datasources"],
              blockedTools: [],
              executedTools: ["list-datasources"],
              skippedTools: [],
              toolCallCount: 1,
              replanUsed: false,
              timingMs: { planning: 1, execution: 2 },
            },
          };
        }

        return {
          provider: "tableau-mcp",
          warnings: [],
          queryInsights: [
            {
              datasourceName,
              datasourceLuid: "ds-123",
              metricField: "workbook_favoriteCount",
              rowCount: 1,
              actualRowCount: 1,
              rows: [{ label: "Viz A", value: 120 }],
              requestedMetricIntent: "favorites",
              requestedRanking: true,
              requestedTopN: 10,
            },
          ],
          mcpExecutionDebug: {
            intent: "data_analysis",
            intentConfidence: 0.88,
            answerableFromDashboardContext: false,
            needsMcp: true,
            maxToolCalls: 5,
            plannedTools: ["get-datasource-metadata", "query-datasource"],
            blockedTools: [],
            executedTools: ["get-datasource-metadata", "query-datasource"],
            skippedTools: [],
            toolCallCount: 2,
            replanUsed: true,
            timingMs: { planning: 2, execution: 4 },
          },
        };
      },
    };
    const plan: AgentPlan = {
      intent: "metadata_lookup",
      confidence: 0.9,
      normalizedQuestion: explicitTop10FavoritesQuestion,
      needsMcp: true,
      answerStyle: "summary",
      reasonBrief: "Need metadata before answering safely.",
      requiredEvidence: ["datasource metadata", "field list"],
    };
    const evaluations: AgentEvaluation[] = [
      {
        isSufficient: false,
        confidence: 0.72,
        reasonBrief: "Metadata is still missing.",
        missingEvidence: ["datasource metadata"],
        followUpQuestion: refinedFavoritesFollowUpQuestion,
      },
      {
        isSufficient: true,
        confidence: 0.94,
        reasonBrief: "A datasource-backed aggregate result is now available.",
        missingEvidence: [],
      },
    ];
    const agent: ChatAgent = {
      name: "stub-agent",
      shouldRun() {
        return true;
      },
      async createPlan() {
        return { plan, source: "heuristic" };
      },
      async evaluateContext() {
        return evaluations.shift();
      },
    };

    const result = await runLightweightAgentLoop({
      agent,
      contextProvider,
      request,
      recentHistory: [],
    });

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.planningQuestion).toContain("Favorite");
    expect(inputs[1]?.questionInterpretation?.metricIntent).toBe("favorites");
    expect(inputs[1]?.questionInterpretation?.topN).toBe(1);
    expect(result.additionalContext.queryInsights?.[0]?.rows[0]?.label).toBe(
      "Viz A",
    );
    expect(result.additionalContext.mcpExecutionDebug?.toolCallCount).toBe(3);
    expect(result.debug?.passCount).toBe(2);
    expect(result.promptContext.evaluationSummary).toContain("sufficient=true");
  });

  it("stops replanning when the second pass adds no meaningful progress", async () => {
    const inputs: GetAdditionalContextInput[] = [];
    const contextProvider: TableauContextProvider = {
      name: "tableau-mcp",
      async getAdditionalContext(input) {
        inputs.push(input);
        return {
          provider: "tableau-mcp",
          warnings: ["metadata missing"],
          mcpExecutionDebug: {
            intent: "metadata_lookup",
            intentConfidence: 0.81,
            answerableFromDashboardContext: false,
            needsMcp: true,
            maxToolCalls: 5,
            plannedTools: ["list-datasources"],
            blockedTools: ["get-datasource-metadata"],
            executedTools: ["list-datasources"],
            skippedTools: [],
            toolCallCount: 1,
            replanUsed: true,
            timingMs: { planning: 1, execution: 2 },
          },
        };
      },
    };
    const plan: AgentPlan = {
      intent: "metadata_lookup",
      confidence: 0.9,
      normalizedQuestion: explicitTop10FavoritesQuestion,
      needsMcp: true,
      answerStyle: "summary",
      reasonBrief: "Need metadata before answering safely.",
      requiredEvidence: ["datasource metadata", "field list"],
    };
    const agent: ChatAgent = {
      name: "stub-agent",
      shouldRun() {
        return true;
      },
      async createPlan() {
        return { plan, source: "heuristic" };
      },
      async evaluateContext() {
        return {
          isSufficient: false,
          confidence: 0.61,
          reasonBrief: "Still missing metadata.",
          missingEvidence: ["datasource metadata"],
          followUpQuestion: refinedFavoritesFollowUpQuestion,
        };
      },
    };

    const result = await runLightweightAgentLoop({
      agent,
      contextProvider,
      request,
      recentHistory: [],
    });

    expect(inputs).toHaveLength(2);
    expect(result.debug?.fallbackReason).toBe(
      "agent_no_progress_replan_stopped",
    );
  });
});
