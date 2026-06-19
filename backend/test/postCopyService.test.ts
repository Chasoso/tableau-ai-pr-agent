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
          "【6/19(金)開催】第8回北陸Tableauユーザー会 会場からひろがるTableauの可能性",
      }),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        surveySummary:
          "MCPをはじめて聞く方も多く、初心者にも伝わるやさしい整理が合いそう。",
        surveyDimensionField: "Mcp Awareness",
        surveyEvidenceRows: [
          { label: "はじめて聞いた", value: 9 },
          { label: "すでに活用している", value: 5 },
          { label: "試したことがある", value: 4 },
        ],
      }),
    });

    const suggestions = generatePostSuggestions({ material });
    const text = suggestions[0]?.text ?? "";

    expect(material.postType).toBe("live_report");
    expect(text).not.toMatch(/告知|参加しませんか|ぜひお越しください/i);
    expect(text).not.toContain(
      "【6/19(金)開催】第8回北陸Tableauユーザー会 会場からひろがるTableauの可能性",
    );
  });

  it("turns survey findings into natural audience context", () => {
    const material = buildPostMaterial({
      request: buildRequest("事前告知"),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        surveySummary:
          "MCPをはじめて聞く方も多く、初心者にも伝わるやさしい整理が合いそう。",
        surveyDimensionField: "Mcp Awareness",
        surveyEvidenceRows: [
          { label: "はじめて聞いた", value: 9 },
          { label: "すでに活用している", value: 5 },
          { label: "試したことがある", value: 4 },
        ],
      }),
    });

    expect(material.audienceContext).toBe("MCPをはじめて聞く方も多い");
    expect(material.tableauInsights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "survey",
          kind: "audience_context",
          summaryForPost: "MCPをはじめて聞く方も多い",
          shouldUseInPost: true,
        }),
      ]),
    );
  });

  it("reflects a survey insight naturally in one suggestion only", () => {
    const material = buildPostMaterial({
      request: buildRequest("事前告知"),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        surveySummary:
          "MCPをはじめて聞く方も多く、初心者にも伝わるやさしい整理が合いそう。",
        surveyDimensionField: "Mcp Awareness",
        surveyEvidenceRows: [
          { label: "はじめて聞いた", value: 9 },
          { label: "すでに活用している", value: 5 },
          { label: "試したことがある", value: 4 },
        ],
      }),
    });

    const suggestions = generatePostSuggestions({ material });
    const surveyAware = suggestions.find(
      (item) => item.variant === "survey_aware",
    );
    const withSurveyInsight = suggestions.filter(
      (item) => (item.usedTableauInsights?.length ?? 0) > 0,
    );

    expect(surveyAware?.text).toContain(
      "MCPをはじめて聞く方にも伝わるように、今日はできるだけやさしく整理していきます。",
    );
    expect(surveyAware?.text).not.toMatch(
      /top item|metric|dimension|Response Id|Mcp Awareness/i,
    );
    expect(withSurveyInsight).toHaveLength(1);
  });

  it("treats date-only post performance as low confidence and keeps it out of the body", () => {
    const material = buildPostMaterial({
      request: buildRequest("事前告知"),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        postPerformanceSummary:
          "過去投稿分析は、日付中心の結果のため本文生成には使わない",
        postPerformanceDimensionField: "日付",
        postPerformanceMetricField: "エンゲージメント",
        postPerformanceEvidenceRows: [
          { label: "Thu, Nov 20, 2025", value: 1067 },
          { label: "Fri, Nov 21, 2025", value: 629 },
        ],
      }),
    });

    expect(material.tableauInsights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "post_performance",
          kind: "low_confidence",
          shouldUseInPost: false,
        }),
      ]),
    );

    const suggestions = generatePostSuggestions({ material });
    for (const suggestion of suggestions) {
      expect(suggestion.text).not.toContain("Thu, Nov 20, 2025");
      expect(suggestion.text).not.toContain("Fri, Nov 21, 2025");
    }
  });

  it("turns image labels into a natural mood", () => {
    const material = buildPostMaterial({
      request: buildRequest("開催中の実況"),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack({
        photoSummary: "friendship, teamwork, positivity",
      }),
    });

    expect(material.mood).toBeDefined();
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
    currentSituation:
      "会場の空気が少しずつあたたまり、参加者が集まり始めています。",
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
  surveyDimensionField?: string;
  surveyEvidenceRows?: Array<{ label: string; value: number }>;
  postPerformanceSummary?: string;
  postPerformanceDimensionField?: string;
  postPerformanceMetricField?: string;
  postPerformanceEvidenceRows?: Array<{ label: string; value: number }>;
}) {
  return {
    photoContext: {
      available: true,
      source: "actual_image" as const,
      summary: input?.photoSummary ?? "The room is getting lively.",
      detectedTopics: ["Viz表現", "AI", "コミュニティ"],
      observedItems: ["people"],
      postableElements: ["Viz表現", "AI", "コミュニティ"],
      subjectCandidates: ["第8回北陸Tableauユーザー会"],
      suggestedPostAngles: ["community"],
      eventFeel: input?.photoSummary ?? "あたたかい空気",
    },
    eventContext: {
      available: true,
      source: "techplay" as const,
      eventName: "第8回北陸Tableauユーザー会",
      eventUrl: "https://techplay.jp/event/996372",
      eventDescription: "Viz表現・AI・コミュニティ",
      venue: "Kanazawa",
      eventDateText: "2026/06/19 18:30 - 20:30",
      hashtags: ["#ほくたぐ", "#HokuTUG", "#Tableau"],
    },
    surveyInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "mcp_session_survey_responses",
      queryRowCount: 1,
      warnings: [],
      dimensionField: input?.surveyDimensionField,
      keyExpectations: [],
      keyInterests: [],
      concernsOrQuestions: [],
      suggestedAngles: [],
      evidenceRows: input?.surveyEvidenceRows,
      evidenceSummary:
        input?.surveySummary ??
        "MCPをはじめて聞く方も多く、初心者にも伝わるやさしい整理が合いそう。",
      keyFindings: [input?.surveySummary ?? "MCPをはじめて聞く方も多い"],
    },
    postPerformanceInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "x_account_analytics_contents",
      queryRowCount: 1,
      warnings: [],
      dimensionField: input?.postPerformanceDimensionField,
      metricField: input?.postPerformanceMetricField,
      highPerformingThemes: ["community"],
      highPerformingPatterns: ["short opening"],
      recommendedTone: ["natural"],
      recommendedStructure: ["one short hook"],
      avoidPatterns: [],
      evidenceRows: input?.postPerformanceEvidenceRows,
      evidenceSummary:
        input?.postPerformanceSummary ?? "Photo posts perform well.",
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
