import { z } from "zod";
import type {
  InvokableTool,
  JSONValue,
  ZodToolConfig,
} from "@strands-agents/sdk";
import { logError, logInfo, safeErrorDetails } from "../../logging";
import type {
  ActionRunAnalysisSection,
  ActionRunRequest,
} from "../../types/actionRun";
import type { TechPlayPreviewResponse } from "../../types/techplay";
import type { PostGenerationEvidencePack } from "../../services/tableauPhotoPostAnalysisService";
import {
  buildChannelDrafts,
  buildImageCaption as buildSafeImageCaption,
  buildPostMaterial,
  buildPostQualityResult,
  buildPostSummary,
  type PostMaterial,
} from "../../services/postCopyService";

export type PrDraftPlatform = "x" | "linkedin" | "email" | "notion";

export type PrDraftReviewStatus = "pass" | "needs_info" | "needs_review";

export type PrDraftSourceInfo = {
  postType: string;
  eventName: string;
  techplayUrl: string;
  currentSituation: string;
  dashboardName: string;
  workbookName?: string;
  worksheetNames: string[];
  capturedAt: string;
  techplayEventName?: string;
  techplayEventDateText?: string;
  techplaySummary?: string;
  analysisHighlights: string[];
  missingFields: string[];
};

export type PrDraftReview = {
  status: PrDraftReviewStatus;
  riskLevel: "low" | "medium" | "high";
  missingFields: string[];
  issues: string[];
  checklist: string[];
  notes: string[];
};

export type PrDraftOutput = {
  sourceInfo: PrDraftSourceInfo;
  summary: string;
  announcementDraft: string;
  socialPostDraft: string;
  drafts: {
    x: string;
    linkedin: string;
    email: string;
    notion: string;
  };
  review: PrDraftReview;
  evidence: string[];
  checks: string[];
  hashtags: string[];
  imageCaption: string;
  missingFields: string[];
};

export type CollectPrSourceInfoInput = z.input<
  typeof collectPrSourceInfoSchema
>;
export type CollectPrSourceInfoOutput = PrDraftSourceInfo;
export type SummarizePrSourceInfoInput = { sourceInfo: PrDraftSourceInfo };
export type SummarizePrSourceInfoOutput = string;
export type GenerateAnnouncementDraftInput = {
  sourceInfo: PrDraftSourceInfo;
  summary: string;
};
export type GenerateAnnouncementDraftOutput = string;
export type GenerateSocialPostDraftInput = {
  platform: PrDraftPlatform;
  sourceInfo: PrDraftSourceInfo;
  summary: string;
};
export type GenerateSocialPostDraftOutput = string;
export type ReviewPrDraftInput = {
  sourceInfo: PrDraftSourceInfo;
  announcementDraft: string;
  socialPostDrafts: { x: string; linkedin: string };
};
export type ReviewPrDraftOutput = PrDraftReview;
export type CreateDraftOutputInput = {
  sourceInfo: PrDraftSourceInfo;
  summary: string;
  announcementDraft: string;
  socialPostDraft: string;
  socialPostDrafts: { x: string; linkedin: string };
  review: PrDraftReview;
};
export type CreateDraftOutputOutput = PrDraftOutput;

type PrToolDefinition<
  TSchema extends z.ZodTypeAny,
  TReturn extends JSONValue,
> = {
  name: string;
  description: string;
  inputSchema: TSchema;
  callback: (input: z.output<TSchema>) => Promise<TReturn>;
};

export type PrToolFactory = <
  TInput extends z.ZodType,
  TReturn extends JSONValue = JSONValue,
>(
  config: ZodToolConfig<TInput, TReturn>,
) => InvokableTool<z.infer<TInput>, TReturn>;

export const collectPrSourceInfoSchema = z.object({
  request: z.object({
    postType: z.string().min(1),
    eventName: z.string().min(1),
    techplayUrl: z.string().min(1),
    currentSituation: z.string().min(1),
    dashboardContext: z.object({
      dashboardName: z.string().min(1),
      workbookName: z.string().nullable().optional(),
      worksheets: z.array(z.object({ name: z.string().min(1) })),
      capturedAt: z.string().min(1),
    }),
  }),
  techplayPreview: z
    .object({
      eventName: z.string().optional(),
      eventDateText: z.string().optional(),
      summary: z.string().optional(),
      techplayUrl: z.string().optional(),
    })
    .optional(),
  analysisSections: z
    .array(
      z.object({
        title: z.string().min(1),
        summary: z.string().min(1),
        rows: z
          .array(
            z.object({
              label: z.string().min(1),
              value: z.number().nullable(),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
  evidencePack: z.custom<PostGenerationEvidencePack>().optional(),
});

export const summarizePrSourceInfoSchema = z.object({
  sourceInfo: z.custom<PrDraftSourceInfo>(),
});

export const generateAnnouncementDraftSchema = z.object({
  sourceInfo: z.custom<PrDraftSourceInfo>(),
  summary: z.string().min(1),
});

export const generateSocialPostDraftSchema = z.object({
  platform: z.enum(["x", "linkedin"]),
  sourceInfo: z.custom<PrDraftSourceInfo>(),
  summary: z.string().min(1),
});

export const reviewPrDraftSchema = z.object({
  sourceInfo: z.custom<PrDraftSourceInfo>(),
  announcementDraft: z.string().min(1),
  socialPostDrafts: z.object({
    x: z.string().min(1),
    linkedin: z.string().min(1),
  }),
});

export const createDraftOutputSchema = z.object({
  sourceInfo: z.custom<PrDraftSourceInfo>(),
  summary: z.string().min(1),
  announcementDraft: z.string().min(1),
  socialPostDraft: z.string().min(1),
  socialPostDrafts: z.object({
    x: z.string().min(1),
    linkedin: z.string().min(1),
  }),
  review: z.custom<PrDraftReview>(),
});

function definePrToolDefinition<
  TSchema extends z.ZodTypeAny,
  TReturn extends JSONValue,
>(
  definition: PrToolDefinition<TSchema, TReturn>,
): PrToolDefinition<TSchema, TReturn> {
  return definition;
}

export function createPrTools(toolFactory: PrToolFactory) {
  return [
    createPrTool(toolFactory, prToolDefinitions.collectPrSourceInfo),
    createPrTool(toolFactory, prToolDefinitions.summarizePrSourceInfo),
    createPrTool(toolFactory, prToolDefinitions.generateAnnouncementDraft),
    createPrTool(toolFactory, prToolDefinitions.generateSocialPostDraft),
    createPrTool(toolFactory, prToolDefinitions.reviewPrDraft),
    createPrTool(toolFactory, prToolDefinitions.createDraftOutput),
  ];
}

function createPrTool<TSchema extends z.ZodTypeAny, TReturn extends JSONValue>(
  toolFactory: PrToolFactory,
  definition: PrToolDefinition<TSchema, TReturn>,
): InvokableTool<z.output<TSchema>, TReturn> {
  return toolFactory({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    callback: definition.callback,
  });
}

export const prToolDefinitions = {
  collectPrSourceInfo: definePrToolDefinition({
    name: "collectPrSourceInfo",
    description:
      "Collect and normalize event, Tableau, and reference preview information for PR drafting. Never invent missing facts.",
    inputSchema: collectPrSourceInfoSchema,
    callback: async (input: z.output<typeof collectPrSourceInfoSchema>) =>
      executeLoggedTool("collectPrSourceInfo", input, async () =>
        collectPrSourceInfo(input),
      ),
  }),
  summarizePrSourceInfo: definePrToolDefinition({
    name: "summarizePrSourceInfo",
    description:
      "Summarize the collected source information into concise drafting notes and surface missing fields.",
    inputSchema: summarizePrSourceInfoSchema,
    callback: async (input: z.output<typeof summarizePrSourceInfoSchema>) =>
      executeLoggedTool("summarizePrSourceInfo", input, async () =>
        summarizePrSourceInfo(input.sourceInfo),
      ),
  }),
  generateAnnouncementDraft: definePrToolDefinition({
    name: "generateAnnouncementDraft",
    description:
      "Generate a long-form announcement draft for human review only.",
    inputSchema: generateAnnouncementDraftSchema,
    callback: async (input: z.output<typeof generateAnnouncementDraftSchema>) =>
      executeLoggedTool("generateAnnouncementDraft", input, async () =>
        generateAnnouncementDraft(input.sourceInfo, input.summary),
      ),
  }),
  generateSocialPostDraft: definePrToolDefinition({
    name: "generateSocialPostDraft",
    description:
      "Generate a short social post draft for the selected platform without posting it.",
    inputSchema: generateSocialPostDraftSchema,
    callback: async (input: z.output<typeof generateSocialPostDraftSchema>) =>
      executeLoggedTool("generateSocialPostDraft", input, async () =>
        generateSocialPostDraft(
          input.platform,
          input.sourceInfo,
          input.summary,
        ),
      ),
  }),
  reviewPrDraft: definePrToolDefinition({
    name: "reviewPrDraft",
    description:
      "Review draft copy for missing information, overclaim risk, URL issues, and tone problems.",
    inputSchema: reviewPrDraftSchema,
    callback: async (input: z.output<typeof reviewPrDraftSchema>) =>
      executeLoggedTool("reviewPrDraft", input, async () =>
        reviewPrDraft(
          input.sourceInfo,
          input.announcementDraft,
          input.socialPostDrafts,
        ),
      ),
  }),
  createDraftOutput: definePrToolDefinition({
    name: "createDraftOutput",
    description:
      "Assemble the final draft-only output for downstream preview and review.",
    inputSchema: createDraftOutputSchema,
    callback: async (input: z.output<typeof createDraftOutputSchema>) =>
      executeLoggedTool("createDraftOutput", input, async () =>
        createDraftOutput(
          input.sourceInfo,
          input.summary,
          input.announcementDraft,
          input.socialPostDraft,
          input.socialPostDrafts,
          input.review,
        ),
      ),
  }),
} as const;

export function collectPrSourceInfo(
  input: CollectPrSourceInfoInput,
): PrDraftSourceInfo {
  const parsed = collectPrSourceInfoSchema.parse(input);
  const request = parsed.request;
  const postMaterial = buildPostMaterial({
    request: request as ActionRunRequest,
    analysisSections: parsed.analysisSections as ActionRunAnalysisSection[],
    evidencePack: parsed.evidencePack,
  });
  const worksheetNames = request.dashboardContext.worksheets
    .map((worksheet) => worksheet.name.trim())
    .filter(Boolean);
  const analysisTopics = uniqueStrings([
    ...(parsed.evidencePack?.photoContext.detectedTopics ?? []),
    ...(parsed.evidencePack?.photoContext.suggestedPostAngles ?? []).map(
      (angle) => angle.split(/\s+/u)[0],
    ),
    ...(postMaterial.eventThemes ?? []),
  ])
    .map((topic) => topic.trim())
    .filter(Boolean)
    .slice(0, 3);
  const analysisHighlights = uniqueStrings([
    postMaterial.eventShortName
      ? "Event: " + postMaterial.eventShortName
      : undefined,
    analysisTopics.length ? "Topics: " + analysisTopics.join(" / ") : undefined,
    postMaterial.mood ? "Mood: " + postMaterial.mood : undefined,
    postMaterial.audienceContext
      ? "Audience: " + postMaterial.audienceContext
      : undefined,
    postMaterial.speakerOrSessionContext
      ? "Session: " + postMaterial.speakerOrSessionContext
      : undefined,
    postMaterial.photoDescriptionForPost
      ? "Photo: " + postMaterial.photoDescriptionForPost
      : undefined,
    postMaterial.callToAction ? "CTA: " + postMaterial.callToAction : undefined,
  ]).slice(0, 10);
  const missingFields = getMissingSourceFields({
    request,
    techplayPreview: parsed.techplayPreview,
    analysisSections: parsed.analysisSections,
    evidencePack: parsed.evidencePack,
    postMaterial,
  });

  return {
    postType: request.postType.trim(),
    eventName: postMaterial.eventOfficialName ?? request.eventName.trim(),
    techplayUrl: request.techplayUrl.trim(),
    currentSituation: postMaterial.situation ?? request.currentSituation.trim(),
    dashboardName: request.dashboardContext.dashboardName.trim(),
    workbookName: request.dashboardContext.workbookName?.trim() || undefined,
    worksheetNames,
    capturedAt: request.dashboardContext.capturedAt,
    techplayEventName: parsed.techplayPreview?.eventName?.trim() || undefined,
    techplayEventDateText:
      parsed.techplayPreview?.eventDateText?.trim() || undefined,
    techplaySummary: parsed.techplayPreview?.summary?.trim() || undefined,
    analysisHighlights,
    missingFields,
  };
}

export function summarizePrSourceInfo(sourceInfo: PrDraftSourceInfo): string {
  return buildPostSummary({
    postType: mapSourcePostType(sourceInfo.postType),
    eventShortName: shortenSourceEventName(sourceInfo.eventName),
    eventOfficialName: sourceInfo.eventName,
    eventUrl: sourceInfo.techplayUrl,
    eventDateText: sourceInfo.techplayEventDateText,
    situation: sourceInfo.currentSituation,
    mood: extractSummaryMood(sourceInfo.analysisHighlights),
    mainTopics: sourceInfo.analysisHighlights
      .flatMap((line) =>
        line
          .replace(/^(?:Event|Topics|Mood|Audience|Session|Photo|CTA):\s*/u, "")
          .split(" / "),
      )
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3),
    audienceContext: extractSummaryAudienceContext(
      sourceInfo.analysisHighlights,
    ),
    speakerOrSessionContext: extractSummarySessionContext(
      sourceInfo.analysisHighlights,
    ),
    photoDescriptionForPost: extractSummaryPhotoContext(
      sourceInfo.analysisHighlights,
    ),
    callToAction: extractSummaryCallToAction(sourceInfo.analysisHighlights),
    hashtags: ["#ほくたぐ", "#HokuTUG", "#Tableau"],
  });
}

export function generateAnnouncementDraft(
  sourceInfo: PrDraftSourceInfo,
  summary: string,
): string {
  const shortEventName = shortenSourceEventName(sourceInfo.eventName);
  return [
    `# ${shortEventName ?? sourceInfo.eventName}`,
    "",
    "## Summary",
    summary,
    "",
    "## What we know",
    `- Event: ${shortEventName ?? sourceInfo.eventName}`,
    `- Post type: ${sourceInfo.postType}`,
    `- TechPlay URL: ${sourceInfo.techplayUrl}`,
    `- Dashboard: ${sourceInfo.dashboardName}`,
    sourceInfo.workbookName
      ? `- Workbook: ${sourceInfo.workbookName}`
      : "- Workbook: not available",
    sourceInfo.techplayEventDateText
      ? `- Date: ${sourceInfo.techplayEventDateText}`
      : "- Date: not available",
    sourceInfo.techplaySummary
      ? `- TechPlay summary: ${sourceInfo.techplaySummary}`
      : "- TechPlay summary: not available",
    "",
    "## Key points",
    ...(sourceInfo.analysisHighlights.length
      ? sourceInfo.analysisHighlights.map((line) => `- ${line}`)
      : ["- No key points were provided."]),
    "",
    "## Current situation",
    sourceInfo.currentSituation,
    "",
    "## Missing information",
    ...(sourceInfo.missingFields.length
      ? sourceInfo.missingFields.map((field) => `- ${field}`)
      : ["- None"]),
  ].join("\n");
}

export function generateSocialPostDraft(
  platform: PrDraftPlatform,
  sourceInfo: PrDraftSourceInfo,
  summary: string,
): string {
  const shortEventName = shortenSourceEventName(sourceInfo.eventName);
  const topics = sourceInfo.analysisHighlights
    .map((line) =>
      line.replace(
        /^(?:Event|Topics|Mood|Audience|Session|Photo|CTA):\s*/u,
        "",
      ),
    )
    .flatMap((line) => line.split(" / "))
    .map((line) => line.trim())
    .filter(Boolean);
  const opening =
    platform === "linkedin"
      ? `${shortEventName ?? sourceInfo.eventName} の投稿案です。`
      : `${shortEventName ?? sourceInfo.eventName}、進行中です。`;
  const topicLine = topics.length
    ? `今日は${topics.slice(0, 3).join("、")}を中心に進めています。`
    : "";
  const summaryLine =
    sourceInfo.analysisHighlights.find((line) => !line.startsWith("Event:")) ??
    firstSentence(summary) ??
    summary.slice(0, 180);
  const hashtags = ["#ほくたぐ", "#HokuTUG", "#Tableau"];
  const body = [
    opening,
    topicLine || summaryLine,
    sourceInfo.currentSituation.includes("和やか")
      ? "会場は和やかな雰囲気です。"
      : undefined,
    sourceInfo.currentSituation.includes("あたたま")
      ? "会場が少しずつあたたまってきています。"
      : undefined,
    sourceInfo.techplayUrl,
    hashtags.join(" "),
  ]
    .filter(Boolean)
    .join(platform === "linkedin" ? "\n\n" : " | ")
    .replace(/\s+/gu, " ")
    .trim();

  return body;
}

export function reviewPrDraft(
  sourceInfo: PrDraftSourceInfo,
  announcementDraft: string,
  socialPostDrafts: { x: string; linkedin: string },
): PrDraftReview {
  const issues: string[] = [];
  const checklist = [
    "Confirm the event name matches the source preview.",
    "Confirm the TechPlay URL is correct and reachable.",
    "Confirm the date, place, and speakers are present before publishing.",
    "Confirm the tone is factual and not overly assertive.",
  ];
  const qualityIssues = [
    buildPostQualityResult(announcementDraft),
    buildPostQualityResult(socialPostDrafts.x),
    buildPostQualityResult(socialPostDrafts.linkedin),
  ].flatMap((result) => result.issues);

  const missingFields = [...new Set(sourceInfo.missingFields)];
  if (missingFields.length) {
    issues.push(`Missing fields: ${missingFields.join(", ")}`);
  }

  if (!isHttpsUrl(sourceInfo.techplayUrl)) {
    issues.push("TechPlay URL is not a valid https URL.");
  }

  if (
    containsOverclaimLanguage(announcementDraft) ||
    containsOverclaimLanguage(socialPostDrafts.x)
  ) {
    issues.push("Draft contains overclaim language that should be softened.");
  }

  if (
    containsPublishLanguage(announcementDraft) ||
    containsPublishLanguage(socialPostDrafts.linkedin)
  ) {
    issues.push("Draft mentions publishing or execution language.");
  }

  if (qualityIssues.length) {
    issues.push(
      ...qualityIssues.map(
        (issue) => `${issue.code}: ${issue.matchedText ?? issue.message}`,
      ),
    );
  }

  const riskLevel =
    qualityIssues.some((issue) => issue.severity === "error") ||
    issues.length > 3 ||
    missingFields.length > 2
      ? "high"
      : issues.length > 0 || missingFields.length > 0
        ? "medium"
        : "low";

  const status: PrDraftReviewStatus =
    missingFields.length > 0
      ? "needs_info"
      : qualityIssues.some((issue) => issue.severity === "error") ||
          issues.length > 0
        ? "needs_review"
        : "pass";

  return {
    status,
    riskLevel,
    missingFields,
    issues,
    checklist,
    notes: [
      "Draft-only review is enforced.",
      missingFields.length
        ? "Do not guess the missing fields. Ask for the missing information before publishing."
        : "The draft has enough information for human review.",
    ],
  };
}

export function createDraftOutput(
  sourceInfo: PrDraftSourceInfo,
  summary: string,
  announcementDraft: string,
  socialPostDraft: string,
  socialPostDrafts: { x: string; linkedin: string },
  review: PrDraftReview,
): PrDraftOutput {
  const material = buildPostMaterial({
    request: {
      postType: sourceInfo.postType as ActionRunRequest["postType"],
      eventName: sourceInfo.eventName,
      techplayUrl: sourceInfo.techplayUrl,
      currentSituation: sourceInfo.currentSituation,
      dashboardContext: {
        dashboardName: sourceInfo.dashboardName,
        workbookName: sourceInfo.workbookName ?? undefined,
        worksheets: sourceInfo.worksheetNames.map((name) => ({ name })),
        capturedAt: sourceInfo.capturedAt,
        filters: [],
        parameters: [],
      },
      eventContext: {
        source: sourceInfo.techplayEventName ? "techplay" : "fallback",
        eventName: sourceInfo.techplayEventName ?? sourceInfo.eventName,
        eventUrl: sourceInfo.techplayUrl,
        eventDescription: sourceInfo.techplaySummary,
        eventDateText: sourceInfo.techplayEventDateText,
      },
    } as ActionRunRequest,
    analysisSections: [] as ActionRunAnalysisSection[],
  });
  const drafts = buildChannelDrafts({ material });
  const emailDraft = drafts.email;
  const notionDraft = drafts.notion;

  return {
    sourceInfo,
    summary,
    announcementDraft,
    socialPostDraft,
    drafts: {
      x: socialPostDrafts.x,
      linkedin: socialPostDrafts.linkedin,
      email: emailDraft,
      notion: notionDraft,
    },
    review,
    evidence: buildEvidenceLines(sourceInfo),
    checks: [...review.checklist, ...review.issues],
    hashtags: [...material.hashtags],
    imageCaption: buildSafeImageCaption(material),
    missingFields: review.missingFields,
  };
}

export function buildPrDraftOutput(input: {
  request: ActionRunRequest;
  techplayPreview?: TechPlayPreviewResponse;
  analysisSections: ActionRunAnalysisSection[];
  evidencePack?: PostGenerationEvidencePack;
}): PrDraftOutput {
  const material = buildPostMaterial({
    request: input.request,
    analysisSections: input.analysisSections,
    evidencePack: input.evidencePack,
  });
  const sourceInfo = collectPrSourceInfo({
    request: input.request,
    techplayPreview: input.techplayPreview,
    analysisSections: input.analysisSections,
    evidencePack: input.evidencePack,
  });
  const summary = buildPostSummary(material);
  const announcementDraft = generateAnnouncementDraft(sourceInfo, summary);
  const socialPostDrafts = buildChannelDrafts({ material });
  const review = reviewPrDraft(sourceInfo, announcementDraft, socialPostDrafts);

  return createDraftOutput(
    sourceInfo,
    summary,
    announcementDraft,
    socialPostDrafts.x,
    socialPostDrafts,
    review,
  );
}

function buildEvidenceLines(sourceInfo: PrDraftSourceInfo): string[] {
  return [
    `Event name: ${shortenSourceEventName(sourceInfo.eventName) ?? sourceInfo.eventName}`,
    `Post type: ${sourceInfo.postType}`,
    `TechPlay URL: ${sourceInfo.techplayUrl}`,
    `Dashboard: ${sourceInfo.dashboardName}`,
    sourceInfo.workbookName
      ? `Workbook: ${sourceInfo.workbookName}`
      : "Workbook not available",
    sourceInfo.techplayEventDateText
      ? `Event date: ${sourceInfo.techplayEventDateText}`
      : "Event date not available",
    ...sourceInfo.analysisHighlights.slice(0, 4),
  ];
}

function getMissingSourceFields(input: {
  request: z.infer<typeof collectPrSourceInfoSchema>["request"];
  techplayPreview?: z.infer<
    typeof collectPrSourceInfoSchema
  >["techplayPreview"];
  analysisSections: z.infer<
    typeof collectPrSourceInfoSchema
  >["analysisSections"];
  evidencePack?: PostGenerationEvidencePack;
  postMaterial?: PostMaterial;
}): string[] {
  const missing: string[] = [];

  if (!input.request.currentSituation.trim()) {
    missing.push("current situation");
  }

  if (!isHttpsUrl(input.request.techplayUrl)) {
    missing.push("valid TechPlay URL");
  }

  if (!input.techplayPreview?.eventDateText?.trim()) {
    missing.push("event date");
  }

  if (!input.techplayPreview?.summary?.trim()) {
    missing.push("event summary");
  }

  if (!input.request.dashboardContext.workbookName?.trim()) {
    missing.push("workbook name");
  }

  if (!input.analysisSections.length) {
    missing.push("Tableau analysis sections");
  }

  if (!input.evidencePack) {
    missing.push("evidence pack");
  }

  return [...new Set(missing)];
}

function mapSourcePostType(postType: string): PostMaterial["postType"] {
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
  if (/次回参加/.test(postType)) {
    return "recap";
  }
  if (/直前|事前/.test(postType)) {
    return "pre_event";
  }
  return "generic";
}

function shortenSourceEventName(eventName: string): string {
  const tokens = eventName.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length <= 3) {
    return eventName.trim();
  }

  if (
    /第\d+回/.test(tokens[0]) ||
    /ユーザー会|勉強会|Meetup|User Group/i.test(tokens[0])
  ) {
    return tokens.slice(0, 3).join(" ");
  }

  return tokens.slice(0, 3).join(" ");
}

function extractSummaryMood(lines: string[]): string | undefined {
  const text = lines.join(" ");
  if (
    /(和やか|あたたか|笑顔|談笑|friendship|teamwork|positivity)/i.test(text)
  ) {
    return "和やかな雰囲気";
  }
  if (/(あたたま|賑わ|盛り上が|集ま|fill|warming)/i.test(text)) {
    return "会場が少しずつあたたまっています";
  }
  return undefined;
}

function extractSummaryAudienceContext(lines: string[]): string | undefined {
  const text = lines.join(" ");
  if (/(はじめて|初めて|初心者|first time|beginner|new to)/i.test(text)) {
    return "MCPをはじめて聞く方にも伝わるように";
  }
  if (/(使いどころ|活用|具体例|イメージ|how to use)/i.test(text)) {
    return "実際の使いどころがイメージしやすいように";
  }
  return undefined;
}

function extractSummarySessionContext(lines: string[]): string | undefined {
  const topics = uniqueStrings(
    lines
      .flatMap((line) => line.split(" / "))
      .map((line) =>
        line
          .replace(/^(?:Event|Topics|Mood|Audience|Session|Photo|CTA):\s*/u, "")
          .trim(),
      )
      .filter(Boolean),
  );
  if (!topics.length) {
    return undefined;
  }
  return `今日は${topics.slice(0, 3).join("、")}を中心に進みます`;
}

function extractSummaryPhotoContext(lines: string[]): string | undefined {
  const text = lines.join(" ");
  if (/和やかな雰囲気/.test(text)) {
    return "会場は和やかな雰囲気です";
  }
  if (/あたたま/.test(text)) {
    return "会場が少しずつあたたまってきています";
  }
  return undefined;
}

function extractSummaryCallToAction(lines: string[]): string | undefined {
  const text = lines.join(" ");
  if (/(一緒に楽しみましょう|楽しんでいきます)/.test(text)) {
    return "一緒に楽しみましょう";
  }
  if (/(また次回も|次回もぜひ)/.test(text)) {
    return "また次回もお会いできたらうれしいです";
  }
  return undefined;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function containsOverclaimLanguage(value: string): boolean {
  return /(100%|必ず|絶対|間違いなく|guarantee|guaranteed|must|will definitely)/i.test(
    value,
  );
}

function containsPublishLanguage(value: string): boolean {
  return /(post|publish|send|submit|schedule|公開|送信|投稿|配信)/i.test(value);
}

function firstSentence(value: string): string | undefined {
  const sentence = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);

  return sentence || undefined;
}

async function executeLoggedTool<TInput, TOutput>(
  toolName: string,
  input: TInput,
  callback: () => Promise<TOutput>,
): Promise<TOutput> {
  const startedAt = Date.now();
  logInfo("pr.agent.tool.started", {
    toolName,
    inputPreview: summarizeToolInput(input),
  });

  try {
    const result = await callback();
    logInfo("pr.agent.tool.completed", {
      toolName,
      durationMs: Date.now() - startedAt,
      outputPreview: summarizeToolOutput(result),
    });
    return result;
  } catch (error) {
    logError("pr.agent.tool.failed", {
      toolName,
      durationMs: Date.now() - startedAt,
      ...safeErrorDetails(error),
      inputPreview: summarizeToolInput(input),
    });
    throw error;
  }
}

function summarizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return { type: typeof input };
  }

  const record = input as Record<string, unknown>;
  return {
    keys: Object.keys(record).slice(0, 6),
    requestPresent: Boolean(record.request),
    sourceInfoPresent: Boolean(record.sourceInfo),
    summaryLength:
      typeof record.summary === "string" ? record.summary.length : undefined,
  };
}

function summarizeToolOutput(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== "object") {
    return { type: typeof output };
  }

  const record = output as Record<string, unknown>;
  return {
    keys: Object.keys(record).slice(0, 8),
    missingFieldCount: Array.isArray(record.missingFields)
      ? record.missingFields.length
      : undefined,
    reviewStatus:
      typeof record.status === "string"
        ? record.status
        : typeof record.review === "object" && record.review
          ? (record.review as Record<string, unknown>).status
          : undefined,
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter(Boolean) as string[],
    ),
  ];
}
