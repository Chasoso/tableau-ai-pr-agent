import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionRunAnalysisService } from "../src/services/actionRunAnalysisService";

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
    prDraftMock.mockResolvedValue({
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
    });

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
    expect(result.summary).toBe("Generated summary");
    expect(result.suggestedSlackPostText).toBe("Generated X post");
    expect(
      result.analysisSections?.some(
        (section) => section.key === "evidence_pack",
      ),
    ).toBe(true);
  });
});

function buildFixedAnalysis() {
  const analysisSections = [
    {
      key: "photo_context" as const,
      title: "Photo context",
      question: "Understand the uploaded photo and identify the post angle.",
      summary: "The venue is filling up. / image file: venue.jpg",
      rows: [{ label: "venue", value: null }],
    },
    {
      key: "evidence_pack" as const,
      title: "Evidence pack",
      question: "Combine the analysis outputs into a single evidence pack.",
      summary:
        "Survey, performance, and account overview evidence are combined.",
      rows: [{ label: "combined", value: "available" }],
    },
  ];

  const photoContext = {
    source: "actual_image" as const,
    summary: "The venue is filling up. / image file: venue.jpg",
    detectedTopics: ["venue"],
    suggestedPostAngles: ["highlight the event atmosphere"],
  };

  return {
    photoContext,
    surveyInsight: {
      available: true,
      keyExpectations: ["practical examples"],
      keyInterests: ["Tableau"],
      concernsOrQuestions: ["setup"],
      suggestedAngles: ["focus on practical value"],
      evidenceSummary: "Participants want practical examples.",
    },
    postPerformanceInsight: {
      available: true,
      highPerformingThemes: ["session recap"],
      highPerformingPatterns: ["lead with the scene"],
      recommendedTone: ["clear"],
      recommendedStructure: ["one short hook"],
      avoidPatterns: ["overly grand claims"],
      evidenceSummary: "Photo posts perform well.",
    },
    accountOverviewInsight: {
      available: true,
      recentTrendSummary: "Photo posts are strong.",
      notableChanges: ["Engagement is rising."],
      timingHints: ["Post while the venue is active."],
      accountContextForPost: "Photo posts are currently strong.",
      evidenceSummary: "Photo posts are currently strong.",
    },
    evidencePack: {
      photoContext,
      surveyInsight: {
        available: true,
        keyExpectations: ["practical examples"],
        keyInterests: ["Tableau"],
        concernsOrQuestions: ["setup"],
        suggestedAngles: ["focus on practical value"],
        evidenceSummary: "Participants want practical examples.",
      },
      postPerformanceInsight: {
        available: true,
        highPerformingThemes: ["session recap"],
        highPerformingPatterns: ["lead with the scene"],
        recommendedTone: ["clear"],
        recommendedStructure: ["one short hook"],
        avoidPatterns: ["overly grand claims"],
        evidenceSummary: "Photo posts perform well.",
      },
      accountOverviewInsight: {
        available: true,
        recentTrendSummary: "Photo posts are strong.",
        notableChanges: ["Engagement is rising."],
        timingHints: ["Post while the venue is active."],
        accountContextForPost: "Photo posts are currently strong.",
        evidenceSummary: "Photo posts are currently strong.",
      },
      constraints: {
        doNotInventMetrics: true,
        useEvidenceOnlyWhenAvailable: true,
        keepNaturalJapanese: true,
      },
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
    postType: "事前告知",
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
    clientContext: {
      source: "tableau-extension",
      appVersion: "1.0.0",
      photo: {
        fileName: "venue.jpg",
        sizeLabel: "1.2 MB",
        mode: "image" as const,
      },
    },
  } as never;
}
