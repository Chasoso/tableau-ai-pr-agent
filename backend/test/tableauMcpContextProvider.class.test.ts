import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TableauMcpContextProvider,
  buildRuleBasedInitialSelections,
} from "../src/tableau/tableauMcpContextProvider";
import {
  TableauMcpToolPlanner,
  type ClassifiedQuestionIntent,
} from "../src/services/tableauMcpToolPlanner";
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

const provider = new TableauMcpContextProvider();

const dashboardContext: GetAdditionalContextInput["dashboardContext"] = {
  dashboardName: "Statistics",
  workbookName: "Tableau Public Insights",
  worksheets: [{ name: "Views" }],
  filters: [],
  parameters: [],
  dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
  capturedAt: "2026-06-04T00:00:00.000Z",
};

const intent: ClassifiedQuestionIntent = {
  intent: "metadata_lookup",
  confidence: 0.91,
  reasonBrief: "Need datasource metadata.",
  answerableFromDashboardContext: false,
  needsMcp: true,
  maxToolCalls: 1,
};

function setMcpEnv(values: Record<string, string>): void {
  process.env.TABLEAU_MCP_TRANSPORT = values.TABLEAU_MCP_TRANSPORT;
  process.env.TABLEAU_MCP_SERVER_URL = values.TABLEAU_MCP_SERVER_URL;
  process.env.TABLEAU_MCP_TIMEOUT_MS = values.TABLEAU_MCP_TIMEOUT_MS;
  process.env.TABLEAU_MCP_ALLOWED_TOOLS = values.TABLEAU_MCP_ALLOWED_TOOLS;
  process.env.TABLEAU_MCP_MAX_TOOL_CALLS = values.TABLEAU_MCP_MAX_TOOL_CALLS;
  process.env.TABLEAU_MCP_COMMAND = values.TABLEAU_MCP_COMMAND;
  process.env.TABLEAU_MCP_ARGS = values.TABLEAU_MCP_ARGS;
  process.env.TABLEAU_MCP_TOOL_PLANNING_ENABLED =
    values.TABLEAU_MCP_TOOL_PLANNING_ENABLED;
  process.env.TABLEAU_MCP_METADATA_CACHE_ENABLED =
    values.TABLEAU_MCP_METADATA_CACHE_ENABLED;
  process.env.TABLEAU_SERVER_URL =
    process.env.TABLEAU_SERVER_URL ?? "https://tableau.example.com";
  process.env.TABLEAU_SITE_CONTENT_URL =
    process.env.TABLEAU_SITE_CONTENT_URL ?? "site";
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TABLEAU_MCP_TRANSPORT;
  delete process.env.TABLEAU_MCP_SERVER_URL;
  delete process.env.TABLEAU_MCP_TIMEOUT_MS;
  delete process.env.TABLEAU_MCP_ALLOWED_TOOLS;
  delete process.env.TABLEAU_MCP_MAX_TOOL_CALLS;
  delete process.env.TABLEAU_MCP_COMMAND;
  delete process.env.TABLEAU_MCP_ARGS;
  delete process.env.TABLEAU_MCP_TOOL_PLANNING_ENABLED;
  delete process.env.TABLEAU_MCP_METADATA_CACHE_ENABLED;
  delete process.env.TABLEAU_SERVER_URL;
  delete process.env.TABLEAU_SITE_CONTENT_URL;
});

describe("TableauMcpContextProvider", () => {
  it("returns a warning when no Tableau subject is available", async () => {
    setMcpEnv({
      TABLEAU_MCP_TRANSPORT: "stdio",
      TABLEAU_MCP_SERVER_URL: "",
      TABLEAU_MCP_TIMEOUT_MS: "5000",
      TABLEAU_MCP_ALLOWED_TOOLS: "",
      TABLEAU_MCP_MAX_TOOL_CALLS: "1",
      TABLEAU_MCP_COMMAND: "",
      TABLEAU_MCP_ARGS: "",
      TABLEAU_MCP_TOOL_PLANNING_ENABLED: "false",
      TABLEAU_MCP_METADATA_CACHE_ENABLED: "false",
    });

    const result = await provider.getAdditionalContext({
      dashboardContext,
      question: "Show metadata",
    });

    expect(result.provider).toBe("tableau-mcp");
    expect(result.warnings).toEqual([
      "Tableau MCP lookup skipped because no authenticated Tableau subject was available.",
    ]);
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });

  it("returns a warning when the MCP transport is unsupported", async () => {
    setMcpEnv({
      TABLEAU_MCP_TRANSPORT: "stream",
      TABLEAU_MCP_SERVER_URL: "",
      TABLEAU_MCP_TIMEOUT_MS: "5000",
      TABLEAU_MCP_ALLOWED_TOOLS: "",
      TABLEAU_MCP_MAX_TOOL_CALLS: "1",
      TABLEAU_MCP_COMMAND: "",
      TABLEAU_MCP_ARGS: "",
      TABLEAU_MCP_TOOL_PLANNING_ENABLED: "false",
      TABLEAU_MCP_METADATA_CACHE_ENABLED: "false",
    });

    const result = await provider.getAdditionalContext({
      dashboardContext,
      question: "Show metadata",
      tableauSubject: "user@example.com",
    });

    expect(result.provider).toBe("tableau-mcp");
    expect(result.warnings?.[0]).toContain("is not supported");
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });

  it("uses the HTTP stub when the transport is http", async () => {
    setMcpEnv({
      TABLEAU_MCP_TRANSPORT: "http",
      TABLEAU_MCP_SERVER_URL: "https://mcp.example.com/lookup/",
      TABLEAU_MCP_TIMEOUT_MS: "5000",
      TABLEAU_MCP_ALLOWED_TOOLS: "",
      TABLEAU_MCP_MAX_TOOL_CALLS: "1",
      TABLEAU_MCP_COMMAND: "",
      TABLEAU_MCP_ARGS: "",
      TABLEAU_MCP_TOOL_PLANNING_ENABLED: "false",
      TABLEAU_MCP_METADATA_CACHE_ENABLED: "false",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          workbook: { name: "Tableau Public Insights" },
          datasources: [{ type: "datasource", name: "Mock Datasource" }],
          normalizedContext: {
            dashboard: { name: "Statistics" },
            views: [],
            datasources: [],
            projects: [],
          },
          questionInterpretation: {
            originalQuestion: "Show metadata",
            investigationQuestion: "Show metadata",
            datasourceMentions: [],
            requestType: "general",
            analysisIntent: "unknown",
            metricIntent: "unknown",
            asksForRanking: false,
            topN: 10,
          },
          metadata: { source: "http" },
          mcpTools: [{ name: "get-datasource-metadata" }],
          mcpToolResults: [],
          mcpObservations: [],
          mcpExecutionDebug: {
            intent: "metadata_lookup",
            intentConfidence: 0.9,
            answerableFromDashboardContext: false,
            needsMcp: true,
            maxToolCalls: 1,
            plannedTools: ["get-datasource-metadata"],
            blockedTools: [],
            executedTools: ["get-datasource-metadata"],
            skippedTools: [],
            toolCallCount: 1,
            replanUsed: false,
            timingMs: { planning: 1, execution: 2 },
          },
          warnings: ["from-http"],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.getAdditionalContext({
      dashboardContext,
      question: "Show metadata",
      tableauSubject: "user@example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://mcp.example.com/lookup",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
      }),
    );
    expect(result.provider).toBe("tableau-mcp");
    expect(result.warnings).toEqual(["from-http"]);
    expect(result.metadata).toEqual({ source: "http" });
  });

  it("executes a metadata tool in stdio mode and respects the max tool count", async () => {
    setMcpEnv({
      TABLEAU_MCP_TRANSPORT: "stdio",
      TABLEAU_MCP_SERVER_URL: "",
      TABLEAU_MCP_TIMEOUT_MS: "5000",
      TABLEAU_MCP_ALLOWED_TOOLS: "",
      TABLEAU_MCP_MAX_TOOL_CALLS: "1",
      TABLEAU_MCP_COMMAND: "",
      TABLEAU_MCP_ARGS: "",
      TABLEAU_MCP_TOOL_PLANNING_ENABLED: "false",
      TABLEAU_MCP_METADATA_CACHE_ENABLED: "false",
    });

    mocks.getTableauConnectedAppSecrets.mockResolvedValue({
      clientId: "client-id",
      secretId: "secret-id",
      secretValue: "secret-value",
    });
    mocks.client.connect.mockResolvedValue(undefined);
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          name: "get-datasource-metadata",
          inputSchema: {
            type: "object",
            required: ["datasourceLuid"],
            properties: {
              datasourceLuid: { type: "string" },
            },
          },
        },
      ],
    });
    mocks.client.callTool.mockResolvedValue({
      content: [
        {
          text: JSON.stringify({
            datasourceModel: {
              name: "Tableau Public Per Day(2025/04-)",
              fields: [{ name: "workbook_title" }],
            },
          }),
        },
      ],
    });

    const result = await provider.getAdditionalContext({
      dashboardContext: {
        ...dashboardContext,
        dataSources: [
          {
            name: "Tableau Public Per Day(2025/04-)",
            id: "datasource-1234",
          },
        ],
      },
      question: "Show datasource metadata",
      questionInterpretation: {
        originalQuestion: "Show datasource metadata",
        investigationQuestion: "Show datasource metadata",
        datasourceMentions: [],
        requestType: "general",
        analysisIntent: "unknown",
        metricIntent: "unknown",
        asksForRanking: false,
        topN: 10,
      },
      intentHint: intent,
      tableauSubject: "user@example.com",
    });

    expect(mocks.clientConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.transportConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.client.connect).toHaveBeenCalledTimes(1);
    expect(mocks.client.listTools).toHaveBeenCalledTimes(1);
    expect(mocks.client.callTool).toHaveBeenCalledTimes(1);
    expect(result.mcpExecutionDebug?.toolCallCount).toBe(1);
    expect(result.mcpTools?.[0]?.name).toBe("get-datasource-metadata");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        transport: "stdio",
        hasMetadata: true,
      }),
    );
  });

  it("blocks datasource-resolution tools when they are not allowlisted", () => {
    const selection = buildRuleBasedInitialSelections(
      [
        {
          name: "list-datasources",
          inputSchema: { type: "object" },
        },
        {
          name: "search-content",
          inputSchema: { type: "object" },
        },
      ],
      ["get-workbook"],
      {
        dashboardContext: {
          ...dashboardContext,
          dataSources: [{ name: "Tableau Public Per Day(2025/04-)" }],
        },
        question: "Show datasource metadata",
      },
      intent,
      1,
    );

    expect(selection.stopFallback).toBe(true);
    expect(selection.blockedTools).toEqual([
      "list-datasources",
      "search-content",
    ]);
    expect(selection.selections).toEqual([]);
  });

  it("stops planning after the configured max tool count", () => {
    const selection = buildRuleBasedInitialSelections(
      [
        { name: "list-views", inputSchema: { type: "object" } },
        { name: "list-workbooks", inputSchema: { type: "object" } },
        { name: "get-workbook", inputSchema: { type: "object" } },
      ],
      ["list-views", "list-workbooks", "get-workbook"],
      {
        question: "Show workbook metadata",
        dashboardContext: {
          ...dashboardContext,
          dataSources: [],
        },
      },
      intent,
      1,
    );

    expect(selection.selections).toHaveLength(1);
    expect(selection.plannedTools).toEqual(["list-views"]);
  });

  it("runs independent initial tool calls in parallel when possible", async () => {
    setMcpEnv({
      TABLEAU_MCP_TRANSPORT: "stdio",
      TABLEAU_MCP_SERVER_URL: "",
      TABLEAU_MCP_TIMEOUT_MS: "5000",
      TABLEAU_MCP_ALLOWED_TOOLS: "get-workbook,get-datasource-metadata",
      TABLEAU_MCP_MAX_TOOL_CALLS: "2",
      TABLEAU_MCP_COMMAND: "",
      TABLEAU_MCP_ARGS: "",
      TABLEAU_MCP_TOOL_PLANNING_ENABLED: "true",
      TABLEAU_MCP_METADATA_CACHE_ENABLED: "false",
    });

    const planSpy = vi
      .spyOn(TableauMcpToolPlanner.prototype, "plan")
      .mockResolvedValue({
        intent: "data_analysis",
        confidence: 0.9,
        answerableFromDashboardContext: false,
        needsMcp: true,
        reasonBrief: "Need two independent lookups.",
        maxToolCalls: 2,
        toolCalls: [
          {
            toolName: "get-workbook",
            arguments: { workbookId: "11111111-1111-1111-1111-111111111111" },
            purpose: "Load workbook metadata.",
          },
          {
            toolName: "get-datasource-metadata",
            arguments: {
              datasourceLuid: "22222222-2222-2222-2222-222222222222",
            },
            purpose: "Load datasource metadata.",
          },
        ],
      });

    const deferreds = {
      workbook: createDeferred<unknown>(),
      metadata: createDeferred<unknown>(),
    };
    let activeCalls = 0;
    let maxActiveCalls = 0;

    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          name: "get-workbook",
          inputSchema: {
            type: "object",
            properties: {
              workbookId: { type: "string" },
            },
            required: ["workbookId"],
          },
        },
        {
          name: "get-datasource-metadata",
          inputSchema: {
            type: "object",
            properties: {
              datasourceLuid: { type: "string" },
            },
            required: ["datasourceLuid"],
          },
        },
      ],
    });
    mocks.getTableauConnectedAppSecrets.mockResolvedValue({
      clientId: "client-id",
      secretId: "secret-id",
      secretValue: "secret-value",
    });
    mocks.client.connect.mockResolvedValue(undefined);
    mocks.client.callTool.mockImplementation(async ({ name }) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      try {
        if (name === "get-workbook") {
          return await deferreds.workbook.promise;
        }

        return await deferreds.metadata.promise;
      } finally {
        activeCalls -= 1;
      }
    });

    const contextPromise = provider.getAdditionalContext({
      dashboardContext,
      question: "Load workbook and datasource metadata in parallel.",
      intentHint: {
        intent: "data_analysis",
        confidence: 0.9,
        reasonBrief: "Need two independent lookups.",
        answerableFromDashboardContext: false,
        needsMcp: true,
        maxToolCalls: 2,
      },
      tableauSubject: "user@example.com",
    });

    await flushMicrotasks();
    expect(maxActiveCalls).toBe(2);

    deferreds.workbook.resolve({
      content: [
        {
          text: JSON.stringify({
            id: "11111111-1111-1111-1111-111111111111",
            name: "Workbook A",
          }),
        },
      ],
    });
    deferreds.metadata.resolve({
      content: [
        {
          text: JSON.stringify({
            datasourceName: "Datasource A",
            datasourceModel: { fields: [] },
          }),
        },
      ],
    });

    const result = await contextPromise;

    expect(mocks.client.callTool).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("tableau-mcp");
    expect(maxActiveCalls).toBeGreaterThanOrEqual(2);
    planSpy.mockRestore();
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
