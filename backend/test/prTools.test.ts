import { describe, expect, it } from "vitest";
import {
  buildPrDraftOutput,
  collectPrSourceInfoSchema,
  prToolDefinitions,
  reviewPrDraft,
} from "../src/agents/tools/prTools";

describe("prTools", () => {
  it("builds draft-only output and surfaces missing fields", () => {
    const output = buildPrDraftOutput({
      request: buildRequest(),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack(),
    });

    expect(output.summary).toContain("Tableau User Group Tokyo 2026");
    expect(output.missingFields).toEqual(
      expect.arrayContaining(["event date", "event summary"]),
    );
    expect(output.review.status).toBe("needs_info");
    expect(output.drafts.x).toContain("Tableau User Group Tokyo 2026");
    expect(output.drafts.email).toContain("Subject:");
    expect(output.drafts.notion).toContain("# Tableau User Group Tokyo 2026");
    expect(output.sourceInfo.analysisHighlights).toEqual(
      expect.arrayContaining([
        "Photo context: The venue is filling up. / image file: venue.jpg / size 1.2 MB",
        "Survey insight: Participants want practical examples.",
      ]),
    );
  });

  it("flags publish language in review", () => {
    const review = reviewPrDraft(buildSourceInfo(), "Please post this now", {
      x: "Please post this now",
      linkedin: "Please publish this update",
    });

    expect(review.issues.join(" ")).toContain("publish");
    expect(review.status).toBe("needs_review");
  });

  it("parses collect source input and returns normalized source info", async () => {
    const input = collectPrSourceInfoSchema.parse(buildCollectInput());
    const output = await prToolDefinitions.collectPrSourceInfo.callback(input);

    expect(output.eventName).toBe("Tableau User Group Tokyo 2026");
    expect(output.analysisHighlights).toContain(
      "Post type distribution: Checked post type counts.",
    );
  });

  it("keeps each tool callback testable in isolation", async () => {
    const sourceInfo = buildSourceInfo();
    const summary = await prToolDefinitions.summarizePrSourceInfo.callback({
      sourceInfo,
    });
    const announcementDraft =
      await prToolDefinitions.generateAnnouncementDraft.callback({
        sourceInfo,
        summary,
      });
    const socialPostDraft =
      await prToolDefinitions.generateSocialPostDraft.callback({
        platform: "x",
        sourceInfo,
        summary,
      });
    const review = await prToolDefinitions.reviewPrDraft.callback({
      sourceInfo,
      announcementDraft,
      socialPostDrafts: {
        x: socialPostDraft,
        linkedin: socialPostDraft,
      },
    });
    const output = await prToolDefinitions.createDraftOutput.callback({
      sourceInfo,
      summary,
      announcementDraft,
      socialPostDraft,
      socialPostDrafts: {
        x: socialPostDraft,
        linkedin: socialPostDraft,
      },
      review,
    });

    expect(summary).toContain("Event: Tableau User Group Tokyo 2026");
    expect(announcementDraft).toContain("# Tableau User Group Tokyo 2026");
    expect(socialPostDraft).toContain("https://techplay.jp/event/123");
    expect(output.drafts.x).toContain("https://techplay.jp/event/123");
    expect(output.review.status).toBe("needs_review");
  });
});

function buildCollectInput() {
  return {
    request: buildRequest(),
    analysisSections: buildAnalysisSections(),
    evidencePack: buildEvidencePack(),
  };
}

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

function buildEvidencePack() {
  return {
    photoContext: {
      source: "actual_image" as const,
      summary: "The venue is filling up. / image file: venue.jpg / size 1.2 MB",
      detectedTopics: ["venue", "tableau"],
      suggestedPostAngles: ["highlight the event atmosphere", "keep the tone natural"],
    },
    surveyInsight: {
      available: true,
      keyExpectations: ["practical examples"],
      keyInterests: ["Tableau tips"],
      concernsOrQuestions: ["setup details"],
      suggestedAngles: ["focus on practical value"],
      evidenceSummary: "Participants want practical examples.",
    },
    postPerformanceInsight: {
      available: true,
      highPerformingThemes: ["live session recap"],
      highPerformingPatterns: ["open with the scene"],
      recommendedTone: ["natural"],
      recommendedStructure: ["one sentence hook"],
      avoidPatterns: ["too much hype"],
      evidenceSummary: "Photo posts perform well when the opening line is concise.",
    },
    accountOverviewInsight: {
      available: true,
      recentTrendSummary: "Recent posts are doing well when they feel conversational.",
      notableChanges: ["Engagement is rising on photo posts."],
      timingHints: ["Post while the venue is active."],
      accountContextForPost: "Photo posts are currently strong.",
      evidenceSummary: "Photo posts are currently strong.",
    },
    constraints: {
      doNotInventMetrics: true,
      useEvidenceOnlyWhenAvailable: true,
      keepNaturalJapanese: true,
    },
  };
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


