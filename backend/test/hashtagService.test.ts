import { describe, expect, it } from "vitest";
import {
  buildHashtagCandidates,
  buildHashtagQualityIssues,
  extractExplicitHashtagsFromText,
  selectHashtags,
} from "../src/services/hashtagService";
import {
  buildChannelDrafts,
  buildPostMaterial,
} from "../src/services/postCopyService";
import type {
  ActionRunAnalysisSection,
  ActionRunPostType,
  ActionRunRequest,
} from "../src/types/actionRun";
import type { PostGenerationEvidencePack } from "../src/services/tableauPhotoPostAnalysisService";

describe("hashtagService", () => {
  it("prefers explicit hashtags from web text", () => {
    const candidates = buildHashtagCandidates({
      webPageTexts: [
        "Hashtags #ほくたぐ #HokuTUG #北陸Tableauユーザー会 #Tableau",
      ],
      eventName: "第8回北陸Tableauユーザー会",
    });

    expect(selectHashtags({ candidates, channel: "x" })).toEqual([
      "#ほくたぐ",
      "#HokuTUG",
      "#北陸Tableauユーザー会",
      "#Tableau",
    ]);
  });

  it("does not add TechPlay when explicit event tags already exist", () => {
    const candidates = buildHashtagCandidates({
      webPageTexts: [
        "Event page #ほくたぐ #HokuTUG #Tableau",
        "https://techplay.jp/event/999999",
      ],
      eventUrl: "https://techplay.jp/event/999999",
    });

    const selected = selectHashtags({ candidates, channel: "x" });
    expect(selected).toEqual(["#ほくたぐ", "#HokuTUG", "#Tableau"]);
    expect(selected).not.toContain("#TechPlay");
  });

  it("falls back to community and inference tags when explicit tags are absent", () => {
    const candidates = buildHashtagCandidates({
      eventDescriptionTexts: ["Tableau and AI event"],
      eventName: "第8回北陸Tableauユーザー会",
    });

    const selected = selectHashtags({ candidates, channel: "x" });
    expect(selected).toContain("#Tableau");
    expect(selected).toContain("#ほくたぐ");
    expect(selected.length).toBeGreaterThan(0);
  });

  it("rejects machine-generated hashtags", () => {
    const candidates = buildHashtagCandidates({
      webPageTexts: ["#6198Tableau #TechPlay"],
      eventName: "第8回北陸Tableauユーザー会",
    });

    const selected = selectHashtags({ candidates, channel: "x" });
    expect(selected).not.toContain("#6198Tableau");
    expect(selected).not.toContain("#TechPlay");

    const issues = buildHashtagQualityIssues({
      hashtags: selected,
      candidates,
      channel: "x",
    });

    expect(
      issues.some((issue) => issue.code === "machine_generated_hashtag"),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.code === "unsupported_platform_tag"),
    ).toBe(true);
  });

  it("extracts Japanese hashtags without breaking them", () => {
    expect(
      extractExplicitHashtagsFromText(
        "#ほくたぐ #北陸Tableauユーザー会 #データ活用",
      ),
    ).toEqual(["#ほくたぐ", "#北陸Tableauユーザー会", "#データ活用"]);
  });

  it("keeps hashtags out of email and notion drafts", () => {
    const material = buildPostMaterial({
      request: buildRequest(),
      analysisSections: buildAnalysisSections(),
      evidencePack: buildEvidencePack(),
    });

    const drafts = buildChannelDrafts({ material });
    expect(drafts.x).toContain("#ほくたぐ");
    expect(drafts.linkedin).toContain("#Tableau");
    expect(drafts.email).not.toContain("#ほくたぐ");
    expect(drafts.notion).not.toContain("#ほくたぐ");
  });
});

function buildRequest(): ActionRunRequest {
  return {
    postType: "事前告知" as ActionRunPostType,
    eventName: "第8回北陸Tableauユーザー会",
    eventUrl: "https://example.com/event",
    techplayUrl: "https://techplay.jp/event/999999",
    currentSituation: "会場は準備中です。",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-19T09:00:00.000Z",
    },
  };
}

function buildAnalysisSections(): ActionRunAnalysisSection[] {
  return [
    {
      key: "survey_insight",
      title: "Survey insight",
      question: "question",
      summary: "Tableau and AI are the main topics.",
      rows: [{ label: "community", value: 1 }],
    },
  ];
}

function buildEvidencePack(): PostGenerationEvidencePack {
  return {
    photoContext: {
      available: true,
      source: "actual_image",
      summary: "The room feels friendly and calm.",
      detectedTopics: ["Tableau"],
      visibleText: [],
      suggestedPostAngles: ["community"],
      observedItems: ["people"],
      sceneInference: "A friendly meetup scene.",
      eventFeel: "Warm and relaxed.",
      postableElements: ["Tableau"],
      subjectCandidates: ["people"],
      ocrText: "",
    },
    eventContext: {
      available: true,
      source: "manual",
      eventName: "第8回北陸Tableauユーザー会",
      eventDescription:
        "Hashtags #ほくたぐ #HokuTUG #北陸Tableauユーザー会 #Tableau",
      eventUrl: "https://example.com/event",
      hashtags: ["#ほくたぐ", "#HokuTUG", "#北陸Tableauユーザー会", "#Tableau"],
    },
    surveyInsight: {
      available: true,
      sourceStatus: "queried",
      datasourceKey: "survey",
      queryRowCount: 1,
      warnings: [],
      keyExpectations: [],
      keyInterests: [],
      concernsOrQuestions: [],
      suggestedAngles: ["community"],
      evidenceSummary: "Survey summary",
    },
    postPerformanceInsight: {
      available: true,
      sourceStatus: "queried",
      datasourceKey: "performance",
      queryRowCount: 1,
      warnings: [],
      highPerformingThemes: ["community"],
      highPerformingPatterns: [],
      recommendedTone: [],
      recommendedStructure: [],
      avoidPatterns: [],
      evidenceSummary: "Performance summary",
    },
    accountOverviewInsight: {
      available: true,
      sourceStatus: "queried",
      datasourceKey: "account",
      queryRowCount: 1,
      warnings: [],
      recentTrendSummary: "Trend summary",
      notableChanges: [],
      timingHints: [],
      accountContextForPost: "Context",
      evidenceSummary: "Account summary",
    },
    canGeneratePost: true,
    generationBlockers: [],
  };
}
