import type {
  ActionRunAnalysisSection,
  ActionRunRequest,
  GeneratedPostSuggestion,
} from "../types/actionRun";
import type { PostGenerationEvidencePack } from "./tableauPhotoPostAnalysisService";
import { POST_TEXT_LIMIT, truncatePostText } from "../utils/postText";
import {
  buildHashtagCandidates,
  buildHashtagLine,
  buildHashtagQualityIssues,
  selectHashtags,
  type HashtagCandidate,
  type HashtagChannel,
} from "./hashtagService";

export type TableauPostInsight = {
  source: "survey" | "post_performance" | "account_overview";
  kind:
    | "audience_context"
    | "tone_hint"
    | "structure_hint"
    | "timing_hint"
    | "content_hint"
    | "low_confidence";
  summaryForPost: string;
  confidence: number;
  shouldUseInPost: boolean;
  reason?: string;
};

export type PostMaterial = {
  postType:
    | "pre_event"
    | "live_report"
    | "post_event_thanks"
    | "recap"
    | "generic";
  eventShortName?: string;
  eventOfficialName?: string;
  eventUrl?: string;
  eventDateText?: string;
  situation?: string;
  eventThemes?: string[];
  sessionTitles?: string[];
  speakerNames?: string[];
  venueMood?: string;
  photoAtmosphere?: string;
  photoPostableDescription?: string;
  mood?: string;
  mainTopics?: string[];
  audienceContext?: string;
  surveyInsightForPost?: string;
  speakerOrSessionContext?: string;
  photoDescriptionForPost?: string;
  toneHints?: string[];
  structureHints?: string[];
  contentHints?: string[];
  tableauInsights?: TableauPostInsight[];
  callToAction?: string;
  hashtags: string[];
  hashtagCandidates?: HashtagCandidate[];
};

export type PostQualityIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  matchedText?: string;
  insightSummary?: string;
};

export type PostQualityResult = {
  ok: boolean;
  issues: PostQualityIssue[];
};

export type PostSuggestionGenerationDiagnostics = {
  desiredVariantCount: number;
  generatedCount: number;
  excludedCount: number;
  globalIssues: PostQualityIssue[];
  excludedReasons: Array<{
    variant: string;
    issues: PostQualityIssue[];
  }>;
};

export type PostCopyDrafts = {
  x: string;
  linkedin: string;
  email: string;
  notion: string;
};

const FORBIDDEN_PATTERNS: Array<{
  code: string;
  severity: "error" | "warning";
  pattern: RegExp;
}> = [
  {
    code: "raw_tableau_data_leaked",
    severity: "error",
    pattern:
      /\b(?:top item|metric|dimension|rank_metric|rank_label|Response Id|Post Hashtags\.Csv|Mcp Awareness)\b/i,
  },
  {
    code: "raw_tableau_data_leaked",
    severity: "error",
    pattern:
      /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\b/u,
  },
  { code: "metric", severity: "error", pattern: /\bmetric\b/i },
  { code: "dimension", severity: "error", pattern: /\bdimension\b/i },
  { code: "top_item", severity: "error", pattern: /\btop item\b/i },
  { code: "rank_metric", severity: "error", pattern: /\brank_metric\b/i },
  { code: "rank_label", severity: "error", pattern: /\brank_label\b/i },
  { code: "workbook_missing", severity: "error", pattern: /Workbook missing/i },
  { code: "dashboard_label", severity: "error", pattern: /Dashboard:/i },
  {
    code: "techplay_missing",
    severity: "error",
    pattern: /TechPlay summary:\s*missing/i,
  },
  { code: "human_approval", severity: "error", pattern: /Human approval/i },
  { code: "source_status", severity: "error", pattern: /\bsourceStatus\b/i },
  { code: "object_key", severity: "error", pattern: /\bobjectKey\b/i },
  { code: "s3", severity: "error", pattern: /\bS3\b/i },
  { code: "size", severity: "error", pattern: /\bSize:/i },
  { code: "image_label", severity: "error", pattern: /\bImage:/i },
  { code: "chatgpt_image", severity: "error", pattern: /ChatGPT Image/i },
  { code: "image_prefix", severity: "error", pattern: /画像:/i },
  { code: "venue_memo", severity: "error", pattern: /会場メモ未入力/i },
  {
    code: "instruction_naturalize",
    severity: "error",
    pattern: /自然に織り込みます/i,
  },
  {
    code: "instruction_readable",
    severity: "error",
    pattern: /読みやすく案内します/i,
  },
  {
    code: "instruction_scene",
    severity: "error",
    pattern: /現場感を込めてお届けします/i,
  },
  {
    code: "instruction_benefit",
    severity: "error",
    pattern: /参加メリットが伝わるように/i,
  },
  {
    code: "instruction_announce",
    severity: "error",
    pattern: /告知をお届けします/i,
  },
  { code: "variant", severity: "error", pattern: /\bvariant:/i },
  { code: "friendship", severity: "error", pattern: /\bfriendship\b/i },
  { code: "teamwork", severity: "error", pattern: /\bteamwork\b/i },
  { code: "positivity", severity: "error", pattern: /\bpositivity\b/i },
  {
    code: "draft_only",
    severity: "warning",
    pattern: /Draft-only mode is enforced/i,
  },
  { code: "missing_fields", severity: "warning", pattern: /Missing fields/i },
  {
    code: "confirm_event",
    severity: "warning",
    pattern: /Confirm the event name/i,
  },
  {
    code: "strip_exif",
    severity: "warning",
    pattern: /Strip EXIF metadata/i,
  },
  {
    code: "faces_review",
    severity: "warning",
    pattern: /Check for faces, badges, name tags/i,
  },
];

export function buildPostMaterial(input: {
  request: ActionRunRequest;
  analysisSections: ActionRunAnalysisSection[];
  evidencePack?: PostGenerationEvidencePack;
}): PostMaterial {
  const evidencePack = input.evidencePack;
  const tableauInsights = deriveTableauPostInsightsV3(evidencePack);
  const eventOfficialName = normalize(
    evidencePack?.eventContext.eventName ?? input.request.eventName,
  );
  const eventShortName = shortenEventName(eventOfficialName);
  const eventUrl = normalize(
    evidencePack?.eventContext.eventUrl ?? input.request.eventUrl,
  );
  const eventDateText = normalize(
    evidencePack?.eventContext.eventDateText ??
      input.request.eventContext?.eventDateText,
  );
  const eventDescriptionTexts = compactStrings([
    evidencePack?.eventContext.eventDescription,
    input.request.eventContext?.eventDescription,
  ]);
  const eventThemes = deriveEventThemesV3({
    eventDescriptionTexts,
    eventName: eventOfficialName,
    analysisSections: input.analysisSections,
  });
  const sessionTitles = deriveSessionTitlesV3({
    eventDescriptionTexts,
    analysisSections: input.analysisSections,
  });
  const photoAtmosphere = derivePhotoAtmosphereV3(input.request, evidencePack);
  const photoPostableDescription =
    photoAtmosphere ??
    derivePhotoPostableDescription(input.request, evidencePack);
  const photoDescriptionForPost = photoPostableDescription;
  const mood = deriveMoodV3(
    input.request,
    evidencePack,
    photoDescriptionForPost,
  );
  const mainTopics = uniqueStrings([...eventThemes, ...sessionTitles]).slice(
    0,
    3,
  );
  const audienceContext =
    deriveAudienceContextFromInsights(tableauInsights) ??
    deriveAudienceContext(input.analysisSections, evidencePack);
  const surveyInsightForPost = buildSurveyInsightForPostV3(tableauInsights);
  const toneHints = collectInsightSummaries(tableauInsights, "tone_hint");
  const structureHints = collectInsightSummaries(
    tableauInsights,
    "structure_hint",
  );
  const contentHints = collectInsightSummaries(tableauInsights, "content_hint");
  const speakerOrSessionContext = deriveSessionContext(
    input.analysisSections,
    sessionTitles.length ? sessionTitles : eventThemes,
    evidencePack,
  );
  const hashtagCandidates = buildHashtagCandidates({
    webPageTexts: compactStrings([
      evidencePack?.eventContext.eventDescription,
      evidencePack?.eventContext.eventName,
    ]),
    eventDescriptionTexts: compactStrings([
      evidencePack?.eventContext.eventDescription,
      input.request.eventContext?.eventDescription,
    ]),
    userInputTexts: compactStrings([
      input.request.eventName,
      input.request.currentSituation,
      input.request.venueMemo,
      input.request.eventContext?.eventName,
      input.request.eventContext?.eventDescription,
    ]),
    explicitHashtags: compactStrings([
      ...(evidencePack?.eventContext.hashtags ?? []),
      ...(input.request.eventContext?.hashtags ?? []),
    ]),
    eventName: eventOfficialName,
    eventUrl,
    extraTexts: compactStrings([
      input.request.currentSituation,
      ...input.analysisSections.map((section) => section.summary),
      ...eventThemes,
      ...sessionTitles,
      evidencePack?.photoContext.summary,
    ]),
  });
  const hashtags = selectHashtags({
    candidates: hashtagCandidates,
    channel: "x",
  });

  const postType = mapPostTypeV3(input.request.postType);
  return {
    postType,
    eventShortName,
    eventOfficialName: eventOfficialName || undefined,
    eventUrl: eventUrl || undefined,
    eventDateText: eventDateText || undefined,
    situation: buildSituationText(
      input.request.currentSituation,
      mood,
      photoDescriptionForPost,
      eventShortName,
    ),
    eventThemes: eventThemes.length ? eventThemes : undefined,
    sessionTitles: sessionTitles.length ? sessionTitles : undefined,
    speakerNames: undefined,
    venueMood: photoAtmosphere,
    photoAtmosphere: photoAtmosphere ?? undefined,
    photoPostableDescription: photoPostableDescription ?? undefined,
    mood,
    mainTopics,
    audienceContext,
    surveyInsightForPost,
    speakerOrSessionContext,
    photoDescriptionForPost,
    toneHints: toneHints.length ? toneHints : undefined,
    structureHints: structureHints.length ? structureHints : undefined,
    contentHints: contentHints.length ? contentHints : undefined,
    tableauInsights: tableauInsights.length ? tableauInsights : undefined,
    callToAction: buildCallToActionV3(postType),
    hashtags,
    hashtagCandidates,
  };
}

export function generatePostSuggestions(input: {
  material: PostMaterial;
  maxSuggestions?: number;
}): GeneratedPostSuggestion[] {
  return generatePostSuggestionsWithDiagnostics(input).suggestions;
}

export function generatePostSuggestionsWithDiagnostics(input: {
  material: PostMaterial;
  maxSuggestions?: number;
}): {
  suggestions: GeneratedPostSuggestion[];
  diagnostics: PostSuggestionGenerationDiagnostics;
} {
  const desiredVariantCount = input.maxSuggestions ?? 3;
  const baseVariants = [
    "fact_based",
    "survey_aware",
    "community",
    "fallback",
  ] as const;
  const accepted: GeneratedPostSuggestion[] = [];
  const excludedReasons: PostSuggestionGenerationDiagnostics["excludedReasons"] =
    [];

  for (const variant of baseVariants) {
    const result = buildSuggestionWithQuality(input.material, variant);
    if (
      result.quality.ok &&
      !accepted.some((item) => item.text === result.suggestion.text)
    ) {
      accepted.push(result.suggestion);
    } else if (!result.quality.ok) {
      excludedReasons.push({ variant, issues: result.quality.issues });
    }
  }

  if (accepted.length < desiredVariantCount) {
    const fallbackMaterial = createFallbackMaterial(input.material);
    for (const variant of baseVariants) {
      if (accepted.length >= desiredVariantCount) {
        break;
      }
      const result = buildSuggestionWithQuality(fallbackMaterial, variant);
      if (
        result.quality.ok &&
        !accepted.some((item) => item.text === result.suggestion.text)
      ) {
        accepted.push(result.suggestion);
      } else if (!result.quality.ok) {
        excludedReasons.push({
          variant: `${variant}:fallback`,
          issues: result.quality.issues,
        });
      }
    }
  }

  if (accepted.length < desiredVariantCount) {
    const fallbackSuggestion = buildSuggestionWithQuality(
      createFallbackMaterial(input.material),
      "fallback",
    );
    if (
      fallbackSuggestion.quality.ok &&
      !accepted.some((item) => item.text === fallbackSuggestion.suggestion.text)
    ) {
      accepted.push(fallbackSuggestion.suggestion);
    }
  }

  const globalIssues = buildTableauUsageIssues(input.material, accepted);

  return {
    suggestions: accepted.slice(0, desiredVariantCount),
    diagnostics: {
      desiredVariantCount,
      generatedCount: accepted.length,
      excludedCount: excludedReasons.length,
      globalIssues,
      excludedReasons,
    },
  };
}

export function buildChannelDrafts(input: {
  material: PostMaterial;
}): PostCopyDrafts {
  return {
    x: renderXDraft(input.material),
    linkedin: renderLinkedInDraft(input.material),
    email: renderEmailDraft(input.material),
    notion: renderNotionDraft(input.material),
  };
}

export function buildPostQualityResult(
  text: string,
  context?: {
    hashtags?: string[];
    hashtagCandidates?: HashtagCandidate[];
    channel?: HashtagChannel;
    material?: PostMaterial;
  },
): PostQualityResult {
  const issues: PostQualityIssue[] = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    const match = text.match(pattern.pattern);
    if (match) {
      issues.push({
        code: pattern.code,
        severity: pattern.severity,
        message: `Forbidden pattern detected: ${pattern.code}`,
        matchedText: match[0],
      });
    }
  }

  if (context?.hashtags && context.channel) {
    const hashtagIssues = buildHashtagQualityIssues({
      hashtags: context.hashtags,
      candidates: context.hashtagCandidates ?? [],
      channel: context.channel,
    });
    issues.push(
      ...hashtagIssues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        matchedText: issue.matchedTag,
      })),
    );
  }

  if (context?.material) {
    issues.push(...detectImageThemeIssues(context.material));
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

export function buildPostSummary(material: PostMaterial): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "イベント";
  const topics = material.mainTopics?.length
    ? `テーマは${material.mainTopics.join("、")}です。`
    : "";
  return `${shortName}の投稿案を作成しました。${topics}`.trim();
}

export function buildImageCaption(material: PostMaterial): string {
  if (material.photoDescriptionForPost) {
    return material.photoDescriptionForPost;
  }
  if (material.mood) {
    return material.mood;
  }
  return (
    material.eventShortName ?? material.eventOfficialName ?? "イベント写真"
  );
}

function buildSuggestionWithQuality(
  material: PostMaterial,
  variant: "fact_based" | "survey_aware" | "community" | "fallback",
): { suggestion: GeneratedPostSuggestion; quality: PostQualityResult } {
  const tableauUsage = selectTableauInsightUsage(material, variant);
  const text = truncatePostText(
    renderXPostV3(material, variant, tableauUsage),
    POST_TEXT_LIMIT,
  );
  const quality = buildPostQualityResult(text, {
    hashtags: material.hashtags,
    hashtagCandidates: material.hashtagCandidates,
    channel: "x",
    material,
  });

  return {
    suggestion: {
      variant,
      text,
      rationale: buildRationaleV3(material, variant, tableauUsage),
      usedEvidence: {
        photo: Boolean(material.photoDescriptionForPost),
        event: Boolean(material.eventOfficialName),
        survey: tableauUsage.usedInsights.some(
          (insight) => insight.source === "survey",
        ),
        postPerformance: tableauUsage.usedInsights.some(
          (insight) => insight.source === "post_performance",
        ),
        accountOverview: tableauUsage.usedInsights.some(
          (insight) => insight.source === "account_overview",
        ),
      },
      usedTableauInsights: tableauUsage.usedInsights.map(
        (insight) => insight.summaryForPost,
      ),
      omittedTableauInsightReason: tableauUsage.omittedReason,
      warnings: quality.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => issue.code),
    },
    quality,
  };
}

/* eslint-disable @typescript-eslint/no-unused-vars */
function renderXPost(
  material: PostMaterial,
  variant: "fact_based" | "survey_aware" | "community" | "fallback",
  tableauUsage: TableauInsightUsage,
): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "Event";
  const topics = material.mainTopics?.slice(0, 3) ?? [];
  const topicLine = topics.length
    ? `今日は${topics.join("、")}の3テーマ。`
    : "";
  const audienceLine =
    variant === "survey_aware"
      ? (tableauUsage.inlineText ?? material.surveyInsightForPost ?? "")
      : "";
  const moodLine = material.mood ?? "";
  const photoLine = material.photoDescriptionForPost ?? "";
  const ctaLine = material.callToAction ?? "";

  switch (material.postType) {
    case "live_report":
      return joinLines([
        variant === "survey_aware"
          ? `${shortName}、少しずつ会場があたたまってきました。`
          : `${shortName}、始まりました。`,
        topicLine || moodLine || photoLine,
        variant === "survey_aware"
          ? audienceLine || ctaLine
          : variant === "community"
            ? audienceLine || ctaLine
            : ctaLine || audienceLine,
        hashLine(material, "x"),
      ]);
    case "post_event_thanks":
      return joinLines([
        variant === "community"
          ? `${shortName}にご参加のみなさん、ありがとうございました。`
          : `ありがとうございました。${shortName}の時間を振り返ります。`,
        topicLine || moodLine || photoLine,
        ctaLine,
        hashLine(material, "x"),
      ]);
    case "recap":
      return joinLines([
        `${shortName}のまとめです。`,
        topicLine || audienceLine || moodLine,
        photoLine || ctaLine,
        hashLine(material, "x"),
      ]);
    case "pre_event":
      return joinLines([
        variant === "fact_based"
          ? `${shortName}、開催が始まりました！`
          : variant === "survey_aware"
            ? `${shortName}、スタートしました。`
            : `${shortName}、いよいよ開催です。`,
        variant === "survey_aware"
          ? audienceLine || topicLine || photoLine || moodLine
          : variant === "community"
            ? topicLine || audienceLine || photoLine || moodLine
            : topicLine || audienceLine || photoLine || moodLine,
        ctaLine,
        hashLine(material, "x"),
      ]);
    default:
      return joinLines([
        `${shortName}の要点をまとめます。`,
        topicLine || audienceLine || moodLine,
        ctaLine,
        hashLine(material, "x"),
      ]);
  }
}
function renderXDraft(material: PostMaterial): string {
  return truncatePostText(
    renderXPostV3(material, "fact_based", {
      usedInsights: [],
    }),
    POST_TEXT_LIMIT,
  );
}

function renderLinkedInDraft(material: PostMaterial): string {
  return truncatePostText(
    joinLines([renderSharedBodyV3(material), hashLine(material, "linkedin")]),
    POST_TEXT_LIMIT,
  );
}

function renderEmailDraft(material: PostMaterial): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "Event";
  return truncatePostText(
    joinLines([`Subject: ${shortName}`, renderSharedBodyV3(material)]),
    1000,
  );
}

function renderNotionDraft(material: PostMaterial): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "Event";
  return truncatePostText(
    joinLines([`# ${shortName}`, renderSharedBodyV3(material)]),
    1000,
  );
}

function renderSharedBody(material: PostMaterial): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "Event";
  const topics = material.mainTopics?.slice(0, 3) ?? [];
  return joinLines([
    `${shortName}の投稿案です。`,
    topics.length
      ? `今日は${topics.join("、")}を軸に、Tableauの楽しさを共有しています。`
      : undefined,
    material.audienceContext,
    material.photoDescriptionForPost,
    material.callToAction,
  ]);
}

function buildRationale(
  material: PostMaterial,
  variant: "fact_based" | "survey_aware" | "community" | "fallback",
  tableauUsage: TableauInsightUsage,
): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "イベント";
  switch (variant) {
    case "survey_aware":
      if (tableauUsage.usedInsights[0]) {
        return `${shortName} の説明を、${tableauUsage.usedInsights[0].summaryForPost} という文脈でやさしく伝える案です。`;
      }
      return `${shortName}の見どころをやわらかくまとめました。`;
    case "community":
      return `${shortName}の見どころをコミュニティ感重視でまとめました。`;
    case "fallback":
      return `${shortName}の見どころを自然な見出しに整理しました。`;
    case "fact_based":
    default:
      return `${shortName}の見どころを素直にまとめた案です。`;
  }
}

function buildSituationText(
  currentSituation: string,
  mood?: string,
  photoDescription?: string,
  shortName?: string,
): string {
  const parts = [currentSituation, mood, photoDescription]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value));

  if (parts.length > 0) {
    return uniqueStrings(parts).join(" / ");
  }

  return shortName ? `${shortName}の進行中` : "進行中";
}

function buildCallToAction(postType: PostMaterial["postType"]): string {
  switch (postType) {
    case "live_report":
      return "会場の雰囲気をお届けします。";
    case "post_event_thanks":
      return "また次回もご一緒できたらうれしいです。";
    case "recap":
      return "印象に残ったポイントを軽く振り返ります。";
    case "pre_event":
      return "一緒に楽しみましょう";
    default:
      return "今日の空気感をそのまままとめます。";
  }
}

function mapPostType(postType: string): PostMaterial["postType"] {
  if (/開催中の実況/.test(postType)) {
    return "live_report";
  }
  if (/開催後のお礼|開催後のレポート/.test(postType)) {
    return "post_event_thanks";
  }
  if (/次回参加の呼びかけ/.test(postType)) {
    return "recap";
  }
  if (/事前告知|開催直前リマインド/.test(postType)) {
    return "pre_event";
  }
  if (/開催中/.test(postType)) {
    return "live_report";
  }
  if (/開催後/.test(postType)) {
    return "post_event_thanks";
  }
  if (/まとめ|レポート/.test(postType)) {
    return "recap";
  }
  if (/告知|前/.test(postType)) {
    return "pre_event";
  }
  return "generic";
}

function shortenEventName(value?: string): string | undefined {
  const cleaned = normalize(value);
  if (!cleaned) {
    return undefined;
  }

  const withoutPrefix = stripEventDecorations(cleaned);
  const noSubtitle =
    withoutPrefix.split(/[|｜/／:：]/u)[0]?.trim() ?? withoutPrefix;
  const tokens = noSubtitle.split(/\s+/u).filter(Boolean);
  if (tokens.length > 1 && looksLikeEventHeadline(tokens[0])) {
    return tokens[0];
  }
  const candidate =
    tokens.length <= 4 ? noSubtitle : tokens.slice(0, 4).join(" ");
  if (!candidate) {
    return undefined;
  }

  return candidate;
}

function derivePhotoPostableDescription(
  request: ActionRunRequest,
  evidencePack?: PostGenerationEvidencePack,
): string | undefined {
  const candidates = [
    evidencePack?.photoContext.summary,
    evidencePack?.photoContext.sceneInference,
    request.currentSituation,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value));

  const postable = evidencePack?.photoContext.postableElements?.find((value) =>
    isSafeTopic(value),
  );
  if (postable) {
    return sanitizeTopic(postable);
  }

  const safeSummary = candidates.find((value) => !looksLikeImageLabel(value));
  return safeSummary || undefined;
}

function derivePhotoAtmosphere(
  request: ActionRunRequest,
  evidencePack?: PostGenerationEvidencePack,
): string | undefined {
  const text = [
    evidencePack?.photoContext.summary,
    evidencePack?.photoContext.eventFeel,
    evidencePack?.photoContext.sceneInference,
    evidencePack?.photoContext.visibleText?.join(" "),
    request.currentSituation,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (!text) {
    return undefined;
  }

  if (looksLikeWarmPhoto(text)) {
    return "和やかな雰囲気";
  }
  if (looksLikeBrightPhoto(text)) {
    return "明るい会場";
  }
  if (looksLikeCrowdedPhoto(text)) {
    return "参加者が集まり始めた会場";
  }
  if (/(live|started|開催中|開催直前)/i.test(text)) {
    return "会場が少しずつあたたまってきています";
  }
  return undefined;
}

function deriveMood(
  request: ActionRunRequest,
  evidencePack?: PostGenerationEvidencePack,
  photoDescription?: string,
): string | undefined {
  const text = [
    photoDescription,
    evidencePack?.photoContext.summary,
    evidencePack?.photoContext.eventFeel,
    request.currentSituation,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (looksLikeWarmPhoto(text)) {
    return "和やかな雰囲気";
  }
  if (looksLikeBrightPhoto(text)) {
    return "明るい雰囲気";
  }
  if (looksLikeCrowdedPhoto(text)) {
    return "参加者同士の交流が感じられる雰囲気";
  }
  if (/(live|started|開催中|開催直前)/i.test(text)) {
    return "会場があたたまってきています";
  }
  return undefined;
}

function deriveEventThemes(input: {
  eventDescriptionTexts: string[];
  eventName?: string;
  analysisSections: ActionRunAnalysisSection[];
}): string[] {
  void input.analysisSections;

  const fromDescription = uniqueStrings(
    [
      ...input.eventDescriptionTexts,
      ...(input.eventName ? [input.eventName] : []),
    ]
      .flatMap((candidate) => extractEventThemeCandidates(candidate))
      .map((topic) => sanitizeTopic(topic))
      .filter((topic) => isSafeEventTheme(topic)),
  );
  return fromDescription.slice(0, 3);
}
function deriveSessionTitles(input: {
  eventDescriptionTexts: string[];
  analysisSections: ActionRunAnalysisSection[];
}): string[] {
  const candidates = [
    ...input.eventDescriptionTexts,
    ...input.analysisSections
      .filter((section) => section.key !== "photo_context")
      .flatMap((section) => [section.title, section.question, section.summary]),
  ];

  return uniqueStrings(
    candidates
      .flatMap((candidate) => extractSessionTitleCandidates(candidate))
      .map((title) => sanitizeTopic(title))
      .filter((title) => isSafeSessionTitle(title)),
  ).slice(0, 5);
}

function extractEventThemeCandidates(value: string): string[] {
  const normalized = normalize(value);
  if (!normalized) {
    return [];
  }

  const emphasized =
    normalized.match(/[〜～]([^〜～]+)[〜～]/u)?.[1] ?? normalized;
  const seed = stripEventDecorations(emphasized)
    .replace(/(?:^|\s)Hashtags?\b/giu, " ")
    .replace(/#[^\s#]+/gu, " ")
    .replace(/\bhttps?:\/\/\S+/giu, " ")
    .replace(/\bwww\.\S+/giu, " ");

  return uniqueStrings(
    seed
      .split(/[、,\/|｜・]+/u)
      .map((topic) => cleanThemeCandidate(topic))
      .filter((topic) => topic.length > 0)
      .filter((topic) => !looksLikeImageLabel(topic))
      .filter((topic) => !isGenericThemeStopWord(topic)),
  );
}

function cleanThemeCandidate(value: string): string {
  return normalize(value)
    .replace(/^(?:テーマ|Topic|Topics|見どころ|内容)[:：\s]*/iu, "")
    .replace(/^(?:第\d+回\s*)/u, "")
    .replace(
      /(?:から考える次の一歩|から考える|をテーマに|について考える|について|の可能性|を中心に|を軸に|から学ぶ|を通して|を通じて|を見ていきます|をお届けします)$/u,
      "",
    )
    .replace(/^[\s\-–—]+/u, "")
    .replace(/[\s\-–—]+$/u, "")
    .trim();
}
function extractSessionTitleCandidates(value: string): string[] {
  const normalized = normalize(value);
  if (!normalized) {
    return [];
  }

  const quoted = [
    ...normalized.matchAll(
      /[\u300c]([^\u300d]+)[\u300d]|[\u300e]([^\u300f]+)[\u300f]|"([^"]+)"/g,
    ),
  ]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/#/.test(item))
    .filter((item) => !looksLikeAnalysisNoise(item))
    .filter((item) => !isGenericThemeStopWord(item));

  const lines = normalized
    .split(/\r?\n+/u)
    .map((line) => line.replace(/^[\s\-*]+/u, "").trim())
    .map((line) =>
      line
        .replace(/^(?:Session|Topic|Title|テーマ|見出し)[:：\s]*/iu, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .filter((line) => !/#/.test(line))
    .filter((line) => line.length <= 80)
    .filter((line) => !looksLikeAnalysisNoise(line))
    .filter((line) => !isGenericThemeStopWord(line));

  return uniqueStrings([...quoted, ...lines]);
}

function looksLikeAnalysisNoise(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return [
    /^photo context$/i,
    /^survey insight$/i,
    /^evidence pack$/i,
    /^question$/i,
    /^session detail$/i,
    /^live event summary\.?$/i,
    /^post type distribution$/i,
    /^checked post type counts\.?$/i,
    /^post perf$/i,
    /^post performance$/i,
    /^analysis$/i,
    /^summary$/i,
    /^tableau user group tokyo 2026$/i,
    /^mcp awareness(?::.*)?$/i,
  ].some((pattern) => pattern.test(trimmed));
}

function stripEventDecorations(value: string): string {
  return normalize(value)
    .replace(/^[【［\[][^】］\]]*[】］\]]\s*/u, "")
    .replace(
      /^(?:\d{1,4}[\/／.,、\-年]\d{1,2}(?:[\/／.,、\-月]\d{1,2})?(?:日)?(?:[（(][月火水木金土日][)）])?(?:開催)?(?:[\s\-–—:：]+)?)+/u,
      "",
    )
    .replace(/^(?:本日|今日|明日|開催中|開催前)\s+/u, "");
}

function looksLikeEventHeadline(value: string): boolean {
  return /(?:第\d+回|ユーザー会|勉強会|セミナー|イベント|Meetup|Conference|Summit|Tableau|MCP|User Group|UG)/iu.test(
    value,
  );
}

function isGenericThemeStopWord(value: string): boolean {
  const trimmed = value.trim();
  return [
    "Tableau",
    "可能性",
    "次の一歩",
    "ユーザー会",
    "開催中",
    "開催",
    "広がる",
    "考える",
    "イベント",
    "セッション",
  ].some((candidate) => candidate === trimmed);
}

function looksLikeWarmPhoto(value: string): boolean {
  return /friendship|teamwork|happiness|happy|joyful|smiling|笑顔|交流/i.test(
    value,
  );
}

function looksLikeBrightPhoto(value: string): boolean {
  return /bright room|large window|明るい|光|照明/i.test(value);
}

function looksLikeCrowdedPhoto(value: string): boolean {
  return /group photo|集合|people|participants|team members|friends|colleagues|会場|参加者/i.test(
    value,
  );
}

function looksLikeImageLabel(value: string): boolean {
  return /^(?:friendship|teamwork|happiness|happy|joyful|positive|positivity|smiling|group photo|bright room|large window|potted plant|friends|team members|colleagues|casual attire)$/i.test(
    value.trim(),
  );
}

function isSafeEventTheme(value: string): boolean {
  return !looksLikeImageLabel(value) && !isGenericThemeStopWord(value);
}

function isSafeSessionTitle(value: string): boolean {
  return !looksLikeImageLabel(value) && value.trim().length > 0;
}

function detectImageThemeIssues(material: PostMaterial): PostQualityIssue[] {
  const offendingThemes = uniqueStrings([
    ...(material.eventThemes ?? []),
    ...(material.mainTopics ?? []),
  ]).filter((value) => looksLikeImageLabel(value));

  if (!offendingThemes.length) {
    return [];
  }

  return [
    {
      code: "image_label_used_as_event_theme",
      severity: "error",
      message:
        "Image-derived labels must not be used as event themes: " +
        offendingThemes.join(", "),
      matchedText: offendingThemes[0],
    },
  ];
}

function createFallbackMaterial(material: PostMaterial): PostMaterial {
  const eventThemes = uniqueStrings(
    (material.eventThemes ?? [])
      .filter((value) => !looksLikeImageLabel(value))
      .filter((value) => !isGenericThemeStopWord(value)),
  );
  const sessionTitles = uniqueStrings(
    (material.sessionTitles ?? [])
      .filter((value) => !looksLikeImageLabel(value))
      .filter((value) => !isGenericThemeStopWord(value)),
  );
  const photoAtmosphere = material.photoAtmosphere
    ? material.photoAtmosphere
    : material.mood && !looksLikeImageLabel(material.mood)
      ? material.mood
      : undefined;

  return {
    ...material,
    eventThemes: eventThemes.length ? eventThemes : undefined,
    sessionTitles: sessionTitles.length ? sessionTitles : undefined,
    photoAtmosphere,
    photoPostableDescription:
      material.photoPostableDescription &&
      !looksLikeImageLabel(material.photoPostableDescription)
        ? material.photoPostableDescription
        : undefined,
    mood: photoAtmosphere,
    mainTopics: uniqueStrings([...eventThemes, ...sessionTitles]).slice(0, 3),
  };
}

type TableauInsightUsage = {
  inlineText?: string;
  usedInsights: TableauPostInsight[];
  omittedReason?: string;
};

function selectTableauInsightUsage(
  material: PostMaterial,
  variant: "fact_based" | "survey_aware" | "community" | "fallback",
): TableauInsightUsage {
  const usableInsights =
    material.tableauInsights?.filter((insight) => insight.shouldUseInPost) ??
    [];
  if (!usableInsights.length) {
    return {
      usedInsights: [],
      omittedReason: "投稿に自然に差し込める Tableau insight がなかったため",
    };
  }

  if (variant !== "survey_aware") {
    return {
      usedInsights: [],
      omittedReason:
        "投稿候補の差別化を優先し、この案では本文に直接入れていないため",
    };
  }

  const selected =
    usableInsights.find(
      (insight) =>
        insight.source === "survey" && insight.kind === "audience_context",
    ) ??
    usableInsights.find((insight) => insight.source === "survey") ??
    usableInsights[0];

  return {
    inlineText:
      material.surveyInsightForPost ??
      (selected ? `${selected.summaryForPost}。` : undefined),
    usedInsights: selected ? [selected] : [],
  };
}

function buildTableauUsageIssues(
  material: PostMaterial,
  suggestions: GeneratedPostSuggestion[],
): PostQualityIssue[] {
  const usableInsights =
    material.tableauInsights?.filter((insight) => insight.shouldUseInPost) ??
    [];
  if (!usableInsights.length) {
    return [];
  }

  const usedAnyInsight = suggestions.some(
    (suggestion) => (suggestion.usedTableauInsights?.length ?? 0) > 0,
  );
  if (usedAnyInsight) {
    return [];
  }

  return [
    {
      code: "tableau_insight_not_used",
      severity: "warning",
      message:
        "Tableau insight was available but was not used in any generated post suggestion.",
      insightSummary: usableInsights[0]?.summaryForPost,
    },
  ];
}

function deriveTableauPostInsights(
  evidencePack?: PostGenerationEvidencePack,
): TableauPostInsight[] {
  if (!evidencePack) {
    return [];
  }

  return uniqueTableauInsights([
    ...deriveSurveyTableauInsights(evidencePack.surveyInsight),
    ...derivePostPerformanceTableauInsights(
      evidencePack.postPerformanceInsight,
    ),
    ...deriveAccountOverviewTableauInsights(
      evidencePack.accountOverviewInsight,
    ),
  ]);
}

function deriveSurveyTableauInsights(
  insight: PostGenerationEvidencePack["surveyInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const labels = extractInsightLabels(insight.evidenceRows);
  const beginnerPresent = labels.some(isBeginnerAwarenessLabel);
  const experiencedPresent = labels.some(isExperiencedAwarenessLabel);
  const triedPresent = labels.some(isTriedAwarenessLabel);
  const awarenessDimension = isMcpAwarenessDimension(insight.dimensionField);

  if (
    !awarenessDimension &&
    !beginnerPresent &&
    !experiencedPresent &&
    !triedPresent
  ) {
    return [];
  }

  const results: TableauPostInsight[] = [];

  if (beginnerPresent) {
    results.push({
      source: "survey",
      kind: "audience_context",
      summaryForPost: "MCPをはじめて聞く方も多い",
      confidence: 0.9,
      shouldUseInPost: true,
      reason: `最多回答が「${labels.find(isBeginnerAwarenessLabel) ?? "はじめて聞いた"}」だったため`,
    });
    results.push({
      source: "survey",
      kind: "content_hint",
      summaryForPost:
        "初心者にも伝わるように、やさしく整理する切り口が合いそう",
      confidence: 0.82,
      shouldUseInPost: true,
    });
  }

  if (beginnerPresent && (experiencedPresent || triedPresent)) {
    results.push({
      source: "survey",
      kind: "structure_hint",
      summaryForPost:
        "初心者にも入りやすく、試したことがある方にも実践イメージが湧く構成が合いそう",
      confidence: 0.78,
      shouldUseInPost: false,
      reason: "初心者と経験者が混在していたため",
    });
  }

  return results;
}

function derivePostPerformanceTableauInsights(
  insight: PostGenerationEvidencePack["postPerformanceInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const labels = extractInsightLabels(insight.evidenceRows);
  const mostlyDates =
    isDateLikeDimension(insight.dimensionField) ||
    labels.filter(isDateLikeLabel).length >=
      Math.max(1, Math.ceil(labels.length / 2));

  if (mostlyDates) {
    return [
      {
        source: "post_performance",
        kind: "low_confidence",
        summaryForPost:
          "過去投稿分析は、日付中心の結果のため本文生成には使わない",
        confidence: 0.2,
        shouldUseInPost: false,
        reason: "日付だけでは投稿文の内容・構成・トーンを判断できないため",
      },
    ];
  }

  const results: TableauPostInsight[] = [];

  if (insight.recommendedTone?.length) {
    results.push({
      source: "post_performance",
      kind: "tone_hint",
      summaryForPost: "少し親しみのある文体で、勢いを出しすぎない方が合いそう",
      confidence: 0.65,
      shouldUseInPost: false,
      reason: insight.recommendedTone.join(", "),
    });
  }

  if (insight.recommendedStructure?.length) {
    results.push({
      source: "post_performance",
      kind: "structure_hint",
      summaryForPost: "短い導入のあとに現場の一言を添える構成が合いそう",
      confidence: 0.68,
      shouldUseInPost: false,
      reason: insight.recommendedStructure.join(" / "),
    });
  }

  return results;
}

function deriveAccountOverviewTableauInsights(
  insight: PostGenerationEvidencePack["accountOverviewInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const results: TableauPostInsight[] = [];

  if (insight.timingHints?.length) {
    results.push({
      source: "account_overview",
      kind: "timing_hint",
      summaryForPost:
        "会場の空気が動いているうちに、短く今の雰囲気を伝えるのが合いそう",
      confidence: 0.58,
      shouldUseInPost: false,
      reason: insight.timingHints.join(" / "),
    });
  }

  if (normalize(insight.accountContextForPost)) {
    results.push({
      source: "account_overview",
      kind: "content_hint",
      summaryForPost:
        "会場感やコミュニティの空気を前に出す切り口が馴染みやすそう",
      confidence: 0.55,
      shouldUseInPost: false,
      reason: insight.accountContextForPost,
    });
  }

  return results;
}

function deriveAudienceContextFromInsights(
  insights: TableauPostInsight[],
): string | undefined {
  return insights.find((insight) => insight.kind === "audience_context")
    ?.summaryForPost;
}

function buildSurveyInsightForPost(
  insights: TableauPostInsight[],
): string | undefined {
  const audienceInsight = insights.find(
    (insight) =>
      insight.source === "survey" && insight.kind === "audience_context",
  );
  if (audienceInsight) {
    return "MCPをはじめて聞く方にも伝わるように、今日はできるだけやさしく整理していきます。";
  }

  const mixedInsight = insights.find(
    (insight) =>
      insight.source === "survey" && insight.kind === "structure_hint",
  );
  if (mixedInsight) {
    return "MCPが初めての方も、試したことがある方も、一緒に見ていけるように整理していきます。";
  }

  return undefined;
}

/* eslint-enable @typescript-eslint/no-unused-vars */
function collectInsightSummaries(
  insights: TableauPostInsight[],
  kind: TableauPostInsight["kind"],
): string[] {
  return insights
    .filter((insight) => insight.kind === kind)
    .map((insight) => insight.summaryForPost);
}

function uniqueTableauInsights(
  insights: TableauPostInsight[],
): TableauPostInsight[] {
  const seen = new Set<string>();
  return insights.filter((insight) => {
    const key = `${insight.source}:${insight.kind}:${insight.summaryForPost}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractInsightLabels(rows?: unknown[]): string[] {
  return (rows ?? [])
    .flatMap((row) => {
      if (!row || typeof row !== "object") {
        return [];
      }
      const label = (row as { label?: unknown }).label;
      return typeof label === "string" ? [label.trim()] : [];
    })
    .filter(Boolean);
}

function isMcpAwarenessDimension(value?: string): boolean {
  return /mcp.?awareness/i.test(value ?? "");
}

function isBeginnerAwarenessLabel(value: string): boolean {
  return /はじめて聞いた|初めて聞いた|first time|new to/i.test(value);
}

function isExperiencedAwarenessLabel(value: string): boolean {
  return /すでに活用している|already using|active user/i.test(value);
}

function isTriedAwarenessLabel(value: string): boolean {
  return /試したことがある|tried|have tried/i.test(value);
}

function isDateLikeDimension(value?: string): boolean {
  return /(日付|date|day|week|month|time)/i.test(value ?? "");
}

function isDateLikeLabel(value: string): boolean {
  return (
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\b/u.test(
      value,
    ) ||
    /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/u.test(value) ||
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/u.test(value)
  );
}

function deriveAudienceContext(
  analysisSections: ActionRunAnalysisSection[],
  evidencePack?: PostGenerationEvidencePack,
): string | undefined {
  const text = [
    evidencePack?.surveyInsight.evidenceSummary,
    ...(evidencePack?.surveyInsight.keyFindings ?? []),
    ...(evidencePack?.surveyInsight.suggestedAngles ?? []),
    ...analysisSections.flatMap((section) => [
      section.summary,
      ...section.rows.map((row) => String(row.value ?? "")),
    ]),
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (
    /(はじめて聞いた|初めて聞いた|first time|beginner|new to|Mcp Awareness)/i.test(
      text,
    )
  ) {
    return "MCPをはじめて聞く方にも伝わるように";
  }
  if (/(how to use|使いどころ|利用)/i.test(text)) {
    return "実際の使いどころがイメージしやすいように";
  }
  return undefined;
}

function deriveSessionContext(
  analysisSections: ActionRunAnalysisSection[],
  mainTopics: string[],
  evidencePack?: PostGenerationEvidencePack,
): string | undefined {
  const text = [
    evidencePack?.eventContext.eventDescription,
    evidencePack?.eventContext.eventDateText,
    ...analysisSections.map((section) => section.summary),
    ...mainTopics,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (!text) {
    return undefined;
  }

  if (mainTopics.length > 0) {
    return `${mainTopics.slice(0, 3).join("、")}を中心にお話しします。`;
  }
  return undefined;
}

function sanitizeTopic(value: string): string {
  return normalize(value)
    .replace(
      /^(?:metric|dimension|top item|rank_metric|rank_label|hashtags?)\s*[:?]\s*/iu,
      "",
    )
    .replace(/^#+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}
function isSafeTopic(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return !/^(?:metric|dimension|top item|rank_metric|rank_label|sourceStatus|variant)$/i.test(
    trimmed,
  );
}

/* eslint-disable @typescript-eslint/no-unused-vars */
function renderXPostV2(
  material: PostMaterial,
  variant: "fact_based" | "survey_aware" | "community" | "fallback",
  tableauUsage: TableauInsightUsage,
): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "イベント";
  const topics = material.mainTopics?.slice(0, 3) ?? [];
  const topicLine = topics.length
    ? `今日は${topics.join("、")}の${topics.length}テーマ。`
    : undefined;
  const audienceLine =
    variant === "survey_aware"
      ? (tableauUsage.inlineText ?? material.surveyInsightForPost ?? "")
      : undefined;
  const atmosphereLine =
    material.photoDescriptionForPost ??
    material.mood ??
    "会場もオンラインも、少しずつあたたまってきました。";
  const explorationLine = topics.length
    ? "それぞれ違う切り口から、Tableauの楽しさを見ていきます。"
    : undefined;
  const communityTopicLine = topics.length
    ? `${topics.join("、")}をテーマに、Tableauの楽しさを広げていきます。`
    : undefined;

  switch (material.postType) {
    case "live_report":
      return joinLines([
        variant === "fact_based"
          ? `${shortName}、始まりました！`
          : variant === "survey_aware"
            ? `${shortName}、スタートしています。`
            : atmosphereLine,
        variant === "survey_aware"
          ? audienceLine || topicLine || atmosphereLine
          : variant === "community"
            ? communityTopicLine || topicLine || atmosphereLine
            : topicLine || atmosphereLine,
        variant === "fact_based" ? explorationLine : undefined,
        hashLine(material, "x"),
      ]);
    case "post_event_thanks":
      return joinLines([
        variant === "community"
          ? `${shortName}に集まってくださったみなさん、ありがとうございました。`
          : `ありがとうございました。${shortName}の様子を少し振り返ります。`,
        topicLine || atmosphereLine,
        material.callToAction,
        hashLine(material, "x"),
      ]);
    case "recap":
      return joinLines([
        `${shortName}のまとめです。`,
        topicLine || audienceLine || atmosphereLine,
        material.callToAction,
        hashLine(material, "x"),
      ]);
    case "pre_event":
      return joinLines([
        variant === "fact_based"
          ? `${shortName}、まもなく始まります。`
          : variant === "survey_aware"
            ? `${shortName}、スタート前です。`
            : `${shortName}、いよいよ開催です。`,
        variant === "survey_aware"
          ? audienceLine || topicLine || atmosphereLine
          : variant === "community"
            ? communityTopicLine || topicLine || atmosphereLine
            : topicLine || atmosphereLine,
        material.callToAction,
        hashLine(material, "x"),
      ]);
    default:
      return joinLines([
        `${shortName}の見どころをまとめます。`,
        topicLine || audienceLine || atmosphereLine,
        material.callToAction || explorationLine,
        hashLine(material, "x"),
      ]);
  }
}

function renderSharedBodyV2(material: PostMaterial): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "イベント";
  const topics = material.mainTopics?.slice(0, 3) ?? [];
  return joinLines([
    `${shortName}の共有メモです。`,
    topics.length
      ? `今日は${topics.join("、")}を軸に、Tableauの楽しさを見ていきます。`
      : undefined,
    material.audienceContext,
    material.photoDescriptionForPost,
    material.callToAction,
  ]);
}

function buildRationaleV2(
  material: PostMaterial,
  variant: "fact_based" | "survey_aware" | "community" | "fallback",
  tableauUsage: TableauInsightUsage,
): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "イベント";
  switch (variant) {
    case "survey_aware":
      if (tableauUsage.usedInsights[0]) {
        return `${shortName}を、${tableauUsage.usedInsights[0].summaryForPost}という文脈でやさしく伝える案です。`;
      }
      return `${shortName}の見どころをやわらかくまとめた案です。`;
    case "community":
      return `${shortName}の見どころをコミュニティ感重視でまとめた案です。`;
    case "fallback":
      return `${shortName}の見どころを自然な言い回しで整理した案です。`;
    case "fact_based":
    default:
      return `${shortName}の見どころを素直にまとめた案です。`;
  }
}

function buildCallToActionV2(postType: PostMaterial["postType"]): string {
  switch (postType) {
    case "live_report":
      return "会場の空気感をそのままお届けします。";
    case "post_event_thanks":
      return "また次回も一緒に楽しめたらうれしいです。";
    case "recap":
      return "次回につながるポイントを少しずつ振り返ります。";
    case "pre_event":
      return "気になる方はぜひチェックしてください。";
    default:
      return "今日の見どころを自然な言葉でまとめます。";
  }
}

function mapPostTypeV2(postType: string): PostMaterial["postType"] {
  if (/(?:開催中の実況|開催中|live report)/iu.test(postType)) {
    return "live_report";
  }
  if (/(?:開催後のお礼|開催後のレポート|開催後|thank you)/iu.test(postType)) {
    return "post_event_thanks";
  }
  if (/(?:次回参加の呼びかけ|まとめ|recap)/iu.test(postType)) {
    return "recap";
  }
  if (/(?:事前告知|開催直前リマインド|告知|remind)/iu.test(postType)) {
    return "pre_event";
  }
  return "generic";
}

function derivePhotoAtmosphereV2(
  request: ActionRunRequest,
  evidencePack?: PostGenerationEvidencePack,
): string | undefined {
  const text = [
    evidencePack?.photoContext.summary,
    evidencePack?.photoContext.eventFeel,
    evidencePack?.photoContext.sceneInference,
    evidencePack?.photoContext.visibleText?.join(" "),
    request.currentSituation,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (!text) {
    return undefined;
  }
  if (looksLikeWarmPhoto(text)) {
    return "和やかな雰囲気";
  }
  if (looksLikeBrightPhoto(text)) {
    return "明るい雰囲気";
  }
  if (looksLikeCrowdedPhoto(text)) {
    return "参加者の熱が高まってきた雰囲気";
  }
  if (/(?:live|started|開催中|開場)/iu.test(text)) {
    return "会場が少しずつあたたまってきています。";
  }
  return undefined;
}

function deriveMoodV2(
  request: ActionRunRequest,
  evidencePack?: PostGenerationEvidencePack,
  photoDescription?: string,
): string | undefined {
  const text = [
    photoDescription,
    evidencePack?.photoContext.summary,
    evidencePack?.photoContext.eventFeel,
    request.currentSituation,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (looksLikeWarmPhoto(text)) {
    return "和やかな雰囲気";
  }
  if (looksLikeBrightPhoto(text)) {
    return "明るい雰囲気";
  }
  if (looksLikeCrowdedPhoto(text)) {
    return "参加者どうしの会話が広がってきた雰囲気";
  }
  if (/(?:live|started|開催中|開場)/iu.test(text)) {
    return "会場があたたまってきています。";
  }
  return undefined;
}

function deriveEventThemesV2(input: {
  eventDescriptionTexts: string[];
  eventName?: string;
  analysisSections: ActionRunAnalysisSection[];
}): string[] {
  void input.analysisSections;

  const fromDescription = uniqueStrings(
    input.eventDescriptionTexts
      .flatMap((candidate) => extractEventThemeCandidatesV2(candidate))
      .map((topic) => sanitizeTopic(topic))
      .filter((topic) => isSafeEventTheme(topic))
      .filter((topic) => isLikelyThemeTokenV2(topic)),
  );
  if (fromDescription.length > 0) {
    return fromDescription.slice(0, 3);
  }

  return input.eventName
    ? uniqueStrings(
        extractEventThemeCandidatesV2(input.eventName)
          .map((topic) => sanitizeTopic(topic))
          .filter((topic) => isSafeEventTheme(topic))
          .filter((topic) => isLikelyThemeTokenV2(topic)),
      ).slice(0, 3)
    : [];
}

function deriveSessionTitlesV2(input: {
  eventDescriptionTexts: string[];
  analysisSections: ActionRunAnalysisSection[];
}): string[] {
  const candidates = [
    ...input.eventDescriptionTexts,
    ...input.analysisSections
      .filter(
        (section) =>
          !["photo_context", "survey_insight", "evidence_pack"].includes(
            section.key,
          ),
      )
      .flatMap((section) => [section.title, section.question, section.summary]),
  ];

  return uniqueStrings(
    candidates
      .flatMap((candidate) => extractSessionTitleCandidatesV2(candidate))
      .map((title) => sanitizeTopic(title))
      .filter((title) => isMeaningfulSessionTitleV2(title)),
  ).slice(0, 5);
}

function extractEventThemeCandidatesV2(value: string): string[] {
  const cleaned = stripEventDecorationsV2(normalize(value))
    .replace(/(?:^|\s)Hashtags?\b/giu, " ")
    .replace(/#[^\s#]+/gu, " ")
    .replace(/\bhttps?:\/\/\S+/giu, " ")
    .replace(/\bwww\.\S+/giu, " ");

  return uniqueStrings(
    cleaned
      .split(/\s*(?:[\/|]|・|･|、|,|，)\s*/u)
      .flatMap((part) => part.split(/\s+-\s+/u))
      .map((topic) => cleanThemeCandidateV2(topic))
      .filter((topic) => topic.length > 0),
  );
}

function cleanThemeCandidateV2(value: string): string {
  return normalize(value)
    .replace(
      /^(?:テーマ|topics?|見どころ|ポイント|session|topic|title)[:：\s]*/iu,
      "",
    )
    .replace(/^(?:第\d+回)\s*/u, "")
    .replace(/^(?:tableauユーザー会|ユーザー会)\s*/iu, "")
    .replace(/[「」『』"]/gu, "")
    .trim();
}

function extractSessionTitleCandidatesV2(value: string): string[] {
  const cleaned = normalize(value);
  if (!cleaned || looksLikeAnalysisNoise(cleaned)) {
    return [];
  }

  const quoted = [
    ...cleaned.matchAll(
      /[\u300c]([^\u300d]+)[\u300d]|[\u300e]([^\u300f]+)[\u300f]|"([^"]+)"/g,
    ),
  ]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .map((item) => item.trim())
    .filter(Boolean);

  const lines = cleaned
    .split(/\r?\n+/u)
    .map((line) => line.replace(/^[\s\-*]+/u, "").trim())
    .map((line) =>
      line.replace(/^(?:session|topic|title|セッション|テーマ)[:：\s]*/iu, ""),
    )
    .filter((line) => line.length > 0)
    .filter((line) => line.length <= 80);

  return uniqueStrings([...quoted, ...lines]);
}

function isLikelyThemeTokenV2(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 2 &&
    trimmed.length <= 24 &&
    !looksLikeNarrativeSentenceV2(trimmed) &&
    !isGenericThemeStopWordV2(trimmed)
  );
}

function isMeaningfulSessionTitleV2(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 6 &&
    trimmed.length <= 80 &&
    !looksLikeAnalysisNoise(trimmed) &&
    !looksLikeNarrativeSentenceV2(trimmed) &&
    !isGenericThemeStopWordV2(trimmed) &&
    !/^(?:session detail|evidence pack|visually rich event notes)$/iu.test(
      trimmed,
    ) &&
    !/(?:Mcp Awareness|はじめて聞いた|すでに活用している|試したことがある)/iu.test(
      trimmed,
    )
  );
}

function looksLikeNarrativeSentenceV2(value: string): boolean {
  return /(?:です|ます|でした|しましょう|したい|合いそう|ように|参加者|会場|スタート|詳細|summary|detail|notes?)/iu.test(
    value,
  );
}

function stripEventDecorationsV2(value: string): string {
  return normalize(value)
    .replace(/^[\[\(【][^\]\)】]+[\]\)】]\s*/u, "")
    .replace(
      /^(?:\d{1,4}[\/.\-年]\d{1,2}(?:[\/.\-月]\d{1,4})?(?:日)?\s*)+/u,
      "",
    )
    .replace(/^(?:本日|今日|開催中|開催後|イベント)\s*/u, "")
    .trim();
}

function isGenericThemeStopWordV2(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return [
    "tableau",
    "tableauユーザー会",
    "ユーザー会",
    "イベント",
    "開催中",
    "開催後",
    "見どころ",
    "ポイント",
    "session",
    "topic",
    "title",
  ].includes(trimmed);
}

function deriveTableauPostInsightsV2(
  evidencePack?: PostGenerationEvidencePack,
): TableauPostInsight[] {
  if (!evidencePack) {
    return [];
  }

  return uniqueTableauInsights([
    ...deriveSurveyTableauInsightsV2(evidencePack.surveyInsight),
    ...derivePostPerformanceTableauInsightsV2(
      evidencePack.postPerformanceInsight,
    ),
    ...deriveAccountOverviewTableauInsightsV2(
      evidencePack.accountOverviewInsight,
    ),
  ]);
}

function deriveSurveyTableauInsightsV2(
  insight: PostGenerationEvidencePack["surveyInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const labels = extractInsightLabels(insight.evidenceRows);
  const beginnerPresent = labels.some(isBeginnerAwarenessLabelV2);
  const experiencedPresent = labels.some(isExperiencedAwarenessLabelV2);
  const triedPresent = labels.some(isTriedAwarenessLabelV2);
  const awarenessDimension = isMcpAwarenessDimensionV2(insight.dimensionField);

  if (
    !awarenessDimension &&
    !beginnerPresent &&
    !experiencedPresent &&
    !triedPresent
  ) {
    return [];
  }

  const results: TableauPostInsight[] = [];

  if (beginnerPresent) {
    results.push({
      source: "survey",
      kind: "audience_context",
      summaryForPost: "MCPをはじめて聞く方も多い",
      confidence: 0.9,
      shouldUseInPost: true,
      reason: `Mcp Awareness の最多回答が「${labels.find(isBeginnerAwarenessLabelV2) ?? "はじめて聞いた"}」`,
    });
    results.push({
      source: "survey",
      kind: "content_hint",
      summaryForPost:
        "初心者にも伝わるように、やさしく整理する切り口が合いそう",
      confidence: 0.82,
      shouldUseInPost: true,
    });
  }

  if (beginnerPresent && (experiencedPresent || triedPresent)) {
    results.push({
      source: "survey",
      kind: "structure_hint",
      summaryForPost:
        "MCPが初めての方と、試したことがある方が混在しているため、やさしく入りつつ実践イメージも持てる構成が合いそう",
      confidence: 0.78,
      shouldUseInPost: false,
      reason: "初心者と経験者の両方が見えているため",
    });
  }

  return results;
}

function derivePostPerformanceTableauInsightsV2(
  insight: PostGenerationEvidencePack["postPerformanceInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const labels = extractInsightLabels(insight.evidenceRows);
  const mostlyDates =
    isDateLikeDimensionV2(insight.dimensionField) ||
    labels.filter(isDateLikeLabelV2).length >=
      Math.max(1, Math.ceil(labels.length / 2));

  if (mostlyDates) {
    return [
      {
        source: "post_performance",
        kind: "low_confidence",
        summaryForPost:
          "過去投稿分析は、日付中心の結果のため本文生成には使わない",
        confidence: 0.2,
        shouldUseInPost: false,
        reason: "日付だけでは投稿文の内容・構成・トーンを判断できない",
      },
    ];
  }

  const results: TableauPostInsight[] = [];

  if (insight.recommendedTone?.length) {
    results.push({
      source: "post_performance",
      kind: "tone_hint",
      summaryForPost: "少し親しみのある文体で、勢いを出しすぎない方が合いそう",
      confidence: 0.65,
      shouldUseInPost: false,
      reason: insight.recommendedTone.join(", "),
    });
  }

  if (insight.recommendedStructure?.length) {
    results.push({
      source: "post_performance",
      kind: "structure_hint",
      summaryForPost: "短い導入のあとに現場の一言を添える構成が合いそう",
      confidence: 0.68,
      shouldUseInPost: false,
      reason: insight.recommendedStructure.join(" / "),
    });
  }

  return results;
}

function deriveAccountOverviewTableauInsightsV2(
  insight: PostGenerationEvidencePack["accountOverviewInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const results: TableauPostInsight[] = [];

  if (insight.timingHints?.length) {
    results.push({
      source: "account_overview",
      kind: "timing_hint",
      summaryForPost:
        "会場の空気が動いているうちに、短く今の雰囲気を伝えるのが合いそう",
      confidence: 0.58,
      shouldUseInPost: false,
      reason: insight.timingHints.join(" / "),
    });
  }

  if (normalize(insight.accountContextForPost)) {
    results.push({
      source: "account_overview",
      kind: "content_hint",
      summaryForPost:
        "会場感やコミュニティの空気を前に出す切り口が馴染みやすそう",
      confidence: 0.55,
      shouldUseInPost: false,
      reason: insight.accountContextForPost,
    });
  }

  return results;
}

function buildSurveyInsightForPostV2(
  insights: TableauPostInsight[],
): string | undefined {
  const audienceInsight = insights.find(
    (insight) =>
      insight.source === "survey" && insight.kind === "audience_context",
  );
  if (audienceInsight) {
    return "MCPをはじめて聞く方にも伝わるように、今日はできるだけやさしく整理していきます。";
  }

  const mixedInsight = insights.find(
    (insight) =>
      insight.source === "survey" && insight.kind === "structure_hint",
  );
  if (mixedInsight) {
    return "MCPが初めての方も、すでに試したことがある方も、一緒にTableauとのつながりを見ていきます。";
  }

  return undefined;
}

function isMcpAwarenessDimensionV2(value?: string): boolean {
  return /mcp.?awareness/i.test(value ?? "");
}

function isBeginnerAwarenessLabelV2(value: string): boolean {
  return /(?:はじめて聞いた|初めて聞いた|first time|new to)/iu.test(value);
}

function isExperiencedAwarenessLabelV2(value: string): boolean {
  return /(?:すでに活用している|already using|active user)/iu.test(value);
}

function isTriedAwarenessLabelV2(value: string): boolean {
  return /(?:試したことがある|have tried|tried)/iu.test(value);
}

function isDateLikeDimensionV2(value?: string): boolean {
  return /(?:日付|date|day|week|month|time)/iu.test(value ?? "");
}

function isDateLikeLabelV2(value: string): boolean {
  return (
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\b/u.test(
      value,
    ) ||
    /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/u.test(value) ||
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/u.test(value)
  );
}

/* eslint-enable @typescript-eslint/no-unused-vars */
function renderXPostV3(
  material: PostMaterial,
  variant: "fact_based" | "survey_aware" | "community" | "fallback",
  tableauUsage: TableauInsightUsage,
): string {
  const shortName =
    material.eventShortName ??
    material.eventOfficialName ??
    "\u30a4\u30d9\u30f3\u30c8";
  const topics = material.mainTopics?.slice(0, 3) ?? [];
  const topicLine = topics.length
    ? `\u4eca\u65e5\u306f${topics.join("\u3001")}\u306e${topics.length}\u30c6\u30fc\u30de\u3002`
    : undefined;
  const audienceLine =
    variant === "survey_aware"
      ? (tableauUsage.inlineText ?? material.surveyInsightForPost ?? "")
      : undefined;
  const communityLead =
    "\u4f1a\u5834\u3082\u30aa\u30f3\u30e9\u30a4\u30f3\u3082\u3001\u5c11\u3057\u305a\u3064\u3042\u305f\u305f\u307e\u3063\u3066\u304d\u307e\u3057\u305f\u3002";
  const atmosphereLine =
    material.photoDescriptionForPost ??
    material.mood ??
    "\u4f1a\u5834\u3082\u30aa\u30f3\u30e9\u30a4\u30f3\u3082\u3001\u5c11\u3057\u305a\u3064\u3042\u305f\u305f\u307e\u3063\u3066\u304d\u307e\u3057\u305f\u3002";
  const explorationLine = topics.length
    ? "\u305d\u308c\u305e\u308c\u9055\u3046\u5207\u308a\u53e3\u304b\u3089\u3001Tableau\u306e\u697d\u3057\u3055\u3092\u898b\u3066\u3044\u304d\u307e\u3059\u3002"
    : undefined;
  const communityTopicLine = topics.length
    ? `${topics.join("\u3001")}\u3092\u30c6\u30fc\u30de\u306b\u3001Tableau\u306e\u697d\u3057\u3055\u3092\u5e83\u3052\u3066\u3044\u304d\u307e\u3059\u3002`
    : undefined;

  switch (material.postType) {
    case "live_report":
      return joinLines([
        variant === "fact_based"
          ? `${shortName}\u3001\u59cb\u307e\u308a\u307e\u3057\u305f\uff01`
          : variant === "survey_aware"
            ? `${shortName}\u3001\u30b9\u30bf\u30fc\u30c8\u3057\u3066\u3044\u307e\u3059\u3002`
            : communityLead,
        variant === "survey_aware"
          ? audienceLine || topicLine || atmosphereLine
          : variant === "community"
            ? communityTopicLine || topicLine || atmosphereLine
            : topicLine || atmosphereLine,
        variant === "fact_based" ? explorationLine : undefined,
        hashLine(material, "x"),
      ]);
    case "post_event_thanks":
      return joinLines([
        variant === "community"
          ? `${shortName}\u306b\u96c6\u307e\u3063\u3066\u304f\u3060\u3055\u3063\u305f\u307f\u306a\u3055\u3093\u3001\u3042\u308a\u304c\u3068\u3046\u3054\u3056\u3044\u307e\u3057\u305f\u3002`
          : `\u3042\u308a\u304c\u3068\u3046\u3054\u3056\u3044\u307e\u3057\u305f\u3002${shortName}\u306e\u69d8\u5b50\u3092\u5c11\u3057\u632f\u308a\u8fd4\u308a\u307e\u3059\u3002`,
        topicLine || atmosphereLine,
        material.callToAction,
        hashLine(material, "x"),
      ]);
    case "recap":
      return joinLines([
        `${shortName}\u306e\u307e\u3068\u3081\u3067\u3059\u3002`,
        topicLine || audienceLine || atmosphereLine,
        material.callToAction,
        hashLine(material, "x"),
      ]);
    case "pre_event":
      return joinLines([
        variant === "fact_based"
          ? `${shortName}\u3001\u307e\u3082\u306a\u304f\u59cb\u307e\u308a\u307e\u3059\u3002`
          : variant === "survey_aware"
            ? `${shortName}\u3001\u30b9\u30bf\u30fc\u30c8\u524d\u3067\u3059\u3002`
            : `${shortName}\u3001\u3044\u3088\u3044\u3088\u958b\u50ac\u3067\u3059\u3002`,
        variant === "survey_aware"
          ? audienceLine || topicLine || atmosphereLine
          : variant === "community"
            ? communityTopicLine || topicLine || atmosphereLine
            : topicLine || atmosphereLine,
        material.callToAction,
        hashLine(material, "x"),
      ]);
    default:
      return joinLines([
        `${shortName}\u306e\u898b\u3069\u3053\u308d\u3092\u307e\u3068\u3081\u307e\u3059\u3002`,
        topicLine || audienceLine || atmosphereLine,
        material.callToAction || explorationLine,
        hashLine(material, "x"),
      ]);
  }
}

function renderSharedBodyV3(material: PostMaterial): string {
  const shortName =
    material.eventShortName ??
    material.eventOfficialName ??
    "\u30a4\u30d9\u30f3\u30c8";
  const topics = material.mainTopics?.slice(0, 3) ?? [];
  return joinLines([
    `${shortName}\u306e\u5171\u6709\u30e1\u30e2\u3067\u3059\u3002`,
    topics.length
      ? `\u4eca\u65e5\u306f${topics.join("\u3001")}\u3092\u8ef8\u306b\u3001Tableau\u306e\u697d\u3057\u3055\u3092\u898b\u3066\u3044\u304d\u307e\u3059\u3002`
      : undefined,
    material.audienceContext,
    material.photoDescriptionForPost,
    material.callToAction,
  ]);
}

function buildRationaleV3(
  material: PostMaterial,
  variant: "fact_based" | "survey_aware" | "community" | "fallback",
  tableauUsage: TableauInsightUsage,
): string {
  const shortName =
    material.eventShortName ??
    material.eventOfficialName ??
    "\u30a4\u30d9\u30f3\u30c8";
  switch (variant) {
    case "survey_aware":
      if (tableauUsage.usedInsights[0]) {
        return `${shortName}\u3092\u3001${tableauUsage.usedInsights[0].summaryForPost}\u3068\u3044\u3046\u6587\u8108\u3067\u3084\u3055\u3057\u304f\u4f1d\u3048\u308b\u6848\u3067\u3059\u3002`;
      }
      return `${shortName}\u306e\u898b\u3069\u3053\u308d\u3092\u3084\u308f\u3089\u304b\u304f\u307e\u3068\u3081\u305f\u6848\u3067\u3059\u3002`;
    case "community":
      return `${shortName}\u306e\u898b\u3069\u3053\u308d\u3092\u30b3\u30df\u30e5\u30cb\u30c6\u30a3\u611f\u91cd\u8996\u3067\u307e\u3068\u3081\u305f\u6848\u3067\u3059\u3002`;
    case "fallback":
      return `${shortName}\u306e\u898b\u3069\u3053\u308d\u3092\u81ea\u7136\u306a\u8a00\u3044\u56de\u3057\u3067\u6574\u7406\u3057\u305f\u6848\u3067\u3059\u3002`;
    case "fact_based":
    default:
      return `${shortName}\u306e\u898b\u3069\u3053\u308d\u3092\u7d20\u76f4\u306b\u307e\u3068\u3081\u305f\u6848\u3067\u3059\u3002`;
  }
}

function buildCallToActionV3(postType: PostMaterial["postType"]): string {
  switch (postType) {
    case "live_report":
      return "\u4f1a\u5834\u306e\u7a7a\u6c17\u611f\u3092\u305d\u306e\u307e\u307e\u304a\u5c4a\u3051\u3057\u307e\u3059\u3002";
    case "post_event_thanks":
      return "\u307e\u305f\u6b21\u56de\u3082\u4e00\u7dd2\u306b\u697d\u3057\u3081\u305f\u3089\u3046\u308c\u3057\u3044\u3067\u3059\u3002";
    case "recap":
      return "\u6b21\u56de\u306b\u3064\u306a\u304c\u308b\u30dd\u30a4\u30f3\u30c8\u3092\u5c11\u3057\u305a\u3064\u632f\u308a\u8fd4\u308a\u307e\u3059\u3002";
    case "pre_event":
      return "\u6c17\u306b\u306a\u308b\u65b9\u306f\u305c\u3072\u30c1\u30a7\u30c3\u30af\u3057\u3066\u304f\u3060\u3055\u3044\u3002";
    default:
      return "\u4eca\u65e5\u306e\u898b\u3069\u3053\u308d\u3092\u81ea\u7136\u306a\u8a00\u8449\u3067\u307e\u3068\u3081\u307e\u3059\u3002";
  }
}

function mapPostTypeV3(postType: string): PostMaterial["postType"] {
  if (
    /(?:\u958b\u50ac\u4e2d\u306e\u5b9f\u6cc1|\u958b\u50ac\u4e2d|live report)/iu.test(
      postType,
    )
  ) {
    return "live_report";
  }
  if (
    /(?:\u958b\u50ac\u5f8c\u306e\u304a\u793c|\u958b\u50ac\u5f8c\u306e\u30ec\u30dd\u30fc\u30c8|\u958b\u50ac\u5f8c|thank you)/iu.test(
      postType,
    )
  ) {
    return "post_event_thanks";
  }
  if (
    /(?:\u6b21\u56de\u53c2\u52a0\u306e\u547c\u3073\u304b\u3051|\u307e\u3068\u3081|recap)/iu.test(
      postType,
    )
  ) {
    return "recap";
  }
  if (
    /(?:\u4e8b\u524d\u544a\u77e5|\u958b\u50ac\u76f4\u524d\u30ea\u30de\u30a4\u30f3\u30c9|\u544a\u77e5|remind)/iu.test(
      postType,
    )
  ) {
    return "pre_event";
  }
  return "generic";
}

function derivePhotoAtmosphereV3(
  request: ActionRunRequest,
  evidencePack?: PostGenerationEvidencePack,
): string | undefined {
  const text = [
    evidencePack?.photoContext.summary,
    evidencePack?.photoContext.eventFeel,
    evidencePack?.photoContext.sceneInference,
    evidencePack?.photoContext.visibleText?.join(" "),
    request.currentSituation,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (!text) {
    return undefined;
  }
  if (looksLikeWarmPhoto(text)) {
    return "\u548c\u3084\u304b\u306a\u96f0\u56f2\u6c17";
  }
  if (looksLikeBrightPhoto(text)) {
    return "\u660e\u308b\u3044\u96f0\u56f2\u6c17";
  }
  if (looksLikeCrowdedPhoto(text)) {
    return "\u53c2\u52a0\u8005\u306e\u71b1\u304c\u9ad8\u307e\u3063\u3066\u304d\u305f\u96f0\u56f2\u6c17";
  }
  if (/(?:live|started|\u958b\u50ac\u4e2d|\u958b\u5834)/iu.test(text)) {
    return "\u4f1a\u5834\u304c\u5c11\u3057\u305a\u3064\u3042\u305f\u305f\u307e\u3063\u3066\u304d\u3066\u3044\u307e\u3059\u3002";
  }
  return undefined;
}

function deriveMoodV3(
  request: ActionRunRequest,
  evidencePack?: PostGenerationEvidencePack,
  photoDescription?: string,
): string | undefined {
  const text = [
    photoDescription,
    evidencePack?.photoContext.summary,
    evidencePack?.photoContext.eventFeel,
    request.currentSituation,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (looksLikeWarmPhoto(text)) {
    return "\u548c\u3084\u304b\u306a\u96f0\u56f2\u6c17";
  }
  if (looksLikeBrightPhoto(text)) {
    return "\u660e\u308b\u3044\u96f0\u56f2\u6c17";
  }
  if (looksLikeCrowdedPhoto(text)) {
    return "\u53c2\u52a0\u8005\u3069\u3046\u3057\u306e\u4f1a\u8a71\u304c\u5e83\u304c\u3063\u3066\u304d\u305f\u96f0\u56f2\u6c17";
  }
  if (/(?:live|started|\u958b\u50ac\u4e2d|\u958b\u5834)/iu.test(text)) {
    return "\u4f1a\u5834\u304c\u3042\u305f\u305f\u307e\u3063\u3066\u304d\u3066\u3044\u307e\u3059\u3002";
  }
  return undefined;
}

function deriveEventThemesV3(input: {
  eventDescriptionTexts: string[];
  eventName?: string;
  analysisSections: ActionRunAnalysisSection[];
}): string[] {
  void input.analysisSections;

  const fromDescription = uniqueStrings(
    input.eventDescriptionTexts
      .flatMap((candidate) => extractEventThemeCandidatesV3(candidate))
      .map((topic) => sanitizeTopic(topic))
      .filter((topic) => isSafeEventTheme(topic))
      .filter((topic) => isLikelyThemeTokenV3(topic)),
  );
  if (fromDescription.length > 0) {
    return fromDescription.slice(0, 3);
  }

  return input.eventName
    ? uniqueStrings(
        extractEventThemeCandidatesV3(input.eventName)
          .map((topic) => sanitizeTopic(topic))
          .filter((topic) => isSafeEventTheme(topic))
          .filter((topic) => isLikelyThemeTokenV3(topic)),
      ).slice(0, 3)
    : [];
}

function deriveSessionTitlesV3(input: {
  eventDescriptionTexts: string[];
  analysisSections: ActionRunAnalysisSection[];
}): string[] {
  const candidates = [
    ...input.eventDescriptionTexts,
    ...input.analysisSections
      .filter(
        (section) =>
          !["photo_context", "survey_insight", "evidence_pack"].includes(
            section.key,
          ),
      )
      .flatMap((section) => [section.title, section.question, section.summary]),
  ];

  return uniqueStrings(
    candidates
      .flatMap((candidate) => extractSessionTitleCandidatesV3(candidate))
      .map((title) => sanitizeTopic(title))
      .filter((title) => isMeaningfulSessionTitleV3(title)),
  ).slice(0, 5);
}

function extractEventThemeCandidatesV3(value: string): string[] {
  const cleaned = stripEventDecorationsV3(normalize(value))
    .replace(/(?:^|\s)Hashtags?\b/giu, " ")
    .replace(/#[^\s#]+/gu, " ")
    .replace(/\bhttps?:\/\/\S+/giu, " ")
    .replace(/\bwww\.\S+/giu, " ");

  return uniqueStrings(
    cleaned
      .split(/\s*(?:[\/|]|・|･|、|,|，)\s*/u)
      .flatMap((part) => part.split(/\s+-\s+/u))
      .map((topic) => cleanThemeCandidateV3(topic))
      .filter((topic) => topic.length > 0),
  );
}

function cleanThemeCandidateV3(value: string): string {
  return normalize(value)
    .replace(
      /^(?:\u30c6\u30fc\u30de|topics?|session|topic|title|points?)[:：\s]*/iu,
      "",
    )
    .replace(/^(?:\u7b2c\d+\u56de)\s*/u, "")
    .replace(
      /^(?:tableau\u30e6\u30fc\u30b6\u30fc\u4f1a|\u30e6\u30fc\u30b6\u30fc\u4f1a)\s*/iu,
      "",
    )
    .replace(/[「」『』"]/gu, "")
    .trim();
}

function extractSessionTitleCandidatesV3(value: string): string[] {
  const cleaned = normalize(value);
  if (!cleaned || looksLikeAnalysisNoise(cleaned)) {
    return [];
  }

  const quoted = [
    ...cleaned.matchAll(
      /[\u300c]([^\u300d]+)[\u300d]|[\u300e]([^\u300f]+)[\u300f]|"([^"]+)"/g,
    ),
  ]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .map((item) => item.trim())
    .filter(Boolean);

  const lines = cleaned
    .split(/\r?\n+/u)
    .map((line) => line.replace(/^[\s\-*]+/u, "").trim())
    .map((line) =>
      line.replace(
        /^(?:session|topic|title|\u30bb\u30c3\u30b7\u30e7\u30f3|\u30c6\u30fc\u30de)[:：\s]*/iu,
        "",
      ),
    )
    .filter((line) => line.length > 0)
    .filter((line) => line.length <= 80);

  return uniqueStrings([...quoted, ...lines]);
}

function isLikelyThemeTokenV3(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 2 &&
    trimmed.length <= 24 &&
    !looksLikeNarrativeSentenceV3(trimmed) &&
    !isGenericThemeStopWordV3(trimmed)
  );
}

function isMeaningfulSessionTitleV3(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 6 &&
    trimmed.length <= 80 &&
    !looksLikeAnalysisNoise(trimmed) &&
    !looksLikeNarrativeSentenceV3(trimmed) &&
    !isGenericThemeStopWordV3(trimmed) &&
    !/^(?:session detail|evidence pack|visually rich event notes)$/iu.test(
      trimmed,
    ) &&
    !/(?:Mcp Awareness|\u306f\u3058\u3081\u3066\u805e\u3044\u305f|\u3059\u3067\u306b\u6d3b\u7528\u3057\u3066\u3044\u308b|\u8a66\u3057\u305f\u3053\u3068\u304c\u3042\u308b)/iu.test(
      trimmed,
    )
  );
}

function looksLikeNarrativeSentenceV3(value: string): boolean {
  return /(?:\u3067\u3059|\u307e\u3059|\u3067\u3057\u305f|\u3057\u307e\u3057\u3087\u3046|\u3057\u305f\u3044|\u5408\u3044\u305d\u3046|\u3088\u3046\u306b|\u53c2\u52a0\u8005|\u4f1a\u5834|summary|detail|notes?)/iu.test(
    value,
  );
}

function stripEventDecorationsV3(value: string): string {
  return normalize(value)
    .replace(/^[\[\(【][^\]\)】]+[\]\)】]\s*/u, "")
    .replace(
      /^(?:\d{1,4}[\/.\-\u5e74]\d{1,2}(?:[\/.\-\u6708]\d{1,4})?(?:\u65e5)?\s*)+/u,
      "",
    )
    .replace(
      /^(?:\u672c\u65e5|\u4eca\u65e5|\u958b\u50ac\u4e2d|\u958b\u50ac\u5f8c|\u30a4\u30d9\u30f3\u30c8)\s*/u,
      "",
    )
    .trim();
}

function isGenericThemeStopWordV3(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return [
    "tableau",
    "tableauユーザー会",
    "ユーザー会",
    "イベント",
    "開催中",
    "開催後",
    "見どころ",
    "ポイント",
    "session",
    "topic",
    "title",
  ].includes(trimmed);
}

function deriveTableauPostInsightsV3(
  evidencePack?: PostGenerationEvidencePack,
): TableauPostInsight[] {
  if (!evidencePack) {
    return [];
  }

  return uniqueTableauInsights([
    ...deriveSurveyTableauInsightsV3(evidencePack.surveyInsight),
    ...derivePostPerformanceTableauInsightsV3(
      evidencePack.postPerformanceInsight,
    ),
    ...deriveAccountOverviewTableauInsightsV3(
      evidencePack.accountOverviewInsight,
    ),
  ]);
}

function deriveSurveyTableauInsightsV3(
  insight: PostGenerationEvidencePack["surveyInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const labels = extractInsightLabels(insight.evidenceRows);
  const beginnerPresent = labels.some(isBeginnerAwarenessLabelV3);
  const experiencedPresent = labels.some(isExperiencedAwarenessLabelV3);
  const triedPresent = labels.some(isTriedAwarenessLabelV3);
  const awarenessDimension = isMcpAwarenessDimensionV3(insight.dimensionField);

  if (
    !awarenessDimension &&
    !beginnerPresent &&
    !experiencedPresent &&
    !triedPresent
  ) {
    return [];
  }

  const results: TableauPostInsight[] = [];

  if (beginnerPresent) {
    results.push({
      source: "survey",
      kind: "audience_context",
      summaryForPost:
        "MCP\u3092\u306f\u3058\u3081\u3066\u805e\u304f\u65b9\u3082\u591a\u3044",
      confidence: 0.9,
      shouldUseInPost: true,
      reason: `Mcp Awareness \u306e\u6700\u591a\u56de\u7b54\u304c\u300c${labels.find(isBeginnerAwarenessLabelV3) ?? "\u306f\u3058\u3081\u3066\u805e\u3044\u305f"}\u300d`,
    });
    results.push({
      source: "survey",
      kind: "content_hint",
      summaryForPost:
        "\u521d\u5fc3\u8005\u306b\u3082\u4f1d\u308f\u308b\u3088\u3046\u306b\u3001\u3084\u3055\u3057\u304f\u6574\u7406\u3059\u308b\u5207\u308a\u53e3\u304c\u5408\u3044\u305d\u3046",
      confidence: 0.82,
      shouldUseInPost: true,
    });
  }

  if (beginnerPresent && (experiencedPresent || triedPresent)) {
    results.push({
      source: "survey",
      kind: "structure_hint",
      summaryForPost:
        "MCP\u304c\u521d\u3081\u3066\u306e\u65b9\u3068\u3001\u8a66\u3057\u305f\u3053\u3068\u304c\u3042\u308b\u65b9\u304c\u6df7\u5728\u3057\u3066\u3044\u308b\u305f\u3081\u3001\u3084\u3055\u3057\u304f\u5165\u308a\u3064\u3064\u5b9f\u8df5\u30a4\u30e1\u30fc\u30b8\u3082\u6301\u3066\u308b\u69cb\u6210\u304c\u5408\u3044\u305d\u3046",
      confidence: 0.78,
      shouldUseInPost: false,
      reason:
        "\u521d\u5fc3\u8005\u3068\u7d4c\u9a13\u8005\u306e\u4e21\u65b9\u304c\u898b\u3048\u3066\u3044\u308b\u305f\u3081",
    });
  }

  return results;
}

function derivePostPerformanceTableauInsightsV3(
  insight: PostGenerationEvidencePack["postPerformanceInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const labels = extractInsightLabels(insight.evidenceRows);
  const mostlyDates =
    isDateLikeDimensionV3(insight.dimensionField) ||
    labels.filter(isDateLikeLabelV3).length >=
      Math.max(1, Math.ceil(labels.length / 2));

  if (mostlyDates) {
    return [
      {
        source: "post_performance",
        kind: "low_confidence",
        summaryForPost:
          "\u904e\u53bb\u6295\u7a3f\u5206\u6790\u306f\u3001\u65e5\u4ed8\u4e2d\u5fc3\u306e\u7d50\u679c\u306e\u305f\u3081\u672c\u6587\u751f\u6210\u306b\u306f\u4f7f\u308f\u306a\u3044",
        confidence: 0.2,
        shouldUseInPost: false,
        reason:
          "\u65e5\u4ed8\u3060\u3051\u3067\u306f\u6295\u7a3f\u6587\u306e\u5185\u5bb9\u30fb\u69cb\u6210\u30fb\u30c8\u30fc\u30f3\u3092\u5224\u65ad\u3067\u304d\u306a\u3044",
      },
    ];
  }

  const results: TableauPostInsight[] = [];

  if (insight.recommendedTone?.length) {
    results.push({
      source: "post_performance",
      kind: "tone_hint",
      summaryForPost:
        "\u5c11\u3057\u89aa\u3057\u307f\u306e\u3042\u308b\u6587\u4f53\u3067\u3001\u52e2\u3044\u3092\u51fa\u3057\u3059\u304e\u306a\u3044\u65b9\u304c\u5408\u3044\u305d\u3046",
      confidence: 0.65,
      shouldUseInPost: false,
      reason: insight.recommendedTone.join(", "),
    });
  }

  if (insight.recommendedStructure?.length) {
    results.push({
      source: "post_performance",
      kind: "structure_hint",
      summaryForPost:
        "\u77ed\u3044\u5c0e\u5165\u306e\u3042\u3068\u306b\u73fe\u5834\u306e\u4e00\u8a00\u3092\u6dfb\u3048\u308b\u69cb\u6210\u304c\u5408\u3044\u305d\u3046",
      confidence: 0.68,
      shouldUseInPost: false,
      reason: insight.recommendedStructure.join(" / "),
    });
  }

  return results;
}

function deriveAccountOverviewTableauInsightsV3(
  insight: PostGenerationEvidencePack["accountOverviewInsight"],
): TableauPostInsight[] {
  if (!insight.available) {
    return [];
  }

  const results: TableauPostInsight[] = [];

  if (insight.timingHints?.length) {
    results.push({
      source: "account_overview",
      kind: "timing_hint",
      summaryForPost:
        "\u4f1a\u5834\u306e\u7a7a\u6c17\u304c\u52d5\u3044\u3066\u3044\u308b\u3046\u3061\u306b\u3001\u77ed\u304f\u4eca\u306e\u96f0\u56f2\u6c17\u3092\u4f1d\u3048\u308b\u306e\u304c\u5408\u3044\u305d\u3046",
      confidence: 0.58,
      shouldUseInPost: false,
      reason: insight.timingHints.join(" / "),
    });
  }

  if (normalize(insight.accountContextForPost)) {
    results.push({
      source: "account_overview",
      kind: "content_hint",
      summaryForPost:
        "\u4f1a\u5834\u611f\u3084\u30b3\u30df\u30e5\u30cb\u30c6\u30a3\u306e\u7a7a\u6c17\u3092\u524d\u306b\u51fa\u3059\u5207\u308a\u53e3\u304c\u99b4\u67d3\u307f\u3084\u3059\u305d\u3046",
      confidence: 0.55,
      shouldUseInPost: false,
      reason: insight.accountContextForPost,
    });
  }

  return results;
}

function buildSurveyInsightForPostV3(
  insights: TableauPostInsight[],
): string | undefined {
  const audienceInsight = insights.find(
    (insight) =>
      insight.source === "survey" && insight.kind === "audience_context",
  );
  if (audienceInsight) {
    return "\u004d\u0043\u0050\u3092\u306f\u3058\u3081\u3066\u805e\u304f\u65b9\u306b\u3082\u4f1d\u308f\u308b\u3088\u3046\u306b\u3001\u4eca\u65e5\u306f\u3067\u304d\u308b\u3060\u3051\u3084\u3055\u3057\u304f\u6574\u7406\u3057\u3066\u3044\u304d\u307e\u3059\u3002";
  }

  const mixedInsight = insights.find(
    (insight) =>
      insight.source === "survey" && insight.kind === "structure_hint",
  );
  if (mixedInsight) {
    return "\u004d\u0043\u0050\u304c\u521d\u3081\u3066\u306e\u65b9\u3082\u3001\u3059\u3067\u306b\u8a66\u3057\u305f\u3053\u3068\u304c\u3042\u308b\u65b9\u3082\u3001\u4e00\u7dd2\u306bTableau\u3068\u306e\u3064\u306a\u304c\u308a\u3092\u898b\u3066\u3044\u304d\u307e\u3059\u3002";
  }

  return undefined;
}

function isMcpAwarenessDimensionV3(value?: string): boolean {
  return /mcp.?awareness/i.test(value ?? "");
}

function isBeginnerAwarenessLabelV3(value: string): boolean {
  return /(?:\u306f\u3058\u3081\u3066\u805e\u3044\u305f|\u521d\u3081\u3066\u805e\u3044\u305f|first time|new to)/iu.test(
    value,
  );
}

function isExperiencedAwarenessLabelV3(value: string): boolean {
  return /(?:\u3059\u3067\u306b\u6d3b\u7528\u3057\u3066\u3044\u308b|already using|active user)/iu.test(
    value,
  );
}

function isTriedAwarenessLabelV3(value: string): boolean {
  return /(?:\u8a66\u3057\u305f\u3053\u3068\u304c\u3042\u308b|have tried|tried)/iu.test(
    value,
  );
}

function isDateLikeDimensionV3(value?: string): boolean {
  return /(?:\u65e5\u4ed8|date|day|week|month|time)/iu.test(value ?? "");
}

function isDateLikeLabelV3(value: string): boolean {
  return (
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\b/u.test(
      value,
    ) ||
    /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/u.test(value) ||
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/u.test(value)
  );
}

function normalize(value?: string): string {
  return value?.trim().replace(/\s+/gu, " ") ?? "";
}

function hashLine(material: PostMaterial, channel: HashtagChannel): string {
  return buildHashtagLine({
    candidates: material.hashtagCandidates ?? [],
    channel,
  });
}

function joinLines(lines: Array<string | undefined>): string {
  return lines
    .filter((line): line is string => Boolean(line && line.trim()))
    .join("\n\n");
}

function compactStrings(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value?.trim()));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => normalize(value)).filter(Boolean))];
}
