import {
  approveActionRun,
  createActionRun,
  getActionRun,
} from "../api/actionRunApi";
import { resolveCalendarEventContext as resolveCalendarEventContextApi } from "../api/calendarApi";
import { previewTechPlayEvent } from "../api/techplayApi";
import { env } from "../env";
import type {
  ActionRunApprovalResponse,
  ActionRunPostType,
  ActionRunRequest,
  ActionRunResult,
} from "../types/actionRun";
import type {
  CalendarEventCandidate,
  CalendarResolveRequest,
  CalendarResolveResponse,
} from "../types/calendar";
import type { DashboardContext } from "../types/tableau";
import type { TechPlayPreviewResponse } from "../types/techplay";

export type ServiceConnections = {
  google: boolean;
  slack: boolean;
  x: boolean;
};

export type UploadedImage = {
  fileName: string;
  objectUrl: string;
  sizeLabel: string;
};

export type TableauAnalysisResult = {
  actionRunId: string;
  ownerToken?: string;
  result: ActionRunResult;
};

export type GeneratedPrPostDraft = {
  postType: ActionRunPostType;
  eventName: string;
  techplayUrl: string;
  calendarResult: CalendarResolveResponse;
  techplayPreview?: TechPlayPreviewResponse;
  analysis: TableauAnalysisResult;
  summaryLines: string[];
  evidenceLines: string[];
  checkLines: string[];
  slackPostText: string;
  xPostText: string;
  hashtags: string[];
  imageCaption?: string;
  image?: UploadedImage | null;
  noImageSituationMemo?: string;
};

export type PostedResult = {
  channel: "slack" | "x";
  text: string;
  openLabel: string;
  postedAt: string;
  url?: string;
};

type AnalysisInput = {
  postType: ActionRunPostType;
  dashboardContext: DashboardContext;
  calendarResult: CalendarResolveResponse;
  image?: UploadedImage | null;
  noImageSituationMemo?: string;
  manualTechPlayUrl?: string;
  authToken?: string;
};

type GeneratePrPostDraftInput = AnalysisInput & {
  analysis: TableauAnalysisResult;
};

export async function resolveCalendarEventContext(
  request: CalendarResolveRequest,
  accessToken?: string,
): Promise<CalendarResolveResponse> {
  return resolveCalendarEventContextApi(request, accessToken);
}

export function extractTechPlayUrl(
  calendarEvent?: CalendarEventCandidate | null,
): string | null {
  const url = calendarEvent?.techplayUrls?.[0]?.trim();
  return url || null;
}

export async function fetchTechPlayEventInfo(
  techplayUrl: string,
  accessToken?: string,
): Promise<TechPlayPreviewResponse> {
  return previewTechPlayEvent({ techplayUrl }, accessToken);
}

export async function analyzePastPostsWithTableau(
  input: AnalysisInput,
): Promise<TableauAnalysisResult> {
  const techplayUrl =
    input.manualTechPlayUrl?.trim() ||
    extractTechPlayUrl(input.calendarResult.selectedEvent) ||
    input.calendarResult.detectedTechPlayUrl?.trim() ||
    "";

  const request: ActionRunRequest = {
    postType: input.postType,
    eventName:
      input.calendarResult.resolvedEventName?.trim() ||
      input.calendarResult.selectedEvent?.summary?.trim() ||
      "PR投稿",
    techplayUrl,
    currentSituation: buildCurrentSituation({
      calendarResult: input.calendarResult,
      image: input.image ?? null,
      noImageSituationMemo: input.noImageSituationMemo,
      manualTechPlayUrl: input.manualTechPlayUrl,
    }),
    dashboardContext: input.dashboardContext,
    clientContext: {
      source: "tableau-extension",
      appVersion: env.appVersion,
    },
  };

  const created = await createActionRun(request, input.authToken);
  const ownerToken = created.ownerToken;
  let delayMs = created.retryAfterMs || 1200;

  for (;;) {
    const job = await getActionRun(
      created.actionRunId,
      input.authToken,
      ownerToken,
    );
    if (job.status === "completed" && job.result) {
      return {
        actionRunId: created.actionRunId,
        ownerToken,
        result: job.result,
      };
    }

    if (job.status === "failed") {
      throw new Error(job.error?.message ?? "Tableau analysis failed.");
    }

    await sleep(delayMs);
    delayMs = Math.min(Math.round(delayMs * 1.35), 2500);
  }
}

export async function generatePrPostDraft(
  input: GeneratePrPostDraftInput,
): Promise<GeneratedPrPostDraft> {
  const techplayUrl =
    input.manualTechPlayUrl?.trim() ||
    extractTechPlayUrl(input.calendarResult.selectedEvent) ||
    input.calendarResult.detectedTechPlayUrl?.trim() ||
    "";

  const techplayPreview =
    input.calendarResult.techplayPreview ??
    (techplayUrl
      ? await fetchTechPlayEventInfo(techplayUrl, input.authToken)
      : undefined);

  const eventName =
    input.calendarResult.resolvedEventName?.trim() ||
    input.calendarResult.selectedEvent?.summary?.trim() ||
    "PR投稿";

  const hashtags = buildHashtags({
    postType: input.postType,
    eventName,
    analysis: input.analysis.result,
  });
  const summaryLines = buildPostTrendSummary(
    input.analysis.result,
    input.postType,
  );
  const evidenceLines = input.analysis.result.evidence.slice(0, 5);
  const checkLines = input.analysis.result.checks.slice(0, 5);
  const slackPostText = buildSlackPost({
    eventName,
    postType: input.postType,
    hashtags,
    techplayUrl,
    analysis: input.analysis.result,
    summaryLines,
    image: input.image ?? null,
    noImageSituationMemo: input.noImageSituationMemo,
  });
  const xPostText = buildXPost({
    eventName,
    postType: input.postType,
    hashtags,
    techplayUrl,
    analysis: input.analysis.result,
    summaryLines,
    image: input.image ?? null,
    noImageSituationMemo: input.noImageSituationMemo,
  });

  return {
    postType: input.postType,
    eventName,
    techplayUrl,
    calendarResult: input.calendarResult,
    techplayPreview,
    analysis: input.analysis,
    summaryLines,
    evidenceLines,
    checkLines,
    slackPostText,
    xPostText,
    hashtags,
    imageCaption: input.analysis.result.imageCaption,
    image: input.image ?? null,
    noImageSituationMemo: input.noImageSituationMemo?.trim() || undefined,
  };
}

export function buildPostTrendSummary(
  analysis: ActionRunResult,
  postType: ActionRunPostType,
): string[] {
  const lines: string[] = [];
  const resultSummary = analysis.summary.trim();

  if (postType === "開催中の実況") {
    lines.push("開催中投稿では短文 + 写真つきが多い");
  } else if (postType === "開催後のお礼・レポート") {
    lines.push("開催後投稿ではお礼と学びの要約が中心です");
  } else {
    lines.push("過去投稿の傾向をもとに、読みやすい文量へ整えました");
  }

  if (analysis.hashtags.includes("#HokuTUG")) {
    lines.push("#HokuTUG と #Tableau を優先");
  } else if (analysis.hashtags.length) {
    lines.push(`${analysis.hashtags.slice(0, 2).join(" / ")} を優先`);
  }

  if (resultSummary) {
    lines.push(resultSummary);
  }

  return dedupeLines(lines).slice(0, 4);
}

export function buildSlackPost(input: {
  eventName: string;
  postType: ActionRunPostType;
  hashtags: string[];
  techplayUrl: string;
  analysis: ActionRunResult;
  summaryLines: string[];
  image?: UploadedImage | null;
  noImageSituationMemo?: string;
}): string {
  const baseLines = [
    input.hashtags.join(" "),
    input.analysis.suggestedSlackPostText.trim(),
    input.techplayUrl,
  ].filter(Boolean);

  if (input.image?.fileName) {
    baseLines.push(`画像: ${input.image.fileName}`);
  }

  if (input.noImageSituationMemo?.trim()) {
    baseLines.push(`会場メモ: ${input.noImageSituationMemo.trim()}`);
  }

  return baseLines.join("\n").trim();
}

export function buildXPost(input: {
  eventName: string;
  postType: ActionRunPostType;
  hashtags: string[];
  techplayUrl: string;
  analysis: ActionRunResult;
  summaryLines: string[];
  image?: UploadedImage | null;
  noImageSituationMemo?: string;
}): string {
  const parts = [
    input.hashtags.slice(0, 3).join(" "),
    input.analysis.suggestedSlackPostText.trim(),
    input.techplayUrl,
  ].filter(Boolean);

  let text = parts.join("\n").trim();
  if (text.length > 280) {
    text = `${text.slice(0, 277).trimEnd()}...`;
  }

  return text;
}

export async function postToSlack(input: {
  draft: GeneratedPrPostDraft;
  accessToken?: string;
  ownerToken?: string;
}): Promise<ActionRunApprovalResponse> {
  return approveActionRun(
    input.draft.analysis.actionRunId,
    { approved: true },
    input.accessToken,
    input.ownerToken,
  );
}

export async function postToX(input: {
  draft: GeneratedPrPostDraft;
}): Promise<PostedResult> {
  await sleep(700);
  return {
    channel: "x",
    text: input.draft.xPostText,
    openLabel: "Xを開く",
    postedAt: new Date().toISOString(),
  };
}

export function buildCurrentSituation(input: {
  calendarResult: CalendarResolveResponse;
  image?: UploadedImage | null;
  noImageSituationMemo?: string;
  manualTechPlayUrl?: string;
}): string {
  const parts = [
    input.calendarResult.selectedEvent?.summary?.trim() ||
      input.calendarResult.resolvedEventName?.trim() ||
      "イベント情報取得中",
    input.image?.fileName ? `画像:${input.image.fileName}` : "画像なし",
    input.noImageSituationMemo?.trim() || "会場メモ未入力",
    input.calendarResult.detectedTechPlayUrl?.trim() ||
      input.manualTechPlayUrl?.trim() ||
      "TechPlay URL未取得",
  ];

  return parts.join(" / ");
}

function buildHashtags(input: {
  postType: ActionRunPostType;
  eventName: string;
  analysis: ActionRunResult;
}): string[] {
  const baseTags = new Set<string>(["#Tableau", "#TechPlay"]);
  if (input.postType === "開催中の実況") {
    baseTags.add("#HokuTUG");
  }

  const keyword = input.eventName
    .split(/\s+/)
    .find((token) => /[A-Za-z0-9]/.test(token))
    ?.replace(/[^A-Za-z0-9]/g, "");
  if (keyword) {
    baseTags.add(`#${keyword}`);
  }

  for (const tag of input.analysis.hashtags) {
    if (tag.startsWith("#")) {
      baseTags.add(tag);
    }
  }

  return Array.from(baseTags).slice(0, 4);
}

function dedupeLines(lines: string[]): string[] {
  return Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}
