import { createRequire } from "node:module";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getTableauConnectedAppSecrets } from "../aws/secrets";
import { getConfig } from "../config";
import { logDebug, logInfo, logWarn, safeErrorDetails } from "../logging";
import { ActionRunInputImageService } from "./actionRunInputImageService";
import type { AuthenticatedUser } from "../types/auth";
import {
  buildTableauDirectTrustAuthLog,
  resolveTableauDirectTrustAuthContext,
  type TableauDirectTrustAuthContext,
} from "../tableau/tableauDirectTrustAuth";
import { interpretQuestion } from "./questionInterpretation";
import type { ClassifiedQuestionIntent } from "../services/tableauMcpToolPlanner";
import type {
  ActionRunAnalysisSection,
  ActionRunRequest,
} from "../types/actionRun";
import type {
  DatasourceFieldProfile,
  DashboardContext,
  QuestionAnalysisIntent,
  QuestionGroupingIntent,
  QuestionInterpretation,
  QuestionMetricIntent,
  QuestionRankingTarget,
  TableauAdditionalContext,
} from "../types/tableau";
import type { TableauContextProvider } from "../tableau/contextProvider";
import type { QuestionPeriod } from "../utils/questionPeriod";

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
  datasourceName?: string;
  queryRowCount: number;
  warnings: string[];
  unknownFields?: string[];
  queryErrorCategory?: string;
  queryErrorMessage?: string;
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
  datasourceName?: string;
  queryRowCount: number;
  warnings: string[];
  unknownFields?: string[];
  queryErrorCategory?: string;
  queryErrorMessage?: string;
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
  datasourceName?: string;
  queryRowCount: number;
  warnings: string[];
  unknownFields?: string[];
  queryErrorCategory?: string;
  queryErrorMessage?: string;
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

export type PhotoContextSource =
  | "actual_image"
  | "image_fetch_failed"
  | "vision_analysis_failed"
  | "vision_analysis_no_usable_output"
  | "fallback"
  | "missing_image";

export type GenerationBlocker =
  | "input_image_not_found"
  | "input_image_fetch_failed"
  | "vision_analysis_failed"
  | "vision_analysis_no_usable_output"
  | "required_photo_context_missing"
  | "tableau_analysis_unavailable";

export type PostGenerationEvidencePack = {
  photoContext: {
    available: boolean;
    source: PhotoContextSource;
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
  eventContext: {
    available: boolean;
    source:
      | "google_calendar"
      | "techplay"
      | "manual"
      | "fallback"
      | "not_found";
    eventName?: string;
    eventUrl?: string;
    eventDescription?: string;
    venue?: string;
    eventDateText?: string;
    skippedReason?: string;
  };
  surveyInsight: SurveyInsight;
  postPerformanceInsight: PostPerformanceInsight;
  accountOverviewInsight: AccountOverviewInsight;
  canGeneratePost: boolean;
  generationBlockers: GenerationBlocker[];
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
    photoContextSource: PhotoContextSource;
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
  }): Promise<PhotoVisionAnalysisOutcome>;
};

type PhotoVisionAnalysisOutcome =
  | {
      status: "success";
      source: "actual_image";
      photoContext: Partial<
        Omit<
          PostGenerationEvidencePack["photoContext"],
          "available" | "source" | "skippedReason"
        >
      >;
      rawText: string;
      responsePreview?: string;
      stopReason?: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      status: "no_usable_output";
      source: "vision_analysis_no_usable_output";
      skippedReason: string;
      rawText?: string;
      responsePreview?: string;
      stopReason?: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      status: "failed";
      source: "vision_analysis_failed" | "image_fetch_failed";
      skippedReason: string;
      error?: string;
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
    const eventContext = buildEventContext(input.request);
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
      eventContext,
      surveyInsight,
      postPerformanceInsight,
      accountOverviewInsight,
      canGeneratePost: analysis.canGeneratePost,
      generationBlockers: analysis.generationBlockers,
    };

    const analysisSections = buildAnalysisSections({
      photoContext,
      eventContext,
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
    logInfo("tableau.photo_post.evidencePackSummary", {
      photoContextAvailable: photoContext.available,
      eventContextAvailable: eventContext.available,
      surveyInsightAvailable: surveyInsight.available,
      postPerformanceInsightAvailable: postPerformanceInsight.available,
      accountOverviewInsightAvailable: accountOverviewInsight.available,
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
  generationBlockers: GenerationBlocker[];
}> {
  logInfo("tableau.photo_post.photoPostTableauAnalysisStarted", {
    photoContextSource: input.photoContext.source,
    photoContextAvailable: input.photoContext.available,
    resolvedDatasourceKeys: input.resolvedDatasources.map(
      (item) => item.allowed.key,
    ),
  });
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

  const generationBlockers = uniqueStrings([
    ...resolvePhotoContextGenerationBlockers(input.photoContext),
  ]) as GenerationBlocker[];

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
}): Promise<SurveyInsight | PostPerformanceInsight | AccountOverviewInsight> {
  logDebug("tableau.photo_post.purposeAnalysisInput", {
    purpose: input.purpose,
    datasourcePresent: Boolean(input.datasource),
    subjectPresent: Boolean(input.authContext.subject?.trim()),
    photoContextAvailable: input.photoContext.available,
    photoContextSource: input.photoContext.source,
  });

  if (!input.datasource) {
    logDebug("tableau.photo_post.purposeAnalysisBranch", {
      purpose: input.purpose,
      branch: "missing_datasource",
      condition: "!input.datasource",
      datasourcePresent: false,
      reason: "allowed datasource could not be resolved",
    });
    logInfo("tableau.photo_post.skippedInsightReason", {
      purpose: input.purpose,
      skippedInsightReason: "allowed datasource could not be resolved",
    });
    return buildUnavailableInsight(
      input.purpose,
      "missing_datasource",
      "missing_datasource",
      "allowed datasource could not be resolved",
      "skipped",
      0,
      ["missing_datasource"],
    );
  }

  const subject = input.authContext.subject;
  if (!subject.trim()) {
    logDebug("tableau.photo_post.purposeAnalysisBranch", {
      purpose: input.purpose,
      branch: "missing_subject",
      condition: "!subject.trim()",
      subjectPresent: Boolean(subject),
      subjectTrimmedLength: subject.trim().length,
      reason: "no Tableau subject available for MCP analysis",
    });
    logWarn("tableau.photo_post.failedInsightReason", {
      purpose: input.purpose,
      failedInsightReason: "no Tableau subject available for MCP analysis",
    });
    return buildUnavailableInsight(
      input.purpose,
      "missing_subject",
      input.datasource.source.name ?? input.datasource.allowed.name,
      "no Tableau subject available for MCP analysis",
      "skipped",
      0,
      ["missing_tableau_subject"],
    );
  }

  const datasourceName =
    input.datasource.source.name ?? input.datasource.allowed.name;
  const question = FIXED_ANALYSIS_QUESTIONS[input.purpose];
  const dashboardContext = buildScopedDashboardContext(
    input.request,
    input.datasource,
  );

  logInfo("tableau.photo_post.purposeAnalysisStarted", {
    purpose: input.purpose,
    datasourceKey: input.datasource.allowed.key,
    datasourceName,
    metadataFetchStarted: true,
  });
  logDebug("tableau.photo_post.purposeAnalysisBranch", {
    purpose: input.purpose,
    branch: "metadata_fetch",
    condition: "input.datasource && subject.trim()",
    datasourceKey: input.datasource.allowed.key,
    datasourceName,
  });

  try {
    const metadataContext =
      await input.tableauContextProvider.getAdditionalContext({
        question,
        planningQuestion: question,
        questionInterpretation: buildFixedPurposeMetadataInterpretation(
          input.purpose,
          dashboardContext,
        ),
        intentHint: buildFixedMetadataLookupIntent(),
        dashboardContext,
        authenticatedUser: input.authenticatedUser,
        tableauSubject: subject,
        tableauAuth: input.authContext,
      });

    logInfo("tableau.photo_post.metadataFetchCompleted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceName,
      metadataFetchCompleted: true,
      metadataFieldCount:
        metadataContext.datasourceFieldProfiles?.[0]?.fieldCount ?? 0,
      metadataMeasureCount: countFieldsByRole(
        metadataContext.datasourceFieldProfiles?.[0],
        "MEASURE",
      ),
      metadataDimensionCount: countFieldsByRole(
        metadataContext.datasourceFieldProfiles?.[0],
        "DIMENSION",
      ),
      metadataProfilesCount:
        metadataContext.datasourceFieldProfiles?.length ?? 0,
    });
    logDebug("tableau.photo_post.purposeAnalysisBranch", {
      purpose: input.purpose,
      branch: "field_plan_selection",
      condition: "metadataContext received",
      metadataSucceeded:
        (metadataContext.datasourceFieldProfiles?.[0]?.fieldCount ?? 0) > 0,
      metadataWarnings: metadataContext.warnings ?? [],
    });

    const fieldPlan = selectPurposeFieldPlan({
      purpose: input.purpose,
      datasourceName,
      fieldProfiles: metadataContext.datasourceFieldProfiles ?? [],
    });
    const metadataFieldDetails = pickFieldDetailsForPurpose({
      datasourceName,
      fieldProfiles: metadataContext.datasourceFieldProfiles ?? [],
    });
    const metadataFieldCaptions = uniqueStrings(
      metadataFieldDetails.map((field) => field.name),
    );
    const fieldValidation = validatePhotoPostQueryPlanFields({
      metadataFieldCaptions,
      queryFields: fieldPlan.queryFields,
      selectedMetricFields: fieldPlan.selectedMetricFields,
    });
    logInfo("tableau.photo_post.fieldSelectionStarted", {
      purpose: input.purpose,
      availableFieldCount: fieldPlan.availableFieldCount,
      candidateTextFields: fieldPlan.candidateTextFields,
      candidateDateFields: fieldPlan.candidateDateFields,
      candidateMetricFields: fieldPlan.candidateMetricFields,
    });
    logInfo("tableau.photo_post.fieldSelectionCompleted", {
      purpose: input.purpose,
      selectedTextFields: fieldPlan.selectedTextFields,
      selectedDateField: fieldPlan.selectedDateField,
      selectedMetricFields: fieldPlan.selectedMetricFields,
      metricSelectionReason: fieldPlan.metricSelectionReason,
    });
    logInfo("tableau.photo_post.photoPostMetricSelection", {
      purpose: input.purpose,
      candidateMetricFields: fieldPlan.candidateMetricFields,
      priorityMetricCandidates: buildMetricPriorityCandidateLabels(
        input.purpose,
      ),
      selectedMetricFields: fieldPlan.selectedMetricFields,
      metricSelectionReason: fieldPlan.metricSelectionReason,
      rowCountFallbackUsed: fieldPlan.rowCountFallbackUsed,
      rowCountFallbackField: fieldPlan.rowCountFallbackField,
    });

    logInfo("tableau.photo_post.queryPlanBuilt", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceName,
      queryPlanType: fieldPlan.queryPlanType,
      queryFields: fieldPlan.queryFields,
      queryFilters: fieldPlan.queryFilters,
      querySorts: fieldPlan.querySorts,
      queryLimit: fieldPlan.queryLimit,
    });
    logInfo("tableau.photo_post.photoPostQueryPlanFieldValidationStarted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      metadataFieldCount: metadataFieldCaptions.length,
      queryPlanFieldCount: fieldPlan.queryFields.length,
      queryPlanFieldCaptions: fieldPlan.queryFields
        .map((field) => readString(field.fieldCaption))
        .filter((field): field is string => Boolean(field)),
      unknownFieldCaptions: fieldValidation.unknownFieldCaptions,
      customCalculationCount: fieldValidation.customCalculationCount,
      fieldValidationPassed: fieldValidation.fieldValidationPassed,
    });

    if (!fieldValidation.fieldValidationPassed) {
      const validationSkippedReason = fieldValidation.skippedReason;
      logInfo("tableau.photo_post.queryArgsBuildStarted", {
        purpose: input.purpose,
        datasourceKey: input.datasource.allowed.key,
        queryPlanType: fieldPlan.queryPlanType,
        queryPlanFieldCount: fieldPlan.queryFields.length,
        queryPlanFields: fieldPlan.queryFields,
        queryPlanFilterCount: fieldPlan.queryFilters.length,
        queryPlanLimit: fieldPlan.queryLimit,
      });
      logInfo("tableau.photo_post.queryArgsBuildCompleted", {
        purpose: input.purpose,
        datasourceKey: input.datasource.allowed.key,
        queryArgsFieldCount: fieldPlan.queryFields.length,
        queryArgsFields: fieldPlan.queryFields,
        queryArgsFilterCount: fieldPlan.queryFilters.length,
        queryArgsLimit: fieldPlan.queryLimit,
        queryArgsDatasourceLuidPresent: Boolean(
          input.datasource.source.luid ?? input.datasource.allowed.luid ?? "",
        ),
        queryArgsBuildWarnings: validationSkippedReason
          ? [validationSkippedReason]
          : [],
      });
      logInfo("tableau.photo_post.queryToolCallPrepared", {
        purpose: input.purpose,
        datasourceKey: input.datasource.allowed.key,
        datasourceLuidPresent: Boolean(
          input.datasource.source.luid ?? input.datasource.allowed.luid ?? "",
        ),
        fieldCount: fieldPlan.queryFields.length,
        fields: fieldPlan.queryFields,
        filterCount: fieldPlan.queryFilters.length,
        filters: fieldPlan.queryFilters,
        limit: fieldPlan.queryLimit,
        willCallQueryDatasource: false,
        skipReason: validationSkippedReason,
      });
      logInfo("tableau.photo_post.queryValidationResult", {
        purpose: input.purpose,
        datasourceKey: input.datasource.allowed.key,
        datasourceName,
        queryValidationResult: "rejected",
        queryValidationRejectedReason: validationSkippedReason,
        queryRowCount: 0,
        sourceStatus: "skipped",
      });
      const unavailableInsight = buildUnavailableInsight(
        input.purpose,
        input.datasource.allowed.key,
        datasourceName,
        validationSkippedReason ?? "query_plan_validation_failed",
        "skipped",
        0,
        validationSkippedReason ? [validationSkippedReason] : [],
        {
          unknownFields: fieldValidation.unknownFieldCaptions,
        },
      );
      logInfo("tableau.photo_post.queryToolCallCompleted", {
        purpose: input.purpose,
        datasourceKey: input.datasource.allowed.key,
        queryToolCalled: false,
        querySucceeded: false,
        queryRowCount: 0,
        queryValidationRejected: true,
        queryValidationRejectedReason: validationSkippedReason,
        sourceStatus: "skipped",
        insightSectionAvailable: unavailableInsight.available,
      });
      logInfo("tableau.photo_post.insightSummaryStarted", {
        purpose: input.purpose,
        rowCount: 0,
        summaryPromptChars: JSON.stringify({
          purpose: input.purpose,
          datasourceKey: input.datasource.allowed.key,
          datasourceName,
          fieldPlan,
          metadataFieldCount: metadataFieldCaptions.length,
        }).length,
      });
      logInfo("tableau.photo_post.insightSummaryCompleted", {
        purpose: input.purpose,
        rowCount: 0,
        summaryCompleted: true,
        summaryTextLength:
          (unavailableInsight as { evidenceSummary?: string }).evidenceSummary
            ?.length ?? 0,
        keyFindingCount: 0,
      });
      logInfo("tableau.photo_post.purposeAnalysisCompleted", {
        purpose: input.purpose,
        datasourceKey: input.datasource.allowed.key,
        datasourceName,
        metadataFetchCompleted: true,
        queryPlanType: fieldPlan.queryPlanType,
        queryRowCount: 0,
        sourceStatus: unavailableInsight.sourceStatus,
        insightSectionAvailable: unavailableInsight.available,
        skippedReason: unavailableInsight.skippedReason,
        failedReason: unavailableInsight.failedReason,
      });
      return unavailableInsight;
    }

    const queryInterpretation = buildFixedPurposeQueryInterpretation({
      purpose: input.purpose,
      dashboardContext,
      fieldPlan,
    });

    const queryArgsPreview = buildPhotoPostQueryArgsPreview({
      datasourceLuid:
        input.datasource.source.luid ?? input.datasource.allowed.luid ?? "",
      fieldPlan,
      validationSkippedReason: fieldValidation.skippedReason,
      fieldValidationPassed: fieldValidation.fieldValidationPassed,
    });
    const directQueryStartedAt = Date.now();
    logInfo("tableau.photo_post.queryArgsBuildStarted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      queryPlanType: fieldPlan.queryPlanType,
      queryPlanFieldCount: fieldPlan.queryFields.length,
      queryPlanFields: fieldPlan.queryFields,
      queryPlanFilterCount: fieldPlan.queryFilters.length,
      queryPlanLimit: fieldPlan.queryLimit,
    });
    logInfo("tableau.photo_post.queryArgsBuildCompleted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      queryArgsFieldCount: queryArgsPreview.queryArgsFieldCount,
      queryArgsFields: queryArgsPreview.queryArgsFields,
      queryArgsFilterCount: queryArgsPreview.queryArgsFilterCount,
      queryArgsLimit: queryArgsPreview.queryArgsLimit,
      queryArgsDatasourceLuidPresent:
        queryArgsPreview.queryArgsDatasourceLuidPresent,
      queryArgsBuildWarnings: queryArgsPreview.queryArgsBuildWarnings,
    });
    logInfo("tableau.photo_post.photoPostDirectQueryToolCallStarted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceLuidPresent: queryArgsPreview.queryArgsDatasourceLuidPresent,
      fieldCount: queryArgsPreview.queryArgsFieldCount,
      fields: queryArgsPreview.queryArgsFields,
      filterCount: queryArgsPreview.queryArgsFilterCount,
      filters: queryArgsPreview.queryArgsFilters,
      sortCount: fieldPlan.querySorts.length,
      sorts: fieldPlan.querySorts,
      limit: queryArgsPreview.queryArgsLimit,
      plannerBypassed: true,
    });
    logInfo("tableau.photo_post.queryToolCallPrepared", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceLuidPresent: queryArgsPreview.queryArgsDatasourceLuidPresent,
      fieldCount: queryArgsPreview.queryArgsFieldCount,
      fields: queryArgsPreview.queryArgsFields,
      filterCount: queryArgsPreview.queryArgsFilterCount,
      filters: queryArgsPreview.queryArgsFilters,
      limit: queryArgsPreview.queryArgsLimit,
      willCallQueryDatasource: queryArgsPreview.willCallQueryDatasource,
      skipReason: queryArgsPreview.skipReason,
    });

    logInfo("tableau.photo_post.queryDatasourceStarted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceName,
      queryPlanType: fieldPlan.queryPlanType,
      queryPlanBuilt: true,
      queryLimit: fieldPlan.queryLimit,
    });

    const additionalContext =
      await input.tableauContextProvider.getAdditionalContext({
        question,
        planningQuestion: question,
        questionInterpretation: queryInterpretation,
        intentHint: buildFixedPhotoPostIntent(),
        dashboardContext,
        authenticatedUser: input.authenticatedUser,
        tableauSubject: subject,
        tableauAuth: input.authContext,
      });

    const queryToolResult = additionalContext.mcpToolResults?.find(
      (toolResult) => toolResult.toolName === "query-datasource",
    );
    const queryInsight = additionalContext.queryInsights?.[0];
    const queryRowCount = queryInsight?.rows?.length ?? 0;
    const querySucceeded = queryToolResult?.status === "success";
    logInfo("tableau.photo_post.photoPostDirectQueryToolCallCompleted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      toolName: "query-datasource",
      queryToolCalled: Boolean(queryToolResult),
      querySucceeded,
      queryRowCount,
      queryErrorCategory: queryToolResult?.errorCategory,
      queryErrorMessage:
        queryToolResult?.errorMessage ?? queryToolResult?.warning,
      durationMs: Date.now() - directQueryStartedAt,
    });
    if (queryArgsPreview.willCallQueryDatasource && !queryToolResult) {
      logWarn("tableau.photo_post.photoPostUnexpectedPlannerUsage", {
        purpose: input.purpose,
        datasourceKey: input.datasource.allowed.key,
        reason: "fixed_analysis_should_bypass_planner",
      });
    }
    const metadataFieldCount =
      metadataContext.datasourceFieldProfiles?.[0]?.fieldCount ?? 0;
    const metadataSucceeded = metadataFieldCount > 0;
    const queryValidationRejected = queryToolResult?.status === "skipped";
    const queryToolCalled = Boolean(queryToolResult);
    const queryErrorCategory = queryToolResult?.errorCategory;
    const queryErrorMessage =
      queryToolResult?.errorMessage ?? queryToolResult?.warning;
    const unknownFields = uniqueStrings(
      queryErrorCategory === "resource_not_found"
        ? extractUnknownFieldsFromQueryError(queryErrorMessage)
        : [],
    );
    const queryValidationRejectedReason =
      queryToolResult?.warning ??
      (queryValidationRejected
        ? (queryArgsPreview.skipReason ?? "query_validation_rejected")
        : undefined);
    const queryFailedReason =
      queryToolResult?.status === "failed"
        ? queryErrorCategory === "resource_not_found"
          ? "query_field_not_found"
          : "query_failed"
        : undefined;
    const warnings = uniqueStrings([
      ...(metadataContext.warnings ?? []),
      ...(additionalContext.warnings ?? []),
      ...(querySucceeded && queryRowCount === 0 ? ["no_query_rows"] : []),
      ...(queryErrorCategory ? [queryErrorCategory] : []),
      ...(unknownFields.length ? unknownFields : []),
      ...(queryValidationRejected
        ? [queryValidationRejectedReason ?? "query_validation_rejected"]
        : []),
      ...queryArgsPreview.queryArgsBuildWarnings,
    ]);
    logInfo("tableau.photo_post.queryValidationResult", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceName,
      queryValidationResult: queryValidationRejected
        ? "rejected"
        : queryToolResult?.status === "failed"
          ? "failed"
          : querySucceeded
            ? "accepted"
            : "not_executed",
      queryValidationRejectedReason,
      queryRowCount,
      sourceStatus: querySucceeded
        ? "queried"
        : queryValidationRejected
          ? "skipped"
          : queryToolResult?.status === "failed"
            ? "failed"
            : metadataSucceeded
              ? "metadata_only"
              : "failed",
    });
    logInfo("tableau.photo_post.photoPostQueryErrorCaptured", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      queryErrorCategory,
      queryErrorMessage,
      unknownFields,
      failedReason: queryFailedReason,
    });
    logDebug("tableau.photo_post.purposeAnalysisBranch", {
      purpose: input.purpose,
      branch: "query_outcome",
      condition: "after query-datasource execution",
      queryToolCalled,
      querySucceeded,
      queryValidationRejected,
      queryRowCount,
      metadataSucceeded,
      sourceStatus: querySucceeded
        ? "queried"
        : queryValidationRejected
          ? "skipped"
          : queryToolResult?.status === "failed"
            ? "failed"
            : metadataSucceeded
              ? "metadata_only"
              : "failed",
      warnings,
    });
    logInfo("tableau.photo_post.queryDatasourceCompleted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceName,
      queryRowCount,
      querySucceeded,
      queryValidationRejected,
      queryErrorCategory,
      queryErrorMessage,
    });
    logInfo("tableau.photo_post.insightSummaryStarted", {
      purpose: input.purpose,
      rowCount: queryRowCount,
      summaryPromptChars: JSON.stringify({
        purpose: input.purpose,
        datasourceKey: input.datasource.allowed.key,
        datasourceName,
        fieldPlan,
        metadataFieldCount,
      }).length,
    });
    const insight = buildPurposeInsight({
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceName,
      additionalContext,
      queryRowCount,
      sourceStatus: querySucceeded
        ? "queried"
        : queryValidationRejected
          ? "skipped"
          : queryToolResult?.status === "failed"
            ? "failed"
            : metadataSucceeded
              ? "metadata_only"
              : "failed",
      warnings,
      skippedReason: queryValidationRejected
        ? (queryValidationRejectedReason ?? "query_validation_rejected")
        : querySucceeded
          ? queryRowCount > 0
            ? undefined
            : "no_query_rows"
          : queryToolResult?.status === "failed"
            ? queryFailedReason
            : metadataSucceeded
              ? (queryArgsPreview.skipReason ?? "query_tool_not_called")
              : "metadata_fetch_failed",
      failedReason:
        queryToolResult?.status === "failed"
          ? queryFailedReason
          : !metadataSucceeded && !querySucceeded && !queryValidationRejected
            ? "metadata_fetch_failed"
            : undefined,
      unknownFields,
      queryErrorCategory,
      queryErrorMessage,
    });
    logInfo("tableau.photo_post.queryToolCallCompleted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      queryToolCalled,
      querySucceeded,
      queryRowCount,
      queryErrorCategory,
      queryErrorMessage,
      unknownFields,
      failedReason: queryFailedReason,
      queryValidationRejected,
      queryValidationRejectedReason,
      sourceStatus: querySucceeded
        ? "queried"
        : queryValidationRejected
          ? "skipped"
          : queryToolResult?.status === "failed"
            ? "failed"
            : metadataSucceeded
              ? "metadata_only"
              : "failed",
      insightSectionAvailable: insight.available,
    });
    logDebug("tableau.photo_post.purposeAnalysisBranch", {
      purpose: input.purpose,
      branch: "insight_build",
      condition: "queryRowCount / sourceStatus",
      queryRowCount,
      sourceStatus: insight.sourceStatus,
      insightAvailable: insight.available,
      skippedReason: insight.skippedReason,
      failedReason: insight.failedReason,
    });
    logInfo("tableau.photo_post.insightSummaryCompleted", {
      purpose: input.purpose,
      rowCount: queryRowCount,
      summaryCompleted: true,
      summaryTextLength:
        (insight as { evidenceSummary?: string }).evidenceSummary?.length ?? 0,
      keyFindingCount: (insight.keyFindings ?? []).length,
    });
    logInfo("tableau.photo_post.purposeAnalysisCompleted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceName,
      metadataFetchCompleted: metadataSucceeded,
      queryPlanType: fieldPlan.queryPlanType,
      queryRowCount,
      sourceStatus: insight.sourceStatus,
      insightSectionAvailable: insight.available,
      skippedReason: insight.skippedReason,
      failedReason: insight.failedReason,
    });
    return insight;
  } catch (error) {
    const errorDetails = safeErrorDetails(error);
    logDebug("tableau.photo_post.purposeAnalysisBranch", {
      purpose: input.purpose,
      branch: "query_exception",
      condition: "catch(error)",
      errorName: errorDetails.errorName,
      errorMessage: errorDetails.errorMessage,
    });
    logWarn("tableau.photo_post.failedInsightReason", {
      purpose: input.purpose,
      failedInsightReason: errorDetails,
    });
    logInfo("tableau.photo_post.purposeAnalysisCompleted", {
      purpose: input.purpose,
      datasourceKey: input.datasource.allowed.key,
      datasourceName:
        input.datasource.source.name ?? input.datasource.allowed.name,
      queryToolCalled: true,
      queryRowCount: 0,
      sourceStatus: "failed",
    });
    return buildUnavailableInsight(
      input.purpose,
      "query_failed",
      datasourceName,
      "Tableau analysis failed for this purpose.",
      "failed",
      0,
      [
        errorDetails.errorMessage?.toString() ??
          errorDetails.errorName?.toString() ??
          "query_failed",
      ],
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

function buildPhotoPostQueryArgsPreview(input: {
  datasourceLuid: string;
  fieldPlan: PurposeFieldPlan;
  fieldValidationPassed: boolean;
  validationSkippedReason?: string;
}): {
  queryArgsDatasourceLuidPresent: boolean;
  queryArgsFieldCount: number;
  queryArgsFields: Array<Record<string, unknown>>;
  queryArgsFilterCount: number;
  queryArgsFilters: Array<Record<string, unknown>>;
  queryArgsLimit: number;
  queryArgsHasAggregateField: boolean;
  queryArgsBuildWarnings: string[];
  willCallQueryDatasource: boolean;
  skipReason?: string;
} {
  const queryArgsFields = input.fieldPlan.queryFields.filter(
    (field): field is Record<string, unknown> =>
      Boolean(field) && typeof field === "object" && !Array.isArray(field),
  );
  const queryArgsFilters = input.fieldPlan.queryFilters.filter(
    (filter): filter is Record<string, unknown> =>
      Boolean(filter) && typeof filter === "object" && !Array.isArray(filter),
  );
  const queryArgsDatasourceLuidPresent = Boolean(input.datasourceLuid.trim());
  const queryArgsBuildWarnings: string[] = [];
  if (!queryArgsDatasourceLuidPresent) {
    queryArgsBuildWarnings.push("query_args_missing_datasource_luid");
  }
  if (queryArgsFields.length === 0) {
    queryArgsBuildWarnings.push("query_args_missing_fields");
  }
  const queryArgsHasAggregateField = queryArgsFields.some(
    (field) =>
      typeof field.function === "string" ||
      typeof field.calculation === "string",
  );
  if (!queryArgsHasAggregateField) {
    queryArgsBuildWarnings.push("query_args_missing_aggregate_field");
  }
  if (input.validationSkippedReason) {
    queryArgsBuildWarnings.push(input.validationSkippedReason);
  }
  return {
    queryArgsDatasourceLuidPresent,
    queryArgsFieldCount: queryArgsFields.length,
    queryArgsFields,
    queryArgsFilterCount: queryArgsFilters.length,
    queryArgsFilters,
    queryArgsLimit: input.fieldPlan.queryLimit,
    queryArgsHasAggregateField,
    queryArgsBuildWarnings,
    willCallQueryDatasource:
      input.fieldValidationPassed &&
      queryArgsDatasourceLuidPresent &&
      queryArgsFields.length > 0 &&
      queryArgsHasAggregateField,
    skipReason: input.validationSkippedReason
      ? input.validationSkippedReason
      : !queryArgsDatasourceLuidPresent
        ? "query_args_missing_datasource_luid"
        : queryArgsFields.length === 0
          ? "query_args_missing_fields"
          : !queryArgsHasAggregateField
            ? "no_suitable_metric_fields"
            : undefined,
  };
}

function buildPurposeInsight(input: {
  purpose: AllowedDatasource["purpose"];
  datasourceKey: string;
  datasourceName: string;
  additionalContext: TableauAdditionalContext;
  queryRowCount: number;
  sourceStatus: "queried" | "metadata_only" | "skipped" | "failed";
  warnings: string[];
  skippedReason?: string;
  failedReason?: string;
  unknownFields?: string[];
  queryErrorCategory?: string;
  queryErrorMessage?: string;
}): SurveyInsight | PostPerformanceInsight | AccountOverviewInsight {
  const summary = buildContextSummary(input.additionalContext);
  const rows = input.additionalContext.queryInsights?.[0]?.rows ?? [];
  const labels = rows
    .map((row) => row.label?.trim())
    .filter((value): value is string => Boolean(value));
  const topLabels = uniqueStrings(labels.slice(0, 6));
  const evidenceSummary =
    summary ||
    topLabels.join(" / ") ||
    "Tableau analysis results were not available.";

  logDebug("tableau.photo_post.insightBranch", {
    purpose: input.purpose,
    sourceStatus: input.sourceStatus,
    queryRowCount: input.queryRowCount,
    rowCount: rows.length,
    hasSummary: Boolean(summary),
    labelCount: labels.length,
  });

  if (input.queryRowCount <= 0 && input.sourceStatus === "queried") {
    logDebug("tableau.photo_post.insightBranch", {
      purpose: input.purpose,
      branch: "queried_but_empty",
      condition: "queryRowCount === 0 && sourceStatus === 'queried'",
      queryRowCount: input.queryRowCount,
      warnings: input.warnings,
    });
    return buildUnavailableInsight(
      input.purpose,
      input.datasourceKey,
      input.datasourceName,
      input.skippedReason ?? "no_query_rows",
      "queried",
      input.queryRowCount,
      uniqueStrings([...(input.warnings ?? []), "no_query_rows"]),
      {
        unknownFields: input.unknownFields,
        queryErrorCategory: input.queryErrorCategory,
        queryErrorMessage: input.queryErrorMessage,
      },
    );
  }

  if (input.queryRowCount <= 0 || input.sourceStatus !== "queried") {
    logDebug("tableau.photo_post.insightBranch", {
      purpose: input.purpose,
      branch: "unavailable",
      condition: "queryRowCount <= 0 || sourceStatus !== 'queried'",
      queryRowCount: input.queryRowCount,
      sourceStatus: input.sourceStatus,
      skippedReason: input.skippedReason,
      failedReason: input.failedReason,
    });
    return buildUnavailableInsight(
      input.purpose,
      input.datasourceKey,
      input.datasourceName,
      input.skippedReason ?? input.failedReason ?? evidenceSummary,
      input.sourceStatus === "failed"
        ? "failed"
        : input.sourceStatus === "skipped"
          ? "skipped"
          : input.sourceStatus === "queried"
            ? "queried"
            : "metadata_only",
      input.queryRowCount,
      input.warnings,
      {
        unknownFields: input.unknownFields,
        queryErrorCategory: input.queryErrorCategory,
        queryErrorMessage: input.queryErrorMessage,
      },
    );
  }

  if (input.purpose === "survey_insight") {
    logDebug("tableau.photo_post.insightBranch", {
      purpose: input.purpose,
      branch: "survey_insight",
      condition: "purpose === 'survey_insight'",
      keywordLabelCount: labels.filter((label) =>
        /expect|interest|concern|question|engagement|impression|follower|post|期待|関心|不安|疑問|質問|回答|自由記述|感想|意見|要望/i.test(
          label,
        ),
      ).length,
    });
    const keywordLabels = labels.filter((label) =>
      /expect|interest|concern|question|engagement|impression|follower|post|期待|関心|不安|疑問|質問|回答|自由記述|感想|意見|要望/i.test(
        label,
      ),
    );
    return {
      available: true,
      sourceStatus: "queried",
      datasourceKey: input.datasourceKey,
      datasourceName: input.datasourceName,
      queryRowCount: rows.length,
      warnings: input.warnings,
      keyExpectations: sliceOrFallback(keywordLabels, 0, 3, topLabels),
      keyInterests: sliceOrFallback(keywordLabels, 1, 3, topLabels),
      concernsOrQuestions: sliceOrFallback(
        labels.filter((label) =>
          /concern|question|issue|worry|unclear|不安|疑問|質問|懸念|気になる/i.test(
            label,
          ),
        ),
        0,
        3,
        topLabels,
      ),
      suggestedAngles: uniqueStrings([
        ...(input.additionalContext.queryInsights?.[0]?.rows
          .map((row) => row.label?.trim() ?? "")
          .filter(Boolean) ?? []),
        ...topLabels.slice(0, 2),
        "Address what people care about first",
      ]).slice(0, 5),
      keyFindings: topLabels,
      evidenceRows: rows,
      evidenceSummary,
    };
  }

  if (input.purpose === "post_performance") {
    logDebug("tableau.photo_post.insightBranch", {
      purpose: input.purpose,
      branch: "post_performance",
      condition: "purpose === 'post_performance'",
      highPerformingThemeCount: topLabels.length,
    });
    return {
      available: true,
      sourceStatus: "queried",
      datasourceKey: input.datasourceKey,
      datasourceName: input.datasourceName,
      queryRowCount: rows.length,
      warnings: input.warnings,
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

  logDebug("tableau.photo_post.insightBranch", {
    purpose: input.purpose,
    branch: "account_overview",
    condition: "default fallback",
    recentTrendSummaryLength: evidenceSummary.length,
  });
  return {
    available: true,
    sourceStatus: "queried",
    datasourceKey: input.datasourceKey,
    datasourceName: input.datasourceName,
    queryRowCount: rows.length,
    warnings: input.warnings,
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
  datasourceName: string,
  reason: string,
  status: "queried" | "skipped" | "failed" | "metadata_only" = "skipped",
  queryRowCount = 0,
  warnings: string[] = [],
  details?: {
    unknownFields?: string[];
    queryErrorCategory?: string;
    queryErrorMessage?: string;
  },
): SurveyInsight | PostPerformanceInsight | AccountOverviewInsight {
  if (purpose === "survey_insight") {
    return {
      available: false,
      sourceStatus: status,
      datasourceKey,
      datasourceName,
      queryRowCount,
      warnings,
      ...(details?.unknownFields?.length
        ? { unknownFields: details.unknownFields }
        : {}),
      ...(details?.queryErrorCategory
        ? { queryErrorCategory: details.queryErrorCategory }
        : {}),
      ...(details?.queryErrorMessage
        ? { queryErrorMessage: details.queryErrorMessage }
        : {}),
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
      datasourceName,
      queryRowCount,
      warnings,
      ...(details?.unknownFields?.length
        ? { unknownFields: details.unknownFields }
        : {}),
      ...(details?.queryErrorCategory
        ? { queryErrorCategory: details.queryErrorCategory }
        : {}),
      ...(details?.queryErrorMessage
        ? { queryErrorMessage: details.queryErrorMessage }
        : {}),
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
    datasourceName,
    queryRowCount,
    warnings,
    ...(details?.unknownFields?.length
      ? { unknownFields: details.unknownFields }
      : {}),
    ...(details?.queryErrorCategory
      ? { queryErrorCategory: details.queryErrorCategory }
      : {}),
    ...(details?.queryErrorMessage
      ? { queryErrorMessage: details.queryErrorMessage }
      : {}),
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

type PurposeFieldPlan = {
  availableFieldCount: number;
  candidateTextFields: string[];
  candidateDateFields: string[];
  candidateMetricFields: string[];
  selectedTextFields: string[];
  selectedDateField?: string;
  selectedMetricFields: string[];
  metricSelectionReason: string;
  rowCountFallbackUsed: boolean;
  rowCountFallbackField?: string;
  metricIntent: QuestionMetricIntent;
  groupingIntent: QuestionGroupingIntent;
  rankingTarget: QuestionRankingTarget;
  analysisIntent: QuestionAnalysisIntent;
  queryPlanType: string;
  queryFields: Array<Record<string, unknown>>;
  queryFilters: Array<Record<string, unknown>>;
  querySorts: Array<Record<string, unknown>>;
  queryLimit: number;
  period?: QuestionPeriod;
  requestedMetricText?: string;
};

function buildFixedMetadataLookupIntent(): ClassifiedQuestionIntent {
  return {
    intent: "metadata_lookup",
    confidence: 1,
    reasonBrief: "Photo post analysis starts with datasource metadata.",
    answerableFromDashboardContext: false,
    needsMcp: true,
    maxToolCalls: 2,
  };
}

function buildFixedPurposeMetadataInterpretation(
  purpose: AllowedDatasource["purpose"],
  dashboardContext: DashboardContext,
): QuestionInterpretation {
  const base = interpretQuestion({
    question: FIXED_ANALYSIS_QUESTIONS[purpose],
    dashboardContext,
  });
  return {
    ...base,
    requestType: "field_inventory",
    analysisIntent: "metadata_lookup",
    metricIntent: "unknown",
    asksForRanking: false,
    rankingTarget: "unknown",
    groupingIntent: "datasource",
    topN: 1,
    topNExplicitlyRequested: false,
  };
}

function buildFixedPurposeQueryInterpretation(input: {
  purpose: AllowedDatasource["purpose"];
  dashboardContext: DashboardContext;
  fieldPlan: PurposeFieldPlan;
}): QuestionInterpretation {
  const base = interpretQuestion({
    question: FIXED_ANALYSIS_QUESTIONS[input.purpose],
    dashboardContext: input.dashboardContext,
  });
  return {
    ...base,
    requestType: "general",
    analysisIntent: input.fieldPlan.analysisIntent,
    metricIntent: input.fieldPlan.metricIntent,
    requestedMetricText: input.fieldPlan.requestedMetricText,
    asksForRanking: true,
    topN: input.fieldPlan.queryLimit,
    rankingTarget: input.fieldPlan.rankingTarget,
    groupingIntent: input.fieldPlan.groupingIntent,
    groupingFieldHint: input.fieldPlan.selectedTextFields,
    period: input.fieldPlan.period,
    queryFields: input.fieldPlan.queryFields,
    queryFilters: input.fieldPlan.queryFilters,
    queryLimit: input.fieldPlan.queryLimit,
    topNExplicitlyRequested: true,
  };
}

function selectPurposeFieldPlan(input: {
  purpose: AllowedDatasource["purpose"];
  datasourceName: string;
  fieldProfiles: DatasourceFieldProfile[];
}): PurposeFieldPlan {
  const fieldDetails = pickFieldDetailsForPurpose(input);
  const availableFieldCount = fieldDetails.length;
  const candidateTextFields = fieldDetails
    .filter(isTextLikeFieldDetail)
    .map((field) => field.name)
    .filter(Boolean)
    .slice(0, 8);
  const candidateDateFields = fieldDetails
    .filter(isDateLikeFieldDetail)
    .map((field) => field.name)
    .filter(Boolean)
    .slice(0, 6);
  const candidateMetricFields = fieldDetails
    .filter(isMetricLikeFieldDetail)
    .map((field) => field.name)
    .filter(Boolean)
    .slice(0, 8);

  if (input.purpose === "survey_insight") {
    logDebug("tableau.photo_post.fieldPlanBranch", {
      purpose: input.purpose,
      branch: "survey_insight",
      condition: "purpose === 'survey_insight'",
      availableFieldCount,
      candidateTextFields,
      candidateDateFields,
      candidateMetricFields,
    });
    const selectedTextFields = uniqueStrings([
      ...candidateTextFields.slice(0, 3),
      ...candidateDateFields.slice(0, 1),
    ]).slice(0, 3);
    const selectedMetric = pickBestMetricField(fieldDetails, [
      {
        intent: "post_count",
        label: "matched survey response metrics",
        patterns: [/response/i, /answer/i, /count/i, /回答/i, /応答/i],
      },
      {
        intent: "engagements",
        label: "matched survey engagement metrics",
        patterns: [/engagement/i, /エンゲージメント/i],
      },
      {
        intent: "impressions",
        label: "matched survey impression metrics",
        patterns: [/impression/i, /インプレッション/i],
      },
      {
        intent: "likes",
        label: "matched survey like metrics",
        patterns: [/like/i, /いいね/i],
      },
      {
        intent: "reposts",
        label: "matched survey repost metrics",
        patterns: [/repost/i, /retweet/i, /リポスト/i, /再投稿/i],
      },
      {
        intent: "replies",
        label: "matched survey reply metrics",
        patterns: [/reply/i, /返信/i],
      },
      {
        intent: "bookmarks",
        label: "matched survey bookmark metrics",
        patterns: [/bookmark/i, /ブックマーク/i],
      },
    ]);
    logDebug("tableau.photo_post.fieldSelectionDecision", {
      purpose: input.purpose,
      selectedTextFields,
      selectedDateField: candidateDateFields[0],
      selectedMetricFields: selectedMetric.metricFieldLabel
        ? [selectedMetric.metricFieldLabel]
        : [],
      metricSelectionReason: selectedMetric.reason,
      metricIntent: selectedMetric.intent,
      queryLimit: 20,
    });
    return {
      availableFieldCount,
      candidateTextFields,
      candidateDateFields,
      candidateMetricFields,
      selectedTextFields,
      selectedDateField: candidateDateFields[0],
      selectedMetricFields: selectedMetric.metricFieldLabel
        ? [selectedMetric.metricFieldLabel]
        : [],
      metricSelectionReason: selectedMetric.reason,
      rowCountFallbackUsed: selectedMetric.rowCountFallbackUsed,
      rowCountFallbackField: selectedMetric.rowCountFallbackField,
      metricIntent: selectedMetric.intent,
      groupingIntent: "datasource",
      rankingTarget: "datasource",
      analysisIntent: "ranking",
      queryPlanType: "survey_insight_fixed",
      queryFields: buildQueryFieldLog({
        selectedTextFields,
        selectedDateField: candidateDateFields[0],
        metricFieldLabel: selectedMetric.metricFieldLabel,
        purpose: input.purpose,
      }),
      queryFilters: [],
      querySorts: [
        {
          field: selectedMetric.metricFieldLabel,
          direction: "DESC",
        },
      ],
      queryLimit: 20,
      requestedMetricText: selectedMetric.metricFieldLabel,
    };
  }

  if (input.purpose === "post_performance") {
    logDebug("tableau.photo_post.fieldPlanBranch", {
      purpose: input.purpose,
      branch: "post_performance",
      condition: "purpose === 'post_performance'",
      availableFieldCount,
      candidateTextFields,
      candidateDateFields,
      candidateMetricFields,
    });
    const selectedTextFields = pickBestTextFields(fieldDetails, [
      /post/i,
      /tweet/i,
      /content/i,
      /body/i,
      /text/i,
      /caption/i,
      /message/i,
      /title/i,
      /summary/i,
      /response/i,
      /feedback/i,
      /comment/i,
      /detail/i,
    ]);
    const selectedMetric = pickBestMetricField(fieldDetails, [
      {
        intent: "engagement_rate",
        label: "matched post engagement rate metrics",
        patterns: [/engagement.?rate/i, /エンゲージメント率/i],
      },
      {
        intent: "engagements",
        label: "matched post engagement metrics",
        patterns: [/engagement/i, /エンゲージメント/i],
      },
      {
        intent: "impressions",
        label: "matched post impression metrics",
        patterns: [/impression/i, /インプレッション/i],
      },
      {
        intent: "likes",
        label: "matched post like metrics",
        patterns: [/like/i, /いいね/i],
      },
      {
        intent: "reposts",
        label: "matched post repost metrics",
        patterns: [/repost/i, /retweet/i, /リポスト/i, /再投稿/i],
      },
      {
        intent: "replies",
        label: "matched post reply metrics",
        patterns: [/reply/i, /返信/i],
      },
      {
        intent: "bookmarks",
        label: "matched post bookmark metrics",
        patterns: [/bookmark/i, /ブックマーク/i],
      },
      {
        intent: "post_count",
        label: "matched post count metrics",
        patterns: [/count/i, /投稿数/i, /ポスト数/i],
      },
    ]);
    logDebug("tableau.photo_post.fieldSelectionDecision", {
      purpose: input.purpose,
      selectedTextFields,
      selectedDateField: candidateDateFields[0],
      selectedMetricFields: selectedMetric.metricFieldLabel
        ? [selectedMetric.metricFieldLabel]
        : [],
      metricSelectionReason: selectedMetric.reason,
      metricIntent: selectedMetric.intent,
      queryLimit: 10,
    });
    return {
      availableFieldCount,
      candidateTextFields,
      candidateDateFields,
      candidateMetricFields,
      selectedTextFields,
      selectedDateField: candidateDateFields[0],
      selectedMetricFields: selectedMetric.metricFieldLabel
        ? [selectedMetric.metricFieldLabel]
        : [],
      metricSelectionReason: selectedMetric.reason,
      rowCountFallbackUsed: selectedMetric.rowCountFallbackUsed,
      rowCountFallbackField: selectedMetric.rowCountFallbackField,
      metricIntent: selectedMetric.intent,
      groupingIntent: "datasource",
      rankingTarget: "post",
      analysisIntent: "ranking",
      queryPlanType: "post_performance_fixed",
      queryFields: buildQueryFieldLog({
        selectedTextFields,
        selectedDateField: candidateDateFields[0],
        metricFieldLabel: selectedMetric.metricFieldLabel,
        purpose: input.purpose,
      }),
      queryFilters: [],
      querySorts: [
        {
          field: selectedMetric.metricFieldLabel,
          direction: "DESC",
        },
      ],
      queryLimit: 10,
      requestedMetricText: selectedMetric.metricFieldLabel,
    };
  }

  const selectedDateField = candidateDateFields[0];
  logDebug("tableau.photo_post.fieldPlanBranch", {
    purpose: input.purpose,
    branch: "account_overview",
    condition: "default fallback",
    availableFieldCount,
    candidateTextFields,
    candidateDateFields,
    candidateMetricFields,
    selectedDateFieldPresent: Boolean(selectedDateField),
  });
  const selectedMetric = pickBestMetricField(fieldDetails, [
    {
      intent: "impressions",
      label: "matched account overview priority metrics",
      patterns: [/impression/i, /インプレッション/i, /表示回数/i],
    },
    {
      intent: "engagements",
      label: "matched account overview priority metrics",
      patterns: [/engagement/i, /エンゲージメント/i],
    },
    {
      intent: "engagement_rate",
      label: "matched account overview priority metrics",
      patterns: [/engagement.?rate/i, /エンゲージメント率/i],
    },
    {
      intent: "post_count",
      label: "matched account overview priority metrics",
      patterns: [/post.?count/i, /count/i, /投稿数/i, /件数/i],
    },
    {
      intent: "likes",
      label: "matched account overview priority metrics",
      patterns: [/like/i, /いいね/i],
    },
    {
      intent: "reposts",
      label: "matched account overview priority metrics",
      patterns: [/repost/i, /retweet/i, /共有/i, /シェア/i],
    },
    {
      intent: "replies",
      label: "matched account overview priority metrics",
      patterns: [/reply/i, /返信/i],
    },
    {
      intent: "bookmarks",
      label: "matched account overview priority metrics",
      patterns: [/bookmark/i, /ブックマーク/i],
    },
  ]);
  const period = buildRecentPeriod(30);
  logDebug("tableau.photo_post.fieldSelectionDecision", {
    purpose: input.purpose,
    selectedTextFields: selectedDateField ? [selectedDateField] : [],
    selectedDateField,
    selectedMetricFields: selectedMetric.metricFieldLabel
      ? [selectedMetric.metricFieldLabel]
      : [],
    metricSelectionReason: selectedMetric.reason,
    metricIntent: selectedMetric.intent,
    queryLimit: 30,
    period,
  });
  return {
    availableFieldCount,
    candidateTextFields,
    candidateDateFields,
    candidateMetricFields,
    selectedTextFields: selectedDateField ? [selectedDateField] : [],
    selectedDateField,
    selectedMetricFields: selectedMetric.metricFieldLabel
      ? [selectedMetric.metricFieldLabel]
      : [],
    metricSelectionReason: selectedMetric.reason,
    rowCountFallbackUsed: selectedMetric.rowCountFallbackUsed,
    rowCountFallbackField: selectedMetric.rowCountFallbackField,
    metricIntent: selectedMetric.intent,
    groupingIntent: "dashboard",
    rankingTarget: "datasource",
    analysisIntent: "grouped_trend",
    queryPlanType: "account_overview_fixed",
    queryFields: buildQueryFieldLog({
      selectedTextFields: selectedDateField ? [selectedDateField] : [],
      selectedDateField,
      metricFieldLabel: selectedMetric.metricFieldLabel,
      purpose: input.purpose,
    }),
    queryFilters: selectedDateField
      ? [
          {
            field: selectedDateField,
            filterType: "QUANTITATIVE_DATE",
            quantitativeFilterType: "RANGE",
            minDate: period.startDate,
            maxDate: period.endDate,
            includeNulls: false,
          },
        ]
      : [],
    querySorts: [
      ...(selectedDateField
        ? [
            {
              field: selectedDateField,
              direction: "DESC",
            },
          ]
        : []),
      {
        field: selectedMetric.metricFieldLabel,
        direction: "DESC",
      },
    ],
    queryLimit: 30,
    period: selectedDateField ? period : undefined,
    requestedMetricText: selectedMetric.metricFieldLabel,
  };
}

function pickFieldDetailsForPurpose(input: {
  datasourceName: string;
  fieldProfiles: DatasourceFieldProfile[];
}): Array<{
  name: string;
  dataType?: string;
  role?: string;
  semanticRole?: string;
}> {
  const normalizedDatasourceName = input.datasourceName.toLowerCase();
  const profiles = input.fieldProfiles.length ? input.fieldProfiles : [];
  const profile =
    profiles.find((candidate) =>
      candidate.datasourceName.toLowerCase().includes(normalizedDatasourceName),
    ) ?? profiles[0];
  return (profile?.fields ?? []).map((field) => ({
    name: field.name,
    dataType: field.dataType,
    role: field.role,
    semanticRole: field.semanticRole,
  }));
}

function pickBestTextFields(
  fieldDetails: Array<{
    name: string;
    dataType?: string;
    role?: string;
    semanticRole?: string;
  }>,
  patterns: RegExp[],
): string[] {
  const scored = fieldDetails
    .filter(isTextLikeFieldDetail)
    .map((field) => ({
      name: field.name,
      score: scoreTextField(field.name, patterns),
    }))
    .sort((left, right) => right.score - left.score);
  return uniqueStrings(
    scored
      .filter((candidate) => candidate.score > 0)
      .map((candidate) => candidate.name)
      .slice(0, 3),
  );
}

function pickBestMetricField(
  fieldDetails: Array<{
    name: string;
    dataType?: string;
    role?: string;
    semanticRole?: string;
  }>,
  preferences: Array<{
    intent: QuestionMetricIntent;
    label: string;
    patterns: RegExp[];
  }>,
): {
  intent: QuestionMetricIntent;
  metricFieldLabel?: string;
  reason: string;
  rowCountFallbackUsed: boolean;
  rowCountFallbackField?: string;
} {
  const candidates = fieldDetails
    .filter(isMetricLikeFieldDetail)
    .map((field) => ({
      name: field.name,
      score: scoreMetricField(field.name, preferences),
    }))
    .sort((left, right) => right.score - left.score);
  const selected = candidates[0];
  if (selected && selected.score > 0) {
    const matchedPreference =
      preferences.find((preference) =>
        preference.patterns.some((pattern) => pattern.test(selected.name)),
      ) ?? preferences[0];
    return {
      intent: matchedPreference?.intent ?? "post_count",
      metricFieldLabel: selected.name,
      reason: matchedPreference?.label
        ? `${matchedPreference.label}: ${selected.name}`
        : `selected ${selected.name} by metadata score`,
      rowCountFallbackUsed: false,
    };
  }

  return {
    intent: "post_count",
    metricFieldLabel: undefined,
    reason: "no suitable metric field was found",
    rowCountFallbackUsed: false,
  };
}

function scoreTextField(name: string, patterns: RegExp[]): number {
  let score = 0;
  for (const pattern of patterns) {
    if (pattern.test(name)) {
      score += 100;
    }
  }
  if (
    /date|time|timestamp|count|num|number|score|rate|impression|like|bookmark|reply|repost|engagement/i.test(
      name,
    )
  ) {
    score -= 50;
  }
  return score;
}

function scoreMetricField(
  name: string,
  preferences: Array<{
    intent: QuestionMetricIntent;
    label: string;
    patterns: RegExp[];
  }>,
): number {
  let score = 0;
  for (let index = 0; index < preferences.length; index += 1) {
    const preference = preferences[index];
    const hit =
      preference.patterns.some((pattern) => pattern.test(name)) ||
      getMetricIntentFallbackPatterns(preference.intent).some((pattern) =>
        pattern.test(name),
      );
    if (hit) {
      score += Math.max(200 - index * 20, 20);
    }
  }
  if (
    /count|total|number|sum|score|rate|impression|engagement|like|bookmark|reply|repost|favorite/i.test(
      name,
    )
  ) {
    score += 25;
  }
  return score;
}

function getMetricIntentFallbackPatterns(
  intent: QuestionMetricIntent,
): RegExp[] {
  switch (intent) {
    case "impressions":
      return [/impression/i, /インプレッション/i, /表示回数/i];
    case "engagements":
      return [/engagement/i, /エンゲージメント/i];
    case "engagement_rate":
      return [/engagement.?rate/i, /エンゲージメント率/i];
    case "reposts":
      return [/repost/i, /retweet/i, /リポスト/i, /共有/i, /シェア/i];
    case "replies":
      return [/reply/i, /返信/i];
    case "likes":
      return [/like/i, /いいね/i];
    case "bookmarks":
      return [/bookmark/i, /ブックマーク/i];
    case "post_count":
      return [/post.?count/i, /count/i, /投稿数/i, /件数/i];
    case "views":
      return [/view/i, /再生/i, /視聴/i];
    case "favorites":
    case "love":
    case "reactions":
    case "unknown":
    default:
      return [];
  }
}

function buildMetricPriorityCandidateLabels(
  purpose: AllowedDatasource["purpose"],
): string[] {
  if (purpose === "account_overview") {
    return [
      "インプレッション数",
      "エンゲージメント",
      "新しいフォロー",
      "プロフィールへのアクセス数",
      "共有された回数",
      "メディアの再生数",
      "動画再生数",
      "ブックマーク",
    ];
  }

  if (purpose === "post_performance") {
    return [
      "エンゲージメント",
      "エンゲージメント率",
      "インプレッション数",
      "いいね",
      "リポスト",
      "返信",
      "ブックマーク",
    ];
  }

  return [
    "回答数",
    "Expectation Score",
    "Mcp Awareness Score",
    "Response Id",
    "Interest Topic",
    "Interest Category",
  ];
}

function validatePhotoPostQueryPlanFields(input: {
  metadataFieldCaptions: string[];
  queryFields: Array<Record<string, unknown>>;
  selectedMetricFields: string[];
}): {
  fieldValidationPassed: boolean;
  unknownFieldCaptions: string[];
  customCalculationCount: number;
  skippedReason?: string;
} {
  const normalizedMetadataFields = new Set(
    input.metadataFieldCaptions
      .map((fieldCaption) => normalizePhotoPostFieldCaption(fieldCaption))
      .filter(Boolean),
  );
  const queryFieldCaptions = input.queryFields
    .map((field) => readString(field.fieldCaption))
    .filter((field): field is string => Boolean(field));
  const customCalculationCount = input.queryFields.filter(
    (field) =>
      typeof field.calculation === "string" && field.calculation.trim(),
  ).length;
  const unknownFieldCaptions = uniqueStrings(
    queryFieldCaptions.filter((fieldCaption) => {
      const normalizedCaption = normalizePhotoPostFieldCaption(fieldCaption);
      if (!normalizedCaption) {
        return false;
      }
      return !normalizedMetadataFields.has(normalizedCaption);
    }),
  );
  const hasAggregateField = input.queryFields.some(
    (field) =>
      typeof field.function === "string" ||
      typeof field.calculation === "string",
  );
  if (unknownFieldCaptions.length > 0) {
    return {
      fieldValidationPassed: false,
      unknownFieldCaptions,
      customCalculationCount,
      skippedReason: "query_plan_contains_unknown_field",
    };
  }
  if (!hasAggregateField || input.selectedMetricFields.length === 0) {
    return {
      fieldValidationPassed: false,
      unknownFieldCaptions,
      customCalculationCount,
      skippedReason: "no_suitable_metric_fields",
    };
  }
  return {
    fieldValidationPassed: true,
    unknownFieldCaptions: [],
    customCalculationCount,
  };
}

function normalizePhotoPostFieldCaption(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractUnknownFieldsFromQueryError(errorMessage?: string): string[] {
  if (!errorMessage) {
    return [];
  }

  const matches = [...errorMessage.matchAll(/Field '([^']+)' was not found/gi)];
  return uniqueStrings(
    matches
      .map((match) => match[1]?.trim())
      .filter((field): field is string => Boolean(field)),
  );
}

function isTextLikeFieldDetail(fieldDetail: {
  name: string;
  dataType?: string;
  role?: string;
  semanticRole?: string;
}): boolean {
  const haystack =
    `${fieldDetail.name} ${fieldDetail.dataType ?? ""} ${fieldDetail.role ?? ""} ${fieldDetail.semanticRole ?? ""}`.toLowerCase();
  return !/int|integer|long|short|float|double|decimal|number|numeric|real|measure|quantitative|date|time|timestamp/.test(
    haystack,
  );
}

function isDateLikeFieldDetail(fieldDetail: {
  name: string;
  dataType?: string;
  role?: string;
  semanticRole?: string;
}): boolean {
  const haystack =
    `${fieldDetail.name} ${fieldDetail.dataType ?? ""}`.toLowerCase();
  return /date|datetime|time|timestamp/.test(haystack);
}

function isMetricLikeFieldDetail(fieldDetail: {
  name: string;
  dataType?: string;
  role?: string;
  semanticRole?: string;
}): boolean {
  const haystack =
    `${fieldDetail.name} ${fieldDetail.dataType ?? ""} ${fieldDetail.role ?? ""} ${fieldDetail.semanticRole ?? ""}`.toLowerCase();
  return /(?:\bint\b|\binteger\b|\blong\b|\bshort\b|\bfloat\b|\bdouble\b|\bdecimal\b|\bnumber\b|\bnumeric\b|\breal\b|\bmeasure\b|\bquantitative\b|\bcount\b|\btotal\b|\bsum\b|\bscore\b|\brate\b|\blike\b|\bfavorite\b|\bbookmark\b|\breply\b|\brepost\b|\bengagement\b|\bimpression\b|繧､繝ｳ繝励Ξ繝・す繝ｧ繝ｳ|陦ｨ遉ｺ蝗樊焚|繧ｨ繝ｳ繧ｲ繝ｼ繧ｸ繝｡繝ｳ繝・|繧ｨ繝ｳ繧ｲ繝ｼ繧ｸ繝｡繝育紫|繝ｪ繝昴せ繝・|蜈ｱ譛・|繧ｷ繧ｧ繧｢|霑比ｿ｡|縺・＞縺ｭ|繝悶ャ繧ｯ繝槭・繧ｯ|謚慕ｨｿ謨ｰ|莉ｶ謨ｰ|蜀咲函|隕冶・)/i.test(
    haystack,
  );
}

function countFieldsByRole(
  profile: DatasourceFieldProfile | undefined,
  role: string,
): number {
  return (
    profile?.fields.filter(
      (field) =>
        field.role?.toUpperCase() === role.toUpperCase() ||
        field.semanticRole?.toUpperCase() === role.toUpperCase(),
    ).length ?? 0
  );
}

function buildRecentPeriod(days: number): QuestionPeriod {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, days));
  return {
    kind: "range",
    label: `recent ${days} days`,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    raw: `recent ${days} days`,
    warnings: [],
  };
}

function buildQueryFieldLog(input: {
  selectedTextFields: string[];
  selectedDateField?: string;
  metricFieldLabel?: string;
  purpose: AllowedDatasource["purpose"];
}): Array<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  if (input.selectedTextFields[0]) {
    fields.push({
      fieldCaption: input.selectedTextFields[0],
      fieldAlias: "rank_label",
    });
  }
  if (input.selectedDateField && input.purpose === "account_overview") {
    fields.push({
      fieldCaption: input.selectedDateField,
      fieldAlias: "rank_label_date",
    });
  }
  if (input.metricFieldLabel) {
    fields.push({
      fieldCaption: input.metricFieldLabel,
      function: "SUM",
      fieldAlias: "rank_metric",
      sortDirection: "DESC",
      sortPriority: 1,
    });
  }
  return fields;
}

function resolvePhotoContextGenerationBlockers(
  photoContext: PostGenerationEvidencePack["photoContext"],
): GenerationBlocker[] {
  if (photoContext.available) {
    return [];
  }

  switch (photoContext.source) {
    case "missing_image":
      return ["input_image_not_found"];
    case "image_fetch_failed":
      return ["input_image_fetch_failed"];
    case "vision_analysis_failed":
      return ["vision_analysis_failed"];
    case "vision_analysis_no_usable_output":
      return ["vision_analysis_no_usable_output"];
    case "fallback":
      return ["required_photo_context_missing"];
    case "actual_image":
    default:
      return ["required_photo_context_missing"];
  }
}

function buildAnalysisSections(input: {
  photoContext: PostGenerationEvidencePack["photoContext"];
  eventContext: PostGenerationEvidencePack["eventContext"];
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
          : input.photoContext.source === "missing_image"
            ? "skipped"
            : input.photoContext.source === "fallback"
              ? "failed"
              : "failed",
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
          : (input.surveyInsight?.sourceStatus ?? "skipped"),
      skippedReason: input.surveyInsight?.available
        ? undefined
        : (input.surveyInsight?.skippedReason ??
          input.surveyInsight?.evidenceSummary),
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
          : (input.postPerformanceInsight?.sourceStatus ?? "skipped"),
      skippedReason: input.postPerformanceInsight?.available
        ? undefined
        : (input.postPerformanceInsight?.skippedReason ??
          input.postPerformanceInsight?.evidenceSummary),
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
          : (input.accountOverviewInsight?.sourceStatus ?? "skipped"),
      skippedReason: input.accountOverviewInsight?.available
        ? undefined
        : (input.accountOverviewInsight?.skippedReason ??
          input.accountOverviewInsight?.evidenceSummary),
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
        eventContext: input.eventContext,
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
  eventContext: PostGenerationEvidencePack["eventContext"];
  surveyInsight?: SurveyInsight;
  postPerformanceInsight?: PostPerformanceInsight;
  accountOverviewInsight?: AccountOverviewInsight;
}): string {
  return [
    input.photoContext.summary,
    input.eventContext.eventName,
    input.eventContext.eventDescription,
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
  const visionProvider = buildVisionProviderDiagnostics();
  if (!photo || photo.mode === "none") {
    return {
      photoContext: buildHeuristicPhotoContext(request, "missing_image", {
        skippedReason: "input_image_not_found",
      }),
      generated: false,
      skippedReason: "input_image_not_found",
    };
  }

  logInfo("tableau.photo_post.inputImageFetchStarted", {
    inputImageObjectKeyPresent: Boolean(photo.objectKey),
    inputImageObjectKey: photo.objectKey ?? undefined,
    inputImageObjectKeyExtension: getImageFileExtension(photo.objectKey),
    inputImageContentType: photo.contentType ?? photo.mimeType ?? undefined,
    inputImageBytes: photo.byteLength ?? undefined,
    inputImageWidth: photo.width ?? undefined,
    inputImageHeight: photo.height ?? undefined,
  });

  if (!photo.objectKey?.trim()) {
    logInfo("tableau.photo_post.imageAnalysisCompleted", {
      imageAnalysisProvider: visionProvider.provider,
      imageAnalysisProviderEnabled: visionProvider.enabled,
      imageAnalysisProviderSource: visionProvider.providerSource,
      imageAnalysisProviderMissingEnvVars: visionProvider.missingEnvVars,
      imageAnalysisModel: getConfig().model.bedrock.modelId,
      imageAnalysisSuccess: false,
      photoContextSource: "missing_image",
      photoContextSkippedReason: "input_image_not_found",
    });
    return {
      photoContext: buildHeuristicPhotoContext(request, "missing_image", {
        skippedReason: "input_image_not_found",
      }),
      generated: false,
      skippedReason: "input_image_not_found",
    };
  }

  let fetchedImage: Awaited<
    ReturnType<ActionRunInputImageService["fetchActionRunInputImage"]>
  > | null = null;
  try {
    fetchedImage = await inputImageService.fetchActionRunInputImage({
      objectKey: photo.objectKey,
    });
  } catch (error) {
    logInfo("tableau.photo_post.imageAnalysisCompleted", {
      imageAnalysisProvider: visionProvider.provider,
      imageAnalysisProviderEnabled: visionProvider.enabled,
      imageAnalysisProviderSource: visionProvider.providerSource,
      imageAnalysisModel: getConfig().model.bedrock.modelId,
      imageAnalysisSuccess: false,
      photoContextSource: "image_fetch_failed",
      photoContextSkippedReason: "input image fetch failed",
    });
    logWarn("tableau.photo_post.inputImageFetchFailed", {
      inputImageObjectKeyPresent: true,
      inputImageObjectKey: photo.objectKey,
      inputImageContentType: photo.contentType ?? photo.mimeType ?? undefined,
      inputImageBytes: photo.byteLength ?? undefined,
      inputImageWidth: photo.width ?? undefined,
      inputImageHeight: photo.height ?? undefined,
      failedInsightReason: safeErrorDetails(error),
    });
    return {
      photoContext: buildHeuristicPhotoContext(request, "image_fetch_failed", {
        skippedReason: "input_image_fetch_failed",
      }),
      generated: false,
      skippedReason: "input_image_fetch_failed",
    };
  }

  const resolvedImage = fetchedImage;

  if (resolvedImage) {
    logInfo("tableau.photo_post.inputImageFetchCompleted", {
      inputImageObjectKeyPresent: true,
      inputImageBytes: resolvedImage.byteLength,
      inputImageContentType: resolvedImage.contentType,
      inputImageObjectKeyExtension: getImageFileExtension(photo.objectKey),
      inputImageContentTypeMatchesObjectKey:
        isImageContentTypeCompatibleWithObjectKey({
          objectKey: photo.objectKey,
          contentType: resolvedImage.contentType,
        }),
      inputImageWidth: photo.width ?? undefined,
      inputImageHeight: photo.height ?? undefined,
    });
  } else {
    logInfo("tableau.photo_post.imageAnalysisCompleted", {
      imageAnalysisProvider: visionProvider.provider,
      imageAnalysisProviderEnabled: visionProvider.enabled,
      imageAnalysisProviderSource: visionProvider.providerSource,
      imageAnalysisModel: getConfig().model.bedrock.modelId,
      imageAnalysisSuccess: false,
      photoContextSource: "image_fetch_failed",
      photoContextSkippedReason: "input image could not be fetched",
    });
    return {
      photoContext: buildHeuristicPhotoContext(request, "image_fetch_failed", {
        skippedReason: "input_image_fetch_failed",
      }),
      generated: false,
      skippedReason: "input_image_fetch_failed",
    };
  }

  const imageBytes =
    resolvedImage?.bytes ??
    (photo.dataUrl ? parseDataUrl(photo.dataUrl)?.bytes : undefined);
  const imageContentType =
    resolvedImage?.contentType ??
    photo.contentType ??
    photo.mimeType ??
    undefined;

  if (!imageBytes || !imageContentType) {
    logInfo("tableau.photo_post.imageAnalysisCompleted", {
      imageAnalysisProvider: visionProvider.provider,
      imageAnalysisProviderEnabled: visionProvider.enabled,
      imageAnalysisProviderSource: visionProvider.providerSource,
      imageAnalysisModel: getConfig().model.bedrock.modelId,
      imageAnalysisSuccess: false,
      photoContextSource: "image_fetch_failed",
      photoContextSkippedReason: "input image could not be decoded",
    });
    return {
      photoContext: buildHeuristicPhotoContext(request, "image_fetch_failed", {
        skippedReason: "input_image_fetch_failed",
      }),
      generated: false,
      skippedReason: "input_image_fetch_failed",
    };
  }

  const inputImageContentTypeMatchesObjectKey =
    isImageContentTypeCompatibleWithObjectKey({
      objectKey: photo.objectKey,
      contentType: imageContentType,
    });
  if (inputImageContentTypeMatchesObjectKey === false) {
    logWarn("tableau.photo_post.inputImageFormatMismatch", {
      inputImageObjectKeyPresent: true,
      inputImageObjectKey: photo.objectKey,
      inputImageObjectKeyExtension: getImageFileExtension(photo.objectKey),
      inputImageContentType: imageContentType,
      inputImageBytes: imageBytes.length,
      inputImageWidth: photo.width ?? undefined,
      inputImageHeight: photo.height ?? undefined,
      reason:
        "object key extension does not match contentType; Bedrock will use contentType",
    });
  }

  logInfo("tableau.photo_post.imageAnalysisStarted", {
    imageAnalysisProvider: visionProvider.provider,
    imageAnalysisProviderEnabled: visionProvider.enabled,
    imageAnalysisProviderSource: visionProvider.providerSource,
    imageAnalysisProviderMissingEnvVars: visionProvider.missingEnvVars,
    imageAnalysisModel: getConfig().model.bedrock.modelId,
    inputImageBytes: imageBytes.length,
    inputImageContentType: imageContentType,
    inputImageObjectKeyPresent: Boolean(photo.objectKey),
    inputImageObjectKeyExtension: getImageFileExtension(photo.objectKey),
    inputImageContentTypeMatchesObjectKey,
    inputImageWidth: photo.width ?? undefined,
    inputImageHeight: photo.height ?? undefined,
  });

  const vision = await visionAnalyzer.analyze({
    currentSituation: request.currentSituation,
    fileName: photo.fileName,
    contentType: imageContentType,
    bytes: imageBytes,
  });

  if (vision.status === "failed") {
    logInfo("tableau.photo_post.imageAnalysisCompleted", {
      imageAnalysisProvider: visionProvider.provider,
      imageAnalysisProviderEnabled: visionProvider.enabled,
      imageAnalysisProviderSource: visionProvider.providerSource,
      imageAnalysisModel: getConfig().model.bedrock.modelId,
      imageAnalysisSuccess: false,
      photoContextSource: vision.source,
      photoContextSkippedReason: vision.skippedReason,
    });
    return {
      photoContext: buildHeuristicPhotoContext(request, vision.source, {
        skippedReason: vision.skippedReason,
      }),
      generated: false,
      skippedReason: vision.skippedReason,
    };
  }

  if (vision.status === "no_usable_output") {
    logInfo("tableau.photo_post.imageAnalysisCompleted", {
      imageAnalysisProvider: visionProvider.provider,
      imageAnalysisProviderEnabled: visionProvider.enabled,
      imageAnalysisProviderSource: visionProvider.providerSource,
      imageAnalysisModel: getConfig().model.bedrock.modelId,
      imageAnalysisSuccess: false,
      photoContextSource: vision.source,
      photoContextSkippedReason: vision.skippedReason,
    });
    return {
      photoContext: buildHeuristicPhotoContext(request, vision.source, {
        skippedReason: vision.skippedReason,
      }),
      generated: false,
      skippedReason: vision.skippedReason,
    };
  }

  const normalizedVision = normalizeVisionPhotoContext(vision.photoContext);
  const heuristic = buildHeuristicPhotoContext(request, "actual_image");
  const detectedTopics = uniqueStrings([
    ...(normalizedVision.detectedTopics ?? []),
    ...(heuristic.detectedTopics ?? []),
  ]).slice(0, 8);
  const suggestedPostAngles = uniqueStrings([
    ...(normalizedVision.suggestedPostAngles ?? []),
    ...(heuristic.suggestedPostAngles ?? []),
  ]).slice(0, 6);

  logInfo("tableau.photo_post.imageAnalysisCompleted", {
    imageAnalysisProvider: visionProvider.provider,
    imageAnalysisProviderEnabled: visionProvider.enabled,
    imageAnalysisProviderSource: visionProvider.providerSource,
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
      ...normalizedVision,
      available: true,
      source: "actual_image",
      summary: buildVisionSummary({
        currentSituation: request.currentSituation,
        vision: normalizedVision,
        heuristic,
        fileName: photo.fileName,
        sizeLabel: photo.sizeLabel,
      }),
      detectedTopics,
      suggestedPostAngles,
      visibleText: uniqueStrings([
        normalizedVision.ocrText ?? "",
        ...(normalizedVision.visibleText ?? []),
      ]).filter(Boolean),
    },
    generated: true,
  };
}

function buildHeuristicPhotoContext(
  request: ActionRunRequest,
  source: PhotoContextSource,
  options?: {
    skippedReason?: string;
  },
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
      photo?.dataUrl && source === "actual_image" ? [photo.fileName ?? ""] : [],
    skippedReason:
      options?.skippedReason ??
      (source === "missing_image" ? "input_image_not_found" : undefined),
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

function normalizeVisionPhotoContext(
  input: Partial<PostGenerationEvidencePack["photoContext"]>,
): Partial<PostGenerationEvidencePack["photoContext"]> {
  return {
    summary: readString(input.summary),
    detectedTopics: uniqueStrings(input.detectedTopics ?? []).slice(0, 8),
    visibleText: uniqueStrings(input.visibleText ?? []).slice(0, 8),
    suggestedPostAngles: uniqueStrings(input.suggestedPostAngles ?? []).slice(
      0,
      6,
    ),
    observedItems: uniqueStrings(input.observedItems ?? []).slice(0, 8),
    sceneInference: readString(input.sceneInference),
    eventFeel: readString(input.eventFeel),
    postableElements: uniqueStrings(input.postableElements ?? []).slice(0, 8),
    subjectCandidates: uniqueStrings(input.subjectCandidates ?? []).slice(0, 8),
    ocrText: readString(input.ocrText),
  };
}

function buildEventContext(
  request: ActionRunRequest,
): PostGenerationEvidencePack["eventContext"] {
  const context = request.eventContext;
  if (context) {
    const eventName = normalizeMeaningfulText(context.eventName);
    const eventUrl = readString(context.eventUrl);
    const eventDescription = readString(context.eventDescription);
    const venue = readString(context.venue);
    const eventDateText = readString(context.eventDateText);
    return {
      available: Boolean(eventName || eventUrl || eventDescription || venue),
      source: context.source,
      ...(eventName ? { eventName } : {}),
      ...(eventUrl ? { eventUrl } : {}),
      ...(eventDescription ? { eventDescription } : {}),
      ...(venue ? { venue } : {}),
      ...(eventDateText ? { eventDateText } : {}),
      ...(context.source === "not_found"
        ? { skippedReason: "event_context_not_found" }
        : {}),
    };
  }

  const fallbackEventName = normalizeMeaningfulText(request.eventName);
  const fallbackEventUrl = readString(request.eventUrl ?? request.techplayUrl);
  const fallbackDescription = readString(request.venueMemo);
  const fallbackSource: PostGenerationEvidencePack["eventContext"]["source"] =
    fallbackEventName || fallbackEventUrl ? "fallback" : "not_found";
  return {
    available: Boolean(
      fallbackEventName || fallbackEventUrl || fallbackDescription,
    ),
    source: fallbackSource,
    ...(fallbackEventName ? { eventName: fallbackEventName } : {}),
    ...(fallbackEventUrl ? { eventUrl: fallbackEventUrl } : {}),
    ...(fallbackDescription ? { eventDescription: fallbackDescription } : {}),
    ...(fallbackSource === "not_found"
      ? { skippedReason: "event_context_not_found" }
      : {}),
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const parsed = tryParseJson(text);
  return isRecord(parsed) ? parsed : undefined;
}

export function extractVisionStructuredOutput(text: string): {
  sceneInference?: string;
  eventFeel?: string;
  observedItems?: string[];
  postableElements?: string[];
  subjectCandidates?: string[];
  detectedTopics?: string[];
  suggestedPostAngles?: string[];
  ocrText?: string;
  visibleText?: string[];
} {
  const normalized = normalizeVisionText(text);
  const jsonText = extractJsonCandidateText(normalized);
  if (jsonText) {
    const parsed = parseJsonObject(jsonText);
    if (parsed) {
      return {
        sceneInference: readString(parsed.sceneInference),
        eventFeel: readString(parsed.eventFeel),
        observedItems: readStringArray(parsed.observedItems),
        postableElements: readStringArray(parsed.postableElements),
        subjectCandidates: readStringArray(parsed.subjectCandidates),
        detectedTopics: readStringArray(parsed.detectedTopics),
        suggestedPostAngles: readStringArray(parsed.suggestedPostAngles),
        ocrText: readString(parsed.ocrText),
        visibleText: readStringArray(parsed.visibleText),
      };
    }
  }

  const summary = buildVisionSummaryFromText(normalized, undefined);
  return {
    sceneInference: summary,
    detectedTopics: uniqueStrings(extractKeywords(normalized)).slice(0, 6),
    suggestedPostAngles: uniqueStrings([
      "lead with the most concrete observation",
      "keep the tone factual and concise",
    ]),
    visibleText: [],
  };
}

export function buildVisionSummaryFromText(
  text: string,
  parsed?: ReturnType<typeof extractVisionStructuredOutput>,
): string {
  const jsonSummary = [
    parsed?.sceneInference,
    parsed?.eventFeel,
    parsed?.ocrText,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" / ");
  if (jsonSummary.trim()) {
    return jsonSummary.trim();
  }

  const lines = normalizeVisionText(text)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  const bulletLines = lines.filter((line) => /^[-*]/.test(line));
  if (bulletLines.length > 0) {
    return bulletLines.slice(0, 3).join(" / ");
  }

  return lines.slice(0, 3).join(" / ");
}

export function normalizeVisionText(text: string): string {
  return text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1").trim();
}

function buildVisionRawOutputPreview(text: string): string {
  const normalized = normalizeVisionText(text);
  if (!normalized) {
    return "";
  }

  return normalized.slice(0, 360);
}

function extractJsonCandidateText(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced?.trim()) {
    return fenced.trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeMeaningfulText(value: unknown): string | undefined {
  const text = readString(value);
  if (!text) {
    return undefined;
  }

  if (/unavailable|not available|missing|none|n\/a/i.test(text)) {
    return undefined;
  }

  return text;
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

function extractVisionResponseText(response: unknown): string {
  if (!isVisionResponseLike(response)) {
    return "";
  }

  return (
    (response.output?.message?.content ?? [])
      .map((content) => readString(content.text))
      .filter((value): value is string => Boolean(value))
      .join("\n")
      .trim() ?? ""
  );
}

function isVisionResponseLike(
  response: unknown,
): response is ConverseCommandOutput & {
  output?: {
    message?: {
      content?: Array<{
        text?: string;
      }>;
    };
  };
} {
  return typeof response === "object" && response !== null;
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

type VisionProviderSource =
  | "MODEL_PROVIDER"
  | "VISION_PROVIDER"
  | "IMAGE_ANALYSIS_PROVIDER"
  | "ENABLE_IMAGE_ANALYSIS"
  | "default";

function buildVisionProviderDiagnostics(): {
  provider: "mock" | "bedrock";
  providerSource: VisionProviderSource;
  providerRawValue?: string;
  enabled: boolean;
  disabledReason?: string;
  missingEnvVars: string[];
  configuredEnvVars: Record<
    | "MODEL_PROVIDER"
    | "VISION_PROVIDER"
    | "IMAGE_ANALYSIS_PROVIDER"
    | "ENABLE_IMAGE_ANALYSIS",
    string | undefined
  >;
} {
  const config = getConfig();
  const configuredEnvVars = {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER,
    VISION_PROVIDER: process.env.VISION_PROVIDER,
    IMAGE_ANALYSIS_PROVIDER: process.env.IMAGE_ANALYSIS_PROVIDER,
    ENABLE_IMAGE_ANALYSIS: process.env.ENABLE_IMAGE_ANALYSIS,
  };
  const missingEnvVars: string[] = [];
  if (config.model.providerSource === "default") {
    missingEnvVars.push("MODEL_PROVIDER");
  }

  const enabled = config.model.provider === "bedrock";
  const disabledReason = enabled
    ? undefined
    : config.model.providerSource === "default"
      ? "MODEL_PROVIDER is not configured"
      : `${config.model.providerSource}=${config.model.providerRawValue ?? "(empty)"}`;

  return {
    provider: config.model.provider,
    providerSource: config.model.providerSource,
    providerRawValue: config.model.providerRawValue,
    enabled,
    disabledReason,
    missingEnvVars,
    configuredEnvVars,
  };
}

function getImageFileExtension(objectKey?: string): string | undefined {
  const fileName = objectKey?.split("/").pop();
  if (!fileName) {
    return undefined;
  }

  const match = fileName.match(/\.([A-Za-z0-9]+)$/);
  return match?.[1]?.trim().toLowerCase() || undefined;
}

function isImageContentTypeCompatibleWithObjectKey(input: {
  objectKey?: string;
  contentType?: string;
}): boolean | undefined {
  const extension = getImageFileExtension(input.objectKey);
  const format = resolveBedrockImageFormat(input.contentType);
  if (!extension || !format) {
    return undefined;
  }

  const expectedExtensions = format === "jpeg" ? ["jpg", "jpeg"] : [format];
  return expectedExtensions.includes(extension);
}

function createPhotoVisionAnalyzer(): PhotoVisionAnalyzer {
  const visionProvider = buildVisionProviderDiagnostics();
  if (!visionProvider.enabled) {
    return {
      async analyze() {
        return {
          status: "failed",
          source: "vision_analysis_failed",
          skippedReason:
            visionProvider.disabledReason ?? "vision provider is not enabled",
        };
      },
    };
  }

  const client = new BedrockRuntimeClient({
    region: getConfig().model.bedrock.region,
  });

  return {
    async analyze(input: {
      currentSituation: string;
      fileName?: string;
      contentType?: string;
      bytes: Uint8Array;
    }): Promise<PhotoVisionAnalysisOutcome> {
      const config = getConfig();
      const format = resolveBedrockImageFormat(input.contentType);
      if (!format) {
        return {
          status: "failed",
          source: "image_fetch_failed",
          skippedReason: "unsupported image content type",
        };
      }

      const prompt =
        "Analyze this photo for X post generation. Return JSON only with keys: sceneInference, eventFeel, observedItems, postableElements, subjectCandidates, detectedTopics, suggestedPostAngles, ocrText. Keep strings concise. Do not invent text you cannot read.";
      const messages: NonNullable<ConverseCommandInput["messages"]> = [
        {
          role: "user",
          content: [
            { text: prompt },
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
      ];

      const request: ConverseCommandInput = {
        modelId: config.model.bedrock.modelId,
        messages,
        inferenceConfig: {
          maxTokens: 800,
          temperature: 0.1,
        },
      };

      logInfo("tableau.photo_post.visionRequestBuilt", {
        visionProvider: visionProvider.provider,
        visionProviderEnabled: visionProvider.enabled,
        visionProviderSource: visionProvider.providerSource,
        visionProviderMissingEnvVars: visionProvider.missingEnvVars,
        visionProviderConfiguredEnvVars: Object.fromEntries(
          Object.entries(visionProvider.configuredEnvVars).map(
            ([key, value]) => [key, Boolean(value?.trim())],
          ),
        ),
        visionModel: config.model.bedrock.modelId,
        visionInputImageIncluded: true,
        visionInputImageBytes: input.bytes.length,
        visionInputImageContentType: input.contentType,
        visionInputMessageCount: messages.length,
        visionPromptChars: prompt.length,
      });

      try {
        const response = await client.send(new ConverseCommand(request));
        const text = extractVisionResponseText(response);
        const preview = buildVisionRawOutputPreview(text);
        logInfo("tableau.photo_post.visionResponseReceived", {
          visionProvider: visionProvider.provider,
          visionProviderEnabled: visionProvider.enabled,
          visionProviderSource: visionProvider.providerSource,
          visionModel: config.model.bedrock.modelId,
          visionResponseTextPresent: Boolean(text),
          visionResponseTextLength: text.length,
          visionResponseStopReason:
            typeof response.stopReason === "string"
              ? response.stopReason
              : undefined,
          visionResponseUsageInputTokens:
            response.usage?.inputTokens ?? undefined,
          visionResponseUsageOutputTokens:
            response.usage?.outputTokens ?? undefined,
          visionRawOutputPreview: preview,
        });

        if (!text) {
          return {
            status: "no_usable_output",
            source: "vision_analysis_no_usable_output",
            skippedReason: "vision response was empty",
            responsePreview: preview,
            stopReason:
              typeof response.stopReason === "string"
                ? response.stopReason
                : undefined,
            inputTokens: response.usage?.inputTokens ?? undefined,
            outputTokens: response.usage?.outputTokens ?? undefined,
          };
        }

        const parsed = extractVisionStructuredOutput(text);
        const summary = buildVisionSummaryFromText(text, parsed);
        if (!summary) {
          return {
            status: "no_usable_output",
            source: "vision_analysis_no_usable_output",
            skippedReason: "vision analysis returned no usable output",
            rawText: text,
            responsePreview: preview,
            stopReason:
              typeof response.stopReason === "string"
                ? response.stopReason
                : undefined,
            inputTokens: response.usage?.inputTokens ?? undefined,
            outputTokens: response.usage?.outputTokens ?? undefined,
          };
        }

        return {
          status: "success",
          source: "actual_image",
          photoContext: {
            summary,
            ...(parsed.sceneInference
              ? { sceneInference: parsed.sceneInference }
              : {}),
            ...(parsed.eventFeel ? { eventFeel: parsed.eventFeel } : {}),
            ...(parsed.observedItems
              ? { observedItems: parsed.observedItems }
              : {}),
            ...(parsed.postableElements
              ? { postableElements: parsed.postableElements }
              : {}),
            ...(parsed.subjectCandidates
              ? { subjectCandidates: parsed.subjectCandidates }
              : {}),
            ...(parsed.detectedTopics
              ? { detectedTopics: parsed.detectedTopics }
              : {}),
            ...(parsed.suggestedPostAngles
              ? { suggestedPostAngles: parsed.suggestedPostAngles }
              : {}),
            ...(parsed.ocrText ? { ocrText: parsed.ocrText } : {}),
            ...(parsed.visibleText ? { visibleText: parsed.visibleText } : {}),
          },
          rawText: text,
          responsePreview: preview,
          stopReason:
            typeof response.stopReason === "string"
              ? response.stopReason
              : undefined,
          inputTokens: response.usage?.inputTokens ?? undefined,
          outputTokens: response.usage?.outputTokens ?? undefined,
        };
      } catch (error) {
        const errorDetails = safeErrorDetails(error);
        logWarn("tableau.photo_post.vision_failed", {
          failedInsightReason: errorDetails,
          fileName: input.fileName,
          visionProvider: visionProvider.provider,
          visionProviderEnabled: visionProvider.enabled,
          visionProviderSource: visionProvider.providerSource,
          visionModel: config.model.bedrock.modelId,
        });
        return {
          status: "failed",
          source: "vision_analysis_failed",
          skippedReason: "vision analysis failed",
          error:
            typeof errorDetails.message === "string"
              ? errorDetails.message
              : "vision analysis failed",
        };
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
    .split(/[\s\u3000,.;:\/(){}\[\]\-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .map((token) => token.replace(/[^\p{L}\p{N}]+/gu, ""))
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
