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
import { createChatService } from "../services/chatService";
import type {
  ApiGatewayProxyEvent,
  ApiGatewayProxyResult,
  LambdaExecutionContext,
} from "../types/api";
import type { ChatRequest, ContextRequest } from "../types/chat";
import { handleNotionRoute } from "./notionHandler";
import { handleCognitoPopupAuthRoute } from "./cognitoPopupAuthHandler";

const chatJobService = new ChatJobService();

export async function handler(
  event: ApiGatewayProxyEvent,
  context?: LambdaExecutionContext,
): Promise<ApiGatewayProxyResult> {
  const requestId = event.requestContext?.requestId;
  const method = event.httpMethod ?? event.requestContext?.http?.method;
  const routePath = getRoutePath(event);
  const isChatJobRoute = routePath.startsWith("/chat-jobs");
  const isNotionCallbackRoute = routePath.startsWith("/notion/callback");
  const isCognitoPopupAuthRoute = routePath.startsWith("/auth/cognito/");

  if (method === "OPTIONS") {
    return jsonResponse(204, {});
  }

  try {
    logInfo("chat.request.received", { requestId, method, routePath });
    const authResult =
      isNotionCallbackRoute || isCognitoPopupAuthRoute
        ? { ok: true as const, user: undefined }
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

function getRoutePath(event: ApiGatewayProxyEvent): string {
  return event.rawPath ?? event.path ?? "";
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
