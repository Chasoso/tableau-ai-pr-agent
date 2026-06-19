import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionRunAnalysisService } from "../src/services/actionRunAnalysisService";
import type { ActionRunRequest } from "../src/types/actionRun";

const prDraftMock = vi.hoisted(() => vi.fn());

vi.mock("../src/agents/prAgent", () => ({
  runPrDraftAgent: prDraftMock,
}));

describe("ActionRunAnalysisService", () => {
  const originalDemoMode = process.env.DEMO_MODE;

  afterEach(() => {
    if (originalDemoMode === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = originalDemoMode;
    }
    prDraftMock.mockReset();
  });

  it("passes the evidence pack into draft generation", async () => {
    prDraftMock.mockResolvedValue(buildPrDraftMock());

    const fixedWorkflowService = {
      analyze: vi.fn(async () => buildFixedAnalysis()),
    };

    const service = new ActionRunAnalysisService(
      {
        name: "tableau-mcp" as const,
      } as never,
      fixedWorkflowService as never,
    );

    const result = await service.analyzeActionRun({
      request: buildRequest(),
    });

    expect(fixedWorkflowService.analyze).toHaveBeenCalledTimes(1);
    expect(prDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        evidencePack: expect.any(Object),
        photoContext: expect.objectContaining({
          summary: expect.any(String),
        }),
      }),
    );
    expect(result.summary).toContain("北陸Tableauユーザー会");
    expect(result.primaryOutputType).toBe("generated_post_suggestions");
    expect(result.generatedPostSuggestions).toHaveLength(3);
    expect(result.generatedPostSuggestion).toEqual(
      result.generatedPostSuggestions?.[0],
    );
    expect(result.suggestedSlackPostText).toBe(
      result.generatedPostSuggestions?.[0]?.text,
    );
    expect(result.generatedPostSuggestions?.[0]?.usedEvidence.photo).toBe(true);
    expect(result.generatedPostSuggestions?.[0]?.warnings).not.toContain(
      "photo_context_missing",
    );
    expect(
      result.generatedPostSuggestions?.filter(
        (item) => (item.usedTableauInsights?.length ?? 0) > 0,
      ),
    ).toHaveLength(1);
    expect(result.generatedPostSuggestions?.[0]?.text).toContain("#ほくたぐ");
    expect(result.generatedPostSuggestions?.[0]?.rationale).toContain(
      "見どころ",
    );
    expect(
      result.analysisSections?.some(
        (section) => section.key === "evidence_pack",
      ),
    ).toBe(true);
  });

  it("keeps photo_context_missing only when photo context is not actually available", async () => {
    prDraftMock.mockResolvedValue(buildPrDraftMock());

    const fixedWorkflowService = {
      analyze: vi.fn(async () => buildFixedAnalysis({ photoAvailable: false })),
    };

    const service = new ActionRunAnalysisService(
      {
        name: "tableau-mcp" as const,
      } as never,
      fixedWorkflowService as never,
    );

    const result = await service.analyzeActionRun({
      request: buildRequest(),
    });

    expect(result.generatedPostSuggestions?.[0]?.usedEvidence.photo).toBe(
      false,
    );
    expect(result.generatedPostSuggestions?.[0]?.warnings).toContain(
      "photo_context_missing",
    );
    expect(result.generatedPostSuggestions?.[0]?.rationale).toContain(
      "見どころ",
    );
  });
});

function buildPrDraftMock() {
  return {
    summary: "Generated summary",
    drafts: {
      x: "Generated X post",
      linkedin: "LinkedIn",
      email: "Email",
      notion: "Notion",
    },
    review: {
      status: "pass",
      riskLevel: "low",
      missingFields: [],
      issues: [],
      checklist: ["check"],
      notes: ["note"],
    },
    hashtags: ["#Tableau"],
    evidence: ["evidence"],
    checks: ["check"],
    imageCaption: "caption",
    missingFields: [],
  };
}

function buildFixedAnalysis(input?: { photoAvailable?: boolean }) {
  const photoAvailable = input?.photoAvailable ?? true;
  const analysisSections = [
    {
      key: "photo_context" as const,
      title: "Photo context",
      question: "Understand the uploaded photo and identify the post angle.",
      summary: "The venue is filling up.",
      rows: [{ label: "venue", value: null }],
    },
    {
      key: "evidence_pack" as const,
      title: "Evidence pack",
      question: "Combine the analysis outputs into a single evidence pack.",
      summary:
        "Survey, performance, and account overview evidence are combined.",
      rows: [{ label: "combined", value: 1 }],
    },
  ];

  const photoContext = {
    available: photoAvailable,
    source: photoAvailable
      ? ("actual_image" as const)
      : ("missing_image" as const),
    summary: photoAvailable ? "The venue is filling up." : undefined,
    detectedTopics: ["venue"],
    suggestedPostAngles: ["highlight the event atmosphere"],
  };

  return {
    photoContext,
    surveyInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "mcp_session_survey_responses",
      datasourceName: "MCP_Session_Survey_Responses",
      dimensionField: "Mcp Awareness",
      queryRowCount: 1,
      warnings: [],
      keyExpectations: ["practical examples"],
      keyInterests: ["Tableau"],
      concernsOrQuestions: ["setup"],
      suggestedAngles: ["focus on practical value"],
      evidenceRows: [
        { label: "はじめて聞いた", value: 9 },
        { label: "すでに活用している", value: 5 },
        { label: "試したことがある", value: 4 },
      ],
      evidenceSummary: "Participants want practical examples.",
    },
    postPerformanceInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "x_account_analytics_contents",
      datasourceName: "X Account Analytics Contents",
      queryRowCount: 1,
      warnings: [],
      highPerformingThemes: ["session recap"],
      highPerformingPatterns: ["lead with the scene"],
      recommendedTone: ["clear"],
      recommendedStructure: ["one short hook"],
      avoidPatterns: ["overly grand claims"],
      evidenceSummary: "Photo posts perform well.",
    },
    accountOverviewInsight: {
      available: true,
      sourceStatus: "queried" as const,
      datasourceKey: "x_account_overview_analytics",
      datasourceName: "X Account Overview Analytics",
      queryRowCount: 1,
      warnings: [],
      recentTrendSummary: "Photo posts are strong.",
      notableChanges: ["Engagement is rising."],
      timingHints: ["Post while the venue is active."],
      accountContextForPost: "Photo posts are currently strong.",
      evidenceSummary: "Photo posts are currently strong.",
    },
    evidencePack: {
      photoContext,
      eventContext: {
        available: true,
        source: "techplay" as const,
        eventName: "第8回北陸Tableauユーザー会",
        eventUrl: "https://techplay.jp/event/996372",
        eventDescription: "Viz表現・AI・コミュニティ",
        venue: "Kanazawa",
        eventDateText: "2026/06/19 18:30 - 20:30",
      },
      surveyInsight: {
        available: true,
        sourceStatus: "queried" as const,
        datasourceKey: "mcp_session_survey_responses",
        datasourceName: "MCP_Session_Survey_Responses",
        dimensionField: "Mcp Awareness",
        queryRowCount: 1,
        warnings: [],
        keyExpectations: ["practical examples"],
        keyInterests: ["Tableau"],
        concernsOrQuestions: ["setup"],
        suggestedAngles: ["focus on practical value"],
        evidenceRows: [
          { label: "はじめて聞いた", value: 9 },
          { label: "すでに活用している", value: 5 },
          { label: "試したことがある", value: 4 },
        ],
        evidenceSummary: "Participants want practical examples.",
      },
      postPerformanceInsight: {
        available: true,
        sourceStatus: "queried" as const,
        datasourceKey: "x_account_analytics_contents",
        datasourceName: "X Account Analytics Contents",
        queryRowCount: 1,
        warnings: [],
        highPerformingThemes: ["session recap"],
        highPerformingPatterns: ["lead with the scene"],
        recommendedTone: ["clear"],
        recommendedStructure: ["one short hook"],
        avoidPatterns: ["overly grand claims"],
        evidenceSummary: "Photo posts perform well.",
      },
      accountOverviewInsight: {
        available: true,
        sourceStatus: "queried" as const,
        datasourceKey: "x_account_overview_analytics",
        datasourceName: "X Account Overview Analytics",
        queryRowCount: 1,
        warnings: [],
        recentTrendSummary: "Photo posts are strong.",
        notableChanges: ["Engagement is rising."],
        timingHints: ["Post while the venue is active."],
        accountContextForPost: "Photo posts are currently strong.",
        evidenceSummary: "Photo posts are currently strong.",
      },
      canGeneratePost: true,
      generationBlockers: [],
    },
    analysisSections,
    datasourceResolution: {
      allowedDatasourceCount: 3,
      allowedDatasourceKeys: [
        "mcp_session_survey_responses",
        "x_account_analytics_contents",
        "x_account_overview_analytics",
      ],
      listDatasourcesCount: 3,
      matchedAllowedDatasourceCount: 3,
      rejectedDatasourceCount: 0,
      resolvedDatasourceKeys: [
        "mcp_session_survey_responses",
        "x_account_analytics_contents",
        "x_account_overview_analytics",
      ],
      unresolvedDatasourceKeys: [],
      selectedDatasourceForPurpose: {
        survey_insight: "MCP_Session_Survey_Responses",
        post_performance: "X Account Analytics Contents",
        account_overview: "X Account Overview Analytics",
      },
      datasourceResolutionReason:
        "All allowlisted datasources were resolved by exact match.",
    },
    debug: {
      photoContextGenerated: true,
      surveyInsightStatus: "available" as const,
      postPerformanceInsightStatus: "available" as const,
      accountOverviewInsightStatus: "available" as const,
      evidencePackGenerated: true,
    },
  };
}

function buildRequest() {
  return {
    postType: "事前告知" as const,
    eventName: "第8回北陸Tableauユーザー会",
    techplayUrl: "https://techplay.jp/event/996372",
    currentSituation: "The venue is filling up.",
    dashboardContext: {
      dashboardName: "Overview",
      workbookName: "Analytics",
      worksheets: [],
      filters: [],
      parameters: [],
      capturedAt: "2026-06-19T09:00:00.000Z",
    },
    clientContext: {
      source: "tableau-extension",
      appVersion: "1.0.0",
      photo: {
        fileName: "venue.jpg",
        sizeLabel: "1.2 MB",
        mode: "image" as const,
      },
    },
  } as ActionRunRequest;
}
