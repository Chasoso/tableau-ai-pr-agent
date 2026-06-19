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

    expect(output.summary).toContain("投稿案を作成しました");
    expect(output.missingFields).toEqual(
      expect.arrayContaining(["event date", "event summary"]),
    );
    expect(output.review.status).toBe("needs_info");
    expect(output.drafts.x).toContain("#HokuTUG");
    expect(output.drafts.email).toContain("Subject:");
    expect(output.drafts.notion).toContain("#");
    expect(output.sourceInfo.analysisHighlights).toEqual(
      expect.arrayContaining([
        "Event: Tableau",
        "Topics: venue / tableau / highlight",
        "CTA: 気になる方はぜひチェックしてください。",
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
    expect(
      output.analysisHighlights.some((line) => line.startsWith("Topics:")),
    ).toBe(true);
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

    expect(summary).toContain("投稿案を作成しました");
    expect(announcementDraft).toContain("# Tableau User Group");
    expect(socialPostDraft).toContain("#HokuTUG");
    expect(output.drafts.x).toContain("#HokuTUG");
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
    postType: "事前告知" as const,
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
  };
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
      available: true,
      source: "actual_image" as const,
      summary: "The venue is filling up.",
      detectedTopics: ["venue", "tableau"],
      suggestedPostAngles: [
        "highlight the event atmosphere",
        "keep the tone natural",
      ],
    },
    eventContext: {
      available: true,
      source: "techplay" as const,
      eventName: "Tableau User Group Tokyo 2026",
      eventUrl: "https://techplay.jp/event/123",
      eventDescription: "Live event summary.",
      venue: "Tokyo",
      eventDateText: "2026/06/14 11:00",
    },
    surveyInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "mcp_session_survey_responses",
      datasourceName: "MCP_Session_Survey_Responses",
      queryRowCount: 1,
      warnings: [],
      keyExpectations: ["practical examples"],
      keyInterests: ["Tableau tips"],
      concernsOrQuestions: ["setup details"],
      suggestedAngles: ["focus on practical value"],
      evidenceSummary: "Participants want practical examples.",
    },
    postPerformanceInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "x_account_analytics_contents",
      datasourceName: "X Account Analytics Contents",
      queryRowCount: 1,
      warnings: [],
      highPerformingThemes: ["live session recap"],
      highPerformingPatterns: ["open with the scene"],
      recommendedTone: ["natural"],
      recommendedStructure: ["one sentence hook"],
      avoidPatterns: ["too much hype"],
      evidenceSummary:
        "Photo posts perform well when the opening line is concise.",
    },
    accountOverviewInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "x_account_overview_analytics",
      datasourceName: "X Account Overview Analytics",
      queryRowCount: 1,
      warnings: [],
      recentTrendSummary:
        "Recent posts are doing well when they feel conversational.",
      notableChanges: ["Engagement is rising on photo posts."],
      timingHints: ["Post while the venue is active."],
      accountContextForPost: "Photo posts are currently strong.",
      evidenceSummary: "Photo posts are currently strong.",
    },
    canGeneratePost: true,
    generationBlockers: [],
  };
}

function buildSourceInfo() {
  return {
    postType: "事前告知" as const,
    eventName: "Tableau User Group Tokyo 2026",
    techplayUrl: "https://techplay.jp/event/123",
    currentSituation: "The venue is filling up.",
    dashboardName: "Overview",
    workbookName: "Analytics",
    worksheetNames: ["Sheet 1"],
    capturedAt: "2026-06-08T00:00:00.000Z",
    techplayEventName: "Tableau User Group Tokyo 2026",
    techplayEventDateText: "2026/06/14 11:00",
    techplaySummary: "Live event summary.",
    analysisHighlights: [
      "Event: Tableau User Group Tokyo 2026",
      "Topics: venue / tableau / highlight the event atmosphere",
      "Audience: MCPをはじめて聞く方にも伝わるように",
    ],
    missingFields: [],
  };
}
