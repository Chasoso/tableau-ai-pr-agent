import { describe, expect, it } from "vitest";
import {
  buildPostMaterial,
  buildPostQualityResult,
  generatePostSuggestions,
} from "../src/services/postCopyService";

describe("postCopyService", () => {
  it("keeps internal analysis markers out of post text", () => {
    const material = buildPostMaterial({
      request: buildRequest("事前告知"),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        photoSummary:
          "ChatGPT Image 2026年6月16日 19_35_36.png Size: 2.1 MB metric: Response Id dimension: Mcp Awareness top item: はじめて聞いた friendship teamwork positivity Workbook missing Dashboard: Dashboard TechPlay summary: missing",
      }),
    });

    const suggestions = generatePostSuggestions({ material });
    expect(suggestions.length).toBeGreaterThan(0);

    for (const suggestion of suggestions) {
      const quality = buildPostQualityResult(suggestion.text);
      expect(quality.ok).toBe(true);
      expect(suggestion.text).not.toMatch(
        /metric|dimension|top item|Workbook missing|Dashboard:|TechPlay summary: missing|friendship|teamwork|positivity|ChatGPT Image|Size:/i,
      );
      expect(suggestion.text).toContain("#ほくたぐ");
      expect(suggestion.text).toContain("#HokuTUG");
      expect(suggestion.text).toContain("#Tableau");
    }
  });

  it("keeps live report copy from sounding like an announcement", () => {
    const material = buildPostMaterial({
      request: buildRequest("開催中の実況", {
        eventName:
          "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性～Viz表現・AI・コミュニティから考える次の一歩～",
      }),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        surveySummary: "Mcp Awareness: はじめて聞いた",
      }),
    });

    const suggestions = generatePostSuggestions({ material });
    const text = suggestions[0]?.text ?? "";

    expect(material.postType).toBe("live_report");
    expect(text).not.toMatch(
      /告知をお届けします|ぜひ参加してみてください|開催日は|現場感を込めてお届けします/,
    );
    expect(text).not.toContain(
      "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性～Viz表現・AI・コミュニティから考える次の一歩～",
    );
  });

  it("turns survey findings into natural audience context", () => {
    const material = buildPostMaterial({
      request: buildRequest("事前告知"),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        surveySummary: "Mcp Awareness: はじめて聞いた",
      }),
    });

    expect(material.audienceContext).toBe(
      "MCPをはじめて聞く方にも伝わるように",
    );
  });

  it("turns image labels into a natural mood", () => {
    const material = buildPostMaterial({
      request: buildRequest("開催中の実況"),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        photoSummary: "friendship, teamwork, positivity",
      }),
    });

    expect(material.mood).toBe("和やかな雰囲気");
  });
});

function buildRequest(
  postType: "事前告知" | "開催中の実況",
  overrides?: Partial<Parameters<typeof buildPostMaterial>[0]["request"]>,
) {
  return {
    postType,
    eventName: "第8回北陸Tableauユーザー会",
    eventUrl: "https://techplay.jp/event/996372",
    techplayUrl: "https://techplay.jp/event/996372",
    currentSituation: "会場の空気が少しずつ動き始めています。",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [{ name: "Sheet 1" }],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-19T09:00:00.000Z",
    },
    ...overrides,
  } as Parameters<typeof buildPostMaterial>[0]["request"];
}

function buildAnalysisSections() {
  return [
    {
      key: "survey_insight" as const,
      title: "Survey insight",
      question: "question",
      summary: "Participants want practical examples.",
      rows: [{ label: "Mcp Awareness", value: 1 }],
    },
    {
      key: "photo_context" as const,
      title: "Photo context",
      question: "question",
      summary: "The room is getting lively.",
      rows: [{ label: "friendship", value: 1 }],
    },
  ];
}

function buildEvidencePack(input?: {
  photoSummary?: string;
  surveySummary?: string;
}) {
  return {
    photoContext: {
      available: true,
      source: "actual_image" as const,
      summary: input?.photoSummary ?? "The room is getting lively.",
      detectedTopics: ["viz表現", "AI", "コミュニティ"],
      observedItems: ["people"],
      postableElements: ["viz表現", "AI", "コミュニティ"],
      subjectCandidates: ["第8回北陸Tableauユーザー会"],
      suggestedPostAngles: ["community"],
      eventFeel: input?.photoSummary ?? "和やか",
    },
    eventContext: {
      available: true,
      source: "techplay" as const,
      eventName:
        "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性～Viz表現・AI・コミュニティから考える次の一歩～",
      eventUrl: "https://techplay.jp/event/996372",
      eventDescription: "Viz表現・AI・コミュニティ",
      venue: "Kanazawa",
      eventDateText: "2026/06/19 18:30 - 20:30",
    },
    surveyInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "mcp_session_survey_responses",
      queryRowCount: 1,
      warnings: [],
      keyExpectations: [],
      keyInterests: [],
      concernsOrQuestions: [],
      suggestedAngles: [],
      evidenceSummary: input?.surveySummary ?? "Mcp Awareness: はじめて聞いた",
      keyFindings: [input?.surveySummary ?? "Mcp Awareness: はじめて聞いた"],
    },
    postPerformanceInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "x_account_analytics_contents",
      queryRowCount: 1,
      warnings: [],
      highPerformingThemes: ["community"],
      highPerformingPatterns: ["short opening"],
      recommendedTone: ["natural"],
      recommendedStructure: ["one short hook"],
      avoidPatterns: [],
      evidenceSummary: "Photo posts perform well.",
    },
    accountOverviewInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "x_account_overview_analytics",
      queryRowCount: 1,
      warnings: [],
      recentTrendSummary: "Recent posts feel conversational.",
      notableChanges: ["Engagement is rising."],
      timingHints: ["Post while the venue is active."],
      accountContextForPost: "Photo posts are currently strong.",
      evidenceSummary: "Photo posts are currently strong.",
    },
    canGeneratePost: true,
    generationBlockers: [],
  };
}
