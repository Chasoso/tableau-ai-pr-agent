import { getConfig } from "../config";
import { logInfo } from "../logging";
import { buildActionRunPublicImageUrl } from "./actionRunImageUrlService";
import { DirectTableauApiContextProvider } from "../tableau/directTableauApiContextProvider";
import { MockTableauContextProvider } from "../tableau/mockTableauContextProvider";
import { TableauMcpContextProvider } from "../tableau/tableauMcpContextProvider";
import type { TableauContextProvider } from "../tableau/contextProvider";
import type { AuthenticatedUser } from "../types/auth";
import type {
  ActionRunAnalysisSection,
  ActionRunRequest,
  ActionRunResult,
  GeneratedPostSuggestion,
  PostGenerationEvidencePack,
} from "../types/actionRun";
import { runPrDraftAgent } from "../agents/prAgent";
import {
  countPostTextCharacters,
  isWithinPostTextLimit,
  POST_TEXT_LIMIT,
  truncatePostText,
} from "../utils/postText";
import {
  buildChannelDrafts,
  buildImageCaption as buildSafeImageCaption,
  buildPostMaterial,
  buildPostQualityResult,
  generatePostSuggestionsWithDiagnostics,
  type PostMaterial,
} from "./postCopyService";
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

    logInfo("evidencePackSummary", {
      photoContextAvailable: fixedAnalysis.photoContext.available,
      eventContextAvailable: fixedAnalysis.evidencePack.eventContext.available,
      surveyInsightAvailable: fixedAnalysis.surveyInsight?.available ?? false,
      postPerformanceInsightAvailable:
        fixedAnalysis.postPerformanceInsight?.available ?? false,
      accountOverviewInsightAvailable:
        fixedAnalysis.accountOverviewInsight?.available ?? false,
      canGeneratePost: fixedAnalysis.evidencePack.canGeneratePost,
      generationBlockers: fixedAnalysis.evidencePack.generationBlockers,
    });

    if (!fixedAnalysis.evidencePack.canGeneratePost) {
      const blockers = fixedAnalysis.evidencePack.generationBlockers ?? [];
      return {
        summary:
          "Required analysis was not completed. Post generation was blocked.",
        suggestedSlackPostText: "",
        draftVariants: {
          x: "",
          linkedin: "",
          email: "",
          notion: "",
        },
        hashtags: [],
        evidence: [],
        checks: [],
        imageCaption: "",
        primaryOutputType: "analysis_summary",
        generatedPostSuggestions: [],
        analysisSections: fixedAnalysis.analysisSections,
        evidencePack: fixedAnalysis.evidencePack,
        canGeneratePost: false,
        generationBlockers: blockers,
        safetyReview: buildSafetyReview({
          request: input.request,
          warnings: blockers,
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
            warnings: blockers,
            qualityReview: {
              score: computeQualityScore(fixedAnalysis),
              issues: blockers,
              signals: collectTableauSignals(fixedAnalysis.analysisSections),
              draftLength: 0,
              refinedLength: 0,
            },
            prAgent: {
              enabled: getConfig().prAgent.useStrandsAgent,
              reviewStatus: "needs_info",
              riskLevel: "high",
              missingFieldCount: blockers.length,
            },
          },
        },
      };
    }

    logInfo("postSuggestionGenerationStarted", {
      postType: input.request.postType,
      tone: "natural",
      maxSuggestions: 3,
      evidencePackAvailable: true,
    });

    const postMaterial = buildPostMaterial({
      request: input.request,
      analysisSections: fixedAnalysis.analysisSections,
      evidencePack: fixedAnalysis.evidencePack,
    });
    logInfo("tableau.post_material.insights", {
      tableauPostInsights: postMaterial.tableauInsights ?? [],
      audienceContext: postMaterial.audienceContext,
      surveyInsightForPost: postMaterial.surveyInsightForPost,
      toneHints: postMaterial.toneHints ?? [],
      structureHints: postMaterial.structureHints ?? [],
      contentHints: postMaterial.contentHints ?? [],
    });
    const generatedSuggestionsResult = generatePostSuggestionsWithDiagnostics({
      material: postMaterial,
      maxSuggestions: 3,
    });
    const generatedPostSuggestions = generatedSuggestionsResult.suggestions;
    const normalizedGeneratedPostSuggestions =
      normalizeGeneratedPostSuggestions({
        suggestions: generatedPostSuggestions,
        evidencePack: fixedAnalysis.evidencePack,
      });
    const channelDrafts = buildChannelDrafts({ material: postMaterial });
    const primarySuggestion = normalizedGeneratedPostSuggestions[0];
    const primarySuggestionQuality = primarySuggestion
      ? buildPostQualityResult(primarySuggestion.text, {
          hashtags: postMaterial.hashtags,
          hashtagCandidates: postMaterial.hashtagCandidates,
          channel: "x",
        })
      : { ok: true, issues: [] };
    logInfo("postSuggestionGenerationCompleted", {
      postType: input.request.postType,
      suggestionCount: normalizedGeneratedPostSuggestions.length,
      desiredVariantCount:
        generatedSuggestionsResult.diagnostics.desiredVariantCount,
      generatedCount: generatedSuggestionsResult.diagnostics.generatedCount,
      excludedCount: generatedSuggestionsResult.diagnostics.excludedCount,
      globalIssues: generatedSuggestionsResult.diagnostics.globalIssues.map(
        (issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          insightSummary: issue.insightSummary,
        }),
      ),
      excludedReasons:
        generatedSuggestionsResult.diagnostics.excludedReasons.map((item) => ({
          variant: item.variant,
          issueCodes: item.issues.map((issue) => issue.code),
        })),
      variantUsage: normalizedGeneratedPostSuggestions.map((item) => ({
        variant: item.variant ?? "unknown",
        usedInsights: item.usedTableauInsights ?? [],
        omittedReason: item.omittedTableauInsightReason,
      })),
      eventThemes: postMaterial.eventThemes ?? [],
      sessionTitles: postMaterial.sessionTitles ?? [],
      photoAtmosphere: postMaterial.photoAtmosphere ?? null,
      suggestionTextLengths: normalizedGeneratedPostSuggestions.map((item) =>
        countPostTextCharacters(item.text),
      ),
    });
    const rawTableauLeakIssues =
      generatedSuggestionsResult.diagnostics.excludedReasons.flatMap((item) =>
        item.issues
          .filter((issue) => issue.code === "raw_tableau_data_leaked")
          .map((issue) => ({
            variant: item.variant,
            matchedText: issue.matchedText,
          })),
      );
    if (rawTableauLeakIssues.length > 0) {
      logInfo("tableau.post_material.raw_leak_blocked", {
        matches: rawTableauLeakIssues,
      });
    }
    logInfo("postSuggestionCount", {
      postType: input.request.postType,
      count: normalizedGeneratedPostSuggestions.length,
    });
    if (generatedSuggestionsResult.diagnostics.generatedCount < 3) {
      logInfo("postSuggestionGenerationShortfall", {
        postType: input.request.postType,
        desiredVariantCount:
          generatedSuggestionsResult.diagnostics.desiredVariantCount,
        generatedCount: generatedSuggestionsResult.diagnostics.generatedCount,
        excludedCount: generatedSuggestionsResult.diagnostics.excludedCount,
      });
    }

    const prDraft = await runPrDraftAgent({
      request: input.request,
      analysisSections: fixedAnalysis.analysisSections,
      evidencePack: fixedAnalysis.evidencePack,
      photoContext: fixedAnalysis.photoContext,
      postCopyLimitChars: POST_TEXT_LIMIT,
      copyGenerationAttempt: 1,
    });
    const summary = buildSummaryFromMaterial(postMaterial);
    const evidence = buildEvidenceLinesFromMaterial(
      input.request,
      fixedAnalysis,
      postMaterial,
    );
    const checks = buildChecks(input.request);
    const hashtags = postMaterial.hashtags;
    const imageCaption = buildSafeImageCaption(postMaterial);
    const warnings = collectWarnings(fixedAnalysis);
    const primaryOutputType = "generated_post_suggestions" as const;
    const suggestedSlackPostText = resolveSharedPostText({
      primarySuggestionText:
        primarySuggestionQuality.ok && primarySuggestion
          ? primarySuggestion.text.trim()
          : undefined,
      fallbackText: channelDrafts.x.trim(),
      limit: POST_TEXT_LIMIT,
    });
    const attachedImage = buildAttachedInputImage(input.request);
    logInfo("photoPostResultBuilt", {
      primaryOutputType,
      hasGeneratedPostSuggestions:
        normalizedGeneratedPostSuggestions.length > 0,
      generatedPostSuggestionCount: normalizedGeneratedPostSuggestions.length,
      hasAttachedInputImage: Boolean(attachedImage),
      attachedInputImageObjectKeyPresent: Boolean(attachedImage?.objectKey),
      hasPosterImage: false,
      posterGenerationSkipped: true,
    });

    const result: ActionRunResult = {
      summary,
      suggestedSlackPostText,
      draftVariants: channelDrafts,
      draftReview: prDraft.review,
      hashtags,
      evidence,
      checks,
      imageCaption,
      primaryOutputType,
      generatedPostSuggestions: normalizedGeneratedPostSuggestions,
      analysisSections: fixedAnalysis.analysisSections,
      evidencePack: fixedAnalysis.evidencePack,
      canGeneratePost: fixedAnalysis.evidencePack.canGeneratePost,
      generationBlockers: fixedAnalysis.evidencePack.generationBlockers,
      generatedPostSuggestion: primarySuggestion,
      ...(attachedImage ? { attachedImage } : {}),
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
            draftLength: primarySuggestion?.text
              ? countPostTextCharacters(primarySuggestion.text)
              : countPostTextCharacters(prDraft.drafts.x),
            refinedLength: primarySuggestion?.text
              ? countPostTextCharacters(primarySuggestion.text)
              : countPostTextCharacters(prDraft.drafts.x),
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

    logInfo("generatedPostSuggestionSaved", {
      postType: input.request.postType,
      primaryOutputType,
      generatedPostSuggestionCount: normalizedGeneratedPostSuggestions.length,
      hasPrimarySuggestion: Boolean(primarySuggestion),
    });

    return result;
  }
}

function normalizeGeneratedPostSuggestions(input: {
  suggestions: GeneratedPostSuggestion[];
  evidencePack: PostGenerationEvidencePack;
}): GeneratedPostSuggestion[] {
  const photoContext = input.evidencePack.photoContext;
  const photoContextAvailable = isMeaningfulPhotoContext(photoContext);

  return input.suggestions.map((suggestion, index) => {
    logInfo("postSuggestionNormalizationStarted", {
      suggestionIndex: index,
      rawSuggestionUsedPhoto: suggestion.usedEvidence.photo,
      photoContextAvailable,
      photoContextSource: photoContext.source,
      rawSuggestionWarnings: suggestion.warnings,
    });

    const rawWarnings = uniqueStrings(suggestion.warnings ?? []);
    const normalizedWarnings = [...rawWarnings];
    const removedWarnings: string[] = [];
    const addedWarnings: string[] = [];

    if (photoContextAvailable) {
      if (!suggestion.usedEvidence.photo) {
        logInfo("normalizedSuggestionUsedPhoto", {
          suggestionIndex: index,
          rawSuggestionUsedPhoto: suggestion.usedEvidence.photo,
          normalizedSuggestionUsedPhoto: true,
          photoContextAvailable,
        });
      }
      if (normalizedWarnings.includes("photo_context_missing")) {
        normalizedWarnings.splice(
          normalizedWarnings.indexOf("photo_context_missing"),
          1,
        );
        removedWarnings.push("photo_context_missing");
      }
    } else if (!normalizedWarnings.includes("photo_context_missing")) {
      normalizedWarnings.push("photo_context_missing");
      addedWarnings.push("photo_context_missing");
    }

    if (addedWarnings.length) {
      logInfo("photoContextMissingWarningAdded", {
        suggestionIndex: index,
        addedWarnings,
      });
    }
    if (removedWarnings.length) {
      logInfo("photoContextMissingWarningRemoved", {
        suggestionIndex: index,
        removedWarnings,
      });
    }

    const normalizedSuggestion: GeneratedPostSuggestion = {
      ...suggestion,
      usedEvidence: {
        ...suggestion.usedEvidence,
        photo: photoContextAvailable,
      },
      warnings: normalizedWarnings,
    };

    logInfo("suggestionWarnings", {
      suggestionIndex: index,
      suggestionWarnings: normalizedSuggestion.warnings,
    });
    logInfo("normalizedSuggestionUsedPhoto", {
      suggestionIndex: index,
      rawSuggestionUsedPhoto: suggestion.usedEvidence.photo,
      normalizedSuggestionUsedPhoto: normalizedSuggestion.usedEvidence.photo,
      photoContextAvailable,
    });

    return normalizedSuggestion;
  });
}

function isMeaningfulPhotoContext(
  photoContext: PostGenerationEvidencePack["photoContext"],
): boolean {
  return (
    photoContext.available === true &&
    photoContext.source === "actual_image" &&
    Boolean(
      normalizeMeaningfulText(photoContext.summary) ||
      (photoContext.detectedTopics?.length ?? 0) > 0 ||
      (photoContext.observedItems?.length ?? 0) > 0 ||
      (photoContext.postableElements?.length ?? 0) > 0 ||
      (photoContext.subjectCandidates?.length ?? 0) > 0 ||
      normalizeMeaningfulText(photoContext.ocrText),
    )
  );
}

function buildAttachedInputImage(
  request: ActionRunRequest,
): ActionRunResult["attachedImage"] | undefined {
  const inputImage = request.inputImage;
  const objectKey =
    inputImage?.objectKey?.trim() ??
    request.clientContext?.photo?.objectKey?.trim();
  if (!objectKey) {
    return undefined;
  }

  const contentType =
    normalizeContentType(inputImage?.contentType) ??
    normalizeContentType(request.clientContext?.photo?.contentType) ??
    normalizeContentType(request.clientContext?.photo?.mimeType);

  if (!contentType) {
    return undefined;
  }

  return {
    source: "original_input_image",
    objectKey,
    url: buildActionRunPublicImageUrl(objectKey),
    contentType,
    ...(inputImage?.bytes ? { byteLength: inputImage.bytes } : {}),
    ...(inputImage?.width ? { width: inputImage.width } : {}),
    ...(inputImage?.height ? { height: inputImage.height } : {}),
  };
}

function normalizeContentType(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function buildSummaryFromMaterial(material: PostMaterial): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "イベント";
  const topics = material.mainTopics?.slice(0, 3).join("、");
  const parts = [
    `${shortName}の投稿案を作成しました。`,
    topics ? `見どころは${topics}です。` : undefined,
    material.audienceContext ? material.audienceContext : undefined,
  ].filter((value): value is string => Boolean(value));

  return parts.join(" ");
}

function buildEvidenceLinesFromMaterial(
  request: ActionRunRequest,
  fixedAnalysis: PhotoPostAnalysisResult,
  material: PostMaterial,
): string[] {
  return [
    `Event name: ${material.eventShortName ?? material.eventOfficialName ?? getEffectiveEventName(request)}`,
    `Post type: ${material.postType}`,
    `Current situation: ${material.situation ?? request.currentSituation}`,
    material.photoDescriptionForPost
      ? `Photo: ${material.photoDescriptionForPost}`
      : undefined,
    material.mood ? `Mood: ${material.mood}` : undefined,
    material.audienceContext
      ? `Audience: ${material.audienceContext}`
      : undefined,
    material.speakerOrSessionContext
      ? `Session: ${material.speakerOrSessionContext}`
      : undefined,
    material.mainTopics?.length
      ? `Topics: ${material.mainTopics.slice(0, 3).join(" / ")}`
      : undefined,
    fixedAnalysis.evidencePack.eventContext.eventUrl
      ? "Event URL available"
      : undefined,
  ].filter((value): value is string => Boolean(value));
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
      const summary = section.summary?.trim() || section.title;
      return `${section.title}: ${summary}`;
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

function getEffectiveEventName(request: ActionRunRequest): string {
  const eventContextName = normalizeMeaningfulText(
    request.eventContext?.eventName,
  );
  if (eventContextName) {
    return eventContextName;
  }

  const requestEventName = normalizeMeaningfulText(request.eventName);
  if (requestEventName) {
    return requestEventName;
  }

  return "Untitled event";
}

function normalizeMeaningfulText(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }

  return text;
}

function resolveSharedPostText(input: {
  primarySuggestionText?: string;
  fallbackText: string;
  limit: number;
}): string {
  const candidates = [
    input.primarySuggestionText?.trim(),
    input.fallbackText.trim(),
  ].filter((value): value is string => Boolean(value));

  const withinLimit = candidates.find((value) =>
    isWithinPostTextLimit(value, input.limit),
  );
  if (withinLimit) {
    return withinLimit;
  }

  return truncatePostText(candidates[0] ?? input.fallbackText, input.limit);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter(Boolean) as string[],
    ),
  ];
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
