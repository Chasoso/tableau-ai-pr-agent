import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_TABLEAU_DATASOURCES,
  TableauPhotoPostAnalysisService,
  buildVisionSummaryFromText,
  extractVisionStructuredOutput,
  normalizeVisionText,
} from "../src/services/tableauPhotoPostAnalysisService";
import type { ActionRunRequest } from "../src/types/actionRun";
import type { TableauContextProvider } from "../src/tableau/contextProvider";
import { resolveTableauDirectTrustAuthContext } from "../src/tableau/tableauDirectTrustAuth";

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
    const authContext = resolveTableauDirectTrustAuthContext({
      authenticatedUser: {
        userId: "user-1",
        email: "user@example.com",
        tableauSubject: "user@example.com",
      },
    });
    const result = await service.analyze({
      request: buildRequest(),
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });

    expect(gateway.listDatasources).toHaveBeenCalledTimes(1);
    const listDatasourcesMock = gateway.listDatasources as unknown as {
      mock: {
        calls: unknown[][];
      };
    };
    const firstCall = listDatasourcesMock.mock.calls[0]?.[0] as
      | {
          authContext?: {
            subject?: string;
          };
        }
      | undefined;
    expect(firstCall?.authContext?.subject).toBe(authContext.subject);
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
      expect(input.tableauAuth?.subject).toBe(authContext.subject);
    }
  });

  it("treats zero-row Tableau analysis as unavailable without blocking post generation", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(async () =>
        buildAdditionalContext("survey", "No rows returned.", []),
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
        status: "success" as const,
        source: "actual_image" as const,
        rawText: "Tableau User Group Tokyo",
        photoContext: {
          sceneInference: "A crowded workshop room.",
          eventFeel: "Busy and energetic.",
          observedItems: ["projector", "attendees", "stage"],
          postableElements: ["crowd", "projector screen"],
          subjectCandidates: ["speaker", "audience"],
          detectedTopics: ["workshop", "tableau"],
          suggestedPostAngles: ["lead with the crowded atmosphere"],
          ocrText: "Tableau User Group Tokyo",
        },
      })),
    };

    const inputImageService = {
      fetchActionRunInputImage: vi.fn(async () => ({
        objectKey: "client-input-images/example.png",
        contentType: "image/png",
        byteLength: 4,
        source: "existing_object",
        bytes: new Uint8Array([1, 2, 3, 4]),
      })),
    };

    const service = new TableauPhotoPostAnalysisService(
      provider as never,
      gateway as never,
      visionAnalyzer as never,
      inputImageService as never,
    );
    const request = buildRequest();
    const result = await service.analyze({
      request: {
        ...request,
        clientContext: {
          ...request.clientContext!,
          photo: {
            ...request.clientContext!.photo!,
            objectKey: "client-input-images/example.png",
            contentType: "image/png",
            mimeType: "image/png",
          },
        },
      },
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });

    expect(result.surveyInsight?.available).toBe(false);
    expect(result.surveyInsight?.sourceStatus).toBe("skipped");
    expect(result.evidencePack.canGeneratePost).toBe(true);
    expect(result.evidencePack.generationBlockers).toEqual([]);
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
        status: "success" as const,
        source: "actual_image" as const,
        rawText: "Tableau User Group Tokyo",
        photoContext: {
          sceneInference: "A crowded workshop room.",
          eventFeel: "Busy and energetic.",
          observedItems: ["projector", "attendees", "stage"],
          postableElements: ["crowd", "projector screen"],
          subjectCandidates: ["speaker", "audience"],
          detectedTopics: ["workshop", "tableau"],
          suggestedPostAngles: ["lead with the crowded atmosphere"],
          ocrText: "Tableau User Group Tokyo",
        },
      })),
    };

    const service = new TableauPhotoPostAnalysisService(
      provider as never,
      gateway as never,
      visionAnalyzer as never,
      {
        fetchActionRunInputImage: vi.fn(async () => ({
          objectKey: "client-input-images/example.png",
          contentType: "image/png",
          byteLength: 4,
          source: "existing_object",
          bytes: new Uint8Array([1, 2, 3, 4]),
        })),
      } as never,
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
            objectKey: "client-input-images/example.png",
            mimeType: "image/png",
            contentType: "image/png",
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

  it("parses structured and unstructured vision text into usable summaries", () => {
    const jsonText = `\`\`\`json
    {
      "sceneInference": "A lively meetup hall.",
      "eventFeel": "Energetic",
      "observedItems": ["screen", "attendees"],
      "detectedTopics": ["tableau", "community"],
      "ocrText": "Tableau Meetup"
    }
    \`\`\``;

    const structured = extractVisionStructuredOutput(jsonText);
    expect(structured.sceneInference).toBe("A lively meetup hall.");
    expect(structured.detectedTopics).toContain("tableau");
    expect(structured.ocrText).toBe("Tableau Meetup");

    const plainText =
      "The photo shows a crowded workshop room with attendees around a projector.";
    const plainStructured = extractVisionStructuredOutput(plainText);
    expect(plainStructured.sceneInference).toContain("crowded workshop room");
    expect(buildVisionSummaryFromText(plainText, plainStructured)).toContain(
      "crowded workshop room",
    );
    expect(normalizeVisionText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("classifies image fetch and vision analysis failures with granular blockers", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(async () =>
        buildAdditionalContext("overview", "Recent posts are steady."),
      ),
    };

    const gateway = {
      listDatasources: vi.fn(async () => [
        { name: "MCP_Session_Survey_Responses", luid: "survey-luid" },
        { name: "X Account Analytics Contents", luid: "performance-luid" },
        { name: "X Account Overview Analytics", luid: "overview-luid" },
      ]),
    };

    const baseRequest = buildRequest();
    const imageRequest: ActionRunRequest = {
      ...baseRequest,
      clientContext: {
        ...baseRequest.clientContext!,
        photo: {
          ...baseRequest.clientContext!.photo!,
          objectKey: "client-input-images/example.jpg",
        },
      },
    };

    const fetchFailureService = new TableauPhotoPostAnalysisService(
      provider as never,
      gateway as never,
      {
        analyze: vi.fn(async () => ({
          status: "failed" as const,
          source: "vision_analysis_failed" as const,
          skippedReason: "vision analysis failed",
        })),
      } as never,
      {
        fetchActionRunInputImage: vi.fn(async () => null),
      } as never,
    );
    const fetchFailureResult = await fetchFailureService.analyze({
      request: imageRequest,
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });
    expect(fetchFailureResult.evidencePack.generationBlockers).toContain(
      "input_image_fetch_failed",
    );
    expect(fetchFailureResult.evidencePack.generationBlockers).not.toContain(
      "input_image_not_found",
    );

    const noOutputService = new TableauPhotoPostAnalysisService(
      provider as never,
      gateway as never,
      {
        analyze: vi.fn(async () => ({
          status: "no_usable_output" as const,
          source: "vision_analysis_no_usable_output" as const,
          skippedReason: "vision response was empty",
        })),
      } as never,
      {
        fetchActionRunInputImage: vi.fn(async () => ({
          objectKey: "client-input-images/example.jpg",
          contentType: "image/jpeg",
          byteLength: 10,
          source: "existing_object",
          bytes: new Uint8Array([1, 2, 3]),
        })),
      } as never,
    );
    const noOutputResult = await noOutputService.analyze({
      request: imageRequest,
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });
    expect(noOutputResult.evidencePack.generationBlockers).toContain(
      "vision_analysis_no_usable_output",
    );
    expect(noOutputResult.evidencePack.generationBlockers).not.toContain(
      "input_image_not_found",
    );
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

function buildAdditionalContext(
  kind: string,
  summary: string,
  rows: Array<{ label: string; value: number }> = [
    { label: summary, value: 1 },
  ],
) {
  return {
    provider: "tableau-mcp" as const,
    queryInsights: [
      {
        datasourceName: kind,
        metricField: "count",
        rowCount: rows.length,
        actualRowCount: rows.length,
        rows,
      },
    ],
    warnings: [],
  };
}
