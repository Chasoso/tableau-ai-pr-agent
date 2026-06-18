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
    expect(provider.getAdditionalContext).toHaveBeenCalledTimes(6);
    for (const call of provider.getAdditionalContext.mock.calls) {
      const input = call[0];
      expect(input.dashboardContext.dataSources ?? []).toHaveLength(1);
      expect(input.dashboardContext.dataSources?.[0]?.name).not.toBe(
        "Disallowed Datasource",
      );
      expect(input.tableauAuth?.subject).toBe(authContext.subject);
    }
  });

  it("prioritizes real account overview metrics and avoids the row-count fallback", async () => {
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
          if (input.questionInterpretation?.requestType === "field_inventory") {
            return buildAdditionalContextWithFields(
              "overview",
              "Metadata fetched successfully.",
              [
                {
                  name: "Date",
                  dataType: "DATE",
                  role: "DIMENSION",
                },
                {
                  name: "インプレッション数",
                  dataType: "INTEGER",
                  role: "MEASURE",
                },
                {
                  name: "エンゲージメント",
                  dataType: "INTEGER",
                  role: "MEASURE",
                },
                {
                  name: "新しいフォロー",
                  dataType: "INTEGER",
                  role: "MEASURE",
                },
                {
                  name: "ブックマーク",
                  dataType: "INTEGER",
                  role: "MEASURE",
                },
              ],
            );
          }

          if (input.questionInterpretation?.requestType === "general") {
            return buildAdditionalContext(
              "overview",
              "Recent overview trends are visible.",
            );
          }

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

    const overviewQueryCall = provider.getAdditionalContext.mock.calls.find(
      ([input]) =>
        input.questionInterpretation?.requestType === "general" &&
        input.questionInterpretation?.analysisIntent === "grouped_trend" &&
        input.questionInterpretation?.topN === 30,
    )?.[0];

    expect(overviewQueryCall?.questionInterpretation?.queryFields).toEqual([
      { fieldCaption: "Date", fieldAlias: "rank_label" },
      { fieldCaption: "Date", fieldAlias: "rank_label_date" },
      {
        fieldCaption: "インプレッション数",
        function: "SUM",
        fieldAlias: "rank_metric",
        sortDirection: "DESC",
        sortPriority: 1,
      },
    ]);
    expect(
      overviewQueryCall?.questionInterpretation?.queryFields?.some(
        (field) => field.fieldCaption === "回答数",
      ),
    ).toBe(false);
    expect(result.accountOverviewInsight?.available).toBe(true);
  });

  it("skips account overview query execution when no suitable metric field exists", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(
        async (
          input: Parameters<TableauContextProvider["getAdditionalContext"]>[0],
        ) => {
          if (input.questionInterpretation?.requestType === "field_inventory") {
            return buildAdditionalContextWithFields(
              "overview",
              "Metadata fetched successfully.",
              [
                {
                  name: "Date",
                  dataType: "DATE",
                  role: "DIMENSION",
                },
                {
                  name: "Owner Name",
                  dataType: "STRING",
                  role: "DIMENSION",
                },
              ],
            );
          }

          if (input.questionInterpretation?.requestType === "general") {
            return buildAdditionalContext(
              "overview",
              "This call should not be reached when validation skips the query.",
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

    const overviewGeneralCalls =
      provider.getAdditionalContext.mock.calls.filter(
        ([input]) =>
          input.questionInterpretation?.requestType === "general" &&
          input.questionInterpretation?.analysisIntent === "grouped_trend",
      );

    expect(overviewGeneralCalls).toHaveLength(0);
    expect(result.accountOverviewInsight?.available).toBe(false);
    expect(result.accountOverviewInsight?.sourceStatus).toBe("skipped");
    expect(result.accountOverviewInsight?.skippedReason).toBe(
      "no_suitable_metric_fields",
    );
  });

  it("propagates Tableau MCP resource-not-found query errors into the insight", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(
        async (
          input: Parameters<TableauContextProvider["getAdditionalContext"]>[0],
        ) => {
          if (input.questionInterpretation?.requestType === "field_inventory") {
            return buildAdditionalContextWithFields(
              "overview",
              "Metadata fetched successfully.",
              [
                {
                  name: "Date",
                  dataType: "DATE",
                  role: "DIMENSION",
                },
                {
                  name: "インプレッション数",
                  dataType: "INTEGER",
                  role: "MEASURE",
                },
              ],
            );
          }
          return {
            ...buildAdditionalContext(
              "overview",
              "Query failed for unknown field.",
              [],
            ),
            mcpToolResults: [
              {
                toolName: "query-datasource",
                status: "failed" as const,
                errorCategory: "resource_not_found",
                errorMessage:
                  "Field '回答数' was not found in the datasource. Fields must either belong to the datasource or provide a custom calculation.",
              },
            ],
            queryInsights: [],
          };
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

    expect(result.accountOverviewInsight?.available).toBe(false);
    expect(result.accountOverviewInsight?.sourceStatus).toBe("failed");
    expect(result.accountOverviewInsight?.failedReason).toBe(
      "query_field_not_found",
    );
    expect(result.accountOverviewInsight?.queryErrorCategory).toBe(
      "resource_not_found",
    );
    expect(result.accountOverviewInsight?.queryErrorMessage).toContain(
      "Field '回答数' was not found",
    );
    expect(result.accountOverviewInsight?.unknownFields).toEqual(["回答数"]);
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
    expect(result.surveyInsight?.sourceStatus).toBe("queried");
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
          if (input.questionInterpretation?.requestType === "field_inventory") {
            return buildAdditionalContext(
              input.question.includes("survey")
                ? "survey"
                : input.question.includes("engagement")
                  ? "performance"
                  : "overview",
              "Metadata fetched successfully.",
              [{ label: "Metadata fetched successfully.", value: 1 }],
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

  it("builds fixed purpose-specific query interpretations from metadata", async () => {
    const provider = {
      name: "tableau-mcp" as const,
      getAdditionalContext: vi.fn(async (input) => {
        const kind = input.question.includes("survey")
          ? "survey"
          : input.question.includes("engagement")
            ? "performance"
            : "overview";
        return buildAdditionalContext(kind, "Metadata fetched successfully.", [
          { label: "Metadata fetched successfully.", value: 1 },
        ]);
      }),
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
    await service.analyze({
      request: buildRequest(),
      authenticatedUser: {
        userId: "user-1",
        tableauSubject: "user@example.com",
      },
    });

    const queryCalls = (
      provider.getAdditionalContext as unknown as {
        mock: {
          calls: Array<
            [Parameters<TableauContextProvider["getAdditionalContext"]>[0]]
          >;
        };
      }
    ).mock.calls
      .map((call) => call[0])
      .filter(
        (input) =>
          input.questionInterpretation?.requestType !== "field_inventory",
      );

    expect(queryCalls).toHaveLength(3);
    const surveyCall = queryCalls.find(
      (input) =>
        input.question.includes("survey") &&
        input.questionInterpretation?.topN === 20,
    );
    const performanceCall = queryCalls.find(
      (input) =>
        input.questionInterpretation?.rankingTarget === "post" &&
        input.questionInterpretation?.topN === 10,
    );
    const overviewCall = queryCalls.find(
      (input) =>
        input.questionInterpretation?.analysisIntent === "grouped_trend" &&
        input.questionInterpretation?.topN === 30,
    );

    expect(surveyCall?.questionInterpretation?.topN).toBe(20);
    expect(performanceCall?.questionInterpretation?.metricIntent).not.toBe(
      "bookmarks",
    );
    expect(overviewCall?.questionInterpretation?.period).toEqual(
      expect.objectContaining({
        startDate: expect.any(String),
        endDate: expect.any(String),
      }),
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
  const datasourceName =
    kind === "survey"
      ? "MCP_Session_Survey_Responses"
      : kind === "performance"
        ? "X Account Analytics Contents"
        : "X Account Overview Analytics";
  const fields = [
    { name: "Response Text", dataType: "STRING", role: "DIMENSION" },
    { name: "Feedback", dataType: "STRING", role: "DIMENSION" },
    { name: "Concern", dataType: "STRING", role: "DIMENSION" },
    { name: "Post Text", dataType: "STRING", role: "DIMENSION" },
    { name: "Post Title", dataType: "STRING", role: "DIMENSION" },
    { name: "Date", dataType: "DATE", role: "DIMENSION" },
    { name: "Impressions", dataType: "INTEGER", role: "MEASURE" },
    { name: "Engagement", dataType: "INTEGER", role: "MEASURE" },
    { name: "Likes", dataType: "INTEGER", role: "MEASURE" },
    { name: "Reposts", dataType: "INTEGER", role: "MEASURE" },
    { name: "Replies", dataType: "INTEGER", role: "MEASURE" },
    { name: "Bookmarks", dataType: "INTEGER", role: "MEASURE" },
  ];
  return {
    provider: "tableau-mcp" as const,
    datasourceFieldProfiles: [
      {
        datasourceName,
        fieldCount: fields.length,
        fieldNames: fields.map((field) => field.name),
        fields,
        sourceTool: "get-datasource-metadata" as const,
      },
    ],
    queryInsights: [
      {
        datasourceName,
        metricField: "count",
        rowCount: rows.length,
        actualRowCount: rows.length,
        rows,
      },
    ],
    mcpToolResults: [
      {
        toolName: "query-datasource",
        status: "success",
      },
    ],
    warnings: [],
  };
}

function buildAdditionalContextWithFields(
  kind: string,
  summary: string,
  fields: Array<{ name: string; dataType: string; role: string }>,
  rows: Array<{ label: string; value: number }> = [
    { label: summary, value: 1 },
  ],
) {
  const base = buildAdditionalContext(kind, summary, rows);
  const datasourceName =
    kind === "survey"
      ? "MCP_Session_Survey_Responses"
      : kind === "performance"
        ? "X Account Analytics Contents"
        : "X Account Overview Analytics";
  return {
    ...base,
    datasourceFieldProfiles: [
      {
        datasourceName,
        fieldCount: fields.length,
        fieldNames: fields.map((field) => field.name),
        fields,
        sourceTool: "get-datasource-metadata" as const,
      },
    ],
  };
}
