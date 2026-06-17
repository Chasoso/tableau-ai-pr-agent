import { getConfig } from "../config";
import { logInfo, logWarn } from "../logging";
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
  TableauPhotoPostAnalysisService,
  type AccountOverviewInsight,
  type PostPerformanceInsight,
  type PhotoPostAnalysisResult,
  type SurveyInsight,
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

    const generatedPostSuggestions =
      await generatePostSuggestionsFromEvidencePack({
        evidencePack: fixedAnalysis.evidencePack,
        postType: input.request.postType,
        tone: "natural",
        maxSuggestions: 3,
      });

    const normalizedGeneratedPostSuggestions =
      normalizeGeneratedPostSuggestions({
        suggestions: generatedPostSuggestions,
        evidencePack: fixedAnalysis.evidencePack,
      });

    const primarySuggestion = normalizedGeneratedPostSuggestions[0];
    logInfo("postSuggestionGenerationCompleted", {
      postType: input.request.postType,
      suggestionCount: normalizedGeneratedPostSuggestions.length,
      suggestionTextLengths: normalizedGeneratedPostSuggestions.map((item) =>
        countPostTextCharacters(item.text),
      ),
    });
    logInfo("postSuggestionCount", {
      postType: input.request.postType,
      count: normalizedGeneratedPostSuggestions.length,
    });

    let prDraft = await runPrDraftAgent({
      request: input.request,
      analysisSections: fixedAnalysis.analysisSections,
      evidencePack: fixedAnalysis.evidencePack,
      photoContext: fixedAnalysis.photoContext,
      postCopyLimitChars: POST_TEXT_LIMIT,
      copyGenerationAttempt: 1,
    });

    if (
      !isWithinPostTextLimit(
        prDraft.drafts.x || primarySuggestion?.text || "",
        POST_TEXT_LIMIT,
      )
    ) {
      logWarn("postSuggestionRetryRequested", {
        postType: input.request.postType,
        limit: POST_TEXT_LIMIT,
        draftLength: countPostTextCharacters(prDraft.drafts.x || ""),
        suggestionLength: primarySuggestion
          ? countPostTextCharacters(primarySuggestion.text)
          : 0,
      });
      const retriedDraft = await runPrDraftAgent({
        request: input.request,
        analysisSections: fixedAnalysis.analysisSections,
        evidencePack: fixedAnalysis.evidencePack,
        photoContext: fixedAnalysis.photoContext,
        postCopyLimitChars: POST_TEXT_LIMIT,
        copyGenerationAttempt: 2,
      });
      if (
        countPostTextCharacters(retriedDraft.drafts.x) <
        countPostTextCharacters(prDraft.drafts.x)
      ) {
        prDraft = retriedDraft;
      }
    }

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
    const primaryOutputType = "generated_post_suggestions" as const;
    const suggestedSlackPostText = resolveSharedPostText({
      primarySuggestionText: primarySuggestion?.text?.trim(),
      fallbackText: prDraft.drafts.x.trim(),
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
      draftVariants: prDraft.drafts,
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

async function generatePostSuggestionsFromEvidencePack(input: {
  evidencePack: PostGenerationEvidencePack;
  postType: ActionRunRequest["postType"];
  tone?: string;
  maxSuggestions?: number;
}): Promise<GeneratedPostSuggestion[]> {
  const maxSuggestions = Math.max(1, Math.min(input.maxSuggestions ?? 3, 5));
  const photoContext = input.evidencePack.photoContext;
  const photoContextAvailable = isMeaningfulPhotoContext(photoContext);
  logInfo("postSuggestionPhotoContextReceived", {
    photoContextAvailable,
    photoContextSource: photoContext.source,
    photoContextSummaryPresent: Boolean(photoContext.summary?.trim()),
    photoContextSummaryLength: photoContext.summary?.trim().length ?? 0,
    photoContextDetectedTopicCount: photoContext.detectedTopics?.length ?? 0,
    photoContextObservedItemCount: photoContext.observedItems?.length ?? 0,
  });
  const prompt = buildPostSuggestionPromptV2(input);
  logInfo("postSuggestionPromptBuilt", {
    postType: input.postType,
    promptChars: prompt.length,
  });
  logInfo("postSuggestionPromptChars", {
    postType: input.postType,
    promptChars: prompt.length,
  });
  logInfo("postSuggestionEvidenceAvailability", {
    postType: input.postType,
    photo: photoContextAvailable,
    eventContextAvailable: input.evidencePack.eventContext.available,
    survey: input.evidencePack.surveyInsight.available,
    postPerformance: input.evidencePack.postPerformanceInsight.available,
    accountOverview: input.evidencePack.accountOverviewInsight.available,
  });

  const eventName = normalizeMeaningfulText(
    input.evidencePack.eventContext.eventName,
  );
  const eventDateText = normalizeMeaningfulText(
    input.evidencePack.eventContext.eventDateText,
  );
  const eventDescription = normalizeMeaningfulText(
    input.evidencePack.eventContext.eventDescription,
  );
  const venue = normalizeMeaningfulText(input.evidencePack.eventContext.venue);
  const photoSummary = normalizeMeaningfulText(
    input.evidencePack.photoContext.summary,
  );
  const photoTopics = uniqueStrings(
    input.evidencePack.photoContext.detectedTopics ?? [],
  );
  const photoObservedItems = uniqueStrings(
    input.evidencePack.photoContext.observedItems ?? [],
  );
  const photoPostableElements = uniqueStrings(
    input.evidencePack.photoContext.postableElements ?? [],
  );
  const photoSubjectCandidates = uniqueStrings(
    input.evidencePack.photoContext.subjectCandidates ?? [],
  );
  const photoOcrText = normalizeMeaningfulText(
    input.evidencePack.photoContext.ocrText,
  );
  const surveyInsight = input.evidencePack
    .surveyInsight as Partial<SurveyInsight>;
  const postPerformanceInsight = input.evidencePack
    .postPerformanceInsight as Partial<PostPerformanceInsight>;
  const accountOverviewInsight = input.evidencePack
    .accountOverviewInsight as Partial<AccountOverviewInsight>;
  const surveyThemes = uniqueStrings([
    ...((surveyInsight.keyExpectations as string[] | undefined) ?? []),
    ...((surveyInsight.keyInterests as string[] | undefined) ?? []),
    ...((surveyInsight.suggestedAngles as string[] | undefined) ?? []),
  ]);
  const performanceThemes = uniqueStrings([
    ...((postPerformanceInsight.highPerformingThemes as string[] | undefined) ??
      []),
    ...((postPerformanceInsight.recommendedStructure as string[] | undefined) ??
      []),
    ...((postPerformanceInsight.recommendedTone as string[] | undefined) ?? []),
  ]);
  const accountThemes = uniqueStrings([
    ...((accountOverviewInsight.notableChanges as string[] | undefined) ?? []),
    ...((accountOverviewInsight.timingHints as string[] | undefined) ?? []),
  ]);
  const hashtags = buildHashtagsForSuggestion(eventName, input.postType);

  const suggestions: GeneratedPostSuggestion[] = [];
  const variants = [
    buildSuggestionVariant({
      variant: "opening",
      eventName,
      eventDateText,
      eventDescription,
      venue,
      photoContextAvailable,
      photoContextSource: photoContext.source,
      photoSummary,
      photoTopics,
      photoObservedItems,
      photoPostableElements,
      photoSubjectCandidates,
      photoOcrText,
      surveyThemes,
      performanceThemes,
      accountThemes,
      hashtags,
      tone: input.tone ?? "natural",
    }),
    buildSuggestionVariant({
      variant: "community",
      eventName,
      eventDateText,
      eventDescription,
      venue,
      photoContextAvailable,
      photoContextSource: photoContext.source,
      photoSummary,
      photoTopics,
      photoObservedItems,
      photoPostableElements,
      photoSubjectCandidates,
      photoOcrText,
      surveyThemes,
      performanceThemes,
      accountThemes,
      hashtags,
      tone: input.tone ?? "natural",
    }),
    buildSuggestionVariant({
      variant: "invitation",
      eventName,
      eventDateText,
      eventDescription,
      venue,
      photoContextAvailable,
      photoContextSource: photoContext.source,
      photoSummary,
      photoTopics,
      photoObservedItems,
      photoPostableElements,
      photoSubjectCandidates,
      photoOcrText,
      surveyThemes,
      performanceThemes,
      accountThemes,
      hashtags,
      tone: input.tone ?? "natural",
    }),
  ].slice(0, maxSuggestions);

  for (const variant of variants) {
    suggestions.push(variant);
  }

  return suggestions;
}

function summarizeEvidencePack(
  evidencePack: PostGenerationEvidencePack,
): Record<string, unknown> {
  return {
    photoContext: {
      available: evidencePack.photoContext.available,
      source: evidencePack.photoContext.source,
      summary: evidencePack.photoContext.summary,
      detectedTopics: evidencePack.photoContext.detectedTopics ?? [],
      observedItems: evidencePack.photoContext.observedItems ?? [],
      sceneInference: evidencePack.photoContext.sceneInference,
      eventFeel: evidencePack.photoContext.eventFeel,
      postableElements: evidencePack.photoContext.postableElements ?? [],
      subjectCandidates: evidencePack.photoContext.subjectCandidates ?? [],
      ocrText: evidencePack.photoContext.ocrText,
    },
    eventContext: {
      available: evidencePack.eventContext.available,
      source: evidencePack.eventContext.source,
      eventName: evidencePack.eventContext.eventName,
      eventDateText: evidencePack.eventContext.eventDateText,
      venue: evidencePack.eventContext.venue,
    },
    surveyInsight: {
      available: evidencePack.surveyInsight.available,
      sourceStatus: evidencePack.surveyInsight.sourceStatus,
      summary: evidencePack.surveyInsight.summary,
      keyFindings: evidencePack.surveyInsight.keyFindings ?? [],
    },
    postPerformanceInsight: {
      available: evidencePack.postPerformanceInsight.available,
      sourceStatus: evidencePack.postPerformanceInsight.sourceStatus,
      summary: evidencePack.postPerformanceInsight.summary,
      keyFindings: evidencePack.postPerformanceInsight.keyFindings ?? [],
    },
    accountOverviewInsight: {
      available: evidencePack.accountOverviewInsight.available,
      sourceStatus: evidencePack.accountOverviewInsight.sourceStatus,
      summary: evidencePack.accountOverviewInsight.summary,
      keyFindings: evidencePack.accountOverviewInsight.keyFindings ?? [],
    },
  };
}

function buildPostSuggestionPromptV2(input: {
  evidencePack: PostGenerationEvidencePack;
  postType: ActionRunRequest["postType"];
  tone?: string;
  maxSuggestions?: number;
}): string {
  const photoContext = input.evidencePack.photoContext;
  const photoSummary = normalizeMeaningfulText(photoContext.summary);
  const photoTopics = uniqueStrings(photoContext.detectedTopics ?? []);
  const photoObservedItems = uniqueStrings(photoContext.observedItems ?? []);
  const photoPostableElements = uniqueStrings(
    photoContext.postableElements ?? [],
  );
  const photoSubjectCandidates = uniqueStrings(
    photoContext.subjectCandidates ?? [],
  );

  return [
    "あなたはSNS投稿文のライターです。",
    "入力画像は実際に投稿へ添付されます。",
    "画像分析結果は、投稿文の現場感・雰囲気・文脈を補うために自然に使ってください。",
    "ただし、画像を説明するだけの文章にはしないでください。",
    "",
    `postType: ${input.postType}`,
    `tone: ${input.tone ?? "natural"}`,
    `maxSuggestions: ${input.maxSuggestions ?? 3}`,
    "",
    "画像分析結果:",
    `- photoContextAvailable: ${photoContext.available}`,
    `- photoContextSource: ${photoContext.source}`,
    `- photoContextSummary: ${photoSummary ?? "unavailable"}`,
    `- detectedTopics: ${photoTopics.length ? photoTopics.join(", ") : "none"}`,
    `- observedItems: ${photoObservedItems.length ? photoObservedItems.join(", ") : "none"}`,
    `- postableElements: ${photoPostableElements.length ? photoPostableElements.join(", ") : "none"}`,
    `- subjectCandidates: ${photoSubjectCandidates.length ? photoSubjectCandidates.join(", ") : "none"}`,
    `- ocrText: ${photoContext.ocrText?.trim() || "unavailable"}`,
    "",
    "生成するのは画像解析レポートではなく、Xにそのまま投稿できる文章です。",
    JSON.stringify(summarizeEvidencePack(input.evidencePack), null, 2),
  ].join("\n");
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
        photo: photoContextAvailable ? true : suggestion.usedEvidence.photo,
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

function buildSuggestionVariant(input: {
  variant: "opening" | "community" | "invitation";
  eventName?: string;
  eventDateText?: string;
  eventDescription?: string;
  venue?: string;
  photoContextAvailable: boolean;
  photoContextSource: PostGenerationEvidencePack["photoContext"]["source"];
  photoSummary?: string;
  photoTopics: string[];
  photoObservedItems: string[];
  photoPostableElements: string[];
  photoSubjectCandidates: string[];
  photoOcrText?: string;
  surveyThemes: string[];
  performanceThemes: string[];
  accountThemes: string[];
  hashtags: string[];
  tone: string;
}): GeneratedPostSuggestion {
  const lines: string[] = [];
  const hasEvent = Boolean(input.eventName);
  const hasPhoto = input.photoContextAvailable;
  const hasSurvey = input.surveyThemes.length > 0;
  const hasPerformance = input.performanceThemes.length > 0;
  const hasAccount = input.accountThemes.length > 0;
  const photoLead =
    input.photoSummary ??
    input.photoOcrText ??
    input.photoObservedItems[0] ??
    input.photoPostableElements[0] ??
    input.photoSubjectCandidates[0] ??
    input.photoTopics[0];

  const openingLine = buildOpeningLine(
    input.variant,
    input.eventName,
    input.eventDateText,
  );
  if (openingLine) {
    lines.push(openingLine);
  }

  if (input.variant === "opening") {
    if (photoLead) {
      lines.push(stripAnalysisLanguage(photoLead));
    }
    if (input.eventDescription) {
      lines.push(stripAnalysisLanguage(input.eventDescription));
    }
    if (input.venue) {
      lines.push(
        `${input.venue}の開催地は落ち着いた雰囲気で、写真からも会場の空気感が伝わります。`,
      );
    }
  }

  if (input.variant === "community") {
    const surveyHint = input.surveyThemes[0];
    const performanceHint = input.performanceThemes[0];
    const accountHint = input.accountThemes[0];
    const middleParts = [
      surveyHint
        ? `参加者が気にしそうな点として ${surveyHint} を自然に織り込みます。`
        : undefined,
      performanceHint
        ? `伸びやすい表現として ${performanceHint} の流れを取り入れます。`
        : undefined,
      accountHint
        ? `アカウントの文脈に合わせて ${accountHint} を反映します。`
        : undefined,
    ].filter((value): value is string => Boolean(value));
    if (middleParts.length) {
      lines.push(middleParts[0]);
    }
    if (input.photoTopics.length && lines.length < 3) {
      lines.push(
        `${input.photoTopics[0]}の要素を、自然な表現で投稿文に取り込みます。`,
      );
    }
  }

  if (input.variant === "invitation") {
    if (input.eventName) {
      lines.push(`ぜひ ${input.eventName} に参加してみてください。`);
    }
    lines.push(
      "会場の雰囲気や参加メリットが伝わるように、読みやすく案内します。",
    );
    if (input.eventDateText) {
      lines.push(`開催日は ${input.eventDateText} です。`);
    }
  }

  if (!lines.length) {
    lines.push(
      hasEvent
        ? `${input.eventName} の告知として、現場感が伝わる一文を中心にまとめます。`
        : "現場感が伝わる一文を中心にまとめます。",
    );
  }

  const body = uniqueStrings(lines).join("\n\n").trim();
  const hashtags = input.hashtags.slice(0, 3).join(" ");
  const text = hashtags ? `${body}\n\n${hashtags}` : body;

  return {
    text: limitPostLength(text),
    rationale: buildRationaleV2({
      hasEvent,
      hasPhoto,
      hasSurvey,
      hasPerformance,
      hasAccount,
      variant: input.variant,
    }),
    usedEvidence: {
      photo: hasPhoto,
      event: hasEvent,
      survey: hasSurvey,
      postPerformance: hasPerformance,
      accountOverview: hasAccount,
    },
    warnings: buildSuggestionWarnings({
      eventName: input.eventName,
      photoContextAvailable: input.photoContextAvailable,
      photoSummary: photoLead,
    }),
  };
}
function buildOpeningLine(
  variant: "opening" | "community" | "invitation",
  eventName?: string,
  eventDateText?: string,
): string {
  if (variant === "invitation") {
    return eventName
      ? `${eventName}、ぜひ参加してみてください。`
      : "ぜひ参加してみてください。";
  }

  if (variant === "community") {
    return eventName
      ? `${eventName}の現場は、少しずつ熱気が高まってきています。`
      : "現場の熱気が少しずつ高まってきています。";
  }

  if (eventName) {
    return eventDateText
      ? `${eventName}・${eventDateText}の告知を、現場感を込めてお届けします。`
      : `${eventName}の告知を、現場感を込めてお届けします。`;
  }

  return "Untitled event";
}

function buildRationaleV2(input: {
  hasEvent: boolean;
  hasPhoto: boolean;
  hasSurvey: boolean;
  hasPerformance: boolean;
  hasAccount: boolean;
  variant: "opening" | "community" | "invitation";
}): string {
  const parts = [
    input.hasPhoto
      ? "画像情報を使用しています。"
      : "画像情報は使っていません。",
    input.hasEvent
      ? "イベント情報を使用しています。"
      : "イベント情報は未取得です。",
    input.hasSurvey
      ? "参加者アンケートを反映しています。"
      : "参加者アンケートは未取得です。",
    input.hasPerformance
      ? "過去投稿の傾向を反映しています。"
      : "過去投稿の傾向は未取得です。",
    input.hasAccount
      ? "アカウント概要を反映しています。"
      : "アカウント概要は未取得です。",
    `variant: ${input.variant}`,
  ];
  return parts.join(" ");
}

function buildSuggestionWarnings(input: {
  eventName?: string;
  photoContextAvailable: boolean;
  photoSummary?: string;
}): string[] {
  const warnings: string[] = [];
  if (!input.eventName) {
    warnings.push("event_context_missing");
  }
  if (!input.photoContextAvailable) {
    warnings.push("photo_context_missing");
  } else if (!input.photoSummary) {
    // Photo context exists even when the summary is sparse; do not add a warning.
  }
  return warnings;
}

function limitPostLength(text: string): string {
  return truncatePostText(text, POST_TEXT_LIMIT);
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

function stripAnalysisLanguage(text: string): string {
  return text
    .replace(/^Photo context:\s*/iu, "")
    .replace(/^Event description:\s*/iu, "")
    .replace(/image file:\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildHashtagsForSuggestion(
  eventName?: string,
  postType?: ActionRunRequest["postType"],
): string[] {
  const tags = new Set<string>(["#Tableau"]);
  if (postType === "事前告知") {
    tags.add("#HokuTUG");
  }
  if (eventName) {
    const token = eventName
      .split(/\s+/u)
      .map((value) => value.replace(/[^A-Za-z0-9]/gu, ""))
      .find((value) => value.length >= 2);
    if (token) {
      tags.add(`#${token}`);
    }
  }
  return [...tags].slice(0, 4);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
  const eventName = getEffectiveEventName(request);
  const insightSummary = [
    fixedAnalysis.photoContext.summary,
    fixedAnalysis.evidencePack.eventContext.eventName,
    fixedAnalysis.surveyInsight?.evidenceSummary,
    fixedAnalysis.postPerformanceInsight?.evidenceSummary,
    fixedAnalysis.accountOverviewInsight?.evidenceSummary,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" / ");

  return `${eventName} ${request.postType} draft prepared. ${insightSummary}`.trim();
}

function buildEvidenceLines(
  request: ActionRunRequest,
  fixedAnalysis: PhotoPostAnalysisResult,
): string[] {
  const eventName = getEffectiveEventName(request);
  return [
    `Event name: ${eventName}`,
    `Current situation: ${request.currentSituation}`,
    `Photo context: ${fixedAnalysis.photoContext.summary}`,
    fixedAnalysis.evidencePack.eventContext.eventDescription
      ? `Event description: ${fixedAnalysis.evidencePack.eventContext.eventDescription}`
      : "Event description: unavailable",
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
  return `${getEffectiveEventName(request)} ${request.postType} image draft. Emphasize ${topLabel}.`;
}

function buildHashtags(request: ActionRunRequest): string[] {
  const hashtags = new Set<string>(["#Tableau", "#TechPlay"]);
  for (const token of getEffectiveEventName(request).split(/\s+/u)) {
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
