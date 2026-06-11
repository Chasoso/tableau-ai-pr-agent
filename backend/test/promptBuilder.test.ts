import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/services/promptBuilder";
import type { ChatHistoryRecord, ChatRequest } from "../src/types/chat";

const request: ChatRequest = {
  question: "What drove sales growth?",
  dashboardContext: {
    dashboardName: "Sales Dashboard",
    workbookName: "Executive Workbook",
    worksheets: [{ name: "Sales Trend" }],
    filters: [{ fieldName: "Region", appliedValues: ["West"] }],
    parameters: [{ name: "Metric", currentValue: "Sales" }],
    capturedAt: new Date().toISOString(),
  },
};

describe("buildPrompt", () => {
  it("includes the dashboard context and question", () => {
    const prompt = buildPrompt(request, {
      provider: "mock",
    });

    expect(prompt).toContain("What drove sales growth?");
    expect(prompt).toContain("Sales Dashboard");
    expect(prompt).toContain("Executive Workbook");
    expect(prompt).toContain("Sales Trend");
    expect(prompt).toContain("Region: West");
    expect(prompt).toContain("Do not provide long HTTP status explanations");
    expect(prompt).toContain("Never mention internal MCP tool names");
  });

  it("uses normalized datasource list instead of dashboard/view names", () => {
    const prompt = buildPrompt(
      {
        ...request,
        dashboardContext: {
          ...request.dashboardContext,
          dashboardName: "Statistics",
          dataSources: [{ name: "Statistics" }],
        },
      },
      {
        provider: "tableau-mcp",
        normalizedContext: {
          dashboard: { name: "Statistics" },
          workbook: {
            type: "workbook",
            name: "Tableau Public Insights",
          },
          views: [],
          datasources: [
            {
              type: "datasource",
              name: "Tableau Public Per Day(2025/04-)",
            },
          ],
          projects: [],
        },
      },
    );

    expect(prompt).toContain("Data sources: Tableau Public Per Day(2025/04-)");
    expect(prompt).not.toContain("Data sources: Statistics");
  });

  it("includes recent session history when provided", () => {
    const recentHistory: ChatHistoryRecord[] = [
      {
        sessionId: "session-1",
        messageId: "message-1",
        ownerUserId: "user-1",
        question: "What changed last week?",
        answer: "Views declined compared with the prior week.",
        dashboardName: "Sales Dashboard",
        workbookName: "Executive Workbook",
        worksheetNames: ["Sales Trend"],
        createdAt: new Date().toISOString(),
        source: "tableau-extension",
      },
    ];

    const prompt = buildPrompt(
      request,
      {
        provider: "mock",
      },
      recentHistory,
    );

    expect(prompt).toContain(
      "Recent conversation in the same authenticated session:",
    );
    expect(prompt).toContain("Turn 1 user: What changed last week?");
    expect(prompt).toContain(
      "Turn 1 assistant: Views declined compared with the prior week.",
    );
  });

  it("includes agent planning notes when provided", () => {
    const prompt = buildPrompt(
      request,
      {
        provider: "mock",
      },
      [],
      {
        agentPlanSummary: "Clarify the request as a datasource-backed ranking.",
        investigationQuestion: "2026年のFavorite数を集計してください。",
        evaluationSummary: "Collected evidence is sufficient.",
        evidenceGaps: ["none"],
      },
    );

    expect(prompt).toContain(
      "Agent plan: Clarify the request as a datasource-backed ranking.",
    );
    expect(prompt).toContain(
      "Tool-planning question: 2026年のFavorite数を集計してください。",
    );
    expect(prompt).toContain(
      "Evidence evaluation: Collected evidence is sufficient.",
    );
    expect(prompt).toContain("Remaining evidence gaps: none");
  });

  it("compresses MCP observations into a short evidence summary", () => {
    const prompt = buildPrompt(request, {
      provider: "mock",
      mcpObservations: [
        {
          tool: "list-workbooks",
          purpose: "Look up workbook context",
          argsSummary: {},
          success: true,
          resultSummary: "Found 2 workbooks",
        },
        {
          tool: "get-workbook",
          purpose: "Inspect workbook metadata",
          argsSummary: {},
          success: false,
          resultSummary: "No workbook id available",
          errorMessage: "Missing workbook id",
        },
      ],
    });

    expect(prompt).toContain("MCP evidence summary:");
    expect(prompt).toContain("list-workbooks:ok:Found 2 workbooks");
    expect(prompt).toContain("get-workbook:fail:No workbook id available");
  });

  it("adds a strong no-fabrication instruction when MCP connection fails", () => {
    const prompt = buildPrompt(request, {
      provider: "tableau-mcp",
      mcpConnectionFailed: true,
      mcpFailureStage: "startup",
      warnings: [
        "Tableau MCP lookup failed before usable observations were collected.",
      ],
    });

    expect(prompt).toContain(
      "do not fabricate rankings, totals, or datasource-wide conclusions",
    );
    expect(prompt).toContain(
      "avoid treating the current filter scope as evidence that the entire datasource is empty",
    );
  });
});
