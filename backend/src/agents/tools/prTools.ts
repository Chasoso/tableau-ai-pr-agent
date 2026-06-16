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
  const worksheetNames = request.dashboardContext.worksheets
    .map((worksheet) => worksheet.name.trim())
    .filter(Boolean);
  const analysisHighlights = parsed.analysisSections
    .flatMap((section) => {
      const firstRow = section.rows?.[0];
      const rowLabel = firstRow?.label?.trim();
      const rowValue =
        firstRow?.value === undefined || firstRow?.value === null
          ? undefined
          : firstRow.value.toLocaleString();
      return [
        `${section.title}: ${section.summary}`,
        rowLabel
          ? `${section.title} top row: ${rowLabel}${rowValue ? ` (${rowValue})` : ""}`
          : undefined,
      ];
    })
    .filter((line): line is string => Boolean(line));
  const evidenceHighlights = buildEvidencePackHighlights(parsed.evidencePack);
  const missingFields = getMissingSourceFields({
    request,
    techplayPreview: parsed.techplayPreview,
    analysisSections: parsed.analysisSections,
    evidencePack: parsed.evidencePack,
  });

  return {
    postType: request.postType.trim(),
    eventName: request.eventName.trim(),
    techplayUrl: request.techplayUrl.trim(),
    currentSituation: request.currentSituation.trim(),
    dashboardName: request.dashboardContext.dashboardName.trim(),
    workbookName: request.dashboardContext.workbookName?.trim() || undefined,
    worksheetNames,
    capturedAt: request.dashboardContext.capturedAt,
    techplayEventName: parsed.techplayPreview?.eventName?.trim() || undefined,
    techplayEventDateText:
      parsed.techplayPreview?.eventDateText?.trim() || undefined,
    techplaySummary: parsed.techplayPreview?.summary?.trim() || undefined,
    analysisHighlights: uniqueStrings([
      ...analysisHighlights,
      ...evidenceHighlights,
    ]).slice(0, 10),
    missingFields,
  };
}

export function summarizePrSourceInfo(sourceInfo: PrDraftSourceInfo): string {
  const lines = [
    `Event: ${sourceInfo.eventName}`,
    `Post type: ${sourceInfo.postType}`,
    `URL: ${sourceInfo.techplayUrl}`,
    `Dashboard: ${sourceInfo.dashboardName}`,
    sourceInfo.workbookName
      ? `Workbook: ${sourceInfo.workbookName}`
      : "Workbook: missing",
    sourceInfo.techplayEventDateText
      ? `Event date: ${sourceInfo.techplayEventDateText}`
      : "Event date: missing",
    sourceInfo.techplaySummary
      ? `TechPlay summary: ${sourceInfo.techplaySummary}`
      : "TechPlay summary: missing",
    `Current situation: ${sourceInfo.currentSituation}`,
    sourceInfo.analysisHighlights.length
      ? `Tableau signals: ${sourceInfo.analysisHighlights.slice(0, 4).join(" / ")}`
      : "Tableau signals: missing",
  ];

  if (sourceInfo.missingFields.length) {
    lines.push(`Missing fields: ${sourceInfo.missingFields.join(", ")}`);
  }

  return lines.join("\n");
}

export function generateAnnouncementDraft(
  sourceInfo: PrDraftSourceInfo,
  summary: string,
): string {
  return [
    `# ${sourceInfo.eventName} announcement draft`,
    "",
    "## Summary",
    summary,
    "",
    "## What we know",
    `- Event: ${sourceInfo.eventName}`,
    `- Post type: ${sourceInfo.postType}`,
    `- TechPlay URL: ${sourceInfo.techplayUrl}`,
    `- Dashboard: ${sourceInfo.dashboardName}`,
    sourceInfo.workbookName
      ? `- Workbook: ${sourceInfo.workbookName}`
      : "- Workbook: missing",
    sourceInfo.techplayEventDateText
      ? `- Date: ${sourceInfo.techplayEventDateText}`
      : "- Date: missing",
    sourceInfo.techplaySummary
      ? `- TechPlay summary: ${sourceInfo.techplaySummary}`
      : "- TechPlay summary: missing",
    "",
    "## Tableau signals",
    ...(sourceInfo.analysisHighlights.length
      ? sourceInfo.analysisHighlights.map((line) => `- ${line}`)
      : ["- No Tableau signals were provided."]),
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
  const conciseSummary = firstSentence(summary) ?? summary.slice(0, 180);
  const hashtags = buildHashtags(sourceInfo.eventName, platform);

  if (platform === "linkedin") {
    return [
      `${sourceInfo.eventName} announcement draft.`,
      conciseSummary,
      sourceInfo.techplayUrl,
      hashtags.join(" "),
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  return [
    `${sourceInfo.eventName} announcement draft`,
    conciseSummary,
    sourceInfo.techplayUrl,
    hashtags.join(" "),
  ]
    .filter(Boolean)
    .join(" | ")
    .replace(/\s+/g, " ")
    .trim();
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

  const riskLevel =
    issues.length > 3 || missingFields.length > 2
      ? "high"
      : issues.length > 0 || missingFields.length > 0
        ? "medium"
        : "low";

  const status: PrDraftReviewStatus =
    missingFields.length > 0
      ? "needs_info"
      : issues.length > 0
        ? "needs_review"
        : "pass";

  return {
    status,
    riskLevel,
    missingFields,
    issues,
    checklist,
    notes: [
      "Draft-only mode is enforced.",
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
  const emailDraft = [
    `Subject: ${sourceInfo.eventName}`,
    "",
    summary,
    "",
    announcementDraft,
  ].join("\n");

  const notionDraft = [
    `# ${sourceInfo.eventName}`,
    "",
    summary,
    "",
    announcementDraft,
  ].join("\n");

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
    hashtags: buildHashtags(sourceInfo.eventName, "x"),
    imageCaption: buildImageCaption(sourceInfo, summary),
    missingFields: review.missingFields,
  };
}

export function buildPrDraftOutput(input: {
  request: ActionRunRequest;
  techplayPreview?: TechPlayPreviewResponse;
  analysisSections: ActionRunAnalysisSection[];
  evidencePack?: PostGenerationEvidencePack;
}): PrDraftOutput {
  const analysisSections = input.evidencePack
    ? mergeEvidencePackIntoAnalysisSections(
        input.analysisSections,
        input.evidencePack,
      )
    : input.analysisSections;
  const sourceInfo = collectPrSourceInfo({
    request: input.request,
    techplayPreview: input.techplayPreview,
    analysisSections,
    evidencePack: input.evidencePack,
  });
  const summary = summarizePrSourceInfo(sourceInfo);
  const announcementDraft = generateAnnouncementDraft(sourceInfo, summary);
  const socialPostDrafts = {
    x: generateSocialPostDraft("x", sourceInfo, summary),
    linkedin: generateSocialPostDraft("linkedin", sourceInfo, summary),
  };
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
    `Event name: ${sourceInfo.eventName}`,
    `Post type: ${sourceInfo.postType}`,
    `TechPlay URL: ${sourceInfo.techplayUrl}`,
    `Dashboard: ${sourceInfo.dashboardName}`,
    sourceInfo.workbookName
      ? `Workbook: ${sourceInfo.workbookName}`
      : "Workbook missing",
    sourceInfo.techplayEventDateText
      ? `Event date: ${sourceInfo.techplayEventDateText}`
      : "Event date missing",
    ...sourceInfo.analysisHighlights.slice(0, 4),
  ];
}

function buildImageCaption(
  sourceInfo: PrDraftSourceInfo,
  summary: string,
): string {
  const firstLine = firstSentence(summary) ?? summary;
  return `${sourceInfo.eventName} draft. ${firstLine}`.slice(0, 220);
}

function buildHashtags(eventName: string, platform: PrDraftPlatform): string[] {
  const base = ["#Tableau", "#TechPlay"];
  const eventToken = eventName
    .split(/\s+/u)
    .map((token) => token.replace(/[^A-Za-z0-9]/g, ""))
    .find((token) => token.length >= 2);

  if (eventToken) {
    base.splice(1, 0, `#${eventToken}`);
  }

  if (platform === "linkedin") {
    base.push("#Community");
  }

  return [...new Set(base)].slice(0, 5);
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

function buildEvidencePackHighlights(
  evidencePack?: PostGenerationEvidencePack,
): string[] {
  if (!evidencePack) {
    return [];
  }

  return uniqueStrings([
    `Photo context: ${evidencePack.photoContext.summary}`,
    ...(evidencePack.photoContext.detectedTopics.length
      ? [
          `Photo topics: ${evidencePack.photoContext.detectedTopics.join(" / ")}`,
        ]
      : []),
    ...(evidencePack.photoContext.observedItems?.length
      ? [
          `Observed items: ${evidencePack.photoContext.observedItems.join(
            " / ",
          )}`,
        ]
      : []),
    ...(evidencePack.photoContext.subjectCandidates?.length
      ? [
          `Subject candidates: ${evidencePack.photoContext.subjectCandidates.join(
            " / ",
          )}`,
        ]
      : []),
    ...(evidencePack.photoContext.ocrText
      ? [`OCR text: ${evidencePack.photoContext.ocrText}`]
      : []),
    ...(evidencePack.surveyInsight?.available
      ? [
          `Survey insight: ${evidencePack.surveyInsight.evidenceSummary}`,
          ...(evidencePack.surveyInsight.suggestedAngles.length
            ? [
                `Survey angles: ${evidencePack.surveyInsight.suggestedAngles.join(
                  " / ",
                )}`,
              ]
            : []),
        ]
      : []),
    ...(evidencePack.postPerformanceInsight?.available
      ? [
          `Post performance: ${evidencePack.postPerformanceInsight.evidenceSummary}`,
        ]
      : []),
    ...(evidencePack.accountOverviewInsight?.available
      ? [
          `Account overview: ${evidencePack.accountOverviewInsight.evidenceSummary}`,
        ]
      : []),
  ]);
}

function mergeEvidencePackIntoAnalysisSections(
  analysisSections: ActionRunAnalysisSection[],
  evidencePack: PostGenerationEvidencePack,
): ActionRunAnalysisSection[] {
  const evidenceSection: ActionRunAnalysisSection = {
    key: "evidence_pack",
    title: "Evidence pack",
    question: "Summarize the evidence pack for draft generation.",
    summary: buildEvidencePackHighlights(evidencePack).join(" / "),
    rows: [],
  };

  return [...analysisSections, evidenceSection];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
