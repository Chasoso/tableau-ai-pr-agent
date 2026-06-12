import { describe, expect, it, vi } from "vitest";
import { ActionRunAnalysisService } from "../src/services/actionRunAnalysisService";

describe("ActionRunAnalysisService", () => {
  it("builds fixed Tableau analysis sections from MCP context", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn().mockResolvedValue({
        provider: "tableau-mcp" as const,
        queryInsights: [
          {
            datasourceName: "x_posts",
            dimensionField: "post_type",
            metricField: "post_count",
            rows: [
              { label: "事前告知", value: 12 },
              { label: "開催中", value: 9 },
            ],
          },
        ],
        warnings: ["warning from provider"],
      }),
    };

    const service = new ActionRunAnalysisService(provider as never);
    const result = await service.analyzeActionRun({
      request: buildRequest(),
    });

    expect(provider.getAdditionalContext).toHaveBeenCalledTimes(4);
    expect(result.analysisSections).toHaveLength(4);
    expect(result.analysisSections?.[0]).toMatchObject({
      key: "post_type_distribution",
      title: "Post type distribution",
      rows: [
        { label: "事前告知", value: 12 },
        { label: "開催中", value: 9 },
      ],
    });
    expect(result.summary).toContain("Tableau User Group Tokyo 2026");
    expect(result.suggestedSlackPostText).toContain("Tableau");
    expect(result.debug?.tableau?.warnings).toContain("warning from provider");
  });
});

function buildRequest() {
  return {
    postType: "\u4e8b\u524d\u544a\u77e5",
    eventName: "Tableau User Group Tokyo 2026",
    techplayUrl: "https://techplay.jp/event/123",
    currentSituation: "The venue is filling up.",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-08T00:00:00.000Z",
    },
  } as never;
}
