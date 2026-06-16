import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionRunServiceMocks = vi.hoisted(() => ({
  uploadActionRunInputImage: vi.fn(),
}));

vi.mock("../src/services/actionRunService", () => ({
  ActionRunService: vi.fn().mockImplementation(() => actionRunServiceMocks),
}));

import { handler } from "../src/handlers/chatHandler";

describe("chatHandler", () => {
  const originalAuthRequired = process.env.AUTH_REQUIRED;
  const originalNotionEnabled = process.env.NOTION_MCP_ENABLED;

  beforeEach(() => {
    delete process.env.AUTH_REQUIRED;
    delete process.env.NOTION_MCP_ENABLED;
    actionRunServiceMocks.uploadActionRunInputImage.mockReset();
  });

  afterEach(() => {
    if (originalAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
    } else {
      process.env.AUTH_REQUIRED = originalAuthRequired;
    }

    if (originalNotionEnabled === undefined) {
      delete process.env.NOTION_MCP_ENABLED;
    } else {
      process.env.NOTION_MCP_ENABLED = originalNotionEnabled;
    }
  });

  it("returns 400 when question is empty", async () => {
    const response = await handler({
      httpMethod: "POST",
      body: JSON.stringify({
        question: "",
        dashboardContext: {
          dashboardName: "Dashboard",
          worksheets: [],
          filters: [],
          parameters: [],
          capturedAt: new Date().toISOString(),
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).message).toBe("question is required.");
  });

  it("returns 401 when auth is required and authorization header is missing", async () => {
    process.env.AUTH_REQUIRED = "true";

    const response = await handler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify({
        question: "What is this dashboard?",
        dashboardContext: {
          dashboardName: "Dashboard",
          worksheets: [],
          filters: [],
          parameters: [],
          capturedAt: new Date().toISOString(),
        },
      }),
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).message).toBe(
      "Authentication is required.",
    );
  });

  it("returns 403 for notion routes when notion integration is disabled", async () => {
    process.env.NOTION_MCP_ENABLED = "false";
    const response = await handler({
      httpMethod: "GET",
      rawPath: "/notion/status",
      headers: {},
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).message).toContain("disabled");
  });

  it("does not require authorization header for notion callback route", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.NOTION_MCP_ENABLED = "true";

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/notion/callback",
      queryStringParameters: {
        code: "dummy",
        state: "dummy",
      },
      headers: {},
    });

    expect(response.statusCode).not.toBe(401);
  });

  it("does not require authorization header for cognito popup auth routes", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.COGNITO_CLIENT_ID = "client-123";
    process.env.COGNITO_DOMAIN =
      "https://demo.auth.ap-northeast-1.amazoncognito.com";
    process.env.COGNITO_POPUP_REDIRECT_URI =
      "https://example.com/api/auth/cognito/callback";

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/auth/cognito/popup/start",
      headers: {},
      body: JSON.stringify({}),
    });

    expect(response.statusCode).not.toBe(401);
  });

  it("requires authorization header for google popup start route", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.GOOGLE_CALENDAR_PROVIDER = "google";
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-123";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret-123";
    process.env.GOOGLE_CALENDAR_REDIRECT_URI =
      "https://example.com/api/auth/google/callback";

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/auth/google/popup/start",
      headers: {},
      body: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(401);
  });

  it("does not require authorization header for google popup status route", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.GOOGLE_CALENDAR_PROVIDER = "google";
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-123";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret-123";
    process.env.GOOGLE_CALENDAR_REDIRECT_URI =
      "https://example.com/api/auth/google/callback";

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/auth/google/popup/status",
      queryStringParameters: {
        transactionId: "txn-123",
      },
      headers: {},
    });

    expect(response.statusCode).not.toBe(401);
  });

  it("routes action-run input image uploads to the chat handler", async () => {
    actionRunServiceMocks.uploadActionRunInputImage.mockResolvedValue({
      objectKey: "client-input-images/mock-upload/venue.jpg",
      contentType: "image/jpeg",
      byteLength: 11,
      width: 1,
      height: 1,
      source: "uploaded_image",
    });

    const response = await handler({
      httpMethod: "POST",
      rawPath: "/action-run-input-images",
      headers: {},
      body: JSON.stringify({
        fileName: "venue.jpg",
        dataUrl: "data:image/jpeg;base64,cGhvdG8=",
        contentType: "image/jpeg",
        byteLength: 11,
        width: 1,
        height: 1,
        source: "library",
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({
      objectKey: "client-input-images/mock-upload/venue.jpg",
      contentType: "image/jpeg",
      byteLength: 11,
      width: 1,
      height: 1,
      source: "uploaded_image",
    });
    expect(
      actionRunServiceMocks.uploadActionRunInputImage,
    ).toHaveBeenCalledTimes(1);
    expect(
      actionRunServiceMocks.uploadActionRunInputImage,
    ).toHaveBeenCalledWith({
      request: {
        fileName: "venue.jpg",
        dataUrl: "data:image/jpeg;base64,cGhvdG8=",
        contentType: "image/jpeg",
        byteLength: 11,
        width: 1,
        height: 1,
        source: "library",
      },
      authenticatedUser: undefined,
      headers: {},
      requestId: undefined,
    });
  });

  it("shows the Cognito error description on callback failures", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.COGNITO_CLIENT_ID = "client-123";
    process.env.COGNITO_DOMAIN =
      "https://demo.auth.ap-northeast-1.amazoncognito.com";
    process.env.COGNITO_POPUP_REDIRECT_URI =
      "https://example.com/api/auth/cognito/callback";

    const response = await handler({
      httpMethod: "GET",
      rawPath: "/auth/cognito/callback",
      queryStringParameters: {
        error: "invalid_request",
        error_description: "redirect_uri mismatch",
      },
      headers: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("invalid_request");
    expect(response.body).toContain("redirect_uri mismatch");
  });
});
