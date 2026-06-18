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
  mood?: string;
  mainTopics?: string[];
  audienceContext?: string;
  speakerOrSessionContext?: string;
  photoDescriptionForPost?: string;
  callToAction?: string;
  hashtags: string[];
  hashtagCandidates?: HashtagCandidate[];
};

export type PostQualityIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  matchedText?: string;
};

export type PostQualityResult = {
  ok: boolean;
  issues: PostQualityIssue[];
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
  const photoDescriptionForPost = derivePhotoDescription(
    input.request,
    evidencePack,
  );
  const mood = deriveMood(input.request, evidencePack, photoDescriptionForPost);
  const mainTopics = deriveMainTopics(input.analysisSections, evidencePack);
  const audienceContext = deriveAudienceContext(
    input.analysisSections,
    evidencePack,
  );
  const speakerOrSessionContext = deriveSessionContext(
    input.analysisSections,
    mainTopics,
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
      ...input.analysisSections.flatMap((section) =>
        section.rows.map((row) => row.label),
      ),
      evidencePack?.photoContext.summary,
    ]),
  });
  const hashtags = selectHashtags({
    candidates: hashtagCandidates,
    channel: "x",
  });

  const postType = mapPostType(input.request.postType);
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
    mood,
    mainTopics,
    audienceContext,
    speakerOrSessionContext,
    photoDescriptionForPost,
    callToAction: buildCallToAction(postType),
    hashtags,
    hashtagCandidates,
  };
}

export function generatePostSuggestions(input: {
  material: PostMaterial;
  maxSuggestions?: number;
}): GeneratedPostSuggestion[] {
  const variants = ["fact", "soft", "community"] as const;
  const suggestions = variants
    .map((variant) => buildSuggestionWithQuality(input.material, variant))
    .filter((item) => item.quality.ok)
    .map((item) => item.suggestion);

  if (suggestions.length > 0) {
    return suggestions.slice(0, input.maxSuggestions ?? 3);
  }

  return [buildSuggestionWithQuality(input.material, "fallback").suggestion];
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
  variant: "fact" | "soft" | "community" | "fallback",
): { suggestion: GeneratedPostSuggestion; quality: PostQualityResult } {
  const text = truncatePostText(
    renderXPost(material, variant),
    POST_TEXT_LIMIT,
  );
  const quality = buildPostQualityResult(text, {
    hashtags: material.hashtags,
    hashtagCandidates: material.hashtagCandidates,
    channel: "x",
  });

  return {
    suggestion: {
      text,
      rationale: buildRationale(material, variant),
      usedEvidence: {
        photo: Boolean(material.photoDescriptionForPost),
        event: Boolean(material.eventOfficialName),
        survey: Boolean(material.audienceContext),
        postPerformance: Boolean(material.mainTopics?.length),
        accountOverview: Boolean(material.mood),
      },
      warnings: quality.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => issue.code),
    },
    quality,
  };
}

function renderXPost(
  material: PostMaterial,
  variant: "fact" | "soft" | "community" | "fallback",
): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "イベント";
  const topics = material.mainTopics?.slice(0, 3) ?? [];
  const topicLine = topics.length
    ? `今日は${topics.join("、")}の3テーマ。`
    : "";
  const audienceLine = material.audienceContext ?? "";
  const moodLine = material.mood ?? "";
  const photoLine = material.photoDescriptionForPost ?? "";
  const ctaLine = material.callToAction ?? "";

  switch (material.postType) {
    case "live_report":
      return joinLines([
        variant === "soft"
          ? `${shortName}、少しずつ会場があたたまってきました。`
          : `${shortName}、始まりました！`,
        topicLine || moodLine || photoLine,
        variant === "community"
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
        variant === "community"
          ? `${shortName}、いよいよ開催です。`
          : `${shortName}、まもなく開催です。`,
        topicLine || audienceLine || photoLine,
        ctaLine,
        hashLine(material, "x"),
      ]);
    default:
      return joinLines([
        `${shortName}の見どころをまとめました。`,
        topicLine || audienceLine || moodLine,
        ctaLine,
        hashLine(material, "x"),
      ]);
  }
}

function renderXDraft(material: PostMaterial): string {
  return truncatePostText(renderXPost(material, "fact"), POST_TEXT_LIMIT);
}

function renderLinkedInDraft(material: PostMaterial): string {
  return truncatePostText(
    joinLines([renderSharedBody(material), hashLine(material, "linkedin")]),
    POST_TEXT_LIMIT,
  );
}

function renderEmailDraft(material: PostMaterial): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "Event";
  return truncatePostText(
    joinLines([`Subject: ${shortName}`, renderSharedBody(material)]),
    1000,
  );
}

function renderNotionDraft(material: PostMaterial): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "Event";
  return truncatePostText(
    joinLines([`# ${shortName}`, renderSharedBody(material)]),
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
  variant: "fact" | "soft" | "community" | "fallback",
): string {
  const shortName =
    material.eventShortName ?? material.eventOfficialName ?? "イベント";
  switch (variant) {
    case "soft":
      return `${shortName}の見どころをやわらかくまとめました。`;
    case "community":
      return `${shortName}の見どころをコミュニティ感重視でまとめました。`;
    case "fallback":
      return `${shortName}の見どころを自然な見出しに整理しました。`;
    case "fact":
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

  const withoutPrefix = cleaned.replace(/^[【［\[]?.*?[】］\]]?\s*/u, "");
  const noSubtitle =
    withoutPrefix.split(/[|｜/／:：]/u)[0]?.trim() ?? withoutPrefix;
  const tokens = noSubtitle.split(/\s+/u).filter(Boolean);
  if (tokens.length <= 3) {
    return noSubtitle;
  }

  return tokens.slice(0, 3).join(" ");
}

function derivePhotoDescription(
  request: ActionRunRequest,
  evidencePack?: PostGenerationEvidencePack,
): string | undefined {
  const candidates = [
    evidencePack?.photoContext.summary,
    evidencePack?.photoContext.eventFeel,
    evidencePack?.photoContext.sceneInference,
    request.currentSituation,
  ]
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value));

  const joined = candidates.join(" ");
  if (/(friendship|teamwork|positivity)/i.test(joined)) {
    return "和やかな雰囲気";
  }
  if (/(fill|ready|setup|準備)/i.test(joined)) {
    return "会場は少しずつ整ってきています";
  }

  const postable = evidencePack?.photoContext.postableElements?.find((value) =>
    isSafeTopic(value),
  );
  if (postable) {
    return sanitizeTopic(postable);
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

  if (/(friendship|teamwork|positivity)/i.test(text)) {
    return "和やかな雰囲気";
  }
  if (/(fill|ready|setup|準備)/i.test(text)) {
    return "準備が少しずつ進んでいます";
  }
  if (/(live|開催中|started)/i.test(text)) {
    return "会場の熱量が少しずつ高まっています";
  }
  return undefined;
}

function deriveMainTopics(
  analysisSections: ActionRunAnalysisSection[],
  evidencePack?: PostGenerationEvidencePack,
): string[] {
  const candidates = [
    ...(evidencePack?.photoContext.detectedTopics ?? []),
    ...(evidencePack?.photoContext.postableElements ?? []),
    ...(evidencePack?.photoContext.suggestedPostAngles ?? []),
    ...(evidencePack?.surveyInsight.suggestedAngles ?? []),
    ...(evidencePack?.postPerformanceInsight.highPerformingThemes ?? []),
    ...(evidencePack?.accountOverviewInsight.notableChanges ?? []),
    ...analysisSections.flatMap((section) => [
      section.title,
      section.summary,
      ...section.rows.map((row) => row.label),
    ]),
  ];

  return uniqueStrings(
    candidates
      .flatMap((candidate) => splitTopics(candidate))
      .map((topic) => sanitizeTopic(topic))
      .filter((topic) => isSafeTopic(topic)),
  ).slice(0, 3);
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

function splitTopics(value: string): string[] {
  return value.split(/[、,\/|;:\n\r\t\s-]+/u).filter(Boolean);
}

function sanitizeTopic(value: string): string {
  return normalize(value)
    .replace(
      /^(?:metric|dimension|top item|rank_metric|rank_label)\s*[:：]?\s*/iu,
      "",
    )
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
