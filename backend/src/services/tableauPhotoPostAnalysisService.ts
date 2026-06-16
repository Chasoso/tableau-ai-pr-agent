import { createRequire } from "node:module";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getTableauConnectedAppSecrets } from "../aws/secrets";
import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails } from "../logging";
import type { AuthenticatedUser } from "../types/auth";
import {
  buildTableauDirectTrustAuthLog,
  resolveTableauDirectTrustAuthContext,
  type TableauDirectTrustAuthContext,
} from "../tableau/tableauDirectTrustAuth";
import type {
  ActionRunAnalysisSection,
  ActionRunRequest,
} from "../types/actionRun";
import type {
  DashboardContext,
  TableauAdditionalContext,
} from "../types/tableau";
import type { TableauContextProvider } from "../tableau/contextProvider";

export type AllowedDatasource = {
  key: string;
  name: string;
  luid?: string;
  purpose: "survey_insight" | "post_performance" | "account_overview";
  description: string;
  priority?: number;
};

export const ALLOWED_TABLEAU_DATASOURCES: AllowedDatasource[] = [
  {
    key: "mcp_session_survey_responses",
    name: "MCP_Session_Survey_Responses",
    purpose: "survey_insight",
    description:
      "Survey responses used to understand expectations and concerns.",
    priority: 1,
  },
  {
    key: "x_account_analytics_contents",
    name: "X Account Analytics Contents",
    purpose: "post_performance",
    description:
      "Post-level X analytics used to understand what performs well.",
    priority: 2,
  },
  {
    key: "x_account_overview_analytics",
    name: "X Account Overview Analytics",
    purpose: "account_overview",
    description: "Account-level X analytics used to understand recent trends.",
    priority: 3,
  },
];

export type SurveyInsight = {
  available: boolean;
  keyExpectations: string[];
  keyInterests: string[];
  concernsOrQuestions: string[];
  suggestedAngles: string[];
  evidenceSummary: string;
};

export type PostPerformanceInsight = {
  available: boolean;
  highPerformingThemes: string[];
  highPerformingPatterns: string[];
  recommendedTone: string[];
  recommendedStructure: string[];
  avoidPatterns: string[];
  evidenceSummary: string;
};

export type AccountOverviewInsight = {
  available: boolean;
  recentTrendSummary: string;
  notableChanges: string[];
  timingHints: string[];
  accountContextForPost: string;
  evidenceSummary: string;
};

export type PostGenerationEvidencePack = {
  photoContext: {
    summary: string;
    detectedTopics: string[];
    suggestedPostAngles: string[];
    observedItems?: string[];
    sceneInference?: string;
    eventFeel?: string;
    postableElements?: string[];
    subjectCandidates?: string[];
    ocrText?: string;
  };
  surveyInsight?: SurveyInsight;
  postPerformanceInsight?: PostPerformanceInsight;
  accountOverviewInsight?: AccountOverviewInsight;
  constraints: {
    doNotInventMetrics: boolean;
    useEvidenceOnlyWhenAvailable: boolean;
    keepNaturalJapanese: boolean;
  };
};

export type PhotoPostAnalysisResult = {
  photoContext: PostGenerationEvidencePack["photoContext"];
  surveyInsight?: SurveyInsight;
  postPerformanceInsight?: PostPerformanceInsight;
  accountOverviewInsight?: AccountOverviewInsight;
  evidencePack: PostGenerationEvidencePack;
  analysisSections: ActionRunAnalysisSection[];
  datasourceResolution: {
    allowedDatasourceCount: number;
    allowedDatasourceKeys: string[];
    listDatasourcesCount: number;
    matchedAllowedDatasourceCount: number;
    rejectedDatasourceCount: number;
    resolvedDatasourceKeys: string[];
    unresolvedDatasourceKeys: string[];
    selectedDatasourceForPurpose: Record<string, string | undefined>;
    datasourceResolutionReason: string;
  };
  debug: {
    photoContextGenerated: boolean;
    surveyInsightStatus: "available" | "skipped" | "failed";
    postPerformanceInsightStatus: "available" | "skipped" | "failed";
    accountOverviewInsightStatus: "available" | "skipped" | "failed";
    evidencePackGenerated: boolean;
  };
};

type ListedDatasource = {
  name?: string;
  luid?: string;
  id?: string;
  contentUrl?: string;
  projectName?: string;
  workbookName?: string;
};

type ResolvedAllowedDatasource = {
  allowed: AllowedDatasource;
  source: ListedDatasource;
};

type ListDatasourcesGateway = {
  listDatasources(input?: {
    authContext?: TableauDirectTrustAuthContext;
  }): Promise<ListedDatasource[]>;
};

type PhotoVisionAnalyzer = {
  analyze(input: {
    currentSituation: string;
    fileName?: string;
    mimeType?: string;
    dataUrl: string;
  }): Promise<Partial<PostGenerationEvidencePack["photoContext"]> | undefined>;
};

const FIXED_ANALYSIS_QUESTIONS: Record<AllowedDatasource["purpose"], string> = {
  survey_insight:
    "Analyze survey response themes for participant expectations, interests, concerns, and post angles.",
  post_performance:
    "Analyze X post analytics for themes, patterns, tone, structure, and avoid patterns that correlate with stronger engagement.",
  account_overview:
    "Analyze X account overview trends for recent changes, timing hints, and account context that should shape the post draft.",
};

export class TableauPhotoPostAnalysisService {
  constructor(
    private readonly tableauContextProvider: TableauContextProvider,
    private readonly datasourceGateway: ListDatasourcesGateway = createListDatasourcesGateway(),
    private readonly photoVisionAnalyzer: PhotoVisionAnalyzer = createPhotoVisionAnalyzer(),
  ) {}

  async analyze(input: {
    request: ActionRunRequest;
    authenticatedUser?: AuthenticatedUser;
  }): Promise<PhotoPostAnalysisResult> {
    const authContext = resolveTableauDirectTrustAuthContext({
      authenticatedUser: input.authenticatedUser,
    });
    logInfo(
      "tableau.photo_post.auth_context",
      buildTableauDirectTrustAuthLog({
        authContext,
        serverUrl: getConfig().tableau.serverUrl,
        siteContentUrl: getConfig().tableau.siteContentUrl,
        apiVersion: getConfig().tableau.apiVersion,
      }),
    );
    const photoContext = await buildPhotoContext(
      input.request,
      this.photoVisionAnalyzer,
    );
    logInfo("tableau.photo_post.photoContextGenerated", {
      photoContextGenerated: true,
      photoTopicCount: photoContext.detectedTopics.length,
    });

    const listedDatasources = await this.datasourceGateway.listDatasources({
      authContext,
    });
    const datasourceResolution = resolveAllowedDatasources(listedDatasources);
    logInfo("tableau.photo_post.datasourceResolution", {
      allowedDatasourceCount: ALLOWED_TABLEAU_DATASOURCES.length,
      allowedDatasourceKeys: ALLOWED_TABLEAU_DATASOURCES.map(
        (item) => item.key,
      ),
      listDatasourcesCount: listedDatasources.length,
      matchedAllowedDatasourceCount:
        datasourceResolution.matchedAllowedDatasourceCount,
      rejectedDatasourceCount: datasourceResolution.rejectedDatasourceCount,
      rejectedReason: "not_in_allowed_list",
      resolvedDatasourceKeys: datasourceResolution.resolvedDatasourceKeys,
      unresolvedDatasourceKeys: datasourceResolution.unresolvedDatasourceKeys,
      selectedDatasourceForPurpose:
        datasourceResolution.selectedDatasourceForPurpose,
      datasourceResolutionReason:
        datasourceResolution.datasourceResolutionReason,
    });

    const surveyInsight = await runPurposeAnalysis({
      request: input.request,
      authenticatedUser: input.authenticatedUser,
      authContext,
      purpose: "survey_insight",
      datasource: datasourceResolution.selectedByPurpose.survey_insight,
      photoContext,
      tableauContextProvider: this.tableauContextProvider,
    });
    const postPerformanceInsight = await runPurposeAnalysis({
      request: input.request,
      authenticatedUser: input.authenticatedUser,
      authContext,
      purpose: "post_performance",
      datasource: datasourceResolution.selectedByPurpose.post_performance,
      photoContext,
      tableauContextProvider: this.tableauContextProvider,
    });
    const accountOverviewInsight = await runPurposeAnalysis({
      request: input.request,
      authenticatedUser: input.authenticatedUser,
      authContext,
      purpose: "account_overview",
      datasource: datasourceResolution.selectedByPurpose.account_overview,
      photoContext,
      tableauContextProvider: this.tableauContextProvider,
    });

    const evidencePack: PostGenerationEvidencePack = {
      photoContext,
      ...(surveyInsight ? { surveyInsight } : {}),
      ...(postPerformanceInsight ? { postPerformanceInsight } : {}),
      ...(accountOverviewInsight ? { accountOverviewInsight } : {}),
      constraints: {
        doNotInventMetrics: true,
        useEvidenceOnlyWhenAvailable: true,
        keepNaturalJapanese: true,
      },
    };

    const analysisSections = buildAnalysisSections({
      photoContext,
      surveyInsight,
      postPerformanceInsight,
      accountOverviewInsight,
    });

    logInfo("tableau.photo_post.evidencePackGenerated", {
      evidencePackGenerated: true,
      analysisSectionCount: analysisSections.length,
      resolvedDatasourceKeys: datasourceResolution.resolvedDatasourceKeys,
    });

    return {
      photoContext,
      ...(surveyInsight ? { surveyInsight } : {}),
      ...(postPerformanceInsight ? { postPerformanceInsight } : {}),
      ...(accountOverviewInsight ? { accountOverviewInsight } : {}),
      evidencePack,
      analysisSections,
      datasourceResolution: {
        allowedDatasourceCount: ALLOWED_TABLEAU_DATASOURCES.length,
        allowedDatasourceKeys: ALLOWED_TABLEAU_DATASOURCES.map(
          (item) => item.key,
        ),
        listDatasourcesCount: listedDatasources.length,
        matchedAllowedDatasourceCount:
          datasourceResolution.matchedAllowedDatasourceCount,
        rejectedDatasourceCount: datasourceResolution.rejectedDatasourceCount,
        resolvedDatasourceKeys: datasourceResolution.resolvedDatasourceKeys,
        unresolvedDatasourceKeys: datasourceResolution.unresolvedDatasourceKeys,
        selectedDatasourceForPurpose:
          datasourceResolution.selectedDatasourceForPurpose,
        datasourceResolutionReason:
          datasourceResolution.datasourceResolutionReason,
      },
      debug: {
        photoContextGenerated: true,
        surveyInsightStatus: surveyInsight?.available ? "available" : "skipped",
        postPerformanceInsightStatus: postPerformanceInsight?.available
          ? "available"
          : "skipped",
        accountOverviewInsightStatus: accountOverviewInsight?.available
          ? "available"
          : "skipped",
        evidencePackGenerated: true,
      },
    };
  }
}

async function runPurposeAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  purpose: "survey_insight";
  datasource?: ResolvedAllowedDatasource;
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<SurveyInsight | undefined>;
async function runPurposeAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  purpose: "post_performance";
  datasource?: ResolvedAllowedDatasource;
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<PostPerformanceInsight | undefined>;
async function runPurposeAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  purpose: "account_overview";
  datasource?: ResolvedAllowedDatasource;
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<AccountOverviewInsight | undefined>;
async function runPurposeAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  purpose: AllowedDatasource["purpose"];
  datasource?: ResolvedAllowedDatasource;
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<
  SurveyInsight | PostPerformanceInsight | AccountOverviewInsight | undefined
> {
  if (!input.datasource) {
    logInfo("tableau.photo_post.skippedInsightReason", {
      purpose: input.purpose,
      skippedInsightReason: "allowed datasource could not be resolved",
    });
    return buildUnavailableInsight(
      input.purpose,
      "allowed datasource could not be resolved",
    );
  }

  const subject = input.authContext.subject;
  if (!subject.trim()) {
    logWarn("tableau.photo_post.failedInsightReason", {
      purpose: input.purpose,
      failedInsightReason: "no Tableau subject available for MCP analysis",
    });
    return buildUnavailableInsight(
      input.purpose,
      "no Tableau subject available for MCP analysis",
    );
  }

  const question = FIXED_ANALYSIS_QUESTIONS[input.purpose];
  const dashboardContext = buildScopedDashboardContext(
    input.request,
    input.datasource,
  );

  try {
    const additionalContext =
      await input.tableauContextProvider.getAdditionalContext({
        question,
        planningQuestion: question,
        dashboardContext,
        authenticatedUser: input.authenticatedUser,
        tableauSubject: subject,
        tableauAuth: input.authContext,
      });
    return buildPurposeInsight(
      input.purpose,
      additionalContext,
      input.photoContext,
    );
  } catch (error) {
    logWarn("tableau.photo_post.failedInsightReason", {
      purpose: input.purpose,
      failedInsightReason: safeErrorDetails(error),
    });
    return buildUnavailableInsight(
      input.purpose,
      "Tableau analysis failed for this purpose.",
    );
  }
}

function buildPurposeInsight(
  purpose: AllowedDatasource["purpose"],
  additionalContext: TableauAdditionalContext,
  photoContext: PostGenerationEvidencePack["photoContext"],
): SurveyInsight | PostPerformanceInsight | AccountOverviewInsight {
  const summary = buildContextSummary(additionalContext);
  const rows = additionalContext.queryInsights?.[0]?.rows ?? [];
  const labels = rows
    .map((row) => row.label?.trim())
    .filter((value): value is string => Boolean(value));
  const topLabels = uniqueStrings(labels.slice(0, 6));
  const evidenceSummary =
    summary ||
    topLabels.join(" / ") ||
    "Tableau analysis results were not available.";

  if (purpose === "survey_insight") {
    const keywordLabels = labels.filter((label) =>
      /expect|interest|concern|question|engagement|impression|follower|post/i.test(
        label,
      ),
    );
    return {
      available: true,
      keyExpectations: sliceOrFallback(keywordLabels, 0, 3, topLabels),
      keyInterests: sliceOrFallback(keywordLabels, 1, 3, topLabels),
      concernsOrQuestions: sliceOrFallback(
        labels.filter((label) =>
          /concern|question|issue|worry|unclear/i.test(label),
        ),
        0,
        3,
        topLabels,
      ),
      suggestedAngles: uniqueStrings([
        ...photoContext.suggestedPostAngles,
        ...topLabels.slice(0, 2),
        "Address what people care about first",
      ]).slice(0, 5),
      evidenceSummary,
    };
  }

  if (purpose === "post_performance") {
    return {
      available: true,
      highPerformingThemes: sliceOrFallback(topLabels, 0, 4, [
        "photo posts",
        "live atmosphere",
        "participant view",
      ]),
      highPerformingPatterns: sliceOrFallback(topLabels, 1, 4, [
        "keep the opening short",
        "share the atmosphere with the photo",
      ]),
      recommendedTone: ["natural", "not too loud", "slightly energetic"],
      recommendedStructure: [
        "Open with the现场感",
        "Add one useful detail",
        "Finish with a minimal set of hashtags",
      ],
      avoidPatterns: [
        "forced numbers",
        "too much hype",
        "irrelevant long text",
      ],
      evidenceSummary,
    };
  }

  return {
    available: true,
    recentTrendSummary: evidenceSummary,
    notableChanges: sliceOrFallback(topLabels, 0, 4, [
      "recently strong themes",
      "engagement shifts",
    ]),
    timingHints: [
      "Post while the venue is still active",
      "Lean on the current winning pattern",
    ],
    accountContextForPost: topLabels[0]
      ? `Recent posts are showing ${topLabels[0]} as a visible theme.`
      : "Use the current account context naturally.",
    evidenceSummary,
  };
}

function buildUnavailableInsight(
  purpose: AllowedDatasource["purpose"],
  reason: string,
): SurveyInsight | PostPerformanceInsight | AccountOverviewInsight {
  if (purpose === "survey_insight") {
    return {
      available: false,
      keyExpectations: [],
      keyInterests: [],
      concernsOrQuestions: [],
      suggestedAngles: [],
      evidenceSummary: reason,
    };
  }

  if (purpose === "post_performance") {
    return {
      available: false,
      highPerformingThemes: [],
      highPerformingPatterns: [],
      recommendedTone: [],
      recommendedStructure: [],
      avoidPatterns: [],
      evidenceSummary: reason,
    };
  }

  return {
    available: false,
    recentTrendSummary: reason,
    notableChanges: [],
    timingHints: [],
    accountContextForPost: reason,
    evidenceSummary: reason,
  };
}

function buildAnalysisSections(input: {
  photoContext: PostGenerationEvidencePack["photoContext"];
  surveyInsight?: SurveyInsight;
  postPerformanceInsight?: PostPerformanceInsight;
  accountOverviewInsight?: AccountOverviewInsight;
}): ActionRunAnalysisSection[] {
  return [
    {
      key: "photo_context",
      title: "Photo context",
      question: "Understand the uploaded photo and identify the post angle.",
      summary: input.photoContext.summary,
      rows: input.photoContext.detectedTopics.map((topic) => ({
        label: topic,
        value: null,
      })),
      details: {
        observedItems: input.photoContext.observedItems,
        ocrText: input.photoContext.ocrText,
        sceneInference: input.photoContext.sceneInference,
        eventFeel: input.photoContext.eventFeel,
        postableElements: input.photoContext.postableElements,
        subjectCandidates: input.photoContext.subjectCandidates,
      },
    },
    {
      key: "survey_insight",
      title: "Survey insight",
      question:
        "Analyze survey responses for participant expectations and concerns.",
      summary:
        input.surveyInsight?.evidenceSummary ||
        "Survey insight was unavailable.",
      rows: (input.surveyInsight?.keyExpectations ?? []).map((label) => ({
        label,
        value: null,
      })),
    },
    {
      key: "post_performance_insight",
      title: "Post performance insight",
      question: "Analyze X post performance for higher-engagement patterns.",
      summary:
        input.postPerformanceInsight?.evidenceSummary ||
        "Post performance insight was unavailable.",
      rows: (input.postPerformanceInsight?.highPerformingThemes ?? []).map(
        (label) => ({
          label,
          value: null,
        }),
      ),
    },
    {
      key: "account_overview_insight",
      title: "Account overview insight",
      question: "Analyze the recent X account overview trends.",
      summary:
        input.accountOverviewInsight?.evidenceSummary ||
        "Account overview insight was unavailable.",
      rows: (input.accountOverviewInsight?.notableChanges ?? []).map(
        (label) => ({
          label,
          value: null,
        }),
      ),
    },
    {
      key: "evidence_pack",
      title: "Evidence pack",
      question: "Summarize the evidence pack for generation.",
      summary: buildEvidencePackSummary({
        photoContext: input.photoContext,
        surveyInsight: input.surveyInsight,
        postPerformanceInsight: input.postPerformanceInsight,
        accountOverviewInsight: input.accountOverviewInsight,
      }),
      rows: [],
    },
  ];
}

function buildEvidencePackSummary(input: {
  photoContext: PostGenerationEvidencePack["photoContext"];
  surveyInsight?: SurveyInsight;
  postPerformanceInsight?: PostPerformanceInsight;
  accountOverviewInsight?: AccountOverviewInsight;
}): string {
  return [
    input.photoContext.summary,
    input.surveyInsight?.evidenceSummary,
    input.postPerformanceInsight?.evidenceSummary,
    input.accountOverviewInsight?.evidenceSummary,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" / ");
}

async function buildPhotoContext(
  request: ActionRunRequest,
  visionAnalyzer: PhotoVisionAnalyzer,
): Promise<PostGenerationEvidencePack["photoContext"]> {
  const photo = request.clientContext?.photo;
  const heuristic = buildHeuristicPhotoContext(request);
  if (!photo?.dataUrl || photo.mode === "none") {
    return heuristic;
  }

  const vision = await visionAnalyzer.analyze({
    currentSituation: request.currentSituation,
    fileName: photo.fileName,
    mimeType: photo.mimeType,
    dataUrl: photo.dataUrl,
  });

  if (!vision) {
    return heuristic;
  }

  const detectedTopics = uniqueStrings([
    ...(vision.detectedTopics ?? []),
    ...heuristic.detectedTopics,
  ]).slice(0, 8);
  const suggestedPostAngles = uniqueStrings([
    ...(vision.suggestedPostAngles ?? []),
    ...heuristic.suggestedPostAngles,
  ]).slice(0, 6);

  return {
    ...heuristic,
    ...vision,
    summary: buildVisionSummary({
      currentSituation: request.currentSituation,
      vision,
      heuristic,
      fileName: photo.fileName,
      sizeLabel: photo.sizeLabel,
    }),
    detectedTopics,
    suggestedPostAngles,
  };
}

function buildHeuristicPhotoContext(
  request: ActionRunRequest,
): PostGenerationEvidencePack["photoContext"] {
  const photo = request.clientContext?.photo;
  const summary = [
    request.currentSituation.trim(),
    photo?.fileName ? `image file: ${photo.fileName}` : undefined,
    photo?.sizeLabel ? `size: ${photo.sizeLabel}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" / ");

  const detectedTopics = uniqueStrings(
    extractKeywords(request.currentSituation)
      .concat(photo?.fileName ? extractKeywords(photo.fileName) : [])
      .slice(0, 5),
  );

  const suggestedPostAngles = uniqueStrings([
    "highlight the现场感",
    "lean into participant expectations",
    "add one sentence about what the photo shows",
    "keep the tone light",
    ...detectedTopics.map((topic) => `mention ${topic} naturally`),
  ]).slice(0, 5);

  return {
    summary,
    detectedTopics,
    suggestedPostAngles,
  };
}

function buildVisionSummary(input: {
  currentSituation: string;
  vision: Partial<PostGenerationEvidencePack["photoContext"]>;
  heuristic: PostGenerationEvidencePack["photoContext"];
  fileName?: string;
  sizeLabel?: string;
}): string {
  const parts = [
    input.vision.sceneInference?.trim(),
    input.vision.eventFeel?.trim(),
    input.vision.observedItems?.length
      ? `observed: ${input.vision.observedItems.join(" / ")}`
      : undefined,
    input.vision.postableElements?.length
      ? `usable: ${input.vision.postableElements.join(" / ")}`
      : undefined,
    input.vision.subjectCandidates?.length
      ? `subjects: ${input.vision.subjectCandidates.join(" / ")}`
      : undefined,
    input.vision.ocrText?.trim()
      ? `ocr: ${input.vision.ocrText.trim()}`
      : undefined,
    input.currentSituation.trim(),
    input.fileName ? `image file: ${input.fileName}` : undefined,
    input.sizeLabel ? `size: ${input.sizeLabel}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return uniqueStrings(parts).join(" / ") || input.heuristic.summary;
}

function createPhotoVisionAnalyzer(): PhotoVisionAnalyzer {
  const config = getConfig();
  if (config.model.provider !== "bedrock") {
    return {
      async analyze() {
        return undefined;
      },
    };
  }

  const client = new BedrockRuntimeClient({
    region: config.model.bedrock.region,
  });

  return {
    async analyze(input: {
      currentSituation: string;
      fileName?: string;
      mimeType?: string;
      dataUrl: string;
    }): Promise<
      Partial<PostGenerationEvidencePack["photoContext"]> | undefined
    > {
      const imageParts = parseDataUrl(input.dataUrl);
      if (!imageParts) {
        return undefined;
      }

      try {
        const response = await client.send(
          new ConverseCommand({
            modelId: config.model.bedrock.modelId,
            messages: [
              {
                role: "user",
                content: [
                  {
                    text: "Analyze this photo for X post generation. Return JSON only with keys: sceneInference, eventFeel, observedItems, postableElements, subjectCandidates, detectedTopics, suggestedPostAngles, ocrText. Keep strings concise. Do not invent text you cannot read.",
                  },
                  {
                    image: {
                      format: imageParts.format,
                      source: {
                        bytes: imageParts.bytes,
                      },
                    },
                  },
                ],
              },
            ],
            inferenceConfig: {
              maxTokens: 800,
              temperature: 0.1,
            },
          }),
        );

        const text = response.output?.message?.content
          ?.map((content) => ("text" in content ? content.text : ""))
          .filter(Boolean)
          .join("\n")
          .trim();
        if (!text) {
          return undefined;
        }

        const parsed = parseJsonObject(text);
        if (!parsed) {
          return undefined;
        }

        return {
          sceneInference: readString(parsed.sceneInference),
          eventFeel: readString(parsed.eventFeel),
          observedItems: readStringArray(parsed.observedItems),
          postableElements: readStringArray(parsed.postableElements),
          subjectCandidates: readStringArray(parsed.subjectCandidates),
          detectedTopics: readStringArray(parsed.detectedTopics),
          suggestedPostAngles: readStringArray(parsed.suggestedPostAngles),
          ocrText: readString(parsed.ocrText),
        };
      } catch (error) {
        logWarn("tableau.photo_post.vision_failed", {
          failedInsightReason: safeErrorDetails(error),
          fileName: input.fileName,
        });
        return undefined;
      }
    },
  };
}

function parseDataUrl(
  dataUrl: string,
): { format: "png" | "jpeg" | "webp" | "gif"; bytes: Uint8Array } | undefined {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    return undefined;
  }

  const mimeType = match[1].toLowerCase();
  const base64 = match[2];
  const format =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/jpeg" || mimeType === "image/jpg"
        ? "jpeg"
        : mimeType === "image/webp"
          ? "webp"
          : mimeType === "image/gif"
            ? "gif"
            : undefined;
  if (!format) {
    return undefined;
  }

  return {
    format,
    bytes: Uint8Array.from(Buffer.from(base64, "base64")),
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  const jsonText =
    first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate;

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);

  return items.length ? items : undefined;
}

function buildScopedDashboardContext(
  request: ActionRunRequest,
  datasource: ResolvedAllowedDatasource,
): DashboardContext {
  return {
    ...request.dashboardContext,
    dataSources: [
      {
        name: datasource.source.name ?? datasource.allowed.name,
        id: datasource.source.id ?? undefined,
      },
    ],
  };
}

function resolveAllowedDatasources(listed: ListedDatasource[]): {
  selectedByPurpose: Partial<
    Record<AllowedDatasource["purpose"], ResolvedAllowedDatasource>
  >;
  matchedAllowedDatasourceCount: number;
  rejectedDatasourceCount: number;
  resolvedDatasourceKeys: string[];
  unresolvedDatasourceKeys: string[];
  selectedDatasourceForPurpose: Record<string, string | undefined>;
  datasourceResolutionReason: string;
} {
  const matched = new Map<string, ResolvedAllowedDatasource>();

  for (const allowed of ALLOWED_TABLEAU_DATASOURCES) {
    const match = allowed.luid?.trim()
      ? listed.find(
          (datasource) =>
            normalize(datasource.luid) === normalize(allowed.luid),
        )
      : listed.find(
          (datasource) =>
            normalize(datasource.name) === normalize(allowed.name),
        );

    if (match) {
      matched.set(allowed.key, {
        allowed,
        source: match,
      });
    }
  }

  const resolvedDatasourceKeys = [...matched.keys()];
  const unresolvedDatasourceKeys = ALLOWED_TABLEAU_DATASOURCES.filter(
    (allowed) => !matched.has(allowed.key),
  ).map((allowed) => allowed.key);

  return {
    selectedByPurpose: {
      survey_insight: matched.get("mcp_session_survey_responses"),
      post_performance: matched.get("x_account_analytics_contents"),
      account_overview: matched.get("x_account_overview_analytics"),
    },
    matchedAllowedDatasourceCount: resolvedDatasourceKeys.length,
    rejectedDatasourceCount: Math.max(
      0,
      listed.length - resolvedDatasourceKeys.length,
    ),
    resolvedDatasourceKeys,
    unresolvedDatasourceKeys,
    selectedDatasourceForPurpose: {
      survey_insight: matched.get("mcp_session_survey_responses")?.source.name,
      post_performance: matched.get("x_account_analytics_contents")?.source
        .name,
      account_overview: matched.get("x_account_overview_analytics")?.source
        .name,
    },
    datasourceResolutionReason: unresolvedDatasourceKeys.length
      ? "Some allowlisted datasources were unavailable and their analysis steps were skipped."
      : "All allowlisted datasources were resolved by exact match.",
  };
}

function createListDatasourcesGateway(): ListDatasourcesGateway {
  return {
    async listDatasources(input?: {
      authContext?: TableauDirectTrustAuthContext;
    }): Promise<ListedDatasource[]> {
      const config = getConfig();
      if (config.tableau.contextProvider === "mock") {
        return [];
      }

      const transport = await createMcpTransport(input?.authContext);
      const client = new Client({
        name: "tableau-ai-pr-agent-backend",
        version: "0.1.0",
      });

      try {
        await client.connect(transport);
        const result = await client.callTool(
          {
            name: "list-datasources",
            arguments: {},
          },
          undefined,
          { timeout: config.tableau.mcp.timeoutMs },
        );
        return parseListDatasourcesResult(result);
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    },
  };
}

async function createMcpTransport(
  authContext?: TableauDirectTrustAuthContext,
): Promise<StdioClientTransport> {
  const config = getConfig();
  const connectedApp = await getTableauConnectedAppSecrets();
  const command = resolveMcpCommand(config.tableau.mcp.command);
  const args = resolveMcpArgs(command, config.tableau.mcp.args);
  const resolvedAuthContext =
    authContext ?? resolveTableauDirectTrustAuthContext();
  const env = buildMcpEnvironment({
    tableauAuth: resolvedAuthContext,
    connectedApp,
  });

  return new StdioClientTransport({
    command,
    args,
    env,
    stderr: "pipe",
  });
}

function resolveMcpCommand(configuredCommand: string): string {
  if (configuredCommand.trim()) {
    return configuredCommand;
  }
  return process.execPath;
}

function resolveMcpArgs(command: string, configuredArgs: string[]): string[] {
  if (configuredArgs.length) {
    return configuredArgs;
  }
  if (command !== process.execPath) {
    return [];
  }
  const requireFromRuntime = createRequire(__filename);
  return [requireFromRuntime.resolve("@tableau/mcp-server")];
}

function buildMcpEnvironment(input: {
  tableauAuth: TableauDirectTrustAuthContext;
  connectedApp: { clientId: string; secretId: string; secretValue: string };
}): Record<string, string> {
  const config = getConfig();
  return compactEnv({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    SERVER: config.tableau.serverUrl,
    SITE_NAME: config.tableau.siteContentUrl,
    TRANSPORT: "stdio",
    AUTH: config.tableau.mcp.authMode || "direct-trust",
    JWT_SUB_CLAIM: input.tableauAuth.subject,
    CONNECTED_APP_CLIENT_ID: input.connectedApp.clientId,
    CONNECTED_APP_SECRET_ID: input.connectedApp.secretId,
    CONNECTED_APP_SECRET_VALUE: input.connectedApp.secretValue,
    DISABLE_LOG_MASKING: "false",
    PRODUCT_TELEMETRY_ENABLED: "false",
    TELEMETRY_PROVIDER: "noop",
  });
}

function compactEnv(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

function parseListDatasourcesResult(result: unknown): ListedDatasource[] {
  if (isRecord(result) && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (isRecord(item) && typeof item.text === "string") {
        const parsed = tryParseJson(item.text);
        const extracted = extractListedDatasources(parsed);
        if (extracted.length) {
          return extracted;
        }
      }
    }
  }

  return extractListedDatasources(result);
}

function extractListedDatasources(value: unknown): ListedDatasource[] {
  const list: unknown[] = [];
  if (Array.isArray(value)) {
    list.push(...value);
  } else if (isRecord(value)) {
    for (const key of [
      "datasources",
      "dataSources",
      "items",
      "results",
      "data",
    ]) {
      const candidate = value[key];
      if (Array.isArray(candidate)) {
        list.push(...candidate);
      }
    }
  }

  return list.filter(isRecord).map((entry) => ({
    name:
      typeof entry.name === "string"
        ? entry.name
        : typeof entry.caption === "string"
          ? entry.caption
          : undefined,
    luid:
      typeof entry.luid === "string"
        ? entry.luid
        : typeof entry.id === "string"
          ? entry.id
          : undefined,
    id: typeof entry.id === "string" ? entry.id : undefined,
    contentUrl:
      typeof entry.contentUrl === "string" ? entry.contentUrl : undefined,
    projectName:
      typeof entry.projectName === "string" ? entry.projectName : undefined,
    workbookName:
      typeof entry.workbookName === "string" ? entry.workbookName : undefined,
  }));
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function buildContextSummary(
  additionalContext: TableauAdditionalContext,
): string {
  const insight = additionalContext.queryInsights?.[0];
  const label = insight?.rows?.[0]?.label?.trim();
  const metricField = insight?.metricField?.trim();
  const dimensionField = insight?.dimensionField?.trim();
  return [
    label ? `top item: ${label}` : undefined,
    metricField ? `metric: ${metricField}` : undefined,
    dimensionField ? `dimension: ${dimensionField}` : undefined,
    ...(additionalContext.warnings ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" / ");
}

function sliceOrFallback(
  values: string[],
  start: number,
  length: number,
  fallback: string[],
): string[] {
  const sliced = values.slice(start, start + length).filter(Boolean);
  return uniqueStrings(sliced.length ? sliced : fallback).slice(0, length);
}

function extractKeywords(value: string): string[] {
  return value
    .split(/[\s\u3000、。・,.;:\/()［］\[\]{}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .map((token) => token.replace(/[^\p{L}\p{N}ぁ-んァ-ヶー]/gu, ""))
    .filter((token) => token.length >= 2);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalize(value?: string): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[_-]/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
