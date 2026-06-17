import { getConfig } from "../config";
import { logInfo } from "../logging";
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

    const primarySuggestion = generatedPostSuggestions[0];
    logInfo("postSuggestionGenerationCompleted", {
      postType: input.request.postType,
      suggestionCount: generatedPostSuggestions.length,
      suggestionTextLengths: generatedPostSuggestions.map(
        (item) => item.text.length,
      ),
    });
    logInfo("postSuggestionCount", {
      postType: input.request.postType,
      count: generatedPostSuggestions.length,
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
    const primaryOutputType = "generated_post_suggestions" as const;
    const suggestedSlackPostText =
      primarySuggestion?.text?.trim() || prDraft.drafts.x;

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
      generatedPostSuggestions,
      analysisSections: fixedAnalysis.analysisSections,
      evidencePack: fixedAnalysis.evidencePack,
      canGeneratePost: fixedAnalysis.evidencePack.canGeneratePost,
      generationBlockers: fixedAnalysis.evidencePack.generationBlockers,
      generatedPostSuggestion: primarySuggestion,
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
            draftLength:
              primarySuggestion?.text.length ?? prDraft.drafts.x.length,
            refinedLength:
              primarySuggestion?.text.length ?? prDraft.drafts.x.length,
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
      generatedPostSuggestionCount: generatedPostSuggestions.length,
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
  const prompt = buildPostSuggestionPrompt(input);
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
    photo: input.evidencePack.photoContext.available,
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
      photoSummary,
      photoTopics,
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
      photoSummary,
      photoTopics,
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
      photoSummary,
      photoTopics,
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

function buildPostSuggestionPrompt(input: {
  evidencePack: PostGenerationEvidencePack;
  postType: ActionRunRequest["postType"];
  tone?: string;
  maxSuggestions?: number;
}): string {
  return [
    "あなたの役割は、SNS投稿文のライターです。",
    "画像分析結果を説明するのではなく、Xにそのまま投稿できる自然な日本語の投稿文を作成してください。",
    `postType: ${input.postType}`,
    `tone: ${input.tone ?? "natural"}`,
    `maxSuggestions: ${input.maxSuggestions ?? 3}`,
    `photoContextAvailable: ${input.evidencePack.photoContext.available}`,
    `eventContextAvailable: ${input.evidencePack.eventContext.available}`,
    `surveyInsightAvailable: ${input.evidencePack.surveyInsight.available}`,
    `postPerformanceAvailable: ${input.evidencePack.postPerformanceInsight.available}`,
    `accountOverviewAvailable: ${input.evidencePack.accountOverviewInsight.available}`,
    JSON.stringify(summarizeEvidencePack(input.evidencePack), null, 2),
  ].join("\n");
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

function buildSuggestionVariant(input: {
  variant: "opening" | "community" | "invitation";
  eventName?: string;
  eventDateText?: string;
  eventDescription?: string;
  venue?: string;
  photoSummary?: string;
  photoTopics: string[];
  surveyThemes: string[];
  performanceThemes: string[];
  accountThemes: string[];
  hashtags: string[];
  tone: string;
}): GeneratedPostSuggestion {
  const lines: string[] = [];
  const hasEvent = Boolean(input.eventName);
  const hasPhoto = Boolean(input.photoSummary);
  const hasSurvey = input.surveyThemes.length > 0;
  const hasPerformance = input.performanceThemes.length > 0;
  const hasAccount = input.accountThemes.length > 0;

  const openingLine = buildOpeningLine(
    input.variant,
    input.eventName,
    input.eventDateText,
  );
  if (openingLine) {
    lines.push(openingLine);
  }

  if (input.variant === "opening") {
    if (input.photoSummary) {
      lines.push(stripAnalysisLanguage(input.photoSummary));
    }
    if (input.eventDescription) {
      lines.push(stripAnalysisLanguage(input.eventDescription));
    }
    if (input.venue) {
      lines.push(`${input.venue}の雰囲気も伝わる、落ち着いた立ち上がりです。`);
    }
  }

  if (input.variant === "community") {
    const surveyHint = input.surveyThemes[0];
    const performanceHint = input.performanceThemes[0];
    const accountHint = input.accountThemes[0];
    const middleParts = [
      surveyHint
        ? `参加される皆さんが気にしていそうな${surveyHint}も、自然に拾えると良さそうです。`
        : undefined,
      performanceHint
        ? `最近の反応がよかった流れも意識して、${performanceHint}のような短い導入に寄せています。`
        : undefined,
      accountHint
        ? `アカウント全体の流れともなじむように、${accountHint}を軽くにじませます。`
        : undefined,
    ].filter((value): value is string => Boolean(value));
    if (middleParts.length) {
      lines.push(middleParts[0]);
    }
    if (input.photoTopics.length && lines.length < 3) {
      lines.push(
        `${input.photoTopics[0]}の空気感を、ひと言で添えるイメージです。`,
      );
    }
  }

  if (input.variant === "invitation") {
    if (input.eventName) {
      lines.push(`今日は${input.eventName}。`);
    }
    lines.push(
      "会場の熱気を感じつつ、参加される皆さんと一緒に楽しんでいきましょう。",
    );
    if (input.eventDateText) {
      lines.push(`開催情報は${input.eventDateText}です。`);
    }
  }

  if (!lines.length) {
    lines.push(
      hasEvent
        ? `${input.eventName} の様子を、現場感が伝わる一文でまとめます。`
        : "現場感が伝わる一文でまとめます。",
    );
  }

  const body = uniqueStrings(lines).join("\n\n").trim();
  const hashtags = input.hashtags.slice(0, 3).join(" ");
  const text = hashtags ? `${body}\n\n${hashtags}` : body;

  return {
    text: limitPostLength(text),
    rationale: buildRationale({
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
      photoSummary: input.photoSummary,
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
      ? `${eventName}、まもなくスタートです！`
      : "まもなくスタートです！";
  }

  if (variant === "community") {
    return eventName
      ? `${eventName}、現場の空気が少しずつ高まってきました。`
      : "会場の空気が少しずつ高まってきました。";
  }

  if (eventName) {
    return eventDateText
      ? `${eventName}（${eventDateText}）の様子をお届けします。`
      : `${eventName}の様子をお届けします。`;
  }

  return "会場の様子をお届けします。";
}

function buildRationale(input: {
  hasEvent: boolean;
  hasPhoto: boolean;
  hasSurvey: boolean;
  hasPerformance: boolean;
  hasAccount: boolean;
  variant: "opening" | "community" | "invitation";
}): string {
  const parts = [
    input.hasPhoto
      ? "画像の現場感を起点にしています。"
      : "画像情報は使っていません。",
    input.hasEvent
      ? "イベント名や開催情報を自然に織り込んでいます。"
      : "イベント名は捏造していません。",
    input.hasSurvey
      ? "アンケート傾向を軽く反映しています。"
      : "アンケート情報は補助扱いです。",
    input.hasPerformance
      ? "過去の投稿傾向をトーン調整に使っています。"
      : "過去の投稿傾向は未取得でも成立するようにしています。",
    input.hasAccount
      ? "アカウント全体の流れも意識しています。"
      : "アカウント概要は未取得でも成立するようにしています。",
    `variant: ${input.variant}`,
  ];
  return parts.join(" ");
}

function buildSuggestionWarnings(input: {
  eventName?: string;
  photoSummary?: string;
}): string[] {
  const warnings: string[] = [];
  if (!input.eventName) {
    warnings.push("event_context_missing");
  }
  if (!input.photoSummary) {
    warnings.push("photo_context_missing");
  }
  return warnings;
}

function limitPostLength(text: string): string {
  if (text.length <= 280) {
    return text;
  }
  return `${text.slice(0, 277).trimEnd()}...`;
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
  if (postType === "開催中の実況") {
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

  return "イベント";
}

function normalizeMeaningfulText(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }

  if (/未取得|未設定|未入力|不明|なし|イベント情報は未取得です/i.test(text)) {
    return undefined;
  }

  return text;
}
