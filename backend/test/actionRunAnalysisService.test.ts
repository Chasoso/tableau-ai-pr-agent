import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionRunAnalysisService } from "../src/services/actionRunAnalysisService";

describe("ActionRunAnalysisService", () => {
  const originalDemoMode = process.env.DEMO_MODE;

  afterEach(() => {
    if (originalDemoMode === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = originalDemoMode;
    }
  });

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
              { label: "Post A", value: 12 },
              { label: "Post B", value: 9 },
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
        { label: "Post A", value: 12 },
        { label: "Post B", value: 9 },
      ],
    });
    expect(result.summary).toContain("Tableau User Group Tokyo 2026");
    expect(result.suggestedSlackPostText).toContain(
      "Tableau User Group Tokyo 2026",
    );
    expect(result.suggestedSlackPostText).toContain("#Tableau");
    expect(result.draftVariants?.x).toContain("Tableau User Group Tokyo 2026");
    expect(result.draftReview?.status).toMatch(/pass|needs_info|needs_review/);
    expect(result.debug?.tableau?.warnings).toContain("warning from provider");
    expect(result.safetyReview?.required).toBe(true);
    expect(result.safetyReview?.status).toBe("pending_manual_review");
    expect(result.safetyReview?.notes?.[0]).toContain(
      "Human approval is required",
    );
    expect(result.debug?.tableau?.qualityReview?.signals?.[0]).toContain(
      "Post type distribution:",
    );
    expect(result.debug?.tableau?.qualityReview?.signals?.[0]).toContain(
      "(12 posts)",
    );
    expect(result.debug?.tableau?.qualityReview?.score).toBeGreaterThan(0);
  });

  it("uses deterministic fallback sections in demo mode", async () => {
    process.env.DEMO_MODE = "true";
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(),
    };

    const service = new ActionRunAnalysisService(provider as never);
    const result = await service.analyzeActionRun({
      request: buildRequest(),
    });

    expect(provider.getAdditionalContext).not.toHaveBeenCalled();
    expect(result.analysisSections?.[0]?.summary).toContain(
      "Demo fallback analysis was used",
    );
    expect(result.analysisSections?.[0]?.rows?.[0]).toMatchObject({
      label: "事前告知",
      value: 12,
    });
    expect(result.draftVariants?.notion).toContain(
      "Tableau User Group Tokyo 2026",
    );
    expect(result.safetyReview?.notes?.[0]).toContain(
      "Human approval is required",
    );
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
