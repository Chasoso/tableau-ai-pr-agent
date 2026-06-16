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
import { ActionRunInputImageService } from "./actionRunInputImageService";
import type { AuthenticatedUser } from "../types/auth";
import {
  buildTableauDirectTrustAuthLog,
  resolveTableauDirectTrustAuthContext,
  type TableauDirectTrustAuthContext,
} from "../tableau/tableauDirectTrustAuth";
import type { ClassifiedQuestionIntent } from "../services/tableauMcpToolPlanner";
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
  sourceStatus: "queried" | "metadata_only" | "skipped" | "failed";
  datasourceKey: string;
  keyExpectations: string[];
  keyInterests: string[];
  concernsOrQuestions: string[];
  suggestedAngles: string[];
  keyFindings?: string[];
  evidenceRows?: unknown[];
  skippedReason?: string;
  failedReason?: string;
  evidenceSummary: string;
};

export type PostPerformanceInsight = {
  available: boolean;
  sourceStatus: "queried" | "metadata_only" | "skipped" | "failed";
  datasourceKey: string;
  highPerformingThemes: string[];
  highPerformingPatterns: string[];
  recommendedTone: string[];
  recommendedStructure: string[];
  avoidPatterns: string[];
  keyFindings?: string[];
  evidenceRows?: unknown[];
  skippedReason?: string;
  failedReason?: string;
  evidenceSummary: string;
};

export type AccountOverviewInsight = {
  available: boolean;
  sourceStatus: "queried" | "metadata_only" | "skipped" | "failed";
  datasourceKey: string;
  recentTrendSummary: string;
  notableChanges: string[];
  timingHints: string[];
  accountContextForPost: string;
  keyFindings?: string[];
  evidenceRows?: unknown[];
  skippedReason?: string;
  failedReason?: string;
  evidenceSummary: string;
};

export type PostGenerationEvidencePack = {
  photoContext: {
    available: boolean;
    source: "actual_image" | "missing_image" | "fallback";
    summary?: string;
    detectedTopics?: string[];
    visibleText?: string[];
    suggestedPostAngles?: string[];
    observedItems?: string[];
    sceneInference?: string;
    eventFeel?: string;
    postableElements?: string[];
    subjectCandidates?: string[];
    ocrText?: string;
    skippedReason?: string;
  };
  surveyInsight: SurveyInsight;
  postPerformanceInsight: PostPerformanceInsight;
  accountOverviewInsight: AccountOverviewInsight;
  canGeneratePost: boolean;
  generationBlockers: string[];
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
    photoContextSource: "actual_image" | "fallback" | "missing_image";
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
    contentType?: string;
    bytes: Uint8Array;
  }): Promise<
    Partial<
      Omit<
        PostGenerationEvidencePack["photoContext"],
        "available" | "source" | "skippedReason"
      >
    > | undefined
  >;
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
    private readonly inputImageService: ActionRunInputImageService = new ActionRunInputImageService(),
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
    const photoContextResult = await buildPhotoContext(
      input.request,
      this.photoVisionAnalyzer,
      this.inputImageService,
    );
    const photoContext = photoContextResult.photoContext;
    logInfo("tableau.photo_post.photoContextGenerated", {
      photoContextGenerated: photoContextResult.generated,
      photoContextSource: photoContext.source,
      ...(photoContextResult.generated
        ? { photoTopicCount: photoContext.detectedTopics?.length ?? 0 }
        : {}),
      photoContextSkippedReason: photoContextResult.skippedReason,
      visibleTextCount: photoContext.visibleText?.length ?? 0,
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

    const analysis = await runPhotoPostTableauAnalysis({
      request: input.request,
      authenticatedUser: input.authenticatedUser,
      authContext,
      resolvedDatasources: datasourceResolution.resolvedDatasources,
      photoContext,
      tableauContextProvider: this.tableauContextProvider,
    });
    const surveyInsight = analysis.surveyInsight;
    const postPerformanceInsight = analysis.postPerformanceInsight;
    const accountOverviewInsight = analysis.accountOverviewInsight;

    const evidencePack: PostGenerationEvidencePack = {
      photoContext,
      surveyInsight,
      postPerformanceInsight,
      accountOverviewInsight,
      canGeneratePost: analysis.canGeneratePost,
      generationBlockers: analysis.generationBlockers,
    };

    const analysisSections = buildAnalysisSections({
      photoContext,
      surveyInsight,
      postPerformanceInsight,
      accountOverviewInsight,
    });
    const evidencePackGenerated =
      photoContext.available &&
      photoContext.source === "actual_image" &&
      analysis.canGeneratePost;

    logInfo("tableau.photo_post.evidencePackGenerated", {
      evidencePackGenerated,
      analysisSectionCount: analysisSections.length,
      resolvedDatasourceKeys: datasourceResolution.resolvedDatasourceKeys,
      photoContextSource: photoContext.source,
      canGeneratePost: analysis.canGeneratePost,
      generationBlockers: analysis.generationBlockers,
    });

    return {
      photoContext,
      surveyInsight,
      postPerformanceInsight,
      accountOverviewInsight,
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
        photoContextGenerated: photoContext.available,
        photoContextSource: photoContext.source,
        surveyInsightStatus: surveyInsight.available
          ? "available"
          : surveyInsight.failedReason
            ? "failed"
            : "skipped",
        postPerformanceInsightStatus: postPerformanceInsight.available
          ? "available"
          : postPerformanceInsight.failedReason
            ? "failed"
            : "skipped",
        accountOverviewInsightStatus: accountOverviewInsight.available
          ? "available"
          : accountOverviewInsight.failedReason
            ? "failed"
            : "skipped",
        evidencePackGenerated,
      },
    };
  }
}

async function runPhotoPostTableauAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  resolvedDatasources: ResolvedAllowedDatasource[];
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<{
  surveyInsight: SurveyInsight;
  postPerformanceInsight: PostPerformanceInsight;
  accountOverviewInsight: AccountOverviewInsight;
  canGeneratePost: boolean;
  generationBlockers: string[];
}> {
  const surveyInsight = await runPurposeAnalysis({
    request: input.request,
    authenticatedUser: input.authenticatedUser,
    authContext: input.authContext,
    purpose: "survey_insight",
    datasource:
      input.resolvedDatasources.find(
        (item) => item.allowed.purpose === "survey_insight",
      ) ?? undefined,
    photoContext: input.photoContext,
    tableauContextProvider: input.tableauContextProvider,
  });
  const postPerformanceInsight = await runPurposeAnalysis({
    request: input.request,
    authenticatedUser: input.authenticatedUser,
    authContext: input.authContext,
    purpose: "post_performance",
    datasource:
      input.resolvedDatasources.find(
        (item) => item.allowed.purpose === "post_performance",
      ) ?? undefined,
    photoContext: input.photoContext,
    tableauContextProvider: input.tableauContextProvider,
  });
  const accountOverviewInsight = await runPurposeAnalysis({
    request: input.request,
    authenticatedUser: input.authenticatedUser,
    authContext: input.authContext,
    purpose: "account_overview",
    datasource:
      input.resolvedDatasources.find(
        (item) => item.allowed.purpose === "account_overview",
      ) ?? undefined,
    photoContext: input.photoContext,
    tableauContextProvider: input.tableauContextProvider,
  });

  const availableInsightCount = [
    surveyInsight.available,
    postPerformanceInsight.available,
    accountOverviewInsight.available,
  ].filter(Boolean).length;
  const generationBlockers = [
    ...(input.photoContext.available ? [] : ["input_image_not_found"]),
    ...(availableInsightCount === 0 ? ["tableau_analysis_unavailable"] : []),
  ];

  return {
    surveyInsight,
    postPerformanceInsight,
    accountOverviewInsight,
    canGeneratePost: generationBlockers.length === 0,
    generationBlockers,
  };
}

async function runPurposeAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  purpose: "survey_insight";
  datasource?: ResolvedAllowedDatasource;
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<SurveyInsight>;
async function runPurposeAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  purpose: "post_performance";
  datasource?: ResolvedAllowedDatasource;
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<PostPerformanceInsight>;
async function runPurposeAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  purpose: "account_overview";
  datasource?: ResolvedAllowedDatasource;
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<AccountOverviewInsight>;
async function runPurposeAnalysis(input: {
  request: ActionRunRequest;
  authenticatedUser?: AuthenticatedUser;
  authContext: TableauDirectTrustAuthContext;
  purpose: AllowedDatasource["purpose"];
  datasource?: ResolvedAllowedDatasource;
  photoContext: PostGenerationEvidencePack["photoContext"];
  tableauContextProvider: TableauContextProvider;
}): Promise<
  SurveyInsight | PostPerformanceInsight | AccountOverviewInsight
> {
  if (!input.datasource) {
    logInfo("tableau.photo_post.skippedInsightReason", {
      purpose: input.purpose,
      skippedInsightReason: "allowed datasource could not be resolved",
    });
    return buildUnavailableInsight(
      input.purpose,
      "missing_datasource",
      "allowed datasource could not be resolved",
      "skipped",
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
      "missing_subject",
      "no Tableau subject available for MCP analysis",
      "skipped",
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
        intentHint: buildFixedPhotoPostIntent(),
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
      "query_failed",
      "Tableau analysis failed for this purpose.",
      "failed",
    );
  }
}

function buildFixedPhotoPostIntent(): ClassifiedQuestionIntent {
  return {
    intent: "data_analysis",
    confidence: 1,
    reasonBrief: "Photo post generation always runs fixed Tableau analysis.",
    answerableFromDashboardContext: false,
    needsMcp: true,
    maxToolCalls: 4,
  };
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
      sourceStatus: "queried",
      datasourceKey: "mcp_session_survey_responses",
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
        ...(photoContext.suggestedPostAngles ?? []),
        ...topLabels.slice(0, 2),
        "Address what people care about first",
      ]).slice(0, 5),
      keyFindings: topLabels,
      evidenceRows: rows,
      evidenceSummary,
    };
  }

  if (purpose === "post_performance") {
    return {
      available: true,
      sourceStatus: "queried",
      datasourceKey: "x_account_analytics_contents",
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
        "Open with the most relevant observation",
        "Add one useful detail",
        "Finish with a minimal set of hashtags",
      ],
      avoidPatterns: [
        "forced numbers",
        "too much hype",
        "irrelevant long text",
      ],
      keyFindings: topLabels,
      evidenceRows: rows,
      evidenceSummary,
    };
  }

  return {
    available: true,
    sourceStatus: "queried",
    datasourceKey: "x_account_overview_analytics",
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
    keyFindings: topLabels,
    evidenceRows: rows,
    evidenceSummary,
  };
}

function buildUnavailableInsight(
  purpose: AllowedDatasource["purpose"],
  datasourceKey: string,
  reason: string,
  status: "skipped" | "failed" = "skipped",
): SurveyInsight | PostPerformanceInsight | AccountOverviewInsight {
  if (purpose === "survey_insight") {
    return {
      available: false,
      sourceStatus: status,
      datasourceKey,
      keyExpectations: [],
      keyInterests: [],
      concernsOrQuestions: [],
      suggestedAngles: [],
      keyFindings: [],
      evidenceRows: [],
      ...(status === "failed"
        ? { failedReason: reason }
        : { skippedReason: reason }),
      evidenceSummary: reason,
    };
  }

  if (purpose === "post_performance") {
    return {
      available: false,
      sourceStatus: status,
      datasourceKey,
      highPerformingThemes: [],
      highPerformingPatterns: [],
      recommendedTone: [],
      recommendedStructure: [],
      avoidPatterns: [],
      keyFindings: [],
      evidenceRows: [],
      ...(status === "failed"
        ? { failedReason: reason }
        : { skippedReason: reason }),
      evidenceSummary: reason,
    };
  }

  return {
    available: false,
    sourceStatus: status,
    datasourceKey,
    recentTrendSummary: reason,
    notableChanges: [],
    timingHints: [],
    accountContextForPost: reason,
    keyFindings: [],
    evidenceRows: [],
    ...(status === "failed"
      ? { failedReason: reason }
      : { skippedReason: reason }),
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
      summary: input.photoContext.summary ?? "Photo context was not available.",
      sourceStatus:
        input.photoContext.source === "actual_image"
          ? "image_queried"
          : input.photoContext.source === "fallback"
            ? "failed"
            : "skipped",
      skippedReason:
        input.photoContext.source === "missing_image"
          ? "No input image was available."
          : undefined,
      rows: (input.photoContext.detectedTopics ?? []).map((topic) => ({
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
      sourceStatus:
        input.surveyInsight?.sourceStatus === "queried"
          ? "tableau_queried"
          : input.surveyInsight?.sourceStatus ?? "skipped",
      skippedReason: input.surveyInsight?.available
        ? undefined
        : input.surveyInsight?.skippedReason ?? input.surveyInsight?.evidenceSummary,
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
      sourceStatus:
        input.postPerformanceInsight?.sourceStatus === "queried"
          ? "tableau_queried"
          : input.postPerformanceInsight?.sourceStatus ?? "skipped",
      skippedReason: input.postPerformanceInsight?.available
        ? undefined
        : input.postPerformanceInsight?.skippedReason ??
          input.postPerformanceInsight?.evidenceSummary,
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
      sourceStatus:
        input.accountOverviewInsight?.sourceStatus === "queried"
          ? "tableau_queried"
          : input.accountOverviewInsight?.sourceStatus ?? "skipped",
      skippedReason: input.accountOverviewInsight?.available
        ? undefined
        : input.accountOverviewInsight?.skippedReason ??
          input.accountOverviewInsight?.evidenceSummary,
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
      sourceStatus: "metadata_only",
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
  inputImageService: ActionRunInputImageService,
): Promise<{
  photoContext: PostGenerationEvidencePack["photoContext"];
  generated: boolean;
  skippedReason?: string;
}> {
  const photo = request.clientContext?.photo;
  if (!photo || photo.mode === "none") {
    return {
      photoContext: buildHeuristicPhotoContext(request, "missing_image"),
      generated: false,
      skippedReason: "missing_image",
    };
  }

  logInfo("tableau.photo_post.inputImageFetchStarted", {
    inputImageObjectKeyPresent: Boolean(photo.objectKey),
    inputImageObjectKey: photo.objectKey ?? undefined,
    inputImageContentType: photo.contentType ?? photo.mimeType ?? undefined,
    inputImageBytes: photo.byteLength ?? undefined,
    inputImageWidth: photo.width ?? undefined,
    inputImageHeight: photo.height ?? undefined,
  });

  const fetchedImage = photo.objectKey
    ? await inputImageService.fetchActionRunInputImage({
        objectKey: photo.objectKey,
      })
    : null;

  if (fetchedImage) {
    logInfo("tableau.photo_post.inputImageFetchCompleted", {
      inputImageObjectKeyPresent: true,
      inputImageBytes: fetchedImage.byteLength,
      inputImageContentType: fetchedImage.contentType,
      inputImageWidth: photo.width ?? undefined,
      inputImageHeight: photo.height ?? undefined,
    });
  }

  const imageBytes =
    fetchedImage?.bytes ??
    (photo.dataUrl ? parseDataUrl(photo.dataUrl)?.bytes : undefined);
  const imageContentType =
    fetchedImage?.contentType ??
    photo.contentType ??
    photo.mimeType ??
    undefined;

  if (!imageBytes || !imageContentType) {
    logInfo("tableau.photo_post.imageAnalysisCompleted", {
      imageAnalysisProvider: "bedrock",
      imageAnalysisModel: getConfig().model.bedrock.modelId,
      imageAnalysisSuccess: false,
      photoContextSource: "fallback",
      photoContextSkippedReason: fetchedImage
        ? "input image could not be decoded"
        : "input image was not available",
    });
    return {
      photoContext: buildHeuristicPhotoContext(request, "fallback"),
      generated: false,
      skippedReason: fetchedImage
        ? "input image could not be decoded"
        : "input image was not available",
    };
  }

  logInfo("tableau.photo_post.imageAnalysisStarted", {
    imageAnalysisProvider: "bedrock",
    imageAnalysisModel: getConfig().model.bedrock.modelId,
    inputImageBytes: imageBytes.length,
    inputImageContentType: imageContentType,
    inputImageObjectKeyPresent: Boolean(photo.objectKey),
    inputImageWidth: photo.width ?? undefined,
    inputImageHeight: photo.height ?? undefined,
  });

  const vision = await visionAnalyzer.analyze({
    currentSituation: request.currentSituation,
    fileName: photo.fileName,
    contentType: imageContentType,
    bytes: imageBytes,
  });

  if (!vision) {
    logInfo("tableau.photo_post.imageAnalysisCompleted", {
      imageAnalysisProvider: "bedrock",
      imageAnalysisModel: getConfig().model.bedrock.modelId,
      imageAnalysisSuccess: false,
      photoContextSource: "fallback",
      photoContextSkippedReason: "vision analysis returned no usable output",
    });
    return {
      photoContext: buildHeuristicPhotoContext(request, "fallback"),
      generated: false,
      skippedReason: "vision analysis returned no usable output",
    };
  }

  const heuristic = buildHeuristicPhotoContext(request, "actual_image");
  const detectedTopics = uniqueStrings([
    ...(vision.detectedTopics ?? []),
    ...(heuristic.detectedTopics ?? []),
  ]).slice(0, 8);
  const suggestedPostAngles = uniqueStrings([
    ...(vision.suggestedPostAngles ?? []),
    ...(heuristic.suggestedPostAngles ?? []),
  ]).slice(0, 6);

  logInfo("tableau.photo_post.imageAnalysisCompleted", {
    imageAnalysisProvider: "bedrock",
    imageAnalysisModel: getConfig().model.bedrock.modelId,
    imageAnalysisSuccess: true,
    photoContextSource: "actual_image",
    photoTopicCount: detectedTopics.length,
    inputImageWidth: photo.width ?? undefined,
    inputImageHeight: photo.height ?? undefined,
  });

  return {
    photoContext: {
      ...heuristic,
      ...vision,
      available: true,
      source: "actual_image",
      summary: buildVisionSummary({
        currentSituation: request.currentSituation,
        vision,
        heuristic,
        fileName: photo.fileName,
        sizeLabel: photo.sizeLabel,
      }),
      detectedTopics,
      suggestedPostAngles,
      visibleText: uniqueStrings([
        vision.ocrText ?? "",
        ...(vision.visibleText ?? []),
      ]).filter(Boolean),
    },
    generated: true,
  };
}

function buildHeuristicPhotoContext(
  request: ActionRunRequest,
  source: PostGenerationEvidencePack["photoContext"]["source"],
): PostGenerationEvidencePack["photoContext"] {
  const photo = request.clientContext?.photo;
  const summary = [
    source === "missing_image" ? "No input image was available." : undefined,
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
    source === "missing_image"
      ? "explain that the image evidence is missing"
      : "highlight the overall atmosphere",
    source === "missing_image"
      ? "lean on event metadata instead"
      : "lean into participant expectations",
    source === "missing_image"
      ? "avoid claiming visual details"
      : "add one sentence about what the photo shows",
    source === "missing_image"
      ? "note the missing image explicitly"
      : "keep the tone light",
    ...detectedTopics.map((topic) => `mention ${topic} naturally`),
  ]).slice(0, 5);

  return {
    available: source === "actual_image",
    source,
    summary,
    detectedTopics,
    suggestedPostAngles,
    visibleText:
      photo?.dataUrl && source !== "missing_image" ? [photo.fileName ?? ""] : [],
    skippedReason: source === "missing_image" ? "input_image_not_found" : undefined,
  };
}

function buildVisionSummary(input: {
  currentSituation?: string;
  vision?: Partial<PostGenerationEvidencePack["photoContext"]>;
  heuristic: PostGenerationEvidencePack["photoContext"];
  fileName?: string;
  sizeLabel?: string;
}): string {
  const segments: string[] = [];
  const currentSituation = input.currentSituation?.trim();
  const fileName = input.fileName?.trim();
  const sizeLabel = input.sizeLabel?.trim();
  const sceneInference = input.vision?.sceneInference?.trim();
  const eventFeel = input.vision?.eventFeel?.trim();
  const ocrText = input.vision?.ocrText?.trim();
  const heuristicSummary = input.heuristic.summary?.trim();

  if (currentSituation) {
    segments.push(currentSituation);
  }
  if (fileName) {
    segments.push(`Image: ${fileName}`);
  }
  if (sizeLabel) {
    segments.push(`Size: ${sizeLabel}`);
  }
  if (sceneInference) {
    segments.push(sceneInference);
  }
  if (eventFeel) {
    segments.push(eventFeel);
  }
  if (ocrText) {
    segments.push(`ocr: ${ocrText}`);
  }
  if (heuristicSummary) {
    segments.push(heuristicSummary);
  }

  return uniqueStrings(segments).join(" / ");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const parsed = tryParseJson(text);
  return isRecord(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = value
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);

  return result.length ? result : undefined;
}

function parseDataUrl(
  dataUrl: string,
): { contentType: string; bytes: Uint8Array } | undefined {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    return undefined;
  }

  const contentType = match[1].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    return undefined;
  }

  return {
    contentType,
    bytes: Uint8Array.from(Buffer.from(match[2], "base64")),
  };
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
      contentType?: string;
      bytes: Uint8Array;
    }): Promise<
      Partial<PostGenerationEvidencePack["photoContext"]> | undefined
    > {
      const format = resolveBedrockImageFormat(input.contentType);
      if (!format) {
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
                      format,
                      source: {
                        bytes: input.bytes,
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

function resolveBedrockImageFormat(
  contentType?: string,
): "png" | "jpeg" | "webp" | "gif" | undefined {
  const normalized = contentType?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "image/png") {
    return "png";
  }

  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "jpeg";
  }

  if (normalized === "image/webp") {
    return "webp";
  }

  if (normalized === "image/gif") {
    return "gif";
  }

  return undefined;
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
  resolvedDatasources: ResolvedAllowedDatasource[];
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
    resolvedDatasources: [...matched.values()],
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
    .split(/[\s\u3000縲√ゅ・,.;:\/()・ｻ・ｽ\[\]{}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .map((token) => token.replace(/[^\p{L}\p{N}縺・繧薙ぃ-繝ｶ繝ｼ]/gu, ""))
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
