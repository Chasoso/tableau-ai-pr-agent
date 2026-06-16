import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_TABLEAU_DATASOURCES,
  TableauPhotoPostAnalysisService,
} from "../src/services/tableauPhotoPostAnalysisService";
import type { ActionRunRequest } from "../src/types/actionRun";
import type { TableauContextProvider } from "../src/tableau/contextProvider";

describe("TableauPhotoPostAnalysisService", () => {
  const originalAllowedLuids = ALLOWED_TABLEAU_DATASOURCES.map(
    (item) => item.luid,
  );

  afterEach(() => {
    ALLOWED_TABLEAU_DATASOURCES.forEach((item, index) => {
      item.luid = originalAllowedLuids[index];
    });
  });

  it("resolves only the allowlisted datasources and builds an evidence pack", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(
        async (
          input: Parameters<TableauContextProvider["getAdditionalContext"]>[0],
        ) => {
          if (input.question.includes("survey")) {
            return buildAdditionalContext(
              "survey",
              "Participants want practical examples.",
            );
          }
          if (input.question.includes("engagement")) {
            return buildAdditionalContext(
              "performance",
              "Photo posts get the strongest engagement.",
            );
          }
          return buildAdditionalContext(
            "overview",
            "Recent photo posts are trending upward.",
          );
        },
      ),
    };

    const gateway = {
      listDatasources: vi.fn(async () => [
        { name: "MCP_Session_Survey_Responses", luid: "survey-luid" },
        { name: "X Account Analytics Contents", luid: "performance-luid" },
        { name: "X Account Overview Analytics", luid: "overview-luid" },
        { name: "Disallowed Datasource", luid: "bad-luid" },
      ]),
    };

    const service = new TableauPhotoPostAnalysisService(
      provider as never,
      gateway as never,
    );
    const result = await service.analyze({
      request: buildRequest(),
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });

    expect(gateway.listDatasources).toHaveBeenCalledTimes(1);
    expect(result.datasourceResolution.allowedDatasourceKeys).toEqual([
      "mcp_session_survey_responses",
      "x_account_analytics_contents",
      "x_account_overview_analytics",
    ]);
    expect(result.datasourceResolution.resolvedDatasourceKeys).toHaveLength(3);
    expect(result.datasourceResolution.rejectedDatasourceCount).toBe(1);
    expect(result.photoContext.summary).toContain("venue.jpg");
    expect(result.surveyInsight?.available).toBe(true);
    expect(result.postPerformanceInsight?.available).toBe(true);
    expect(result.accountOverviewInsight?.available).toBe(true);
    expect(result.evidencePack.surveyInsight?.evidenceSummary).toContain(
      "Participants want practical examples.",
    );
    expect(provider.getAdditionalContext).toHaveBeenCalledTimes(3);
    for (const call of provider.getAdditionalContext.mock.calls) {
      const input = call[0];
      expect(input.dashboardContext.dataSources ?? []).toHaveLength(1);
      expect(input.dashboardContext.dataSources?.[0]?.name).not.toBe(
        "Disallowed Datasource",
      );
    }
  });

  it("prefers exact LUID matches when configured", async () => {
    ALLOWED_TABLEAU_DATASOURCES[0].luid = "preferred-survey-luid";

    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(async () =>
        buildAdditionalContext("survey", "Matched by LUID."),
      ),
    };

    const gateway = {
      listDatasources: vi.fn(async () => [
        { name: "Completely Different Name", luid: "preferred-survey-luid" },
        { name: "X Account Analytics Contents", luid: "performance-luid" },
        { name: "X Account Overview Analytics", luid: "overview-luid" },
      ]),
    };

    const service = new TableauPhotoPostAnalysisService(
      provider as never,
      gateway as never,
    );
    const result = await service.analyze({
      request: buildRequest(),
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });

    expect(result.datasourceResolution.resolvedDatasourceKeys).toContain(
      "mcp_session_survey_responses",
    );
    expect(result.surveyInsight?.evidenceSummary).toContain("Matched by LUID.");
  });

  it("uses real image vision/OCR output when an image data URL is provided", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(async () =>
        buildAdditionalContext(
          "survey",
          "Participants want practical examples.",
        ),
      ),
    };

    const gateway = {
      listDatasources: vi.fn(async () => [
        { name: "MCP_Session_Survey_Responses", luid: "survey-luid" },
        { name: "X Account Analytics Contents", luid: "performance-luid" },
        { name: "X Account Overview Analytics", luid: "overview-luid" },
      ]),
    };

    const visionAnalyzer = {
      analyze: vi.fn(async () => ({
        sceneInference: "A crowded workshop room.",
        eventFeel: "Busy and energetic.",
        observedItems: ["projector", "attendees", "stage"],
        postableElements: ["crowd", "projector screen"],
        subjectCandidates: ["speaker", "audience"],
        detectedTopics: ["workshop", "tableau"],
        suggestedPostAngles: ["lead with the crowded atmosphere"],
        ocrText: "Tableau User Group Tokyo",
      })),
    };

    const service = new TableauPhotoPostAnalysisService(
      provider as never,
      gateway as never,
      visionAnalyzer as never,
    );
    const request = buildRequest();
    const clientContext = request.clientContext!;
    const result = await service.analyze({
      request: {
        ...request,
        clientContext: {
          ...clientContext,
          photo: {
            ...clientContext.photo,
            dataUrl: "data:image/png;base64,AAAA",
            mimeType: "image/png",
          },
        },
      },
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });

    expect(visionAnalyzer.analyze).toHaveBeenCalledTimes(1);
    expect(result.photoContext.summary).toContain("A crowded workshop room.");
    expect(result.photoContext.summary).toContain(
      "ocr: Tableau User Group Tokyo",
    );
    expect(result.photoContext.observedItems).toContain("projector");
    expect(result.photoContext.ocrText).toBe("Tableau User Group Tokyo");
    expect(result.photoContext.detectedTopics).toContain("tableau");
    expect(result.photoContext.suggestedPostAngles).toContain(
      "lead with the crowded atmosphere",
    );
  });

  it("skips only the failed insight and continues generating the rest", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(
        async (
          input: Parameters<TableauContextProvider["getAdditionalContext"]>[0],
        ) => {
          if (input.question.includes("survey")) {
            return buildAdditionalContext(
              "survey",
              "Survey responses mention setup and speed.",
            );
          }
          if (input.question.includes("engagement")) {
            throw new Error("Post performance query failed.");
          }
          return buildAdditionalContext("overview", "Recent posts are steady.");
        },
      ),
    };

    const gateway = {
      listDatasources: vi.fn(async () => [
        { name: "MCP_Session_Survey_Responses", luid: "survey-luid" },
        { name: "X Account Analytics Contents", luid: "performance-luid" },
        { name: "X Account Overview Analytics", luid: "overview-luid" },
      ]),
    };

    const service = new TableauPhotoPostAnalysisService(
      provider as never,
      gateway as never,
    );
    const result = await service.analyze({
      request: buildRequest(),
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });

    expect(result.surveyInsight?.available).toBe(true);
    expect(result.postPerformanceInsight?.available).toBe(false);
    expect(result.accountOverviewInsight?.available).toBe(true);
    expect(
      result.analysisSections.find(
        (section) => section.key === "post_performance_insight",
      )?.summary,
    ).toContain("failed for this purpose");
  });
});

function buildRequest(): ActionRunRequest {
  return {
    postType: "事前告知",
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
    clientContext: {
      source: "tableau-extension",
      appVersion: "1.0.0",
      photo: {
        fileName: "venue.jpg",
        sizeLabel: "1.2 MB",
        mode: "image" as const,
      },
    },
  };
}

function buildAdditionalContext(kind: string, summary: string) {
  return {
    provider: "tableau-mcp" as const,
    queryInsights: [
      {
        datasourceName: kind,
        metricField: "count",
        rowCount: 1,
        actualRowCount: 1,
        rows: [{ label: summary, value: 1 }],
      },
    ],
    warnings: [],
  };
}
