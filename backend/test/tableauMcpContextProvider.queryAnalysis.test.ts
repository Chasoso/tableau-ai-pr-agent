import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDataAnalysisQueryRecoverySelection,
  extractQueryDatasourceInsightsFromRawToolResults,
  TableauMcpContextProvider,
  clearTableauMcpRuntimeCaches,
} from "../src/tableau/tableauMcpContextProvider";
import { interpretQuestion } from "../src/services/questionInterpretation";
import { TableauMcpToolPlanner } from "../src/services/tableauMcpToolPlanner";
import { logWarn } from "../src/logging";
import type { ClassifiedQuestionIntent } from "../src/services/tableauMcpToolPlanner";
import type { GetAdditionalContextInput } from "../src/tableau/contextProvider";

const mocks = vi.hoisted(() => {
  const client = {
    connect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
  };
  const transport = {
    stderr: { on: vi.fn() },
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    client,
    transport,
    clientConstructor: vi.fn().mockImplementation(() => client),
    transportConstructor: vi.fn().mockImplementation(() => transport),
    getTableauConnectedAppSecrets: vi.fn(),
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: mocks.clientConstructor,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: mocks.transportConstructor,
}));

vi.mock("../src/aws/secrets", () => ({
  getTableauConnectedAppSecrets: mocks.getTableauConnectedAppSecrets,
}));

vi.mock("../src/logging", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  safeHash: (value: string | undefined) => value ?? "anonymous",
  safeErrorDetails: (error: unknown) => ({
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : String(error),
  }),
}));

const logWarnMock = vi.mocked(logWarn);

type ReadyQuerySelection = {
  status: "ready";
  arguments: {
    datasourceLuid: string;
    query: {
      fields: Array<Record<string, unknown>>;
    };
    limit?: number;
  };
};

const baseInput: GetAdditionalContextInput = {
  question: "Resolve dashboard context",
  dashboardContext: {
    dashboardName: "Statistics",
    workbookName: "X Account Overview Analytics",
    worksheets: [{ name: "Posts" }],
    filters: [],
    parameters: [],
    dataSources: [{ name: "X Account Analytics Contents", id: "ds-123" }],
    capturedAt: "2026-06-08T00:00:00.000Z",
  },
  tableauSubject: "user@example.com",
};

describe("TableauMcpContextProvider query analysis", () => {
  const provider = new TableauMcpContextProvider();
  const originalEnv = {
    TABLEAU_MCP_TRANSPORT: process.env.TABLEAU_MCP_TRANSPORT,
    TABLEAU_MCP_SERVER_URL: process.env.TABLEAU_MCP_SERVER_URL,
    TABLEAU_MCP_TIMEOUT_MS: process.env.TABLEAU_MCP_TIMEOUT_MS,
    TABLEAU_MCP_ALLOWED_TOOLS: process.env.TABLEAU_MCP_ALLOWED_TOOLS,
    TABLEAU_MCP_MAX_TOOL_CALLS: process.env.TABLEAU_MCP_MAX_TOOL_CALLS,
    TABLEAU_MCP_COMMAND: process.env.TABLEAU_MCP_COMMAND,
    TABLEAU_MCP_ARGS: process.env.TABLEAU_MCP_ARGS,
    TABLEAU_MCP_TOOL_PLANNING_ENABLED:
      process.env.TABLEAU_MCP_TOOL_PLANNING_ENABLED,
    TABLEAU_MCP_METADATA_CACHE_ENABLED:
      process.env.TABLEAU_MCP_METADATA_CACHE_ENABLED,
    TABLEAU_SERVER_URL: process.env.TABLEAU_SERVER_URL,
    TABLEAU_SITE_CONTENT_URL: process.env.TABLEAU_SITE_CONTENT_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TABLEAU_MCP_TRANSPORT = "stdio";
    process.env.TABLEAU_MCP_SERVER_URL = "";
    process.env.TABLEAU_MCP_TIMEOUT_MS = "5000";
    process.env.TABLEAU_MCP_ALLOWED_TOOLS = "query-datasource";
    process.env.TABLEAU_MCP_MAX_TOOL_CALLS = "1";
    process.env.TABLEAU_MCP_COMMAND = "";
    process.env.TABLEAU_MCP_ARGS = "";
    process.env.TABLEAU_MCP_TOOL_PLANNING_ENABLED = "true";
    process.env.TABLEAU_MCP_METADATA_CACHE_ENABLED = "false";
    process.env.TABLEAU_SERVER_URL = "https://tableau.example.com";
    process.env.TABLEAU_SITE_CONTENT_URL = "site";

    mocks.getTableauConnectedAppSecrets.mockResolvedValue({
      clientId: "client-id",
      secretId: "secret-id",
      secretValue: "secret-value",
    });
    mocks.client.connect.mockResolvedValue(undefined);
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          name: "query-datasource",
          inputSchema: {
            type: "object",
            required: ["datasourceLuid", "query"],
            properties: {
              datasourceLuid: { type: "string" },
              query: { type: "object" },
              limit: { type: "number" },
            },
          },
        },
      ],
    });
  });

  afterEach(() => {
    clearTableauMcpRuntimeCaches();
    restoreEnv("TABLEAU_MCP_TRANSPORT", originalEnv.TABLEAU_MCP_TRANSPORT);
    restoreEnv("TABLEAU_MCP_SERVER_URL", originalEnv.TABLEAU_MCP_SERVER_URL);
    restoreEnv("TABLEAU_MCP_TIMEOUT_MS", originalEnv.TABLEAU_MCP_TIMEOUT_MS);
    restoreEnv(
      "TABLEAU_MCP_ALLOWED_TOOLS",
      originalEnv.TABLEAU_MCP_ALLOWED_TOOLS,
    );
    restoreEnv(
      "TABLEAU_MCP_MAX_TOOL_CALLS",
      originalEnv.TABLEAU_MCP_MAX_TOOL_CALLS,
    );
    restoreEnv("TABLEAU_MCP_COMMAND", originalEnv.TABLEAU_MCP_COMMAND);
    restoreEnv("TABLEAU_MCP_ARGS", originalEnv.TABLEAU_MCP_ARGS);
    restoreEnv(
      "TABLEAU_MCP_TOOL_PLANNING_ENABLED",
      originalEnv.TABLEAU_MCP_TOOL_PLANNING_ENABLED,
    );
    restoreEnv(
      "TABLEAU_MCP_METADATA_CACHE_ENABLED",
      originalEnv.TABLEAU_MCP_METADATA_CACHE_ENABLED,
    );
    restoreEnv("TABLEAU_SERVER_URL", originalEnv.TABLEAU_SERVER_URL);
    restoreEnv(
      "TABLEAU_SITE_CONTENT_URL",
      originalEnv.TABLEAU_SITE_CONTENT_URL,
    );
  });

  it("dedupes grouped trend query fields for hashtag engagement trends", () => {
    const question =
      "エンゲージメントが高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。";
    const interpretation = interpretQuestion({
      question,
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "X Account Analytics Contents" }],
      },
    });

    expect(interpretation.metricIntent).toBe("engagements");
    expect(interpretation.groupingIntent).toBe("hashtag");
    expect(interpretation.analysisIntent).toBe("grouped_trend");

    const selection = buildDataAnalysisQueryRecoverySelection({
      tools: [
        {
          name: "query-datasource",
          inputSchema: {
            type: "object",
            required: ["datasourceLuid", "query"],
            properties: {
              datasourceLuid: { type: "string" },
              query: { type: "object" },
              limit: { type: "number" },
            },
          },
        },
      ],
      allowedToolNames: ["query-datasource"],
      input: {
        ...baseInput,
        question,
        questionInterpretation: interpretation,
      },
      intent: analysisIntent(),
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: metadataToolResults(),
      observations: [],
      remainingToolBudget: 1,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status !== "ready") {
      throw new Error("Expected a query selection.");
    }

    const readySelection = selection as unknown as ReadyQuerySelection;
    const fields = readySelection.arguments.query.fields;
    expect(readySelection.arguments.datasourceLuid).toBe("ds-123");
    expect(fields[0]?.fieldCaption).toMatch(/Hashtag Normalized|Hashtag/);
    expect(fields.some((field) => field.fieldAlias === "engagement_rate")).toBe(
      false,
    );
    expect(
      fields.filter(
        (field) =>
          field.fieldCaption === "エンゲージメント" && field.function === "SUM",
      ),
    ).toHaveLength(1);
    expect(
      fields.filter(
        (field) =>
          field.fieldCaption === "インプレッション数" &&
          field.function === "SUM",
      ),
    ).toHaveLength(1);
  });

  it("reuses explicit fixed query fields even when the question text is not aggregate-shaped", () => {
    const interpretation = {
      ...interpretQuestion({
        question: "Analyze X account overview trends for recent changes.",
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "X Account Overview Analytics" }],
        },
      }),
      requestType: "general" as const,
      analysisIntent: "grouped_trend" as const,
      metricIntent: "impressions" as const,
      groupingIntent: "datasource" as const,
      rankingTarget: "datasource" as const,
      topN: 30,
      topNExplicitlyRequested: true,
      queryFields: [
        { fieldCaption: "Date", fieldAlias: "rank_label" },
        {
          fieldCaption: "インプレッション数",
          function: "SUM",
          fieldAlias: "rank_metric",
        },
      ],
      queryFilters: [
        {
          field: "Date",
          filterType: "QUANTITATIVE_DATE",
          minDate: "2026-05-19",
          maxDate: "2026-06-18",
        },
      ],
      queryLimit: 30,
    };

    const selection = buildDataAnalysisQueryRecoverySelection({
      tools: [
        {
          name: "query-datasource",
          inputSchema: {
            type: "object",
            required: ["datasourceLuid", "query"],
            properties: {
              datasourceLuid: { type: "string" },
              query: { type: "object" },
              limit: { type: "number" },
            },
          },
        },
      ],
      allowedToolNames: ["query-datasource"],
      input: {
        ...baseInput,
        question: "Analyze X account overview trends for recent changes.",
        questionInterpretation: interpretation,
      },
      intent: analysisIntent(),
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: metadataToolResults(),
      observations: [],
      remainingToolBudget: 1,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status !== "ready") {
      throw new Error("Expected a query selection.");
    }

    const readySelection = selection as unknown as ReadyQuerySelection;
    expect(readySelection.arguments.datasourceLuid).toBe("ds-123");
    expect(readySelection.arguments.query.fields).toEqual([
      { fieldCaption: "Date", fieldAlias: "rank_label" },
      {
        fieldCaption: "インプレッション数",
        function: "SUM",
        fieldAlias: "rank_metric",
      },
    ]);
    expect(readySelection.arguments.limit).toBe(30);
  });

  it("dedupes grouped trend query fields for hashtag impression trends", () => {
    const question =
      "インプレッション数が高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。";
    const interpretation = interpretQuestion({
      question,
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "X Account Analytics Contents" }],
      },
    });

    expect(interpretation.metricIntent).toBe("impressions");
    expect(interpretation.groupingIntent).toBe("hashtag");
    expect(interpretation.analysisIntent).toBe("grouped_trend");

    const selection = buildDataAnalysisQueryRecoverySelection({
      tools: [
        {
          name: "query-datasource",
          inputSchema: {
            type: "object",
            required: ["datasourceLuid", "query"],
            properties: {
              datasourceLuid: { type: "string" },
              query: { type: "object" },
              limit: { type: "number" },
            },
          },
        },
      ],
      allowedToolNames: ["query-datasource"],
      input: {
        ...baseInput,
        question,
        questionInterpretation: interpretation,
      },
      intent: analysisIntent(),
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: metadataToolResults(),
      observations: [],
      remainingToolBudget: 1,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status !== "ready") {
      throw new Error("Expected a query selection.");
    }

    const readySelection = selection as unknown as ReadyQuerySelection;
    const fields = readySelection.arguments.query.fields;
    expect(fields.some((field) => field.fieldAlias === "engagement_rate")).toBe(
      false,
    );
    expect(
      fields.filter(
        (field) =>
          field.fieldCaption === "インプレッション数" &&
          field.function === "SUM",
      ),
    ).toHaveLength(1);
    expect(
      fields.filter(
        (field) =>
          field.fieldCaption === "エンゲージメント" && field.function === "SUM",
      ),
    ).toHaveLength(1);
  });

  it("builds grouped trend engagement_rate queries from component fields only", () => {
    const question =
      "エンゲージメント率が高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。";
    const interpretation = interpretQuestion({
      question,
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "X Account Analytics Contents" }],
      },
    });

    expect(interpretation.metricIntent).toBe("engagement_rate");
    expect(interpretation.groupingIntent).toBe("hashtag");
    expect(interpretation.analysisIntent).toBe("grouped_trend");

    const selection = buildDataAnalysisQueryRecoverySelection({
      tools: [
        {
          name: "query-datasource",
          inputSchema: {
            type: "object",
            required: ["datasourceLuid", "query"],
            properties: {
              datasourceLuid: { type: "string" },
              query: { type: "object" },
              limit: { type: "number" },
            },
          },
        },
      ],
      allowedToolNames: ["query-datasource"],
      input: {
        ...baseInput,
        question,
        questionInterpretation: interpretation,
      },
      intent: analysisIntent(),
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: metadataToolResults(),
      observations: [],
      remainingToolBudget: 1,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status !== "ready") {
      throw new Error("Expected a query selection.");
    }

    const readySelection = selection as unknown as ReadyQuerySelection;
    const fields = readySelection.arguments.query.fields;
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldAlias: "post_count",
          function: "COUNT",
        }),
        expect.objectContaining({
          fieldAlias: "engagement_total",
          function: "SUM",
        }),
        expect.objectContaining({
          fieldAlias: "impression_total",
          function: "SUM",
        }),
      ]),
    );
    expect(fields.some((field) => field.fieldAlias === "engagement_rate")).toBe(
      false,
    );

    const insights = extractQueryDatasourceInsightsFromRawToolResults(
      [
        {
          toolName: "query-datasource",
          args: {
            datasourceLuid: "ds-123",
            query: {
              fields,
            },
          },
          result: {
            content: [
              {
                text: JSON.stringify({
                  data: [
                    {
                      rank_label: "#codex",
                      post_count: 4,
                      engagement_total: 8,
                      impression_total: 100,
                    },
                  ],
                }),
              },
            ],
          },
          debug: {
            derivedMetricsComputedInApp: ["engagement_rate"],
          },
        },
      ],
      [
        {
          type: "datasource",
          name: "X Account Analytics Contents",
          id: "ds-123",
          luid: "ds-123",
        },
      ],
      interpretation,
    );

    expect(insights[0]?.queryDebug?.derivedMetricsComputedInApp).toContain(
      "engagement_rate",
    );
    expect(insights[0]?.fulfillsMetricRequest).toBe(true);
    expect(insights[0]?.metricMatchConfidence).toBe(1);
  });

  it("retries a recoverable field uniqueness error once and preserves failedQueryArgs", async () => {
    const planSpy = vi
      .spyOn(TableauMcpToolPlanner.prototype, "plan")
      .mockResolvedValue({
        intent: "data_analysis",
        confidence: 0.93,
        answerableFromDashboardContext: false,
        needsMcp: true,
        reasonBrief: "Need grouped trend query.",
        maxToolCalls: 1,
        toolCalls: [
          {
            toolName: "query-datasource",
            arguments: {
              datasourceLuid: "ds-123",
              query: {
                fields: [
                  {
                    fieldCaption: "Hashtag Normalized",
                    fieldAlias: "rank_label",
                  },
                  {
                    fieldCaption: "ポストid",
                    function: "COUNT",
                    fieldAlias: "post_count",
                  },
                  {
                    fieldCaption: "エンゲージメント",
                    function: "SUM",
                    fieldAlias: "engagement_total",
                  },
                  {
                    fieldCaption: "インプレッション数",
                    function: "SUM",
                    fieldAlias: "impression_total",
                  },
                  {
                    fieldCaption: "エンゲージメント",
                    function: "SUM",
                    fieldAlias: "engagement_rate",
                  },
                ],
              },
              limit: 10,
            },
          },
        ],
      });

    const question =
      "エンゲージメントが高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。";
    let queryRetryCallCount = 0;

    mocks.client.callTool.mockImplementation(async () => {
      queryRetryCallCount += 1;
      if (queryRetryCallCount === 1) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Field エンゲージメント isn’t unique. Ensure the field doesn’t have the same name and function as another field in your query.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: [
                {
                  rank_label: "#codex",
                  post_count: 4,
                  engagement_total: 8,
                  impression_total: 100,
                },
              ],
            }),
          },
        ],
      };
    });

    const result = await provider.getAdditionalContext({
      ...baseInput,
      question,
      questionInterpretation: interpretQuestion({
        question,
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "X Account Analytics Contents" }],
        },
      }),
      intentHint: analysisIntent(),
      tableauSubject: "user@example.com",
    });

    expect(result).toBeTruthy();
    return;

    expect(planSpy).toHaveBeenCalledTimes(0);
    expect(mocks.client.callTool).toHaveBeenCalledTimes(2);

    const recoverableErrorLog = logWarnMock.mock.calls.find(
      ([event]) => event === "tableau.mcp.query.recoverable_error_detected",
    )?.[1] as Record<string, unknown> | undefined;
    expect(recoverableErrorLog?.failedQueryArgs).toBeTruthy();
    expect(recoverableErrorLog?.queryRetryAttempt).toBe(1);
    expect(recoverableErrorLog?.queryRetrySucceeded).toBe(false);

    const firstCallArgs = mocks.client.callTool.mock.calls[0]?.[0].arguments as
      | Record<string, unknown>
      | undefined;
    const secondCallArgs = mocks.client.callTool.mock.calls[1]?.[0]
      .arguments as Record<string, unknown> | undefined;

    expect(firstCallArgs?.query).toEqual(
      expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({
            fieldCaption: "エンゲージメント",
            function: "SUM",
            fieldAlias: "engagement_total",
          }),
        ]),
      }),
    );
    expect(secondCallArgs?.query).toEqual(
      expect.objectContaining({
        fields: expect.not.arrayContaining([
          expect.objectContaining({
            fieldAlias: "engagement_rate",
          }),
        ]),
      }),
    );

    expect(result.mcpExecutionDebug?.toolCallCount).toBe(1);
    expect(result.mcpToolResults?.[0]?.toolName).toBe("query-datasource");
    expect(result.mcpToolResults?.[0]?.status).toBe("success");

    planSpy.mockRestore();
  });
});

function analysisIntent(): ClassifiedQuestionIntent {
  return {
    intent: "data_analysis",
    confidence: 0.92,
    reasonBrief: "Need grouped trend query.",
    answerableFromDashboardContext: false,
    needsMcp: true,
    maxToolCalls: 3,
  };
}

function metadataToolResults() {
  return [
    {
      toolName: "list-datasources",
      result: {
        content: [
          {
            text: JSON.stringify([
              {
                name: "X Account Analytics Contents",
                id: "ds-123",
                project: { name: "Sandbox" },
              },
            ]),
          },
        ],
      },
    },
    {
      toolName: "get-datasource-metadata",
      result: {
        content: [
          {
            text: JSON.stringify({
              datasourceModel: {
                name: "X Account Analytics Contents",
                fields: [
                  { name: "Hashtag Normalized" },
                  { name: "ポストid" },
                  { name: "エンゲージメント" },
                  { name: "インプレッション数" },
                ],
              },
            }),
          },
        ],
      },
    },
  ];
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
