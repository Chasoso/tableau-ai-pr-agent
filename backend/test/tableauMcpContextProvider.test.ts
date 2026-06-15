import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDataAnalysisQueryRecoverySelection,
  buildMetadataIdentifierRecoverySelection,
  buildRuleBasedInitialSelections,
  buildMcpErrorMessage,
  checkToolPreconditions,
  classifyMcpErrorCategory,
  clearTableauMcpRuntimeCaches,
  extractBestWorkbookId,
  extractDatasourceFieldProfilesFromRawToolResults,
  extractQueryDatasourceInsightsFromRawToolResults,
  extractDatasourcesFromRawToolResults,
  extractWorkbookFromToolResults,
  inferPlannedToolArguments,
  isMcpErrorResult,
  normalizeTableauContext,
  resolveDatasourceIdentifier,
  selectAggregateMetricField,
  TableauMcpContextProvider,
} from "../src/tableau/tableauMcpContextProvider";
import { interpretQuestion } from "../src/services/questionInterpretation";
import type { ClassifiedQuestionIntent } from "../src/services/tableauMcpToolPlanner";
import type { TableauMcpToolResultSummary } from "../src/types/tableau";
import type { GetAdditionalContextInput } from "../src/tableau/contextProvider";

const baseInput: GetAdditionalContextInput = {
  question: "Resolve dashboard context",
  dashboardContext: {
    dashboardName: "Statistics",
    worksheets: [{ name: "Views" }, { name: "Favorites" }],
    filters: [],
    parameters: [],
    capturedAt: "2026-05-27T00:00:00.000Z",
  },
  tableauSubject: "user@example.com",
};

afterEach(() => {
  clearTableauMcpRuntimeCaches();
  vi.unstubAllEnvs();
});

describe("TableauMcpContextProvider extraction helpers", () => {
  it("fails fast when the Tableau server URL is invalid", async () => {
    vi.stubEnv("TABLEAU_CONTEXT_PROVIDER", "mcp");
    vi.stubEnv("TABLEAU_MCP_TRANSPORT", "stdio");
    vi.stubEnv("TABLEAU_SERVER_URL", "not-a-url");
    vi.stubEnv("TABLEAU_SITE_CONTENT_URL", "site");

    const provider = new TableauMcpContextProvider();
    const additionalContext = await provider.getAdditionalContext(baseInput);

    expect(additionalContext.provider).toBe("tableau-mcp");
    expect(additionalContext.mcpConnectionFailed).toBe(true);
    expect(additionalContext.mcpFailureStage).toBe("startup");
    expect(additionalContext.mcpFailureReason).toContain(
      "Tableau MCP server URL is invalid",
    );
  });

  it("extracts workbook name from search-content parentWorkbookName", () => {
    const toolResults: TableauMcpToolResultSummary[] = [
      {
        toolName: "search-content",
        status: "success",
        summary: JSON.stringify([
          {
            type: "view",
            sheetType: "dashboard",
            title: "Statistics",
            parentWorkbookName: "Tableau Public Insights",
            luid: "8199f5d0-dff2-4d2d-a8ea-4bbef7c5a896",
          },
        ]),
      },
    ];

    expect(extractWorkbookFromToolResults(toolResults, baseInput)).toEqual({
      name: "Tableau Public Insights",
    });
  });

  it("prefers nested workbook id from list-views over the view id", () => {
    const result = {
      content: [
        {
          text: JSON.stringify([
            {
              id: "8199f5d0-dff2-4d2d-a8ea-4bbef7c5a896",
              name: "Statistics",
              workbook: {
                id: "d351b42d-7545-4cbd-bd76-e23410275f1b",
              },
            },
          ]),
        },
      ],
    };

    expect(extractBestWorkbookId(result, "Statistics")).toBe(
      "d351b42d-7545-4cbd-bd76-e23410275f1b",
    );
  });

  it("extracts structured datasource records from untruncated list-datasources results", () => {
    const input: GetAdditionalContextInput = {
      ...baseInput,
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
      },
    };
    const result = {
      content: [
        {
          text: JSON.stringify([
            {
              id: "not-used",
              name: "Other Datasource",
              project: { id: "project-1", name: "Sandbox" },
              tags: {},
            },
            {
              id: "datasource-luid",
              name: "Tableau Public Per Day(2025/04-)",
              description: "Daily Tableau Public activity data.",
              project: { id: "project-1", name: "Sandbox" },
              tags: {},
            },
          ]),
        },
      ],
    };

    expect(
      extractDatasourcesFromRawToolResults(
        [{ toolName: "list-datasources", result }],
        input,
      ),
    ).toEqual([
      {
        type: "datasource",
        name: "Tableau Public Per Day(2025/04-)",
        id: "datasource-luid",
        luid: "datasource-luid",
        contentUrl: undefined,
        projectName: "Sandbox",
        workbookName: undefined,
      },
    ]);
  });

  it("extracts datasource field details including data types from metadata", () => {
    const profiles = extractDatasourceFieldProfilesFromRawToolResults(
      [
        {
          toolName: "get-datasource-metadata",
          result: {
            content: [
              {
                text: JSON.stringify({
                  datasourceName: "Tableau Public Per Day(2025/04-)",
                  datasourceModel: {
                    fields: [
                      {
                        name: "Default View Path",
                        dataType: "STRING",
                        role: "DIMENSION",
                      },
                      {
                        name: "Daily View Count",
                        dataType: "INTEGER",
                        role: "MEASURE",
                      },
                    ],
                  },
                }),
              },
            ],
          },
        },
      ],
      [
        {
          type: "datasource",
          name: "Tableau Public Per Day(2025/04-)",
        },
      ],
    );

    expect(profiles[0]?.fields).toEqual([
      {
        name: "Default View Path",
        dataType: "STRING",
        role: "DIMENSION",
        semanticRole: undefined,
        source: "datasourceModel",
      },
      {
        name: "Daily View Count",
        dataType: "INTEGER",
        role: "MEASURE",
        semanticRole: undefined,
        source: "datasourceModel",
      },
    ]);
  });

  it("prefers numeric view-count fields over string path fields for view questions", () => {
    const interpretation = interpretQuestion({
      question: "Show the 2026/05 view ranking for Viz titles.",
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
      },
    });

    const selection = selectAggregateMetricField(
      [
        {
          name: "Default View Path",
          dataType: "STRING",
          role: "DIMENSION",
          source: "datasourceModel",
        },
        {
          name: "Daily View Count",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
      ],
      interpretation,
    );

    expect(selection.fieldName).toBe("Daily View Count");
    expect(selection.candidates[0]?.fieldName).toBe("Daily View Count");
    expect(
      selection.candidates.find(
        (candidate) => candidate.fieldName === "Default View Path",
      )?.score,
    ).toBeLessThan(
      selection.candidates.find(
        (candidate) => candidate.fieldName === "Daily View Count",
      )?.score ?? 0,
    );
  });

  it("prefers explicit impression metrics and post identifiers for post ranking questions", () => {
    const interpretation = interpretQuestion({
      question:
        "X Account Overview Analytics を使って、2026年5月のインプレッション数が最も多かったポストを教えてください。",
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "X Account Overview Analytics" }],
      },
    });

    expect(interpretation.metricIntent).toBe("impressions");
    expect(interpretation.requestedMetricText).toBe("インプレッション数");
    expect(interpretation.rankingTarget).toBe("post");

    const metricSelection = selectAggregateMetricField(
      [
        {
          name: "Post本文",
          dataType: "STRING",
          role: "DIMENSION",
          source: "datasourceModel",
        },
        {
          name: "Post URL",
          dataType: "STRING",
          role: "DIMENSION",
          source: "datasourceModel",
        },
        {
          name: "インプレッション数",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
        {
          name: "ブックマーク",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
      ],
      interpretation,
    );

    expect(metricSelection.fieldName).toBe("インプレッション数");

    const selection = buildDataAnalysisQueryRecoverySelection({
      tools: [
        {
          name: "query-datasource",
          inputSchema: {
            type: "object",
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
        question:
          "X Account Overview Analytics を使って、2026年5月のインプレッション数が最も多かったポストを教えてください。",
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "X Account Overview Analytics" }],
        },
      },
      intent: {
        intent: "metadata_lookup",
        confidence: 0.9,
        reasonBrief: "Need metadata first.",
        answerableFromDashboardContext: false,
        needsMcp: true,
        maxToolCalls: 4,
      },
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: [
        {
          toolName: "list-datasources",
          result: {
            content: [
              {
                text: JSON.stringify([
                  {
                    name: "X Account Overview Analytics",
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
                    name: "X Account Overview Analytics",
                    fields: [
                      { name: "Post本文" },
                      { name: "Post URL" },
                      { name: "インプレッション数" },
                      { name: "ブックマーク" },
                    ],
                  },
                }),
              },
            ],
          },
        },
      ],
      observations: [],
      remainingToolBudget: 2,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status === "ready") {
      expect(selection.arguments.query).toEqual(
        expect.objectContaining({
          fields: [
            { fieldCaption: "Post本文", fieldAlias: "rank_label" },
            {
              fieldCaption: "インプレッション数",
              function: "SUM",
              fieldAlias: "rank_metric",
              sortDirection: "DESC",
              sortPriority: 1,
            },
          ],
        }),
      );
    }
  });

  it("derives engagement rate when the rate field is absent", () => {
    const interpretation = interpretQuestion({
      question:
        "X Account Analytics Contents のエンゲージメント率が高い投稿を教えてください。",
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "X Account Analytics Contents" }],
      },
    });

    const selection = selectAggregateMetricField(
      [
        {
          name: "エンゲージメント",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
        {
          name: "インプレッション数",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
        {
          name: "ポスト本文",
          dataType: "STRING",
          role: "DIMENSION",
          source: "datasourceModel",
        },
      ],
      interpretation,
    );

    expect(selection.fieldName).toBe("エンゲージメント率");
    expect(selection.fieldSpec).toEqual(
      expect.objectContaining({
        fieldCaption: "エンゲージメント率",
        calculation: "SUM([エンゲージメント]) / SUM([インプレッション数])",
        fieldAlias: "rank_metric",
        sortDirection: "DESC",
        sortPriority: 1,
      }),
    );
    expect(selection.componentFields).toEqual([
      "エンゲージメント",
      "インプレッション数",
    ]);
  });

  it("builds a composite reactions metric when reaction ranking is requested", () => {
    const interpretation = interpretQuestion({
      question:
        "2026年5月のリアクション数が多かったVizをランキング形式でTop10まで教えてください。",
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
      },
    });

    const selection = selectAggregateMetricField(
      [
        {
          name: "Daily Favorite Reaction Count",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
        {
          name: "Daily Love Reaction Count",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
        {
          name: "Daily Insightful Reaction Count",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
        {
          name: "Daily View Count",
          dataType: "INTEGER",
          role: "MEASURE",
          source: "datasourceModel",
        },
      ],
      interpretation,
    );

    expect(selection.fieldName).toBe("Total Reactions");
    expect(selection.componentFields).toEqual([
      "Daily Favorite Reaction Count",
      "Daily Love Reaction Count",
      "Daily Insightful Reaction Count",
    ]);
    expect(selection.fieldSpec).toEqual(
      expect.objectContaining({
        fieldCaption: "Total Reactions",
        fieldAlias: "rank_metric",
      }),
    );
    expect(selection.fieldSpec?.calculation).toContain(
      "SUM([Daily Favorite Reaction Count])",
    );
    expect(selection.fieldSpec?.calculation).toContain(
      "SUM([Daily Love Reaction Count])",
    );
  });

  it("attaches stable ranking metadata to extracted query insights", () => {
    const interpretation = interpretQuestion({
      question: "Show the top 10 Viz entries by views for 2026/05.",
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
      },
    });

    const insights = extractQueryDatasourceInsightsFromRawToolResults(
      [
        {
          toolName: "query-datasource",
          args: {
            datasourceLuid: "datasource-luid",
            query: {
              fields: [
                {
                  fieldCaption: "Workbook Title",
                  fieldAlias: "dimension_label",
                },
                {
                  fieldCaption: "Daily View Count",
                  fieldAlias: "aggregated_value",
                  function: "SUM",
                },
              ],
            },
          },
          result: {
            data: [
              {
                dimension_label: "Viz A",
                aggregated_value: 120,
              },
            ],
          },
        },
      ],
      [
        {
          type: "datasource",
          name: "Tableau Public Per Day(2025/04-)",
          id: "datasource-luid",
          luid: "datasource-luid",
        },
      ],
      interpretation,
    );

    expect(insights[0]).toEqual(
      expect.objectContaining({
        datasourceName: "Tableau Public Per Day(2025/04-)",
        metricField: "Daily View Count",
        requestedMetricIntent: "views",
        requestedRanking: true,
        requestedTopN: 10,
        requestedPeriodStart: "2026-05-01",
        requestedPeriodEnd: "2026-05-31",
      }),
    );
  });

  it("does not build aggregate recovery selections for field inventory questions", () => {
    const selection = buildDataAnalysisQueryRecoverySelection({
      tools: [{ name: "query-datasource", inputSchema: { properties: {} } }],
      allowedToolNames: ["query-datasource"],
      input: {
        ...baseInput,
        question:
          "X Account Analytics Contentsのフィールドについて教えてください。",
        questionInterpretation: interpretQuestion({
          question:
            "X Account Analytics Contentsのフィールドについて教えてください。",
          dashboardContext: {
            ...baseInput.dashboardContext,
            dataSources: [{ name: "X Account Analytics Contents" }],
          },
        }),
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "X Account Analytics Contents" }],
        },
      },
      intent: {
        intent: "metadata_lookup",
        confidence: 0.9,
        reasonBrief: "metadata",
        answerableFromDashboardContext: false,
        needsMcp: true,
        maxToolCalls: 4,
      },
      calledToolNames: new Set<string>(),
      rawToolResults: [],
      observations: [],
      remainingToolBudget: 2,
    });

    expect(selection).toBeUndefined();
  });

  it("extracts datasource field profiles from get-datasource-metadata results", () => {
    const rawToolResults = [
      {
        toolName: "get-datasource-metadata",
        result: {
          content: [
            {
              text: JSON.stringify({
                datasourceModel: {
                  name: "Tableau Public Per Day(2025/04-)",
                  fields: [
                    { name: "Datetime(JST)" },
                    { name: "workbook_title" },
                  ],
                },
                fieldGroups: [
                  {
                    name: "Measures",
                    fields: [{ name: "workbook_viewCount" }],
                  },
                ],
              }),
            },
          ],
        },
      },
    ];

    const profiles = extractDatasourceFieldProfilesFromRawToolResults(
      rawToolResults,
      [
        {
          type: "datasource",
          name: "Tableau Public Per Day(2025/04-)",
          id: "datasource-luid",
          luid: "datasource-luid",
        },
      ],
    );

    expect(profiles).toEqual([
      {
        datasourceName: "Tableau Public Per Day(2025/04-)",
        fields: [
          {
            name: "Datetime(JST)",
            dataType: undefined,
            role: undefined,
            semanticRole: undefined,
            source: "datasourceModel",
          },
          {
            name: "workbook_title",
            dataType: undefined,
            role: undefined,
            semanticRole: undefined,
            source: "datasourceModel",
          },
          {
            name: "workbook_viewCount",
            dataType: undefined,
            role: undefined,
            semanticRole: undefined,
            source: "fieldGroups",
          },
        ],
        fieldNames: ["Datetime(JST)", "workbook_title", "workbook_viewCount"],
        fieldCount: 3,
        sourceTool: "get-datasource-metadata",
      },
    ]);
  });

  it("does not treat project content as datasource", () => {
    const result = {
      content: [
        {
          text: JSON.stringify([
            {
              contentType: "datasource",
              name: "Tableau Public Per Day(2025/04-)",
              id: "datasource-luid",
              projectName: "Sandbox",
            },
            {
              contentType: "project",
              name: "Sandbox",
              id: "project-id",
            },
          ]),
        },
      ],
    };

    expect(
      extractDatasourcesFromRawToolResults(
        [{ toolName: "search-content", result }],
        baseInput,
      ),
    ).toEqual([
      {
        type: "datasource",
        name: "Tableau Public Per Day(2025/04-)",
        id: "datasource-luid",
        luid: "datasource-luid",
        contentUrl: undefined,
        projectName: "Sandbox",
        workbookName: undefined,
      },
    ]);
  });

  it("does not treat view/workbook/project names as datasource", () => {
    const result = {
      content: [
        {
          text: JSON.stringify([
            {
              id: "view-1",
              name: "Statistics",
              workbook: { name: "Tableau Public Insights" },
              project: { name: "Sandbox" },
            },
          ]),
        },
      ],
    };

    expect(
      extractDatasourcesFromRawToolResults(
        [{ toolName: "list-views", result }],
        baseInput,
      ),
    ).toEqual([]);
  });

  it("keeps known datasource hint when only view records are present", () => {
    const rawToolResults = [
      {
        toolName: "list-views",
        result: {
          content: [
            {
              text: JSON.stringify([
                {
                  id: "view-1",
                  name: "Statistics",
                  workbook: { name: "Tableau Public Insights" },
                  project: { name: "Sandbox" },
                },
              ]),
            },
          ],
        },
      },
    ];

    const resolved = resolveDatasourceIdentifier(
      ["Tableau Public Per Day(2025/04-)"],
      [],
      [],
      {
        rawToolResults,
        dashboardName: "Statistics",
        viewName: "Statistics",
        workbookName: "Tableau Public Insights",
        worksheetNames: ["Views"],
        projectNames: ["Sandbox"],
      },
    );
    expect(resolved).toEqual([
      {
        name: "Tableau Public Per Day(2025/04-)",
        matchConfidence: 1,
        matchReason: "exact_name_match",
        source: "dashboardContext",
      },
    ]);
  });

  it("precondition blocks datasource metadata call when datasource id is missing but name exists", () => {
    const result = checkToolPreconditions(
      "get-datasource-metadata",
      {},
      {
        intent: {
          intent: "metadata_lookup",
          confidence: 0.8,
          reasonBrief: "Need datasource metadata.",
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 5,
        },
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
        calledToolNames: new Set<string>(),
        executedToolResults: [],
        rawToolResults: [],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.recoverable).toBe(true);
    expect(result.suggestedTools).toContain("list-datasources");
  });

  it("precondition allows datasource metadata call when datasource id is provided", () => {
    const result = checkToolPreconditions(
      "get-datasource-metadata",
      {
        datasourceLuid: "datasource-luid",
      },
      {
        intent: {
          intent: "metadata_lookup",
          confidence: 0.9,
          reasonBrief: "Need datasource metadata.",
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 5,
        },
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [
            { name: "Tableau Public Per Day(2025/04-)", id: "datasource-luid" },
          ],
        },
        calledToolNames: new Set<string>(),
        executedToolResults: [],
        rawToolResults: [],
      },
    );

    expect(result.ok).toBe(true);
  });

  it("treats MCP isError responses as failures and classifies invalid requests", () => {
    const errorResult = {
      content: [{ type: "text", text: "Request failed with status code 400" }],
      isError: true,
    };

    expect(isMcpErrorResult(errorResult)).toBe(true);
    const category = classifyMcpErrorCategory(errorResult);
    expect(category).toBe("request_invalid_or_identifier_missing");
    expect(buildMcpErrorMessage(errorResult, category)).toContain("invalid");
  });

  it("precondition becomes non-recoverable after context resolution attempts still lack datasource identifier", () => {
    const result = checkToolPreconditions(
      "get-datasource-metadata",
      {},
      {
        intent: {
          intent: "metadata_lookup",
          confidence: 0.8,
          reasonBrief: "Need datasource metadata.",
          answerableFromDashboardContext: false,
          needsMcp: true,
          maxToolCalls: 5,
        },
        dashboardContext: {
          ...baseInput.dashboardContext,
        },
        calledToolNames: new Set<string>([
          "list-views",
          "list-workbooks",
          "search-content",
        ]),
        executedToolResults: [
          {
            toolName: "list-views",
            status: "success",
          },
          {
            toolName: "list-workbooks",
            status: "success",
          },
        ],
        rawToolResults: [],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.recoverable).toBe(false);
  });

  it("resolves datasource identifier from list-datasources by name", () => {
    const rawToolResults = [
      {
        toolName: "list-datasources",
        result: {
          content: [
            {
              text: JSON.stringify([
                {
                  name: "Tableau Public Per Day(2025/04-)",
                  id: "ds-123",
                  project: { name: "Sandbox" },
                },
              ]),
            },
          ],
        },
      },
    ];
    const resolved = resolveDatasourceIdentifier(
      ["Tableau Public Per Day(2025/04-)"],
      [],
      [],
      { rawToolResults },
    );
    expect(resolved[0]?.id).toBe("ds-123");
    expect(resolved[0]?.matchReason).toBe("exact_name_match");
  });

  it("does not allow metadata args when only datasource name is provided", () => {
    const tool = {
      name: "get-datasource-metadata",
      inputSchema: {
        type: "object",
        required: ["datasourceLuid"],
        properties: {
          datasourceLuid: { type: "string" },
          datasourceId: { type: "string" },
          name: { type: "string" },
        },
      },
    };

    const args = inferPlannedToolArguments(
      tool,
      { name: "Tableau Public Per Day(2025/04-)" },
      {
        ...baseInput,
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
      },
    );
    expect(args).toBeUndefined();
  });

  it("does not treat workbook name as workbook id for get-workbook", () => {
    const tool = {
      name: "get-workbook",
      inputSchema: {
        type: "object",
        required: ["workbookId"],
        properties: {
          workbookId: { type: "string" },
        },
      },
    };

    const args = inferPlannedToolArguments(
      tool,
      { workbookId: "Tableau Public Insights" },
      {
        ...baseInput,
        dashboardContext: {
          ...baseInput.dashboardContext,
          workbookName: "Tableau Public Insights",
        },
      },
    );
    expect(args).toBeUndefined();
  });

  it("allows aggregate query args even when datasource has author-prefixed fields", () => {
    const queryTool = {
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
    };
    const args = inferPlannedToolArguments(
      queryTool,
      {
        datasourceLuid: "ds-123",
        query: {
          fields: [
            { fieldCaption: "workbook_title" },
            { fieldCaption: "workbook_viewCount", function: "SUM" },
          ],
        },
        limit: 1,
      },
      {
        ...baseInput,
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [
            { name: "Tableau Public Per Day(2025/04-)", id: "ds-123" },
          ],
        },
      },
    );

    expect(args).toEqual({
      datasourceLuid: "ds-123",
      query: {
        fields: [
          { fieldCaption: "workbook_title" },
          { fieldCaption: "workbook_viewCount", function: "SUM" },
        ],
      },
      limit: 1,
    });
  });

  it("treats multiple close datasource matches as ambiguous", () => {
    const rawToolResults = [
      {
        toolName: "list-datasources",
        result: {
          content: [
            {
              text: JSON.stringify([
                { name: "Sales Daily", id: "ds-1" },
                { name: "Sales_Daily", id: "ds-2" },
              ]),
            },
          ],
        },
      },
    ];

    const resolved = resolveDatasourceIdentifier(["Sales Daily"], [], [], {
      rawToolResults,
    });
    expect(resolved.length).toBeGreaterThan(1);
    expect(
      Math.abs(resolved[0]!.matchConfidence - resolved[1]!.matchConfidence),
    ).toBeLessThanOrEqual(0.051);
  });

  it("prioritizes datasource resolution tools for metadata lookup when datasource name exists", () => {
    const intent: ClassifiedQuestionIntent = {
      intent: "metadata_lookup",
      confidence: 0.9,
      reasonBrief: "Need datasource fields.",
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 5,
    };
    const input: GetAdditionalContextInput = {
      ...baseInput,
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
      },
    };
    const tools = [
      {
        name: "list-datasources",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "search-content",
        inputSchema: {
          type: "object",
          properties: { terms: { type: "string" } },
        },
      },
      {
        name: "list-views",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "list-workbooks",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
    ];
    const selection = buildRuleBasedInitialSelections(
      tools,
      [],
      input,
      intent,
      5,
    );
    expect(selection.plannedTools[0]).toBe("list-datasources");
  });

  it("selects list-datasources as recovery tool when datasource is matched but identifier is missing", () => {
    const intent: ClassifiedQuestionIntent = {
      intent: "metadata_lookup",
      confidence: 0.9,
      reasonBrief: "Need datasource fields.",
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 5,
    };
    const tools = [
      {
        name: "list-datasources",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "search-content",
        inputSchema: {
          type: "object",
          properties: { terms: { type: "string" } },
        },
      },
      {
        name: "list-views",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "list-workbooks",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "get-workbook",
        inputSchema: {
          type: "object",
          properties: { workbookId: { type: "string" } },
        },
      },
      {
        name: "get-datasource-metadata",
        inputSchema: {
          type: "object",
          properties: { datasourceLuid: { type: "string" } },
        },
      },
    ];
    const selection = buildMetadataIdentifierRecoverySelection({
      tools,
      allowedToolNames: tools.map((tool) => tool.name),
      input: {
        ...baseInput,
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
      },
      intent,
      calledToolNames: new Set([
        "list-views",
        "get-workbook",
        "list-workbooks",
      ]),
      rawToolResults: [],
      observations: [],
      remainingToolBudget: 2,
    });
    expect(selection?.status).toBe("ready");
    if (selection?.status === "ready") {
      expect(selection.tool.name).toBe("list-datasources");
    }
  });

  it("selects search-content as recovery tool after list-datasources is called and identifier remains missing", () => {
    const intent: ClassifiedQuestionIntent = {
      intent: "metadata_lookup",
      confidence: 0.9,
      reasonBrief: "Need datasource fields.",
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 5,
    };
    const tools = [
      {
        name: "list-datasources",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "search-content",
        inputSchema: {
          type: "object",
          properties: { terms: { type: "string" } },
        },
      },
      {
        name: "get-datasource-metadata",
        inputSchema: {
          type: "object",
          properties: { datasourceLuid: { type: "string" } },
        },
      },
    ];
    const selection = buildMetadataIdentifierRecoverySelection({
      tools,
      allowedToolNames: tools.map((tool) => tool.name),
      input: {
        ...baseInput,
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
      },
      intent,
      calledToolNames: new Set(["list-datasources"]),
      rawToolResults: [
        {
          toolName: "list-datasources",
          result: {
            content: [
              {
                text: JSON.stringify([
                  { name: "Tableau Public Per Day(2025/04-)" },
                ]),
              },
            ],
          },
        },
      ],
      observations: [],
      remainingToolBudget: 1,
    });
    expect(selection?.status).toBe("ready");
    if (selection?.status === "ready") {
      expect(selection.tool.name).toBe("search-content");
    }
  });

  it("does not enqueue recovery tool when no remaining tool budget", () => {
    const intent: ClassifiedQuestionIntent = {
      intent: "metadata_lookup",
      confidence: 0.9,
      reasonBrief: "Need datasource fields.",
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 5,
    };
    const tools = [
      {
        name: "list-datasources",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
    ];
    const selection = buildMetadataIdentifierRecoverySelection({
      tools,
      allowedToolNames: ["list-datasources"],
      input: {
        ...baseInput,
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
      },
      intent,
      calledToolNames: new Set(),
      rawToolResults: [],
      observations: [],
      remainingToolBudget: 0,
    });
    expect(selection).toBeUndefined();
  });

  it("enqueues query-datasource recovery for aggregate analysis after datasource metadata is resolved", () => {
    const intent: ClassifiedQuestionIntent = {
      intent: "metadata_lookup",
      confidence: 0.85,
      reasonBrief: "Need datasource metadata first.",
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 5,
    };
    const tools = [
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
      {
        name: "list-datasources",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "get-datasource-metadata",
        inputSchema: {
          type: "object",
          properties: { datasourceLuid: { type: "string" } },
        },
      },
    ];

    const selection = buildDataAnalysisQueryRecoverySelection({
      tools,
      allowedToolNames: tools.map((tool) => tool.name),
      input: {
        ...baseInput,
        question:
          "Show a ranking of the Viz with the most favorites in 2026/05.",
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
      },
      intent,
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: [
        {
          toolName: "list-datasources",
          result: {
            content: [
              {
                text: JSON.stringify([
                  {
                    name: "Tableau Public Per Day(2025/04-)",
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
                    name: "Tableau Public Per Day(2025/04-)",
                    fields: [
                      { name: "Datetime(JST)" },
                      { name: "workbook_title" },
                      { name: "workbook_favoriteCount" },
                    ],
                  },
                }),
              },
            ],
          },
        },
      ],
      observations: [],
      remainingToolBudget: 2,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status === "ready") {
      expect(selection.tool.name).toBe("query-datasource");
      expect(selection.arguments.datasourceLuid).toBe("ds-123");
      expect(selection.arguments.limit).toBe(1);
      expect(selection.arguments.query).toEqual({
        fields: [
          { fieldCaption: "workbook_title", fieldAlias: "rank_label" },
          {
            fieldCaption: "workbook_favoriteCount",
            function: "SUM",
            fieldAlias: "rank_metric",
            sortDirection: "DESC",
            sortPriority: 1,
          },
        ],
        filters: [
          {
            field: { fieldCaption: "Datetime(JST)" },
            filterType: "QUANTITATIVE_DATE",
            quantitativeFilterType: "RANGE",
            minDate: "2026-05-01",
            maxDate: "2026-05-31",
            includeNulls: false,
          },
        ],
      });
    }
  });

  it("builds a full-year query filter for a year-only question", () => {
    const intent: ClassifiedQuestionIntent = {
      intent: "metadata_lookup",
      confidence: 0.85,
      reasonBrief: "Need datasource metadata first.",
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 5,
    };
    const tools = [
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
      {
        name: "list-datasources",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "get-datasource-metadata",
        inputSchema: {
          type: "object",
          properties: { datasourceLuid: { type: "string" } },
        },
      },
    ];

    const selection = buildDataAnalysisQueryRecoverySelection({
      tools,
      allowedToolNames: tools.map((tool) => tool.name),
      input: {
        ...baseInput,
        question:
          "2026年に最もFavoriteを集めたVizをランキング形式で教えてください。",
        dashboardContext: {
          ...baseInput.dashboardContext,
          capturedAt: "2026-06-03T00:00:00.000Z",
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
      },
      intent,
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: [
        {
          toolName: "list-datasources",
          result: {
            content: [
              {
                text: JSON.stringify([
                  {
                    name: "Tableau Public Per Day(2025/04-)",
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
                    name: "Tableau Public Per Day(2025/04-)",
                    fields: [
                      { name: "Datetime(JST)" },
                      { name: "workbook_title" },
                      { name: "workbook_favoriteCount" },
                    ],
                  },
                }),
              },
            ],
          },
        },
      ],
      observations: [],
      remainingToolBudget: 2,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status === "ready") {
      expect(selection.arguments.query).toEqual({
        fields: [
          { fieldCaption: "workbook_title", fieldAlias: "rank_label" },
          {
            fieldCaption: "workbook_favoriteCount",
            function: "SUM",
            fieldAlias: "rank_metric",
            sortDirection: "DESC",
            sortPriority: 1,
          },
        ],
        filters: [
          {
            field: { fieldCaption: "Datetime(JST)" },
            filterType: "QUANTITATIVE_DATE",
            quantitativeFilterType: "RANGE",
            minDate: "2026-01-01",
            maxDate: "2026-12-31",
            includeNulls: false,
          },
        ],
      });
    }
  });

  it("builds a rolling week query filter for a relative-period question", () => {
    const intent: ClassifiedQuestionIntent = {
      intent: "metadata_lookup",
      confidence: 0.85,
      reasonBrief: "Need datasource metadata first.",
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 5,
    };
    const tools = [
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
      {
        name: "list-datasources",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
        },
      },
      {
        name: "get-datasource-metadata",
        inputSchema: {
          type: "object",
          properties: { datasourceLuid: { type: "string" } },
        },
      },
    ];

    const selection = buildDataAnalysisQueryRecoverySelection({
      tools,
      allowedToolNames: tools.map((tool) => tool.name),
      input: {
        ...baseInput,
        question:
          "直近1週間で最もFavoriteを集めたVizをランキング形式で教えてください。",
        dashboardContext: {
          ...baseInput.dashboardContext,
          capturedAt: "2026-06-03T00:00:00.000Z",
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
      },
      intent,
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: [
        {
          toolName: "list-datasources",
          result: {
            content: [
              {
                text: JSON.stringify([
                  {
                    name: "Tableau Public Per Day(2025/04-)",
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
                    name: "Tableau Public Per Day(2025/04-)",
                    fields: [
                      { name: "Datetime(JST)" },
                      { name: "workbook_title" },
                      { name: "workbook_favoriteCount" },
                    ],
                  },
                }),
              },
            ],
          },
        },
      ],
      observations: [],
      remainingToolBudget: 2,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status === "ready") {
      expect(selection.arguments.query).toEqual({
        fields: [
          { fieldCaption: "workbook_title", fieldAlias: "rank_label" },
          {
            fieldCaption: "workbook_favoriteCount",
            function: "SUM",
            fieldAlias: "rank_metric",
            sortDirection: "DESC",
            sortPriority: 1,
          },
        ],
        filters: [
          {
            field: { fieldCaption: "Datetime(JST)" },
            filterType: "QUANTITATIVE_DATE",
            quantitativeFilterType: "RANGE",
            minDate: "2026-05-28",
            maxDate: "2026-06-03",
            includeNulls: false,
          },
        ],
      });
    }
  });

  it("keeps narrowed datasource matches and avoids re-expanding to list-datasources full set", () => {
    const normalized = normalizeTableauContext({
      dashboardContext: {
        ...baseInput.dashboardContext,
        workbookName: "Tableau Public Insights",
      },
      workbook: { name: "Tableau Public Insights", id: "wb-1" },
      datasources: [
        {
          type: "datasource",
          name: "Tableau Public Per Day(2025/04-)",
          id: "ds-target",
          luid: "ds-target",
          projectName: "Sandbox",
        },
      ],
      rawToolResults: [
        {
          toolName: "list-datasources",
          result: {
            content: [
              {
                text: JSON.stringify([
                  {
                    name: "Tableau Public Per Day(2025/04-)",
                    id: "ds-target",
                    project: { name: "Sandbox" },
                  },
                  {
                    name: "Superstore Datasource",
                    id: "ds-other-1",
                    project: { name: "Sandbox" },
                  },
                  {
                    name: "Admin Insights",
                    id: "ds-other-2",
                    project: { name: "Sandbox" },
                  },
                ]),
              },
            ],
          },
        },
      ],
    });

    expect(normalized.datasources).toHaveLength(1);
    expect(normalized.datasources[0]?.name).toBe(
      "Tableau Public Per Day(2025/04-)",
    );
    expect(normalized.datasources[0]?.id).toBe("ds-target");
    expect(normalized.datasources[0]?.luid).toBe("ds-target");
  });

  it("extracts structured ranking rows from successful query-datasource results", () => {
    const insights = extractQueryDatasourceInsightsFromRawToolResults(
      [
        {
          toolName: "query-datasource",
          args: {
            datasourceLuid: "ds-123",
            query: {
              fields: [
                { fieldCaption: "workbook_title", fieldAlias: "rank_label" },
                {
                  fieldCaption: "workbook_favoriteCount",
                  function: "SUM",
                  fieldAlias: "rank_metric",
                },
              ],
            },
          },
          result: {
            content: [
              {
                text: JSON.stringify({
                  data: [
                    { rank_label: "Viz A", rank_metric: 120 },
                    { rank_label: "Viz B", rank_metric: 88 },
                  ],
                }),
              },
            ],
          },
        },
      ],
      [
        {
          type: "datasource",
          name: "Tableau Public Per Day(2025/04-)",
          id: "ds-123",
          luid: "ds-123",
        },
      ],
    );

    expect(insights).toMatchObject([
      {
        datasourceName: "Tableau Public Per Day(2025/04-)",
        datasourceLuid: "ds-123",
        dimensionField: "workbook_title",
        metricField: "workbook_favoriteCount",
        rowCount: 2,
        actualRowCount: 2,
        fulfillsMetricRequest: true,
        fulfillsPeriodRequest: true,
        fulfillsRankingRequest: true,
        rows: [
          { label: "Viz A", value: 120 },
          { label: "Viz B", value: 88 },
        ],
      },
    ]);
  });

  it("uses the requested period instead of a datasource literal when building a recovery query", () => {
    const intent: ClassifiedQuestionIntent = {
      intent: "data_analysis",
      confidence: 0.9,
      reasonBrief: "Need an aggregate datasource query.",
      answerableFromDashboardContext: false,
      needsMcp: true,
      maxToolCalls: 5,
    };
    const tools = [
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
    ];

    const question =
      "Tableau Public Per Day(2025/04-)を使って、2026年4月に最もView数を集めたVizをランキング形式で教えてください。";
    const selection = buildDataAnalysisQueryRecoverySelection({
      tools,
      allowedToolNames: ["query-datasource"],
      input: {
        ...baseInput,
        question,
        questionInterpretation: interpretQuestion({
          question,
          dashboardContext: {
            ...baseInput.dashboardContext,
            dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
            capturedAt: "2026-06-04T00:00:00.000Z",
          },
        }),
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
          capturedAt: "2026-06-04T00:00:00.000Z",
        },
      },
      intent,
      calledToolNames: new Set(),
      rawToolResults: [
        {
          toolName: "list-datasources",
          result: {
            content: [
              {
                text: JSON.stringify([
                  {
                    name: "Tableau Public Per Day(2025/04-)",
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
                    name: "Tableau Public Per Day(2025/04-)",
                    fields: [
                      { name: "Datetime(JST)" },
                      { name: "workbook_title" },
                      { name: "workbook_viewCount" },
                      { name: "workbook_favoriteCount" },
                    ],
                  },
                }),
              },
            ],
          },
        },
      ],
      observations: [],
      remainingToolBudget: 1,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status === "ready") {
      expect(selection.arguments.query).toEqual(
        expect.objectContaining({
          fields: expect.arrayContaining([
            { fieldCaption: "workbook_title", fieldAlias: "rank_label" },
            expect.objectContaining({
              fieldCaption: "workbook_viewCount",
              function: "SUM",
              fieldAlias: "rank_metric",
              sortDirection: "DESC",
              sortPriority: 1,
            }),
          ]),
          filters: [
            {
              field: { fieldCaption: "Datetime(JST)" },
              filterType: "QUANTITATIVE_DATE",
              quantitativeFilterType: "RANGE",
              minDate: "2026-04-01",
              maxDate: "2026-04-30",
              includeNulls: false,
            },
          ],
        }),
      );
    }
  });

  it("dedupes grouped trend query fields and keeps engagement_rate out of query-datasource fields", () => {
    const question =
      "インプレッション数が高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。";
    const interpretation = interpretQuestion({
      question,
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "X Account Analytics Contents" }],
      },
    });
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
        dashboardContext: {
          ...baseInput.dashboardContext,
          dataSources: [{ name: "X Account Analytics Contents" }],
          capturedAt: "2026-06-04T00:00:00.000Z",
        },
      },
      intent: {
        intent: "data_analysis",
        confidence: 0.92,
        reasonBrief: "Need grouped trend analysis.",
        answerableFromDashboardContext: false,
        needsMcp: true,
        maxToolCalls: 2,
      },
      calledToolNames: new Set(["list-datasources", "get-datasource-metadata"]),
      rawToolResults: [
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
      ],
      observations: [],
      remainingToolBudget: 1,
    });

    expect(selection?.status).toBe("ready");
    if (selection?.status !== "ready") {
      throw new Error("Expected a ready query selection.");
    }

    const query = selection.arguments.query as Record<string, unknown>;
    const fields = Array.isArray(query.fields) ? query.fields : [];
    const keySet = new Set(
      fields.map((field) => {
        if (!field || typeof field !== "object" || Array.isArray(field)) {
          return "invalid";
        }
        const record = field as Record<string, unknown>;
        return `${record.fieldCaption ?? ""}|${String(record.function ?? "")}`;
      }),
    );

    expect(keySet.size).toBe(fields.length);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldCaption: "Hashtag Normalized",
          fieldAlias: "rank_label",
        }),
        expect.objectContaining({
          fieldCaption: "ポストid",
          fieldAlias: "post_count",
          function: "COUNT",
        }),
        expect.objectContaining({
          fieldCaption: "エンゲージメント",
          fieldAlias: "engagement_total",
          function: "SUM",
        }),
        expect.objectContaining({
          fieldCaption: "インプレッション数",
          fieldAlias: "impression_total",
          function: "SUM",
        }),
      ]),
    );
    expect(
      fields.some((field) => {
        if (!field || typeof field !== "object" || Array.isArray(field)) {
          return false;
        }
        return (
          String((field as Record<string, unknown>).fieldAlias ?? "") ===
          "engagement_rate"
        );
      }),
    ).toBe(false);
  });

  it("treats engagement_rate as an in-app derived metric for grouped trend query insights", () => {
    const interpretation = interpretQuestion({
      question:
        "エンゲージメント率が高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。",
      dashboardContext: {
        ...baseInput.dashboardContext,
        dataSources: [{ name: "X Account Analytics Contents" }],
      },
    });

    const insights = extractQueryDatasourceInsightsFromRawToolResults(
      [
        {
          toolName: "query-datasource",
          args: {
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
              ],
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

    expect(insights).toHaveLength(1);
    expect(insights[0]?.queryDebug?.derivedMetricsComputedInApp).toContain(
      "engagement_rate",
    );
    expect(insights[0]?.metricMatchConfidence).toBe(1);
    expect(insights[0]?.fulfillsMetricRequest).toBe(true);
  });

  it("drops query insights that do not match the requested metric intent", () => {
    const insights = extractQueryDatasourceInsightsFromRawToolResults(
      [
        {
          toolName: "query-datasource",
          args: {
            datasourceLuid: "ds-123",
            query: {
              fields: [
                { fieldCaption: "workbook_title", fieldAlias: "rank_label" },
                {
                  fieldCaption: "workbook_favoriteCount",
                  function: "SUM",
                  fieldAlias: "rank_metric",
                },
              ],
            },
          },
          result: {
            content: [
              {
                text: JSON.stringify({
                  data: [{ rank_label: "Viz A", rank_metric: 120 }],
                }),
              },
            ],
          },
        },
      ],
      [
        {
          type: "datasource",
          name: "Tableau Public Per Day(2025/04-)",
          id: "ds-123",
          luid: "ds-123",
        },
      ],
      {
        originalQuestion: "2026年4月のView数ランキング",
        investigationQuestion: "2026年4月のView数ランキング",
        datasourceMentions: [],
        requestType: "general",
        analysisIntent: "ranking",
        metricIntent: "views",
        asksForRanking: true,
        topN: 10,
        period: {
          kind: "month",
          label: "2026年4月",
          startDate: "2026-04-01",
          endDate: "2026-04-30",
          raw: "2026年4月",
          warnings: [],
        },
      },
    );

    expect(insights).toEqual([]);
  });
});
