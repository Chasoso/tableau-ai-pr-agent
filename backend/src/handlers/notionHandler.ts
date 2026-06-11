import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails, safeHash } from "../logging";
import { NotionService } from "../notion/notionService";
import type { AuthenticatedUser } from "../types/auth";
import type { ApiGatewayProxyEvent, ApiGatewayProxyResult } from "../types/api";
import type { CreateNotionPostIdeaRequest } from "../types/notion";

const notionService = new NotionService();

export async function handleNotionRoute(
  event: ApiGatewayProxyEvent,
  user: AuthenticatedUser | undefined,
): Promise<ApiGatewayProxyResult> {
  const config = getConfig();
  if (!config.notion.enabled) {
    return jsonResponse(403, {
      message: "Notion MCP integration is disabled.",
    });
  }

  const method =
    event.httpMethod ?? event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? event.path ?? "";

  try {
    if (path.endsWith("/notion/status") && method === "GET") {
      return jsonResponse(200, await notionService.getStatus(user));
    }

    if (path.endsWith("/notion/connect") && method === "POST") {
      const body = parseJsonBody<{ redirectAfter?: string }>(event.body);
      return jsonResponse(
        200,
        await notionService.connect(user, body?.redirectAfter),
      );
    }

    if (path.endsWith("/notion/callback") && method === "GET") {
      const code = event.queryStringParameters?.code;
      const state = event.queryStringParameters?.state;
      logInfo("notion.callback.received", {
        hasCode: Boolean(code),
        hasState: Boolean(state),
        stateHash: safeHash(state),
      });
      try {
        const result = await notionService.callback(code, state);
        logInfo("notion.callback.completed", {
          ok: true,
          redirectToHash: safeHash(result.redirectTo),
        });
        return htmlResponse(
          200,
          buildNotionCallbackHtml({
            ok: true,
            redirectTo: result.redirectTo,
          }),
        );
      } catch (error) {
        const userFacing = toUserFacingMessage(error);
        logWarn("notion.callback.failed", {
          hasCode: Boolean(code),
          hasState: Boolean(state),
          stateHash: safeHash(state),
          statusCode: userFacing.statusCode,
          ...safeErrorDetails(error),
        });
        return htmlResponse(
          userFacing.statusCode,
          buildNotionCallbackHtml({
            ok: false,
            redirectTo: "/",
            errorMessage: userFacing.text,
          }),
        );
      }
    }

    if (path.endsWith("/notion/disconnect") && method === "POST") {
      await notionService.disconnect(user);
      return jsonResponse(200, { ok: true });
    }

    if (path.endsWith("/notion/settings") && method === "POST") {
      const body = parseJsonBody<{
        targetParentPageId?: string;
        targetDatabaseId?: string;
      }>(event.body);
      await notionService.updateSettings(user, body ?? {});
      return jsonResponse(200, { ok: true });
    }

    if (path.endsWith("/notion/create-post-idea") && method === "POST") {
      const body = parseJsonBody<CreateNotionPostIdeaRequest>(event.body);
      validateCreatePostIdeaBody(body);
      const response = await notionService.createPostIdea(user, body);
      return jsonResponse(200, response);
    }

    return jsonResponse(404, { message: "Notion route not found." });
  } catch (error) {
    const message = toUserFacingMessage(error);
    logWarn("notion.route.failed", {
      path,
      method,
      ...safeErrorDetails(error),
    });
    return jsonResponse(message.statusCode, { message: message.text });
  }
}

function parseJsonBody<T>(body: string | null | undefined): T {
  if (!body) {
    return {} as T;
  }

  return JSON.parse(body) as T;
}

function validateCreatePostIdeaBody(body: CreateNotionPostIdeaRequest): void {
  if (!body?.title?.trim()) {
    throw new Error("title is required.");
  }
  if (!body.reason?.trim()) {
    throw new Error("reason is required.");
  }
  if (!body.suggestedPostText?.trim()) {
    throw new Error("suggestedPostText is required.");
  }
}

function toUserFacingMessage(error: unknown): {
  statusCode: number;
  text: string;
} {
  const message =
    error instanceof Error ? error.message : "Notion integration failed.";
  if (/not connected|Notion is not connected/i.test(message)) {
    return {
      statusCode: 409,
      text: "Notion is not connected. Please connect Notion first.",
    };
  }
  if (/state expired|state not found|OAuth state/i.test(message)) {
    return {
      statusCode: 400,
      text: "Notion authorization session expired. Please connect again.",
    };
  }
  if (/required|missing/i.test(message)) {
    return { statusCode: 400, text: message };
  }
  if (/notion-create-pages is not allowed/i.test(message)) {
    return {
      statusCode: 500,
      text: "Notion保存設定に問題があります（許可ツール設定）。管理者に設定確認を依頼してください。",
    };
  }
  if (/Notion target is not configured/i.test(message)) {
    return {
      statusCode: 400,
      text: "Notion保存先が未設定です。保存先ページまたはデータベースを設定してください。",
    };
  }
  if (
    /object_not_found|Could not find page|Could not find database|data source/i.test(
      message,
    )
  ) {
    return {
      statusCode: 400,
      text: "Notion保存先IDが見つからないか、アクセス権がありません。保存先設定を確認してください。",
    };
  }
  if (/unauthorized|forbidden|insufficient/i.test(message)) {
    return {
      statusCode: 403,
      text: "Notion側の権限不足により保存できませんでした。連携先ページをインテグレーションに共有してください。",
    };
  }
  if (/disabled/i.test(message)) {
    return { statusCode: 403, text: message };
  }
  if (/refresh/i.test(message)) {
    return {
      statusCode: 401,
      text: "Notion session refresh failed. Please reconnect Notion.",
    };
  }

  return { statusCode: 500, text: "Notion request failed. Please retry." };
}

function jsonResponse(
  statusCode: number,
  payload: unknown,
): ApiGatewayProxyResult {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

function htmlResponse(statusCode: number, html: string): ApiGatewayProxyResult {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: html,
  };
}

function buildNotionCallbackHtml(input: {
  ok: boolean;
  redirectTo: string;
  errorMessage?: string;
}): string {
  const redirectToJson = JSON.stringify(input.redirectTo || "/");
  const errorJson = JSON.stringify(input.errorMessage ?? "");
  const okJson = input.ok ? "true" : "false";
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Notion Connection</title>
</head>
<body>
  <p>Notion connection is being completed...</p>
  <script>
    (function () {
      var payload = {
        type: "tableau-chat.notion.complete",
        ok: ${okJson},
        error: ${errorJson}
      };
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
          window.close();
          return;
        }
      } catch (_) {}

      window.location.replace(${redirectToJson});
    })();
  </script>
</body>
</html>`;
}

function corsHeaders(): Record<string, string> {
  const config = getConfig();
  return {
    "Access-Control-Allow-Origin": config.corsAllowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
  };
}
