import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "../src/services/chatService";
import { logDebug } from "../src/logging";
import type { ChatHistoryRepository } from "../src/repositories/chatHistoryRepository";
import type { ChatAgent } from "../src/services/chatAgent";
import type { ChatRequest } from "../src/types/chat";
import type { TableauContextProvider } from "../src/tableau/contextProvider";
import type { TableauAdditionalContext } from "../src/types/tableau";

vi.mock("../src/logging", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  safeErrorDetails: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }),
  safeHash: (value: string | undefined) => value ?? "anonymous",
}));

const logDebugMock = vi.mocked(logDebug);

describe("ChatService final answer resolution", () => {
  afterEach(() => {
    logDebugMock.mockReset();
  });

  it("keeps fast-path datasource inventory answers as markdown", async () => {
    const service = createService({
      request: buildFastPathRequest(),
      additionalContext: {
        provider: "mock",
      },
    });

    const response = await service.generateAnswer(buildFastPathRequest());

    expect(response.answer).toContain("## データソース概要");
    expect(response.answer).toContain("X Account Analytics Contents");
  });

  it("uses the query insight template when the selected metric and dimension match", async () => {
    const request = buildRankingRequest();
    const service = createService({
      request,
      additionalContext: buildValidQueryInsightContext(request),
    });

    const response = await service.generateAnswer(request);

    expect(response.answer).toContain("## 結論");
    expect(response.answer).toContain("| 順位 | ポスト | インプレッション数 |");
    expect(getFinalAnswerLog()?.finalAnswerSource).toBe(
      "query_insight_template",
    );
    expect(getFinalAnswerLog()?.queryInsightUsedForFinalAnswer).toBe(true);
    expect(getFinalAnswerLog()?.selectedMetricField).toBe("インプレッション数");
    expect(getFinalAnswerLog()?.selectedDimensionField).toBe("ポストid");
    expect(getFinalAnswerLog()?.answerHasActualQueryResult).toBe(true);
  });

  it("does not overwrite the answer with query insight when the metric mismatches", async () => {
    const request = buildRankingRequest();
    const service = createService({
      request,
      additionalContext: buildMetricMismatchContext(request),
    });

    const response = await service.generateAnswer(request);

    expect(response.answer).toContain("## 回答");
    expect(response.answer).not.toContain("## 結論");
    expect(getFinalAnswerLog()?.finalAnswerSource).toBe("fallback");
    expect(getFinalAnswerLog()?.queryInsightUsedForFinalAnswer).toBe(false);
    expect(getFinalAnswerLog()?.selectedMetricField).toBeNull();
    expect(getFinalAnswerLog()?.answerHasActualQueryResult).toBe(false);
  });

  it("falls back to a markdown explanation when no validated grouped trend result is available", async () => {
    const request = buildGroupedTrendRequest();
    const service = createService({
      request,
      additionalContext: buildNoResultGroupedTrendContext(request),
    });

    const response = await service.generateAnswer(request);

    expect(response.answer).toContain("## 回答できなかった理由");
    expect(response.answer).toContain("ハッシュタグ別のエンゲージメント");
    expect(getFinalAnswerLog()?.finalAnswerSource).toBe("fallback");
    expect(getFinalAnswerLog()?.queryInsightUsedForFinalAnswer).toBe(false);
    expect(getFinalAnswerLog()?.answerHasActualQueryResult).toBe(false);
  });

  it("wraps plain Bedrock output in markdown", async () => {
    const request = buildGenericRequest();
    const service = createService({
      request,
      additionalContext: {
        provider: "mock",
      },
      answerText: "plain bedrock answer",
    });

    const response = await service.generateAnswer(request);

    expect(response.answer).toContain("## 回答");
    expect(response.answer).toContain("plain bedrock answer");
    expect(getFinalAnswerLog()?.finalAnswerSource).toBe("bedrock");
    expect(getFinalAnswerLog()?.markdownValidationPassed).toBe(true);
  });
});

function createService(input: {
  request: ChatRequest;
  additionalContext: TableauAdditionalContext;
  answerText?: string;
}): ChatService {
  const contextProvider: TableauContextProvider = {
    name: input.additionalContext.provider,
    async getAdditionalContext() {
      return input.additionalContext;
    },
  };

  const answerGenerator = {
    name: "mock",
    async generate() {
      return input.answerText ?? "plain answer";
    },
  };

  const repository: ChatHistoryRepository = {
    async save() {},
    async listRecentBySession() {
      return [];
    },
  };

  const chatAgent: ChatAgent = {
    name: "noop",
    shouldRun() {
      return false;
    },
    async createPlan() {
      throw new Error("not expected");
    },
    async evaluateContext() {
      throw new Error("not expected");
    },
  };

  return new ChatService(
    contextProvider,
    answerGenerator,
    repository,
    chatAgent,
  );
}

function buildFastPathRequest(): ChatRequest {
  return {
    question: "このダッシュボードで使われているデータソースを教えてください。",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      dataSources: [{ name: "X Account Analytics Contents" }],
      capturedAt: "2026-06-08T00:00:00.000Z",
    },
  };
}

function buildRankingRequest(): ChatRequest {
  return {
    question:
      "X Account Overview Analytics を使って、2026年5月のインプレッション数が最も多かったポストを教えてください。",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      dataSources: [{ name: "X Account Overview Analytics" }],
      capturedAt: "2026-06-08T00:00:00.000Z",
    },
  };
}

function buildGroupedTrendRequest(): ChatRequest {
  return {
    question:
      "エンゲージメントが高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      dataSources: [{ name: "X Account Analytics Contents" }],
      capturedAt: "2026-06-08T00:00:00.000Z",
    },
  };
}

function buildGenericRequest(): ChatRequest {
  return {
    question: "What is this dashboard?",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-08T00:00:00.000Z",
    },
  };
}

function buildValidQueryInsightContext(
  request: ChatRequest,
): TableauAdditionalContext {
  return {
    provider: "tableau-mcp",
    questionInterpretation: {
      originalQuestion: request.question,
      investigationQuestion: request.question,
      datasourceMentions: ["X Account Overview Analytics"],
      requestType: "general",
      analysisIntent: "ranking",
      metricIntent: "impressions",
      requestedMetricText: "インプレッション数",
      asksForRanking: true,
      topN: 1,
      rankingTarget: "post",
      groupingIntent: "hashtag",
      groupingFieldHint: ["ポストid"],
      period: {
        kind: "month",
        label: "2026年5月",
        startDate: "2026-05-01",
        endDate: "2026-05-31",
        raw: "2026年5月",
        warnings: [],
      },
    },
    queryInsights: [
      {
        datasourceName: "X Account Overview Analytics",
        datasourceLuid: "ds-123",
        dimensionField: "ポストid",
        metricField: "インプレッション数",
        rowCount: 2,
        actualRowCount: 2,
        rows: [
          {
            label: "Post A",
            value: 120,
          },
          {
            label: "Post B",
            value: 80,
          },
        ],
        requestedMetricIntent: "impressions",
        requestedMetricText: "インプレッション数",
        rankingTarget: "post",
        requestedTopN: 1,
        requestedRanking: true,
        requestedPeriodStart: "2026-05-01",
        requestedPeriodEnd: "2026-05-31",
        sourceQuestion: request.question,
        metricMatchConfidence: 1,
        dimensionMatchConfidence: 1,
        fulfillsMetricRequest: true,
        fulfillsRankingRequest: true,
        fulfillsPeriodRequest: true,
        queryDebug: {
          derivedMetricsComputedInApp: [],
        },
      },
    ],
    mcpExecutionDebug: {
      intent: "data_analysis",
      intentConfidence: 0.91,
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 4,
      plannedTools: ["query-datasource"],
      blockedTools: [],
      executedTools: ["query-datasource"],
      skippedTools: [],
      toolCallCount: 1,
      replanUsed: false,
      timingMs: { planning: 1, execution: 2 },
    },
  };
}

function buildMetricMismatchContext(
  request: ChatRequest,
): TableauAdditionalContext {
  return {
    provider: "tableau-mcp",
    questionInterpretation: {
      originalQuestion: request.question,
      investigationQuestion: request.question,
      datasourceMentions: ["X Account Overview Analytics"],
      requestType: "general",
      analysisIntent: "ranking",
      metricIntent: "impressions",
      requestedMetricText: "インプレッション数",
      asksForRanking: true,
      topN: 1,
      rankingTarget: "post",
      period: {
        kind: "month",
        label: "2026年5月",
        startDate: "2026-05-01",
        endDate: "2026-05-31",
        raw: "2026年5月",
        warnings: [],
      },
    },
    queryInsights: [
      {
        datasourceName: "X Account Overview Analytics",
        datasourceLuid: "ds-123",
        dimensionField: "ブックマーク",
        metricField: "ブックマーク",
        rowCount: 1,
        actualRowCount: 1,
        rows: [
          {
            label: "Post A",
            value: 12,
          },
        ],
        requestedMetricIntent: "bookmarks",
        requestedMetricText: "ブックマーク",
        rankingTarget: "post",
        requestedTopN: 1,
        requestedRanking: true,
        requestedPeriodStart: "2026-05-01",
        requestedPeriodEnd: "2026-05-31",
        sourceQuestion: request.question,
        metricMatchConfidence: 0,
        dimensionMatchConfidence: 0,
        fulfillsMetricRequest: false,
        fulfillsRankingRequest: true,
        fulfillsPeriodRequest: true,
        queryDebug: {
          derivedMetricsComputedInApp: [],
        },
      },
    ],
    mcpToolResults: [
      {
        toolName: "query-datasource",
        status: "success",
        summary: "rows returned",
      },
    ],
    mcpExecutionDebug: {
      intent: "data_analysis",
      intentConfidence: 0.91,
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 4,
      plannedTools: ["query-datasource"],
      blockedTools: [],
      executedTools: ["query-datasource"],
      skippedTools: [],
      toolCallCount: 1,
      replanUsed: false,
      timingMs: { planning: 1, execution: 2 },
    },
  };
}

function buildNoResultGroupedTrendContext(
  request: ChatRequest,
): TableauAdditionalContext {
  return {
    provider: "tableau-mcp",
    questionInterpretation: {
      originalQuestion: request.question,
      investigationQuestion: request.question,
      datasourceMentions: ["X Account Analytics Contents"],
      requestType: "general",
      analysisIntent: "grouped_trend",
      metricIntent: "engagements",
      requestedMetricText: "エンゲージメント",
      asksForRanking: true,
      topN: 10,
      rankingTarget: "post",
      groupingIntent: "hashtag",
      groupingFieldHint: ["Hashtag Normalized"],
      period: {
        kind: "month",
        label: "2026年5月",
        startDate: "2026-05-01",
        endDate: "2026-05-31",
        raw: "2026年5月",
        warnings: [],
      },
    },
    queryInsights: [],
    mcpToolResults: [
      {
        toolName: "query-datasource",
        status: "success",
        summary: "rows returned",
      },
    ],
    mcpExecutionDebug: {
      intent: "data_analysis",
      intentConfidence: 0.91,
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 4,
      plannedTools: ["query-datasource"],
      blockedTools: [],
      executedTools: ["query-datasource"],
      skippedTools: [],
      toolCallCount: 1,
      replanUsed: false,
      timingMs: { planning: 1, execution: 2 },
    },
  };
}

function getFinalAnswerLog():
  | (Record<string, unknown> & {
      finalAnswerSource?: string;
      queryInsightUsedForFinalAnswer?: boolean;
      selectedMetricField?: string | null;
      selectedDimensionField?: string | null;
      answerHasActualQueryResult?: boolean;
      markdownValidationPassed?: boolean;
    })
  | undefined {
  const call = logDebugMock.mock.calls.find(
    ([event]) => event === "chat.final_answer.resolved",
  );
  return call?.[1] as
    | (Record<string, unknown> & {
        finalAnswerSource?: string;
        queryInsightUsedForFinalAnswer?: boolean;
        selectedMetricField?: string | null;
        selectedDimensionField?: string | null;
        answerHasActualQueryResult?: boolean;
        markdownValidationPassed?: boolean;
      })
    | undefined;
}
