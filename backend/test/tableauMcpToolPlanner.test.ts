import { describe, expect, it } from "vitest";
import {
  classifyQuestionIntent,
  filterAllowedToolNamesByIntent,
  parseToolPlanResponse,
  resolveAllowedToolNames,
} from "../src/services/tableauMcpToolPlanner";
import { interpretQuestion } from "../src/services/questionInterpretation";

describe("tableauMcpToolPlanner", () => {
  it("parses planned MCP tool calls from fenced JSON", () => {
    const plan = parseToolPlanResponse(`
\`\`\`json
{
  "intent": "data_analysis",
  "confidence": 0.9,
  "answerableFromDashboardContext": false,
  "needsMcp": true,
  "reasonBrief": "Need datasource metadata and aggregate query.",
  "maxToolCalls": 4,
  "toolCalls": [
    {
      "toolName": "list-datasources",
      "purpose": "Find datasource IDs for this workbook.",
      "arguments": {},
      "reason": "Find datasources used by the workbook."
    },
    {
      "tool": "query-datasource",
      "arguments": {
        "datasourceLuid": "abc",
        "query": { "fields": [{ "fieldCaption": "Views", "function": "SUM" }] },
        "authorization": "Bearer unsafe"
      }
    }
  ]
}
\`\`\`
`);

    expect(plan?.toolCalls).toEqual([
      {
        toolName: "list-datasources",
        purpose: "Find datasource IDs for this workbook.",
        reason: "Find datasources used by the workbook.",
      },
      {
        toolName: "query-datasource",
        arguments: {
          datasourceLuid: "abc",
          query: { fields: [{ fieldCaption: "Views", function: "SUM" }] },
        },
      },
    ]);
    expect(plan?.intent).toBe("data_analysis");
    expect(plan?.needsMcp).toBe(true);
  });

  it("uses all MCP-exposed tools when no explicit allowlist is configured", () => {
    const allowed = resolveAllowedToolNames(
      [
        { name: "list-workbooks" },
        { name: "query-datasource" },
        { name: "delete-everything" },
      ],
      [],
    );

    expect(allowed).toEqual([
      "list-workbooks",
      "query-datasource",
      "delete-everything",
    ]);
  });

  it("intersects configured allowlist with tools exposed by MCP", () => {
    const allowed = resolveAllowedToolNames(
      [
        { name: "list-workbooks" },
        { name: "query-datasource" },
        { name: "delete-everything" },
      ],
      ["list-workbooks", "query-datasource", "get-workbook"],
    );

    expect(allowed).toEqual(["list-workbooks", "query-datasource"]);
  });

  it("classifies filter question intent", () => {
    const intent = classifyQuestionIntent(
      "今のフィルター状態を説明して",
      {
        dashboardName: "Dashboard",
        worksheets: [{ name: "Sheet 1" }],
        filters: [{ fieldName: "Region", appliedValues: ["West"] }],
        parameters: [],
        capturedAt: "2026-05-28T00:00:00.000Z",
      },
      ["list-views"],
    );

    expect(intent.intent).toBe("filter_or_selection_state");
    expect(intent.needsMcp).toBe(false);
  });

  it("prioritizes metadata intent when question asks for datasource fields", () => {
    const intent = classifyQuestionIntent(
      "このダッシュボードで使われているデータソースのフィールドを説明して",
      {
        dashboardName: "Statistics",
        workbookName: "Tableau Public Insights",
        worksheets: [{ name: "Views" }],
        filters: [],
        parameters: [],
        dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        capturedAt: "2026-05-31T00:00:00.000Z",
      },
      ["list-datasources", "get-datasource-metadata", "query-datasource"],
    );

    expect(intent.intent).toBe("metadata_lookup");
  });

  it("uses the request type hint to keep field inventory questions out of data analysis", () => {
    const intent = classifyQuestionIntent(
      "X Account Analytics Contentsのフィールドについて教えてください。",
      {
        dashboardName: "Analytics",
        workbookName: "Social Workbook",
        worksheets: [{ name: "Posts" }],
        filters: [],
        parameters: [],
        dataSources: [{ name: "X Account Analytics Contents" }],
        capturedAt: "2026-06-07T00:00:00.000Z",
      },
      ["list-datasources", "get-datasource-metadata", "query-datasource"],
      "field_inventory",
    );

    expect(intent.intent).toBe("metadata_lookup");
    expect(intent.needsMcp).toBe(true);
  });

  it("prioritizes data_analysis when the question asks for ranked query results", () => {
    const intent = classifyQuestionIntent(
      "viewCountが最も多いworkbookは何か、データソースをクエリして求めてください。",
      {
        dashboardName: "Statistics",
        workbookName: "Tableau Public Insights",
        worksheets: [{ name: "Views" }],
        filters: [],
        parameters: [],
        dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        capturedAt: "2026-05-31T00:00:00.000Z",
      },
      ["list-datasources", "get-datasource-metadata", "query-datasource"],
    );

    expect(intent.intent).toBe("data_analysis");
    expect(intent.needsMcp).toBe(true);
  });

  it("prioritizes grouped hashtag trend analysis as data analysis", () => {
    const question =
      "エンゲージメント率が高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。";
    const dashboardContext = {
      dashboardName: "X Dashboard",
      workbookName: "X Workbook",
      worksheets: [{ name: "Posts" }],
      filters: [],
      parameters: [],
      dataSources: [{ name: "X Account Analytics Contents" }],
      capturedAt: "2026-06-07T00:00:00.000Z",
    };
    const interpretation = interpretQuestion({
      question,
      dashboardContext,
    });

    const intent = classifyQuestionIntent(
      question,
      dashboardContext,
      ["list-datasources", "get-datasource-metadata", "query-datasource"],
      undefined,
      interpretation,
    );

    expect(interpretation.analysisIntent).toBe("grouped_trend");
    expect(interpretation.groupingIntent).toBe("hashtag");
    expect(intent.intent).toBe("data_analysis");
    expect(intent.needsMcp).toBe(true);
  });

  it("keeps tool freedom in soft intent filter mode", () => {
    const allowed = filterAllowedToolNamesByIntent(
      ["list-views", "list-datasources", "search-content"],
      "metadata_lookup",
      "soft",
    );

    expect(allowed).toEqual([
      "list-views",
      "list-datasources",
      "search-content",
    ]);
  });

  it("restricts tools by intent in strict mode", () => {
    const allowed = filterAllowedToolNamesByIntent(
      ["list-views", "search-content", "query-datasource"],
      "metadata_lookup",
      "strict",
    );

    expect(allowed).toEqual(["list-views"]);
  });

  it("supports mask sanitize mode while preserving argument structure", () => {
    const plan = parseToolPlanResponse(
      JSON.stringify({
        intent: "data_analysis",
        confidence: 0.75,
        needsMcp: true,
        answerableFromDashboardContext: false,
        reasonBrief: "Need analysis",
        maxToolCalls: 3,
        toolCalls: [
          {
            toolName: "query-datasource",
            arguments: {
              datasourceLuid: "abc",
              authorization: "Bearer xyz",
              query: {
                fields: [{ fieldCaption: "Views", function: "SUM" }],
              },
            },
          },
        ],
      }),
      undefined,
      {
        mode: "mask",
        maxDepth: 5,
        maxArrayLength: 50,
        maxObjectKeys: 30,
      },
    );

    expect(plan?.toolCalls[0]?.arguments).toEqual({
      datasourceLuid: "abc",
      authorization: "__REDACTED__",
      query: {
        fields: [{ fieldCaption: "Views", function: "SUM" }],
      },
    });
  });
});
