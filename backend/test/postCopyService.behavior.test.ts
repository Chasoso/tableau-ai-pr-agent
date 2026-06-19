import { describe, expect, it } from "vitest";
import {
  buildPostMaterial,
  generatePostSuggestionsWithDiagnostics,
} from "../src/services/postCopyService";
import type { ActionRunRequest } from "../src/types/actionRun";
import type { PostGenerationEvidencePack } from "../src/services/tableauPhotoPostAnalysisService";

describe("postCopyService behavior", () => {
  it("keeps image labels out of event themes and turns them into atmosphere text", () => {
    const material = buildPostMaterial({
      request: buildRequest(),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack(),
    });

    expect(material.eventThemes).toEqual(["Viz表現", "AI", "コミュニティ"]);
    expect(material.photoAtmosphere).toBeDefined();
    expect(material.photoPostableDescription).toBeDefined();
    expect(material.mainTopics).toEqual(["Viz表現", "AI", "コミュニティ"]);
    expect(material.eventThemes).not.toContain("friendship");
    expect(material.eventThemes).not.toContain("teamwork");
    expect(material.eventThemes).not.toContain("happiness");
  });

  it("returns three distinct post suggestions for a normal live report material", () => {
    const material = buildPostMaterial({
      request: buildRequest(),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack(),
    });

    const result = generatePostSuggestionsWithDiagnostics({
      material,
      maxSuggestions: 3,
    });

    expect(result.suggestions).toHaveLength(3);
    expect(new Set(result.suggestions.map((item) => item.text)).size).toBe(3);
    expect(result.diagnostics.desiredVariantCount).toBe(3);
    expect(result.diagnostics.generatedCount).toBeGreaterThanOrEqual(3);
    expect(result.diagnostics.excludedCount).toBe(0);
    expect(
      result.suggestions.filter(
        (item) => (item.usedTableauInsights?.length ?? 0) > 0,
      ),
    ).toHaveLength(1);

    for (const suggestion of result.suggestions) {
      expect(suggestion.text).not.toMatch(
        /friendship|teamwork|happiness|metric|dimension|top item|Workbook missing|Dashboard:|TechPlay summary: missing/i,
      );
    }
  });
});

function buildRequest(): ActionRunRequest {
  return {
    postType: "開催中の実況",
    eventName: "第8回北陸Tableauユーザー会",
    eventUrl: "https://techplay.jp/event/996372",
    techplayUrl: "https://techplay.jp/event/996372",
    currentSituation:
      "会場の熱が少しずつ上がってきて、参加者どうしの会話も増えています。",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [{ name: "Sheet 1" }],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-19T09:00:00.000Z",
    } as never,
    eventContext: {
      source: "techplay",
      eventName: "第8回北陸Tableauユーザー会",
      eventUrl: "https://techplay.jp/event/996372",
      eventDescription: "Viz表現・AI・コミュニティ",
      eventDateText: "2026/06/19 18:30 - 20:30",
      hashtags: ["#ほくたぐ", "#HokuTUG", "#Tableau"],
    },
  } as ActionRunRequest;
}

function buildAnalysisSections() {
  return [
    {
      key: "photo_context" as const,
      title: "Photo context",
      question: "question",
      summary: "friendship teamwork happiness",
      rows: [{ label: "mood", value: 1 }],
    },
    {
      key: "survey_insight" as const,
      title: "Survey insight",
      question: "question",
      summary: "MCPをはじめて聞く方も多い",
      rows: [{ label: "Mcp Awareness", value: 1 }],
    },
    {
      key: "post_performance_insight" as const,
      title: "Session detail",
      question: "session detail",
      summary: "session detail",
      rows: [{ label: "session", value: 1 }],
    },
    {
      key: "evidence_pack" as const,
      title: "Evidence pack",
      question: "question",
      summary: "Visually rich event notes",
      rows: [{ label: "combined", value: 1 }],
    },
  ];
}

function buildEvidencePack(): PostGenerationEvidencePack {
  return {
    photoContext: {
      available: true,
      source: "actual_image",
      summary: "friendship, teamwork, happiness",
      detectedTopics: [],
      observedItems: [],
      postableElements: [],
      subjectCandidates: [],
      suggestedPostAngles: [],
      eventFeel: "friendship, teamwork, happiness",
      sceneInference: "smiling faces",
      visibleText: [],
    },
    eventContext: {
      available: true,
      source: "techplay",
      eventName: "第8回北陸Tableauユーザー会",
      eventUrl: "https://techplay.jp/event/996372",
      eventDescription: "Viz表現・AI・コミュニティ",
      venue: "Kanazawa",
      eventDateText: "2026/06/19 18:30 - 20:30",
    },
    surveyInsight: {
      available: true,
      sourceStatus: "queried",
      datasourceKey: "mcp_session_survey_responses",
      dimensionField: "Mcp Awareness",
      queryRowCount: 1,
      warnings: [],
      keyExpectations: [],
      keyInterests: [],
      concernsOrQuestions: [],
      suggestedAngles: ["初心者にも伝わるようにやさしく整理する"],
      evidenceRows: [
        { label: "はじめて聞いた", value: 9 },
        { label: "すでに活用している", value: 5 },
        { label: "試したことがある", value: 4 },
      ],
      evidenceSummary:
        "MCPをはじめて聞く方も多く、初心者にも伝わるやさしい整理が合いそう。",
      keyFindings: ["はじめて聞いた", "すでに活用している", "試したことがある"],
    },
    postPerformanceInsight: {
      available: true,
      sourceStatus: "queried",
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
      sourceStatus: "queried",
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
