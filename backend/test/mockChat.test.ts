import { describe, expect, it } from "vitest";
import { InMemoryChatHistoryRepository } from "../src/repositories/chatHistoryRepository";
import type { AnswerGenerator } from "../src/services/answerGenerator";
import { MockAnswerGenerator } from "../src/services/answerGenerator";
import {
  buildStructuredDataAnalysisAnswer,
  ChatService,
  finalizeUserFacingAnswer,
  sanitizeUserFacingAnswer,
} from "../src/services/chatService";
import { interpretQuestion } from "../src/services/questionInterpretation";
import { MockTableauContextProvider } from "../src/tableau/mockTableauContextProvider";
import type { AuthenticatedUser } from "../src/types/auth";

describe("ChatService with mock provider", () => {
  it("returns a context-based answer and saves chat history", async () => {
    const repository = new InMemoryChatHistoryRepository();
    const service = new ChatService(
      new MockTableauContextProvider(),
      new MockAnswerGenerator(),
      repository,
    );

    const response = await service.generateAnswer({
      question: "Summarize this dashboard",
      dashboardContext: {
        dashboardName: "Mock Dashboard",
        workbookName: "Mock Workbook",
        worksheets: [{ name: "Sheet 1" }, { name: "Sheet 2" }],
        filters: [],
        parameters: [],
        capturedAt: new Date().toISOString(),
      },
      clientContext: {
        source: "tableau-extension",
      },
    });

    expect(response.answer).toContain("Sheet 1, Sheet 2");
    expect(response.debug?.usedMock).toBe(true);
    expect(response.debug?.tableauContextProvider).toBe("mock");
    expect(repository.getAll()).toHaveLength(1);
  });

  it("reuses recent session history only for the same authenticated user", async () => {
    const repository = new InMemoryChatHistoryRepository();
    const provider = new MockTableauContextProvider();
    const userA: AuthenticatedUser = {
      userId: "user-a",
      email: "user-a@example.com",
      tableauSubject: "user-a@example.com",
      tokenUse: "id",
    };
    const userB: AuthenticatedUser = {
      userId: "user-b",
      email: "user-b@example.com",
      tableauSubject: "user-b@example.com",
      tokenUse: "id",
    };

    let callCount = 0;
    const answerGenerator: AnswerGenerator = {
      name: "mock",
      async generate({ prompt }) {
        callCount += 1;
        return callCount === 1 ? "First answer" : prompt;
      },
    };

    const service = new ChatService(provider, answerGenerator, repository);
    const dashboardContext = {
      dashboardName: "Mock Dashboard",
      workbookName: "Mock Workbook",
      worksheets: [{ name: "Sheet 1" }],
      filters: [],
      parameters: [],
      capturedAt: new Date().toISOString(),
    };

    const firstResponse = await service.generateAnswer(
      {
        question: "First question",
        dashboardContext,
        clientContext: {
          source: "tableau-extension",
        },
      },
      userA,
    );

    const secondResponse = await service.generateAnswer(
      {
        question: "Second question",
        dashboardContext,
        clientContext: {
          source: "tableau-extension",
        },
        sessionId: firstResponse.sessionId,
      },
      userA,
    );

    expect(secondResponse.answer).toContain(
      "Recent conversation in the same authenticated session:",
    );
    expect(secondResponse.answer).toContain("Turn 1 user: First question");
    expect(secondResponse.answer).toContain("Turn 1 assistant: ## 回答");
    expect(secondResponse.answer).toContain("First answer");

    const otherUserResponse = await service.generateAnswer(
      {
        question: "Third question",
        dashboardContext,
        clientContext: {
          source: "tableau-extension",
        },
        sessionId: firstResponse.sessionId,
      },
      userB,
    );

    expect(otherUserResponse.answer).not.toContain(
      "Turn 1 user: First question",
    );
    expect(otherUserResponse.answer).not.toContain("First answer");
  });

  it("sanitizes internal tool instructions in metadata-unavailable answers", () => {
    const sanitized = sanitizeUserFacingAnswer(
      "get-datasource-metadata and query-datasource need datasource-id",
      {
        question:
          "このダッシュボードで使われているデータソースのフィールドを説明して",
        dashboardContext: {
          dashboardName: "Statistics",
          workbookName: "Tableau Public Insights",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: new Date().toISOString(),
        },
      },
      {
        provider: "tableau-mcp",
        normalizedContext: {
          dashboard: { name: "Statistics" },
          workbook: { type: "workbook", name: "Tableau Public Insights" },
          views: [],
          datasources: [
            { type: "datasource", name: "Tableau Public Per Day(2025/04-)" },
          ],
          projects: [],
        },
        mcpExecutionDebug: {
          intent: "metadata_lookup",
          intentConfidence: 0.9,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 5,
          plannedTools: [],
          blockedTools: [],
          executedTools: [],
          skippedTools: [],
          toolCallCount: 0,
          replanUsed: true,
          timingMs: { planning: 0, execution: 0 },
        },
        metadata: { hasMetadata: false },
      },
    );

    expect(sanitized).not.toContain("get-datasource-metadata");
    expect(sanitized).not.toContain("query-datasource");
    expect(sanitized).not.toContain("datasource-id");
    expect(sanitized).toContain(
      "このダッシュボードで確認できているデータソース",
    );
  });

  it("replaces hallucinated datasource fields with strict metadata-backed field list", () => {
    const sanitized = sanitizeUserFacingAnswer(
      [
        "| field | type |",
        "| --- | --- |",
        "| workbook_title | string |",
        "| workbook_reactionCounts_LAUGH | number |",
      ].join("\n"),
      {
        question: "このデータソースのフィールドを説明して",
        dashboardContext: {
          dashboardName: "Statistics",
          workbookName: "Tableau Public Insights",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: new Date().toISOString(),
        },
      },
      {
        provider: "tableau-mcp",
        normalizedContext: {
          dashboard: { name: "Statistics" },
          workbook: { type: "workbook", name: "Tableau Public Insights" },
          views: [],
          datasources: [
            { type: "datasource", name: "Tableau Public Per Day(2025/04-)" },
          ],
          projects: [],
        },
        datasourceFieldProfiles: [
          {
            datasourceName: "Tableau Public Per Day(2025/04-)",
            fields: [
              {
                name: "workbook_title",
                source: "datasourceModel",
              },
              {
                name: "workbook_viewCount",
                source: "datasourceModel",
              },
            ],
            fieldNames: ["workbook_title", "workbook_viewCount"],
            fieldCount: 2,
            sourceTool: "get-datasource-metadata",
          },
        ],
        mcpExecutionDebug: {
          intent: "metadata_lookup",
          intentConfidence: 0.9,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 5,
          plannedTools: [],
          blockedTools: [],
          executedTools: ["get-datasource-metadata"],
          skippedTools: [],
          toolCallCount: 1,
          replanUsed: false,
          timingMs: { planning: 0, execution: 0 },
        },
        metadata: { hasMetadata: true },
      },
    );

    expect(sanitized).toContain("Tableau Public Per Day(2025/04-)");
    expect(sanitized).toContain("workbook_title");
    expect(sanitized).toContain("workbook_viewCount");
    expect(sanitized).not.toContain("workbook_reactionCounts_LAUGH");
  });

  it("returns a deterministic field inventory answer instead of a bogus aggregate summary", () => {
    const finalized = finalizeUserFacingAnswer(
      "Posts Countが高いVizです。",
      {
        question:
          "X Account Analytics Contentsのフィールドについて教えてください。",
        dashboardContext: {
          dashboardName: "Analytics",
          workbookName: "Social Workbook",
          worksheets: [{ name: "Posts" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "X Account Analytics Contents" }],
          capturedAt: new Date().toISOString(),
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "X Account Analytics Contentsのフィールドについて教えてください。",
          dashboardContext: {
            dashboardName: "Analytics",
            workbookName: "Social Workbook",
            worksheets: [{ name: "Posts" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "X Account Analytics Contents" }],
            capturedAt: new Date().toISOString(),
          },
        }),
        datasourceFieldProfiles: [
          {
            datasourceName: "X Account Analytics Contents",
            fields: [
              {
                name: "Posts Count",
                dataType: "INTEGER",
                role: "MEASURE",
                source: "datasourceModel",
              },
              {
                name: "Last Date",
                dataType: "DATE",
                role: "DIMENSION",
                source: "datasourceModel",
              },
            ],
            fieldNames: ["Posts Count", "Last Date"],
            fieldCount: 2,
            sourceTool: "get-datasource-metadata",
          },
        ],
        normalizedContext: {
          dashboard: { name: "Analytics" },
          workbook: { type: "workbook", name: "Social Workbook" },
          views: [],
          datasources: [
            { type: "datasource", name: "X Account Analytics Contents" },
          ],
          projects: [],
        },
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.8,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 5,
          plannedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          blockedTools: [],
          executedTools: ["list-datasources", "get-datasource-metadata"],
          skippedTools: [],
          toolCallCount: 2,
          replanUsed: false,
          timingMs: { planning: 0, execution: 0 },
        },
      },
    );

    expect(finalized).toContain("X Account Analytics Contents");
    expect(finalized).toContain("Posts Count");
    expect(finalized).toContain("Last Date");
    expect(finalized).not.toContain("高いViz");
  });

  it("removes manual query instructions when data-analysis query was not executed", () => {
    const sanitized = sanitizeUserFacingAnswer(
      [
        "このデータソースから最上位を求めるには次のクエリを実行してください。",
        "```sql",
        "SELECT workbook_title, workbook_viewCount FROM datasource ORDER BY workbook_viewCount DESC LIMIT 1;",
        "```",
      ].join("\n"),
      {
        question:
          "viewCountが最も多いworkbookは何か、データソースをクエリして求めてください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: new Date().toISOString(),
        },
      },
      {
        provider: "tableau-mcp",
        normalizedContext: {
          dashboard: { name: "Statistics" },
          views: [],
          datasources: [
            { type: "datasource", name: "Tableau Public Per Day(2025/04-)" },
          ],
          projects: [],
        },
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.89,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          blockedTools: [],
          executedTools: ["list-datasources", "get-datasource-metadata"],
          skippedTools: [],
          toolCallCount: 2,
          replanUsed: true,
          timingMs: { planning: 0, execution: 0 },
        },
        mcpToolResults: [
          { toolName: "list-datasources", status: "success" },
          { toolName: "get-datasource-metadata", status: "success" },
        ],
      },
    );

    expect(sanitized).not.toContain("```sql");
    expect(sanitized).not.toContain("SELECT ");
    expect(sanitized).toContain("安全制約により集計クエリを実行できなかった");
  });

  it("formats a direct ranking answer from successful datasource query results", () => {
    const formatted = buildStructuredDataAnalysisAnswer(
      {
        question:
          "このダッシュボードで使われているデータソースから、2026年5月に最もFavoriteを集めたVizを、ランキング形式で出してください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: new Date().toISOString(),
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "このダッシュボードで使われているデータソースから、2026年5月に最もFavoriteを集めたVizを、ランキング形式で出してください。",
          dashboardContext: {
            dashboardName: "Statistics",
            worksheets: [{ name: "Views" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: new Date().toISOString(),
          },
        }),
        queryInsights: [
          {
            datasourceName: "Tableau Public Per Day(2025/04-)",
            datasourceLuid: "ds-123",
            dimensionField: "workbook_title",
            metricField: "workbook_favoriteCount",
            rowCount: 3,
            actualRowCount: 3,
            rows: [
              { label: "Viz A", value: 120 },
              { label: "Viz B", value: 88 },
              { label: "Viz C", value: 75 },
            ],
          },
        ],
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.95,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          blockedTools: [],
          executedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          skippedTools: [],
          toolCallCount: 3,
          replanUsed: true,
          timingMs: { planning: 0, execution: 0 },
        },
      },
    );

    expect(formatted).toContain("2026年5月のVizのFavorite数ランキング");
    expect(formatted).toContain("| 1 | Viz A | 120 |");
    expect(formatted).not.toContain("| 2 | Viz B | 88 |");
    expect(formatted).toContain("Tableau Public Per Day(2025/04-)");
  });

  it("formats a year-only ranking answer with a year label", () => {
    const formatted = buildStructuredDataAnalysisAnswer(
      {
        question:
          "2026年に最もFavoriteを集めたVizをランキング形式で教えてください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: "2026-06-03T00:00:00.000Z",
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "2026年に最もFavoriteを集めたVizをランキング形式で教えてください。",
          dashboardContext: {
            dashboardName: "Statistics",
            worksheets: [{ name: "Views" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: "2026-06-03T00:00:00.000Z",
          },
        }),
        queryInsights: [
          {
            datasourceName: "Tableau Public Per Day(2025/04-)",
            datasourceLuid: "ds-123",
            dimensionField: "workbook_title",
            metricField: "workbook_favoriteCount",
            rowCount: 2,
            actualRowCount: 2,
            rows: [
              { label: "Viz A", value: 120 },
              { label: "Viz B", value: 88 },
            ],
          },
        ],
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.95,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          blockedTools: [],
          executedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          skippedTools: [],
          toolCallCount: 3,
          replanUsed: true,
          timingMs: { planning: 0, execution: 0 },
        },
      },
    );

    expect(formatted).toContain("2026年のVizのFavorite数ランキング");
  });

  it("prefers the latest insight that matches the requested metric and ranking shape", () => {
    const formatted = buildStructuredDataAnalysisAnswer(
      {
        question:
          "2026年5月にView数が多かったVizをランキング形式でTop10まで教えてください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: "2026-06-03T00:00:00.000Z",
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "2026年5月にView数が多かったVizをランキング形式でTop10まで教えてください。",
          dashboardContext: {
            dashboardName: "Statistics",
            worksheets: [{ name: "Views" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: "2026-06-03T00:00:00.000Z",
          },
        }),
        queryInsights: [
          {
            datasourceName: "Tableau Public Per Day(2025/04-)",
            datasourceLuid: "ds-123",
            dimensionField: "workbook_title",
            metricField: "workbook_favoriteCount",
            rowCount: 10,
            actualRowCount: 10,
            rows: [{ label: "Favorite Viz", value: 999 }],
            requestedMetricIntent: "favorites",
            requestedRanking: true,
            requestedTopN: 10,
            requestedPeriodStart: "2026-05-01",
            requestedPeriodEnd: "2026-05-31",
            fulfillsMetricRequest: true,
            fulfillsRankingRequest: false,
            fulfillsPeriodRequest: true,
          },
          {
            datasourceName: "Tableau Public Per Day(2025/04-)",
            datasourceLuid: "ds-123",
            dimensionField: "workbook_title",
            metricField: "workbook_viewCount",
            rowCount: 10,
            actualRowCount: 10,
            rows: [{ label: "View Viz", value: 120 }],
            requestedMetricIntent: "views",
            requestedRanking: true,
            requestedTopN: 10,
            requestedPeriodStart: "2026-05-01",
            requestedPeriodEnd: "2026-05-31",
            fulfillsMetricRequest: true,
            fulfillsRankingRequest: true,
            fulfillsPeriodRequest: true,
          },
        ],
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.95,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          blockedTools: [],
          executedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          skippedTools: [],
          toolCallCount: 3,
          replanUsed: true,
          timingMs: { planning: 0, execution: 0 },
        },
      },
    );

    expect(formatted).toContain("2026年5月のVizのビュー数ランキング");
    expect(formatted).toContain("| 1 | View Viz | 120 |");
    expect(formatted).not.toContain("Favorite Viz");
  });

  it("formats a relative-period ranking answer with a rolling-week label", () => {
    const formatted = buildStructuredDataAnalysisAnswer(
      {
        question:
          "直近1週間で最もFavoriteを集めたVizをランキング形式で教えてください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: "2026-06-03T00:00:00.000Z",
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "直近1週間で最もFavoriteを集めたVizをランキング形式で教えてください。",
          dashboardContext: {
            dashboardName: "Statistics",
            worksheets: [{ name: "Views" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: "2026-06-03T00:00:00.000Z",
          },
        }),
        queryInsights: [
          {
            datasourceName: "Tableau Public Per Day(2025/04-)",
            datasourceLuid: "ds-123",
            dimensionField: "workbook_title",
            metricField: "workbook_favoriteCount",
            rowCount: 2,
            actualRowCount: 2,
            rows: [
              { label: "Viz A", value: 120 },
              { label: "Viz B", value: 88 },
            ],
          },
        ],
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.95,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          blockedTools: [],
          executedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          skippedTools: [],
          toolCallCount: 3,
          replanUsed: true,
          timingMs: { planning: 0, execution: 0 },
        },
      },
    );

    expect(formatted).toContain("直近1週間のVizのFavorite数ランキング");
  });

  it("prefers structured query results over a manual SQL-style answer", () => {
    const finalized = finalizeUserFacingAnswer(
      [
        "このランキングを取得するには次のクエリを実行してください。",
        "```sql",
        "SELECT workbook_title, SUM(workbook_favoriteCount) FROM datasource",
        "```",
      ].join("\n"),
      {
        question:
          "このダッシュボードで使われているデータソースから、2026年5月に最もFavoriteを集めたVizを、ランキング形式で出してください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: new Date().toISOString(),
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "このダッシュボードで使われているデータソースから、2026年5月に最もFavoriteを集めたVizを、ランキング形式で出してください。",
          dashboardContext: {
            dashboardName: "Statistics",
            worksheets: [{ name: "Views" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: new Date().toISOString(),
          },
        }),
        queryInsights: [
          {
            datasourceName: "Tableau Public Per Day(2025/04-)",
            datasourceLuid: "ds-123",
            dimensionField: "workbook_title",
            metricField: "workbook_favoriteCount",
            rowCount: 2,
            actualRowCount: 2,
            rows: [
              { label: "Viz A", value: 120 },
              { label: "Viz B", value: 88 },
            ],
          },
        ],
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.95,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          blockedTools: [],
          executedTools: [
            "list-datasources",
            "get-datasource-metadata",
            "query-datasource",
          ],
          skippedTools: [],
          toolCallCount: 3,
          replanUsed: true,
          timingMs: { planning: 0, execution: 0 },
        },
        mcpToolResults: [
          { toolName: "query-datasource", status: "success", summary: "ok" },
        ],
      },
    );

    expect(finalized).not.toContain("```sql");
    expect(finalized).toContain("| 1 | Viz A | 120 |");
  });

  it("returns a safe data-analysis fallback when query results cannot be validated", () => {
    const finalized = finalizeUserFacingAnswer(
      "2025年4月のFavorite数ランキングです。\n1. Viz A: 値なし",
      {
        question:
          "Tableau Public Per Day(2025/04-)を使って、2026年4月に最もView数を集めたVizをランキング形式で教えてください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: "2026-06-04T00:00:00.000Z",
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "Tableau Public Per Day(2025/04-)を使って、2026年4月に最もView数を集めたVizをランキング形式で教えてください。",
          dashboardContext: {
            dashboardName: "Statistics",
            worksheets: [{ name: "Views" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: "2026-06-04T00:00:00.000Z",
          },
        }),
        normalizedContext: {
          dashboard: { name: "Statistics" },
          views: [],
          datasources: [
            { type: "datasource", name: "Tableau Public Per Day(2025/04-)" },
          ],
          projects: [],
        },
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.95,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: ["query-datasource"],
          blockedTools: [],
          executedTools: ["query-datasource"],
          skippedTools: [],
          toolCallCount: 1,
          replanUsed: false,
          timingMs: { planning: 0, execution: 0 },
        },
        mcpToolResults: [
          { toolName: "query-datasource", status: "success", summary: "ok" },
        ],
      },
    );

    expect(finalized).toContain(
      "2026年4月のビュー数ランキングを安全に確定できませんでした",
    );
    expect(finalized).not.toContain("2025年4月のFavorite数ランキング");
    expect(finalized).not.toContain("値なし");
  });

  it("returns a connection-failure explanation instead of an invented analysis when MCP fails", () => {
    const finalized = finalizeUserFacingAnswer(
      "1. Viz A: 120\n2. Viz B: 80",
      {
        question:
          "Tableau Public Per Day(2025/04-)を使って、2026年5月に最もView数を集めたVizをランキング形式で教えてください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: "2026-06-04T00:00:00.000Z",
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "Tableau Public Per Day(2025/04-)を使って、2026年5月に最もView数を集めたVizをランキング形式で教えてください。",
          dashboardContext: {
            dashboardName: "Statistics",
            worksheets: [{ name: "Views" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: "2026-06-04T00:00:00.000Z",
          },
        }),
        mcpConnectionFailed: true,
        mcpFailureStage: "startup",
        mcpFailureReason: "Connection closed",
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.95,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: ["list-datasources", "get-datasource-metadata"],
          blockedTools: [],
          executedTools: [],
          skippedTools: [],
          toolCallCount: 0,
          replanUsed: false,
          timingMs: { planning: 0, execution: 0 },
        },
      },
    );

    expect(finalized).toContain(
      "実データに基づく分析結果を確定できませんでした",
    );
    expect(finalized).toContain(
      "これはデータソース全体にデータがないことを意味しません",
    );
    expect(finalized).not.toContain("Viz A: 120");
    expect(finalized).not.toContain("Viz B: 80");
  });

  it("does not fabricate a ranking table when no validated query insight exists", () => {
    const finalized = finalizeUserFacingAnswer(
      [
        "In this dashboard context, here is a possible TOP10 table:",
        "1. Viz A | 120",
        "2. Viz B | 80",
      ].join("\n"),
      {
        question:
          "2026年5月のリアクション数が多かったVizをランキング形式でTop10まで教えてください。",
        dashboardContext: {
          dashboardName: "Statistics",
          worksheets: [{ name: "Views" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: "2026-06-04T00:00:00.000Z",
        },
      },
      {
        provider: "tableau-mcp",
        questionInterpretation: interpretQuestion({
          question:
            "2026年5月のリアクション数が多かったVizをランキング形式でTop10まで教えてください。",
          dashboardContext: {
            dashboardName: "Statistics",
            worksheets: [{ name: "Views" }],
            filters: [],
            parameters: [],
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: "2026-06-04T00:00:00.000Z",
          },
        }),
        normalizedContext: {
          dashboard: { name: "Statistics" },
          views: [],
          datasources: [
            { type: "datasource", name: "Tableau Public Per Day(2025/04-)" },
          ],
          projects: [],
        },
        mcpExecutionDebug: {
          intent: "data_analysis",
          intentConfidence: 0.95,
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 8,
          plannedTools: ["list-datasources", "get-datasource-metadata"],
          blockedTools: [],
          executedTools: ["list-datasources", "get-datasource-metadata"],
          skippedTools: [],
          toolCallCount: 2,
          replanUsed: false,
          timingMs: { planning: 0, execution: 0 },
        },
      },
    );

    expect(finalized).toContain("ランキングをまだ確定できませんでした");
    expect(finalized).not.toContain("1. Viz A");
    expect(finalized).not.toContain("TOP10 table");
  });

  it("creates a notion draft preview when the question asks to save into Notion", async () => {
    const repository = new InMemoryChatHistoryRepository();
    const service = new ChatService(
      new MockTableauContextProvider(),
      new MockAnswerGenerator(),
      repository,
    );

    const response = await service.generateAnswer({
      question: "この分析をNotionに保存したい",
      dashboardContext: {
        dashboardName: "Mock Dashboard",
        workbookName: "Mock Workbook",
        worksheets: [{ name: "Sheet 1" }],
        filters: [],
        parameters: [],
        capturedAt: new Date().toISOString(),
      },
      clientContext: {
        source: "tableau-extension",
      },
    });

    expect(response.notionPostIdeaDraft).toBeDefined();
    expect(response.notionPostIdeaDraft?.draftKind).toBe("analysis_memo");
    expect(response.notionPostIdeaDraft?.title).not.toContain("Notionに保存");
    expect(
      response.notionPostIdeaDraft?.analysisBody?.length ?? 0,
    ).toBeGreaterThan(0);
    expect(response.notionPostIdeaDraft?.summary?.length ?? 0).toBeGreaterThan(
      0,
    );
  });

  it("answers datasource inventory questions from dashboard context without invoking the answer generator", async () => {
    const repository = new InMemoryChatHistoryRepository();
    const answerGenerator: AnswerGenerator = {
      name: "mock",
      async generate() {
        throw new Error("Answer generator should not be called for fast path");
      },
    };
    const service = new ChatService(
      new MockTableauContextProvider(),
      answerGenerator,
      repository,
    );

    const response = await service.generateAnswer({
      question: "使われているデータソースを教えてください",
      dashboardContext: {
        dashboardName: "Mock Dashboard",
        workbookName: "Mock Workbook",
        worksheets: [{ name: "Sheet 1" }],
        filters: [],
        parameters: [],
        dataSources: [{ name: "Mock Datasource" }],
        capturedAt: new Date().toISOString(),
      },
      clientContext: {
        source: "tableau-extension",
      },
    });

    expect(response.answer).toContain("Mock Datasource");
    expect(repository.getAll()).toHaveLength(1);
  });

  it("does not take the datasource inventory fast path for analysis-like unknown metrics", async () => {
    const repository = new InMemoryChatHistoryRepository();
    let generatorCalled = false;
    const answerGenerator: AnswerGenerator = {
      name: "mock",
      async generate() {
        generatorCalled = true;
        return "分析結果を確認しています。";
      },
    };
    const service = new ChatService(
      new MockTableauContextProvider(),
      answerGenerator,
      repository,
    );

    const response = await service.generateAnswer({
      question: "2026年5月のポスト数がありますか？",
      dashboardContext: {
        dashboardName: "Mock Dashboard",
        workbookName: "Mock Workbook",
        worksheets: [{ name: "Sheet 1" }],
        filters: [],
        parameters: [],
        dataSources: [{ name: "X Account Overview Analytics" }],
        capturedAt: new Date().toISOString(),
      },
      clientContext: {
        source: "tableau-extension",
      },
    });

    expect(generatorCalled).toBe(true);
    expect(response.answer).toContain("分析結果を確認しています");
  });

  it("does not take the datasource inventory fast path for generic datasource explain questions", async () => {
    const repository = new InMemoryChatHistoryRepository();
    let generatorCalled = false;
    const answerGenerator: AnswerGenerator = {
      name: "mock",
      async generate() {
        generatorCalled = true;
        return "概要を確認しています。";
      },
    };
    const service = new ChatService(
      new MockTableauContextProvider(),
      answerGenerator,
      repository,
    );

    const response = await service.generateAnswer({
      question: "X Account Overview Analyticsについて、詳しく教えてください。",
      dashboardContext: {
        dashboardName: "Mock Dashboard",
        workbookName: "Mock Workbook",
        worksheets: [{ name: "Sheet 1" }],
        filters: [],
        parameters: [],
        dataSources: [{ name: "X Account Overview Analytics" }],
        capturedAt: new Date().toISOString(),
      },
      clientContext: {
        source: "tableau-extension",
      },
    });

    expect(generatorCalled).toBe(true);
    expect(response.answer).toContain("概要を確認しています");
  });

  it("skips bedrock answer generation when remaining execution time is too low", async () => {
    const repository = new InMemoryChatHistoryRepository();
    const answerGenerator: AnswerGenerator = {
      name: "bedrock",
      async generate() {
        throw new Error(
          "Bedrock answer generation should not run near timeout",
        );
      },
    };
    const service = new ChatService(
      new MockTableauContextProvider(),
      answerGenerator,
      repository,
    );

    const response = await service.generateAnswer(
      {
        question: "このダッシュボードを要約してください",
        dashboardContext: {
          dashboardName: "Mock Dashboard",
          workbookName: "Mock Workbook",
          worksheets: [{ name: "Sheet 1" }],
          filters: [],
          parameters: [],
          dataSources: [{ name: "Mock Datasource" }],
          capturedAt: new Date().toISOString(),
        },
        clientContext: {
          source: "tableau-extension",
        },
      },
      undefined,
      {
        getRemainingTimeInMillis: () => 7_500,
      },
    );

    expect(response.answer).toContain("Mock Dashboard");
    expect(response.answer).toContain("Mock Datasource");
  });
});
