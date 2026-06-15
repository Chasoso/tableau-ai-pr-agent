import { getConfig } from "../config";
import { authenticateRequest } from "../auth/cognitoAuth";
import {
  logError,
  logInfo,
  logWarn,
  safeErrorDetails,
  safeHash,
} from "../logging";
import { ChatJobService } from "../services/chatJobService";
import { ActionRunService } from "../services/actionRunService";
import { CalendarService } from "../services/calendarService";
import { TechPlayService } from "../services/techplayService";
import { createChatService } from "../services/chatService";
import { handleGoogleCalendarAuthRoute } from "./googleCalendarAuthHandler";
import type {
  ApiGatewayProxyEvent,
  ApiGatewayProxyResult,
  LambdaExecutionContext,
} from "../types/api";
import type {
  ActionRunApprovalRequest,
  ActionRunRequest,
} from "../types/actionRun";
import type { CalendarResolveRequest } from "../types/calendar";
import type { TechPlayPreviewRequest } from "../types/techplay";
import type { ChatRequest, ContextRequest } from "../types/chat";
import { handleNotionRoute } from "./notionHandler";
import { handleCognitoPopupAuthRoute } from "./cognitoPopupAuthHandler";

const chatJobService = new ChatJobService();
const actionRunService = new ActionRunService();
const calendarService = new CalendarService();
const techPlayService = new TechPlayService();

export async function handler(
  event: ApiGatewayProxyEvent,
  context?: LambdaExecutionContext,
): Promise<ApiGatewayProxyResult> {
  const requestId = event.requestContext?.requestId;
  const method = event.httpMethod ?? event.requestContext?.http?.method;
  const routePath = getRoutePath(event);
  const isChatJobRoute = routePath.startsWith("/chat-jobs");
  const isActionRunRoute = routePath.startsWith("/action-runs");
  const isActionRunApprovalRoute =
    routePath.startsWith("/action-runs/") && routePath.endsWith("/approval");
  const isTechPlayRoute = routePath.startsWith("/techplay");
  const isNotionCallbackRoute = routePath.startsWith("/notion/callback");
  const isCognitoPopupAuthRoute = routePath.startsWith("/auth/cognito/");
  const isGoogleCallbackRoute = routePath === "/auth/google/callback";
  const canUseOwnerTokenFallback =
    isChatJobRoute ||
    isActionRunRoute ||
    isActionRunApprovalRoute ||
    routePath === "/calendar/resolve" ||
    routePath === "/techplay/preview";

  if (method === "OPTIONS") {
    return jsonResponse(204, {});
  }

  try {
    logInfo("chat.request.received", { requestId, method, routePath });
    const authResult =
      isNotionCallbackRoute || isCognitoPopupAuthRoute || isGoogleCallbackRoute
        ? { ok: true as const, user: undefined }
        : canUseOwnerTokenFallback &&
            !getHeader(event.headers, "authorization") &&
            getHeader(event.headers, "x-chat-owner-token")
          ? {
              ok: true as const,
              user: {
                userId: `anon:${getHeader(event.headers, "x-chat-owner-token")}`,
              },
            }
          : await authenticateRequest(event.headers);
    if (!authResult.ok) {
      logWarn("chat.auth.rejected", {
        requestId,
        statusCode: authResult.statusCode,
      });
      return jsonResponse(authResult.statusCode, {
        message: authResult.message,
      });
    }
    logInfo("chat.auth.accepted", {
      requestId,
      userHash: safeHash(authResult.user?.userId),
      emailHash: safeHash(authResult.user?.email),
      tableauSubjectHash: safeHash(authResult.user?.tableauSubject),
      tokenUse: authResult.user?.tokenUse,
    });

    if (routePath.startsWith("/notion")) {
      return handleNotionRoute(event, authResult.user);
    }
    if (routePath.startsWith("/auth/cognito")) {
      return handleCognitoPopupAuthRoute(event);
    }
    if (routePath.startsWith("/auth/google")) {
      return handleGoogleCalendarAuthRoute(event, authResult.user);
    }

    if (routePath === "/chat-jobs" && method === "POST") {
      const request = parseRequest(event.body) as ChatRequest;
      const validationError = validateRequest(request);
      if (validationError) {
        logWarn("chat.job_request.invalid", {
          requestId,
          validationError,
        });
        return jsonResponse(400, { message: validationError });
      }

      const response = await chatJobService.createChatJob({
        request,
        authenticatedUser: authResult.user,
        headers: event.headers,
        requestId,
      });
      logInfo("chat.job.request.created", {
        requestId,
        jobId: response.jobId,
        status: response.status,
      });
      return jsonResponse(202, response);
    }

    if (routePath.startsWith("/chat-jobs/") && method === "GET") {
      const jobId = parseJobId(routePath);
      if (!jobId) {
        return jsonResponse(400, { message: "jobId is required." });
      }

      const response = await chatJobService.getChatJob({
        jobId,
        authenticatedUser: authResult.user,
        headers: event.headers,
      });
      logInfo("chat.job.request.fetched", {
        requestId,
        jobId,
        status: response.status,
        stage: response.stage,
      });
      return jsonResponse(200, response);
    }

    if (routePath === "/action-runs" && method === "POST") {
      const request = parseRequest(event.body) as ActionRunRequest;
      const validationError = validateActionRunRequest(request);
      if (validationError) {
        logWarn("action.run_request.invalid", {
          requestId,
          validationError,
        });
        return jsonResponse(400, { message: validationError });
      }

      const response = await actionRunService.createActionRun({
        request,
        authenticatedUser: authResult.user,
        headers: event.headers,
        requestId,
      });
      logInfo("action.run.request.created", {
        requestId,
        actionRunId: response.actionRunId,
        status: response.status,
      });
      return jsonResponse(202, response);
    }

    if (routePath === "/calendar/resolve" && method === "POST") {
      const request = parseRequest(event.body) as CalendarResolveRequest;
      const validationError = validateCalendarResolveRequest(request);
      if (validationError) {
        logWarn("calendar.resolve_request.invalid", {
          requestId,
          validationError,
        });
        return jsonResponse(400, { message: validationError });
      }

      const response = await calendarService.resolveEventContextFromCalendar(
        request,
        authResult.user,
      );
      logInfo("calendar.resolve.request.completed", {
        requestId,
        postType: request.postType,
        calendarLookupStatus: response.calendarLookupStatus,
        techPlayFetchStatus: response.techPlayFetchStatus,
        candidateCount: response.candidates.length,
      });
      return jsonResponse(200, response);
    }

    if (routePath === "/techplay/preview" && method === "POST") {
      const request = parseRequest(event.body) as TechPlayPreviewRequest;
      const validationError = validateTechPlayPreviewRequest(request);
      if (validationError) {
        logWarn("techplay.preview_request.invalid", {
          requestId,
          validationError,
        });
        return jsonResponse(400, { message: validationError });
      }

      const response = await techPlayService.previewTechPlayEvent({
        techplayUrl: request.techplayUrl,
      });
      logInfo("techplay.preview.request.completed", {
        requestId,
        techplayUrl: response.techplayUrl,
        extractedFrom: response.extractedFrom,
      });
      return jsonResponse(200, response);
    }

    if (routePath.startsWith("/action-runs/") && method === "GET") {
      const actionRunId = parseActionRunId(routePath);
      if (!actionRunId) {
        return jsonResponse(400, { message: "actionRunId is required." });
      }

      const response = await actionRunService.getActionRun({
        actionRunId,
        authenticatedUser: authResult.user,
        headers: event.headers,
      });
      logInfo("action.run.request.fetched", {
        requestId,
        actionRunId,
        status: response.status,
        stage: response.stage,
      });
      return jsonResponse(200, response);
    }

    if (isActionRunApprovalRoute && method === "POST") {
      const actionRunId = parseActionRunApprovalId(routePath);
      if (!actionRunId) {
        return jsonResponse(400, { message: "actionRunId is required." });
      }

      const request = parseRequest(event.body) as ActionRunApprovalRequest;
      const validationError = validateActionRunApprovalRequest(request);
      if (validationError) {
        logWarn("action.run_approval_request.invalid", {
          requestId,
          validationError,
        });
        return jsonResponse(400, { message: validationError });
      }

      const response = await actionRunService.approveActionRun({
        actionRunId,
        request,
        authenticatedUser: authResult.user,
        headers: event.headers,
        requestId,
      });
      logInfo("action.run.approval.completed", {
        requestId,
        actionRunId,
        slackSent: response.slackWebhook.sent,
        slackSkipped: response.slackWebhook.skipped,
      });
      return jsonResponse(200, response);
    }

    if (routePath === "/chat-jobs" && method !== "POST") {
      return jsonResponse(405, {
        message: "Method not allowed.",
      });
    }

    if (routePath.startsWith("/chat-jobs/") && method !== "GET") {
      return jsonResponse(405, {
        message: "Method not allowed.",
      });
    }

    if (routePath === "/action-runs" && method !== "POST") {
      return jsonResponse(405, {
        message: "Method not allowed.",
      });
    }

    if (routePath === "/calendar/resolve" && method !== "POST") {
      return jsonResponse(405, {
        message: "Method not allowed.",
      });
    }

    if (routePath === "/techplay/preview" && method !== "POST") {
      return jsonResponse(405, {
        message: "Method not allowed.",
      });
    }

    if (routePath.startsWith("/action-runs/") && method !== "GET") {
      if (isActionRunApprovalRoute && method === "POST") {
        return jsonResponse(405, {
          message: "Method not allowed.",
        });
      }

      return jsonResponse(405, {
        message: "Method not allowed.",
      });
    }

    const request = parseRequest(event.body);

    if (routePath === "/context") {
      const contextRequest = request as ContextRequest;
      const validationError = validateContextRequest(contextRequest);
      if (validationError) {
        logWarn("chat.context_request.invalid", { requestId, validationError });
        return jsonResponse(400, { message: validationError });
      }

      const response = await createChatService().getDashboardContextPatch(
        contextRequest,
        authResult.user,
      );
      logInfo("chat.context_request.completed", {
        requestId,
        provider: response.debug?.tableauContextProvider,
        patchedFields: response.dashboardContextPatch?.workbookName
          ? ["workbookName"]
          : [],
      });
      return jsonResponse(200, response);
    }

    const chatRequest = request as ChatRequest;
    const validationError = validateRequest(chatRequest);
    if (validationError) {
      logWarn("chat.request.invalid", { requestId, validationError });
      return jsonResponse(400, { message: validationError });
    }

    const response = await createChatService().generateAnswer(
      chatRequest,
      authResult.user,
      {
        getRemainingTimeInMillis: context?.getRemainingTimeInMillis,
      },
    );
    logInfo("chat.request.completed", {
      requestId,
      provider: response.debug?.tableauContextProvider,
      sessionId: response.sessionId,
      messageId: response.messageId,
    });
    return jsonResponse(200, response);
  } catch (error) {
    if (isChatJobRoute && method === "GET") {
      const jobRouteError = mapChatJobRouteError(error);
      if (jobRouteError) {
        logWarn("chat.job.request.rejected", {
          requestId,
          routePath,
          statusCode: jobRouteError.statusCode,
          ...safeErrorDetails(error),
        });
        return jsonResponse(jobRouteError.statusCode, {
          message: jobRouteError.message,
        });
      }
    }

    if (isActionRunRoute && method === "GET") {
      const actionRunRouteError = mapActionRunRouteError(error);
      if (actionRunRouteError) {
        logWarn("action.run.request.rejected", {
          requestId,
          routePath,
          statusCode: actionRunRouteError.statusCode,
          ...safeErrorDetails(error),
        });
        return jsonResponse(actionRunRouteError.statusCode, {
          message: actionRunRouteError.message,
        });
      }
    }

    if (isActionRunApprovalRoute && method === "POST") {
      const actionRunApprovalRouteError = mapActionRunApprovalRouteError(error);
      if (actionRunApprovalRouteError) {
        logWarn("action.run.approval.rejected", {
          requestId,
          routePath,
          statusCode: actionRunApprovalRouteError.statusCode,
          ...safeErrorDetails(error),
        });
        return jsonResponse(actionRunApprovalRouteError.statusCode, {
          message: actionRunApprovalRouteError.message,
        });
      }
    }

    if (isTechPlayRoute && method === "POST") {
      const techPlayRouteError = mapTechPlayRouteError(error);
      if (techPlayRouteError) {
        logWarn("techplay.preview.request.rejected", {
          requestId,
          routePath,
          statusCode: techPlayRouteError.statusCode,
          ...safeErrorDetails(error),
        });
        return jsonResponse(techPlayRouteError.statusCode, {
          message: techPlayRouteError.message,
        });
      }
    }

    logError("chat.request.failed", { requestId, ...safeErrorDetails(error) });
    return jsonResponse(500, { message: "Failed to generate an answer." });
  }
}

function parseRequest(body: string | null | undefined): unknown {
  if (!body) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(body) as unknown;
}

function validateRequest(request: ChatRequest): string | null {
  if (!request.question?.trim()) {
    return "question is required.";
  }

  if (!request.dashboardContext) {
    return "dashboardContext is required.";
  }

  if (!Array.isArray(request.dashboardContext.worksheets)) {
    return "dashboardContext.worksheets must be an array.";
  }

  return null;
}

function validateContextRequest(request: ContextRequest): string | null {
  if (!request.dashboardContext) {
    return "dashboardContext is required.";
  }

  if (!Array.isArray(request.dashboardContext.worksheets)) {
    return "dashboardContext.worksheets must be an array.";
  }

  return null;
}

function validateActionRunRequest(request: ActionRunRequest): string | null {
  if (!request.postType?.trim()) {
    return "postType is required.";
  }

  if (!request.eventName?.trim()) {
    return "eventName is required.";
  }

  if (!request.techplayUrl?.trim()) {
    return "techplayUrl is required.";
  }

  if (!request.currentSituation?.trim()) {
    return "currentSituation is required.";
  }

  if (!request.dashboardContext) {
    return "dashboardContext is required.";
  }

  if (!Array.isArray(request.dashboardContext.worksheets)) {
    return "dashboardContext.worksheets must be an array.";
  }

  return null;
}

function validateActionRunApprovalRequest(
  request: ActionRunApprovalRequest,
): string | null {
  if (typeof request.approved !== "boolean") {
    return "approved is required.";
  }

  if (!request.approved) {
    return "approved must be true to send Slack.";
  }

  return null;
}

function validateCalendarResolveRequest(
  request: CalendarResolveRequest,
): string | null {
  if (!request?.postType?.trim()) {
    return "postType is required.";
  }

  if (!request?.dashboardContext?.dashboardName?.trim()) {
    return "dashboardContext is required.";
  }

  return null;
}

function validateTechPlayPreviewRequest(
  request: TechPlayPreviewRequest,
): string | null {
  if (!request.techplayUrl?.trim()) {
    return "techplayUrl is required.";
  }

  try {
    const url = new URL(request.techplayUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "techplay.jp" && !hostname.endsWith(".techplay.jp")) {
      return "techplayUrl must point to techplay.jp.";
    }
  } catch {
    return "techplayUrl must be a valid URL.";
  }

  return null;
}

function getRoutePath(event: ApiGatewayProxyEvent): string {
  return event.rawPath ?? event.path ?? "";
}

function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

function jsonResponse(
  statusCode: number,
  payload: unknown,
): ApiGatewayProxyResult {
  const config = getConfig();
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": config.corsAllowedOrigin,
      "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Auth-Poll-Token,X-Chat-Owner-Token",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      "Content-Type": "application/json",
    },
    body: statusCode === 204 ? "" : JSON.stringify(payload),
  };
}

function parseJobId(routePath: string): string | null {
  const prefix = "/chat-jobs/";
  if (!routePath.startsWith(prefix)) {
    return null;
  }

  const jobId = routePath.slice(prefix.length).trim();
  return jobId || null;
}

function parseActionRunId(routePath: string): string | null {
  const prefix = "/action-runs/";
  if (!routePath.startsWith(prefix)) {
    return null;
  }

  const actionRunId = routePath.slice(prefix.length).trim();
  return actionRunId || null;
}

function parseActionRunApprovalId(routePath: string): string | null {
  const suffix = "/approval";
  if (!routePath.startsWith("/action-runs/") || !routePath.endsWith(suffix)) {
    return null;
  }

  const actionRunId = routePath
    .slice("/action-runs/".length, -suffix.length)
    .trim();
  return actionRunId || null;
}

function mapChatJobRouteError(
  error: unknown,
): { statusCode: number; message: string } | null {
  const message = error instanceof Error ? error.message : "";

  if (/not found/i.test(message)) {
    return {
      statusCode: 404,
      message: "Chat job not found.",
    };
  }

  if (/access|unauthorized|forbidden/i.test(message)) {
    return {
      statusCode: 403,
      message: "You do not have access to this chat job.",
    };
  }

  return null;
}

function mapActionRunRouteError(
  error: unknown,
): { statusCode: number; message: string } | null {
  const message = error instanceof Error ? error.message : "";

  if (/not found/i.test(message)) {
    return {
      statusCode: 404,
      message: "Action run not found.",
    };
  }

  if (/access|unauthorized|forbidden/i.test(message)) {
    return {
      statusCode: 403,
      message: "You do not have access to this action run.",
    };
  }

  return null;
}

function mapActionRunApprovalRouteError(
  error: unknown,
): { statusCode: number; message: string } | null {
  const message = error instanceof Error ? error.message : "";

  if (/not found/i.test(message)) {
    return {
      statusCode: 404,
      message: "Action run not found.",
    };
  }

  if (/access|unauthorized|forbidden/i.test(message)) {
    return {
      statusCode: 403,
      message: "You do not have access to this action run.",
    };
  }

  if (
    /approval is required|not ready for approval|approval must be true|already been sent/i.test(
      message,
    )
  ) {
    return {
      statusCode: 409,
      message,
    };
  }

  return null;
}

function mapTechPlayRouteError(
  error: unknown,
): { statusCode: number; message: string } | null {
  const message = error instanceof Error ? error.message : "";

  if (/invalid url|must point to techplay\.jp/i.test(message)) {
    return {
      statusCode: 400,
      message,
    };
  }

  if (/not found/i.test(message)) {
    return {
      statusCode: 404,
      message: "TechPlay page not found.",
    };
  }

  if (/request failed/i.test(message)) {
    return {
      statusCode: 502,
      message,
    };
  }

  return null;
}
