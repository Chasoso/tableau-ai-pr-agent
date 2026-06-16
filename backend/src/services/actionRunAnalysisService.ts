import { getConfig } from "../config";
import { DirectTableauApiContextProvider } from "../tableau/directTableauApiContextProvider";
import { MockTableauContextProvider } from "../tableau/mockTableauContextProvider";
import { TableauMcpContextProvider } from "../tableau/tableauMcpContextProvider";
import type { TableauContextProvider } from "../tableau/contextProvider";
import type { AuthenticatedUser } from "../types/auth";
import type {
  ActionRunAnalysisSection,
  ActionRunRequest,
  ActionRunResult,
} from "../types/actionRun";
import { runPrDraftAgent } from "../agents/prAgent";
import {
  TableauPhotoPostAnalysisService,
  type PhotoPostAnalysisResult,
} from "./tableauPhotoPostAnalysisService";

export class ActionRunAnalysisService {
  private readonly fixedWorkflowService: TableauPhotoPostAnalysisService;

  constructor(
    private readonly tableauContextProvider = createTableauContextProvider(),
    fixedWorkflowService?: TableauPhotoPostAnalysisService,
  ) {
    this.fixedWorkflowService =
      fixedWorkflowService ??
      new TableauPhotoPostAnalysisService(this.tableauContextProvider);
  }

  async analyzeActionRun(input: {
    request: ActionRunRequest;
    authenticatedUser?: AuthenticatedUser;
  }): Promise<ActionRunResult> {
    const fixedAnalysis = await this.fixedWorkflowService.analyze({
      request: input.request,
      authenticatedUser: input.authenticatedUser,
    });

    const prDraft = await runPrDraftAgent({
      request: input.request,
      analysisSections: fixedAnalysis.analysisSections,
      evidencePack: fixedAnalysis.evidencePack,
      photoContext: fixedAnalysis.photoContext,
    });

    const summary =
      prDraft.summary || buildSummary(input.request, fixedAnalysis);
    const evidence = prDraft.evidence.length
      ? prDraft.evidence
      : buildEvidenceLines(input.request, fixedAnalysis);
    const checks = prDraft.checks.length
      ? prDraft.checks
      : buildChecks(input.request);
    const hashtags = prDraft.hashtags.length
      ? prDraft.hashtags
      : buildHashtags(input.request);
    const imageCaption =
      prDraft.imageCaption ||
      buildImageCaption(input.request, fixedAnalysis.analysisSections);
    const warnings = collectWarnings(fixedAnalysis);

    return {
      summary,
      suggestedSlackPostText: prDraft.drafts.x,
      draftVariants: prDraft.drafts,
      draftReview: prDraft.review,
      hashtags,
      evidence,
      checks,
      imageCaption,
      analysisSections: fixedAnalysis.analysisSections,
      safetyReview: buildSafetyReview({
        request: input.request,
        warnings,
      }),
      debug: {
        source: "stub",
        requestEcho: {
          postType: input.request.postType,
          eventName: input.request.eventName,
          techplayUrl: input.request.techplayUrl,
          currentSituation: input.request.currentSituation,
        },
        tableau: {
          provider: this.tableauContextProvider.name,
          analysisQuestions: fixedAnalysis.analysisSections.map(
            (section) => section.question,
          ),
          warnings,
          qualityReview: {
            score: computeQualityScore(fixedAnalysis),
            issues: warnings,
            signals: collectTableauSignals(fixedAnalysis.analysisSections),
            draftLength: prDraft.drafts.x.length,
            refinedLength: prDraft.drafts.x.length,
          },
          prAgent: {
            enabled: getConfig().prAgent.useStrandsAgent,
            reviewStatus: prDraft.review.status,
            riskLevel: prDraft.review.riskLevel,
            missingFieldCount: prDraft.missingFields.length,
          },
        },
      },
    };
  }
}

function createTableauContextProvider(): TableauContextProvider {
  switch (getConfig().tableau.contextProvider) {
    case "direct-api":
      return new DirectTableauApiContextProvider();
    case "mcp":
      return new TableauMcpContextProvider();
    case "mock":
    default:
      return new MockTableauContextProvider();
  }
}

function buildSummary(
  request: ActionRunRequest,
  fixedAnalysis: PhotoPostAnalysisResult,
): string {
  const insightSummary = [
    fixedAnalysis.photoContext.summary,
    fixedAnalysis.surveyInsight?.evidenceSummary,
    fixedAnalysis.postPerformanceInsight?.evidenceSummary,
    fixedAnalysis.accountOverviewInsight?.evidenceSummary,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" / ");

  return `${request.eventName} ${request.postType} draft prepared. ${insightSummary}`.trim();
}

function buildEvidenceLines(
  request: ActionRunRequest,
  fixedAnalysis: PhotoPostAnalysisResult,
): string[] {
  return [
    `Event name: ${request.eventName}`,
    `Current situation: ${request.currentSituation}`,
    `Photo context: ${fixedAnalysis.photoContext.summary}`,
    fixedAnalysis.surveyInsight
      ? `Survey insight: ${fixedAnalysis.surveyInsight.evidenceSummary}`
      : "Survey insight: unavailable",
    fixedAnalysis.postPerformanceInsight
      ? `Post performance insight: ${fixedAnalysis.postPerformanceInsight.evidenceSummary}`
      : "Post performance insight: unavailable",
    fixedAnalysis.accountOverviewInsight
      ? `Account overview insight: ${fixedAnalysis.accountOverviewInsight.evidenceSummary}`
      : "Account overview insight: unavailable",
  ];
}

function buildChecks(request: ActionRunRequest): string[] {
  return [
    "Confirm the event name and TechPlay URL match.",
    "Confirm the current situation matches the venue reality.",
    `Confirm the requested post type "${request.postType}" is appropriate.`,
    "Check for faces, badges, name tags, and sensitive content before publishing.",
    "Strip EXIF metadata from any uploaded photo before reuse.",
  ];
}

function buildSafetyReview(input: {
  request: ActionRunRequest;
  warnings: string[];
}): NonNullable<ActionRunResult["safetyReview"]> {
  return {
    status: "pending_manual_review",
    required: true,
    checklist: buildChecks(input.request),
    notes: [
      "Human approval is required before any Slack post is sent.",
      "Review any uploaded photo for faces, badges, slides, and screens before posting.",
      "Strip EXIF metadata from any uploaded photo before reuse.",
      ...input.warnings.map((warning) => `Tableau warning: ${warning}`),
    ],
  };
}

function buildImageCaption(
  request: ActionRunRequest,
  analysisSections: ActionRunAnalysisSection[],
): string {
  const topLabel = collectTableauSignals(analysisSections)[0] ?? "in progress";
  return `${request.eventName} ${request.postType} image draft. Emphasize ${topLabel}.`;
}

function buildHashtags(request: ActionRunRequest): string[] {
  const hashtags = new Set<string>(["#Tableau", "#TechPlay"]);
  for (const token of request.eventName.split(/\s+/u)) {
    const cleaned = token.replace(/[^A-Za-z0-9]/g, "").trim();
    if (cleaned.length >= 2) {
      hashtags.add(`#${cleaned}`);
    }
  }
  return [...hashtags].slice(0, 5);
}

function collectWarnings(input: PhotoPostAnalysisResult): string[] {
  return [
    ...(input.datasourceResolution.unresolvedDatasourceKeys.length
      ? [
          `Skipped analyses for unresolved datasources: ${input.datasourceResolution.unresolvedDatasourceKeys.join(", ")}`,
        ]
      : []),
    ...(input.surveyInsight?.available === false
      ? [input.surveyInsight.evidenceSummary]
      : []),
    ...(input.postPerformanceInsight?.available === false
      ? [input.postPerformanceInsight.evidenceSummary]
      : []),
    ...(input.accountOverviewInsight?.available === false
      ? [input.accountOverviewInsight.evidenceSummary]
      : []),
  ];
}

function collectTableauSignals(
  analysisSections: ActionRunAnalysisSection[],
): string[] {
  return analysisSections
    .map((section) => {
      const firstRow = section.rows[0];
      const label = firstRow?.label?.trim() || section.title;
      return `${section.title}: ${label}`;
    })
    .filter(Boolean);
}

function computeQualityScore(input: PhotoPostAnalysisResult): number {
  const resolvedCount =
    input.datasourceResolution.resolvedDatasourceKeys.length;
  const availableInsights = [
    input.surveyInsight?.available,
    input.postPerformanceInsight?.available,
    input.accountOverviewInsight?.available,
  ].filter(Boolean).length;
  return Math.max(
    0,
    Math.min(100, 45 + resolvedCount * 10 + availableInsights * 10),
  );
}
