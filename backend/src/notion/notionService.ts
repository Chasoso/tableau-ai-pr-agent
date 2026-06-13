import { getConfig } from "../config";
import { logDebug } from "../logging";
import {
  getDefaultNotionConnectionId,
  NotionRepository,
} from "../repositories/notionRepository";
import type { AuthenticatedUser } from "../types/auth";
import type {
  CreateNotionPostIdeaRequest,
  NotionPostIdeaSaveResponse,
  NotionStatusResponse,
} from "../types/notion";
import { NotionOAuthService } from "./notionOAuthService";

export class NotionService {
  constructor(
    private readonly repository = new NotionRepository(),
    private readonly oauthService = new NotionOAuthService(),
  ) {}

  async getStatus(
    user: AuthenticatedUser | undefined,
  ): Promise<NotionStatusResponse> {
    const userId = resolveNotionUserId(user);
    const config = getConfig().notion;
    const connection = await this.repository.getConnection(
      userId,
      getDefaultNotionConnectionId(),
    );
    const effectiveTargetParentPageId =
      connection?.targetParentPageId ?? config.defaultTargetParentPageId;
    const effectiveTargetDatabaseId =
      connection?.targetDatabaseId ?? config.defaultTargetDatabaseId;

    return {
      connected: Boolean(connection?.status === "connected"),
      workspaceName: connection?.notionWorkspaceName,
      status: connection?.status ?? "disconnected",
      targetParentPageIdConfigured: Boolean(effectiveTargetParentPageId),
      targetDatabaseIdConfigured: Boolean(effectiveTargetDatabaseId),
    };
  }

  async connect(
    user: AuthenticatedUser | undefined,
    redirectAfter?: string,
  ): Promise<{ authorizationUrl: string }> {
    const userId = resolveNotionUserId(user);
    return this.oauthService.buildAuthorizationUrl({ userId, redirectAfter });
  }

  async callback(
    code?: string,
    state?: string,
  ): Promise<{ redirectTo: string }> {
    return this.oauthService.handleCallback({ code, state });
  }

  async disconnect(user: AuthenticatedUser | undefined): Promise<void> {
    const userId = resolveNotionUserId(user);
    await this.repository.deleteConnection(
      userId,
      getDefaultNotionConnectionId(),
    );
  }

  async updateSettings(
    user: AuthenticatedUser | undefined,
    input: { targetParentPageId?: string; targetDatabaseId?: string },
  ): Promise<void> {
    const userId = resolveNotionUserId(user);
    const connection = await this.repository.getConnection(
      userId,
      getDefaultNotionConnectionId(),
    );
    if (!connection) {
      throw new Error("Notion is not connected.");
    }

    await this.repository.putConnection({
      ...connection,
      targetParentPageId:
        input.targetParentPageId ?? connection.targetParentPageId,
      targetDatabaseId: input.targetDatabaseId ?? connection.targetDatabaseId,
      updatedAt: new Date().toISOString(),
    });
  }

  async createPostIdea(
    user: AuthenticatedUser | undefined,
    payload: CreateNotionPostIdeaRequest,
  ): Promise<NotionPostIdeaSaveResponse> {
    const userId = resolveNotionUserId(user);
    const { connection } = await this.oauthService.getConnectionForUse(userId);
    logDebug("notion.create_post_idea.started", {
      userIdPresent: Boolean(userId),
      hasTargetParentPageId: Boolean(connection.targetParentPageId),
      hasTargetDatabaseId: Boolean(connection.targetDatabaseId),
      draftKind: payload.draftKind ?? "post_idea",
    });

    const markdownBody = buildNotionMarkdown(payload);
    logDebug("notion.create_post_idea.markdown_built", {
      draftKind: payload.draftKind ?? "post_idea",
      markdownLength: markdownBody.length,
      summaryLength: payload.summary?.length ?? 0,
      analysisBodyLength: payload.analysisBody?.length ?? 0,
    });

    logDebug("notion.create_post_idea.draft_only", {
      userIdPresent: Boolean(userId),
      draftKind: payload.draftKind ?? "post_idea",
      hasMarkdownPreview: Boolean(markdownBody),
      targetConfigured:
        Boolean(connection.targetParentPageId) ||
        Boolean(connection.targetDatabaseId),
    });
    return {
      ok: true,
      pageTitle: payload.title,
      draftMarkdown: markdownBody,
    };
  }
}

export function buildNotionMarkdown(
  payload: CreateNotionPostIdeaRequest,
): string {
  if ((payload.draftKind ?? "post_idea") === "analysis_memo") {
    return buildAnalysisMemoMarkdown(payload);
  }

  return buildPostIdeaMarkdown(payload);
}

function buildPostIdeaMarkdown(payload: CreateNotionPostIdeaRequest): string {
  const tags =
    payload.tags?.filter(Boolean).join(", ") || "Tableau, MCP, X Analytics";
  return [
    `# 投稿アイデア: ${payload.title}`,
    "",
    "## 概要",
    payload.reason,
    "",
    "## 推奨投稿文",
    payload.suggestedPostText,
    "",
    "## 根拠となる指標",
    `- Impressions: ${payload.metricSummary?.impressions ?? "n/a"}`,
    `- Engagement Rate: ${payload.metricSummary?.engagementRate ?? "n/a"}`,
    `- Bookmark Rate: ${payload.metricSummary?.bookmarkRate ?? "n/a"}`,
    `- Profile Visit Rate: ${payload.metricSummary?.profileVisitRate ?? "n/a"}`,
    "",
    "## 参照ポスト",
    payload.referencePostUrl || "n/a",
    "",
    "## Source",
    payload.source || "Generated from Tableau MCP analysis.",
    "",
    "## Tags",
    tags,
  ].join("\n");
}

function buildAnalysisMemoMarkdown(
  payload: CreateNotionPostIdeaRequest,
): string {
  const lines: string[] = [`# ${payload.title}`, ""];

  if (payload.reason?.trim()) {
    lines.push("## 概要", payload.reason.trim(), "");
  }

  if (payload.summary?.trim()) {
    lines.push("## 保存内容の要約", payload.summary.trim(), "");
  }

  if (payload.analysisBody?.trim()) {
    lines.push("## 分析結果", payload.analysisBody.trim(), "");
  }

  if (payload.rankingItems?.length) {
    lines.push("## ランキング");
    for (const item of payload.rankingItems) {
      const valueText =
        item.value === undefined || item.value === null || item.value === ""
          ? ""
          : `: ${item.value}`;
      lines.push(`- ${item.label}${valueText}`);
    }
    lines.push("");
  }

  if (payload.datasourceName?.trim()) {
    lines.push("## 対象データソース", payload.datasourceName.trim(), "");
  }

  if (payload.periodLabel?.trim()) {
    lines.push("## 対象期間", payload.periodLabel.trim(), "");
  }

  if (hasMetricSummaryValues(payload.metricSummary)) {
    lines.push("## 補足指標");
    if (payload.metricSummary?.impressions !== undefined) {
      lines.push(`- Impressions: ${payload.metricSummary.impressions}`);
    }
    if (payload.metricSummary?.engagementRate !== undefined) {
      lines.push(`- Engagement Rate: ${payload.metricSummary.engagementRate}`);
    }
    if (payload.metricSummary?.bookmarkRate !== undefined) {
      lines.push(`- Bookmark Rate: ${payload.metricSummary.bookmarkRate}`);
    }
    if (payload.metricSummary?.profileVisitRate !== undefined) {
      lines.push(
        `- Profile Visit Rate: ${payload.metricSummary.profileVisitRate}`,
      );
    }
    lines.push("");
  }

  if (payload.source?.trim()) {
    lines.push("## Source", payload.source.trim(), "");
  }

  const tags =
    payload.tags?.filter(Boolean).join(", ") || "Tableau, MCP, Analysis Memo";
  lines.push("## Tags", tags);

  return lines.join("\n");
}

function hasMetricSummaryValues(
  value: CreateNotionPostIdeaRequest["metricSummary"],
): boolean {
  return Boolean(
    value &&
    Object.values(value).some(
      (metricValue) => metricValue !== undefined && metricValue !== null,
    ),
  );
}

export function resolveNotionUserId(
  user: AuthenticatedUser | undefined,
): string {
  const config = getConfig();
  if (user?.userId) {
    return user.userId;
  }

  if (!config.auth.required) {
    return config.notion.localDevUserId;
  }

  throw new Error("Authenticated user is required.");
}
