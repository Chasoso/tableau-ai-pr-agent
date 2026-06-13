import { describe, expect, it } from "vitest";
import { buildPrDraftOutput, reviewPrDraft } from "../src/agents/tools/prTools";

describe("prTools", () => {
  it("builds draft-only output and surfaces missing fields", () => {
    const output = buildPrDraftOutput({
      request: buildRequest(),
      analysisSections: buildAnalysisSections(),
    });

    expect(output.summary).toContain("Tableau User Group Tokyo 2026");
    expect(output.missingFields).toEqual(
      expect.arrayContaining(["event date", "event summary"]),
    );
    expect(output.review.status).toBe("needs_info");
    expect(output.drafts.x).toContain("Tableau User Group Tokyo 2026");
    expect(output.drafts.email).toContain("Subject:");
    expect(output.drafts.notion).toContain("# Tableau User Group Tokyo 2026");
  });

  it("flags publish language in review", () => {
    const review = reviewPrDraft(
      buildSourceInfo(),
      "Please post this now",
      {
        x: "Please post this now",
        linkedin: "Please publish this update",
      },
    );

    expect(review.issues.join(" ")).toContain("publish");
    expect(review.status).toBe("needs_review");
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
      worksheets: [{ name: "Sheet 1" }],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-08T00:00:00.000Z",
    },
  } as never;
}

function buildAnalysisSections() {
  return [
    {
      key: "post_type_distribution" as const,
      title: "Post type distribution",
      question: "question",
      summary: "Checked post type counts.",
      rows: [{ label: "A", value: 12 }],
    },
  ];
}

function buildSourceInfo() {
  return {
    postType: "\u4e8b\u524d\u544a\u77e5",
    eventName: "Tableau User Group Tokyo 2026",
    techplayUrl: "https://techplay.jp/event/123",
    currentSituation: "The venue is filling up.",
    dashboardName: "Overview",
    workbookName: "Analytics",
    worksheetNames: ["Sheet 1"],
    capturedAt: "2026-06-08T00:00:00.000Z",
    analysisHighlights: ["Post type distribution: Checked post type counts."],
    missingFields: [],
  };
}
