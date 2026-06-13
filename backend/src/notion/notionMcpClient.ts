import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getConfig } from "../config";
import { logDebug, logWarn, safeErrorDetails, safeHash } from "../logging";

type McpTool = {
  name: string;
  description?: string;
};

export class NotionMcpClient {
  async createPostIdeaPage(input: {
    accessToken: string;
    title: string;
    markdownBody: string;
    targetParentPageId?: string;
    targetDatabaseId?: string;
  }): Promise<{ pageUrl?: string; pageId?: string }> {
    const config = getConfig().notion;
    const mcpUrl = config.mcpUrl;
    if (!mcpUrl) {
      throw new Error("NOTION_MCP_URL is required.");
    }

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
        },
      },
    });
    const client = new Client({
      name: "tableau-ai-pr-agent-notion-client",
      version: "0.1.0",
    });

    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools as McpTool[];
      const allowedTools = resolveAllowedNotionTools(
        config.allowedTools,
        tools.map((tool) => tool.name),
      );
      if (!allowedTools.has("notion-create-pages")) {
        throw new Error(
          "notion-create-pages is not allowed by NOTION_MCP_ALLOWED_TOOLS.",
        );
      }

      const parents = buildParentCandidates(input);
      logDebug("notion.mcp.create_pages.requested", {
        allowedToolCount: allowedTools.size,
        hasTargetParentPageId: Boolean(input.targetParentPageId),
        hasTargetDatabaseId: Boolean(input.targetDatabaseId),
        parentCandidateCount: parents.length,
      });
      let lastError: unknown;
      for (const parent of parents) {
        const args = buildCreatePagesArgs({
          title: input.title,
          markdownBody: input.markdownBody,
          parent,
        });
        try {
          logDebug("notion.mcp.create_pages.attempt", {
            parentType: parent.type,
            parentHash: safeHash(parent.value),
          });
          const result = await client.callTool({
            name: "notion-create-pages",
            arguments: args,
          });
          if (isToolErrorResult(result)) {
            throw new Error(summarizeToolError(result));
          }

          const pageRef = extractNotionPageRef(result);
          logDebug("notion.mcp.create_pages.result_debug", {
            parentType: parent.type,
            hasPageUrl: Boolean(pageRef.pageUrl),
            hasPageId: Boolean(pageRef.pageId),
            resultShape: summarizeResultShape(result),
          });
          return pageRef;
        } catch (error) {
          lastError = error;
          logWarn("notion.mcp.create_pages.attempt_failed", {
            parentType: parent.type,
            parentHash: safeHash(parent.value),
            errorCategory: categorizeNotionMcpError(error),
            ...safeErrorDetails(error),
          });
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("Notion page creation failed.");
    } catch (error) {
      logWarn("notion.mcp.create_pages.failed", {
        errorCategory: categorizeNotionMcpError(error),
        ...safeErrorDetails(error),
      });
      throw error;
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
}

export function categorizeNotionMcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid_token|Invalid access token/i.test(message)) {
    return "invalid_token";
  }
  if (/forbidden|insufficient/i.test(message)) {
    return "insufficient_permission";
  }
  if (
    /object_not_found|Could not find page|Could not find database/i.test(
      message,
    )
  ) {
    return "target_not_found";
  }
  if (/timed out|timeout/i.test(message)) {
    return "timeout";
  }
  return "unknown";
}

function resolveAllowedNotionTools(
  configuredTools: string[],
  discoveredToolNames: string[],
): Set<string> {
  const configured = configuredTools
    .map((toolName) => toolName.trim())
    .filter(Boolean);
  if (!configured.length) {
    return new Set(discoveredToolNames);
  }

  const discovered = new Set(discoveredToolNames);
  return new Set(configured.filter((toolName) => discovered.has(toolName)));
}

function buildCreatePagesArgs(input: {
  title: string;
  markdownBody: string;
  parent: ParentCandidate;
}): Record<string, unknown> {
  const parent =
    input.parent.type === "page_id"
      ? { page_id: input.parent.value, type: "page_id" as const }
      : { data_source_id: input.parent.value, type: "data_source_id" as const };

  return {
    parent,
    pages: [
      {
        properties: {
          title: input.title,
        },
        content: input.markdownBody,
      },
    ],
  };
}

type ParentCandidate = {
  type: "page_id" | "data_source_id";
  value: string;
};

export function buildParentCandidates(input: {
  targetParentPageId?: string;
  targetDatabaseId?: string;
}): ParentCandidate[] {
  const pageId = normalizeNotionIdentifier(input.targetParentPageId);
  const dataSourceId = normalizeNotionIdentifier(input.targetDatabaseId);
  if (!pageId && !dataSourceId) {
    throw new Error(
      "Notion target is not configured. Set targetParentPageId or targetDatabaseId.",
    );
  }

  // Prefer data source target first when configured, because page targets are more
  // likely to be stale or lack the required integration access in this PoC flow.
  const candidates: ParentCandidate[] = [];
  if (dataSourceId) {
    candidates.push({ type: "data_source_id", value: dataSourceId });
  }
  if (pageId) {
    candidates.push({ type: "page_id", value: pageId });
  }
  return candidates;
}

export function normalizeNotionIdentifier(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("collection://")) {
    return trimmed.replace(/^collection:\/\//, "");
  }

  const fromUrl = extractUuidFromNotionUrl(trimmed);
  if (fromUrl) {
    return fromUrl;
  }

  return trimmed;
}

function extractUuidFromNotionUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!/notion\.so$/i.test(parsed.hostname)) {
      return undefined;
    }

    const tail = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (!tail) {
      return undefined;
    }

    const match = tail.match(
      /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    return match?.[0];
  } catch {
    return undefined;
  }
}

function isToolErrorResult(
  result: unknown,
): result is { isError: boolean; content?: unknown } {
  return Boolean(
    result &&
    typeof result === "object" &&
    "isError" in result &&
    (result as { isError?: unknown }).isError,
  );
}

function summarizeToolError(result: { content?: unknown }): string {
  const text = JSON.stringify(result.content ?? "");
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

export function extractNotionPageRef(result: unknown): {
  pageUrl?: string;
  pageId?: string;
} {
  const pageUrl = findStringByPredicate(result, (value) =>
    /^https:\/\/www\.notion\.so\//i.test(value),
  );
  const pageId = findStringByPredicate(result, (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ),
  );
  if (pageUrl || pageId) {
    return { pageUrl, pageId };
  }

  const text = JSON.stringify(result ?? "");
  const notionUrl = text.match(/https:\/\/www\.notion\.so\/[^\s"']+/)?.[0];
  const fallbackPageId = text.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0];
  return {
    pageUrl: notionUrl,
    pageId: fallbackPageId,
  };
}

function findStringByPredicate(
  value: unknown,
  predicate: (candidate: string) => boolean,
): string | undefined {
  if (typeof value === "string") {
    return predicate(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByPredicate(item, predicate);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findStringByPredicate(child, predicate);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function summarizeResultShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (!value || typeof value !== "object") {
    return typeof value;
  }

  return Object.keys(value as Record<string, unknown>)
    .slice(0, 12)
    .join(",");
}
