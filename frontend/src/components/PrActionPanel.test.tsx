// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrActionPanel from "./PrActionPanel";
import type { DashboardContext } from "../types/tableau";

const mocks = vi.hoisted(() => ({
  createActionRun: vi.fn(),
  getActionRun: vi.fn(),
  resolveCalendarEventContext: vi.fn(),
  uploadActionRunInputImage: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    apiBaseUrl: "/api",
    prActionImagePublicBaseUrl: "https://images.example.com",
    prActionImageObjectKeyPrefix: "pr-action-images",
    useMockTableau: true,
    authRequired: false,
    cognito: {
      userPoolId: "",
      clientId: "",
      region: "",
      domain: "",
      redirectUri: "",
      logoutUri: "",
    },
    appVersion: "0.1.0",
  },
}));

vi.mock("../api/actionRunApi", () => ({
  createActionRun: mocks.createActionRun,
  getActionRun: mocks.getActionRun,
}));

vi.mock("../api/calendarApi", () => ({
  resolveCalendarEventContext: mocks.resolveCalendarEventContext,
}));

vi.mock("../api/actionRunImageApi", () => ({
  uploadActionRunInputImage: mocks.uploadActionRunInputImage,
}));

const dashboardContext: DashboardContext = {
  dashboardName: "Mock Executive Sales Dashboard",
  workbookName: "Sales Workbook",
  worksheets: [{ name: "Summary" }],
  filters: [],
  parameters: [],
  capturedAt: "2026-06-14T00:00:00.000Z",
};

const createObjectURLMock = vi.fn(() => "blob:venue-photo");
const revokeObjectURLMock = vi.fn();

beforeEach(() => {
  globalThis.localStorage?.clear();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURLMock,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURLMock,
    writable: true,
  });
});

afterEach(() => {
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  mocks.createActionRun.mockReset();
  mocks.getActionRun.mockReset();
  mocks.resolveCalendarEventContext.mockReset();
  mocks.uploadActionRunInputImage.mockReset();
});

describe("PrActionPanel", () => {
  it("renders the assistant-style action flow without TechPlay input upfront", () => {
    render(<PrActionPanel dashboardContext={dashboardContext} />);

    expect(
      screen.getByRole("heading", { name: "Tableau PR Assistant" }),
    ).toBeVisible();
    expect(screen.getByText("参照中：")).toBeVisible();
    expect(screen.getByText("Mock Executive Sales Dashboard")).toBeVisible();
    expect(screen.getByRole("button", { name: "開催中の実況" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "＋ 会場写真を追加" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "投稿案を作成" })).toBeVisible();
    expect(screen.queryByLabelText("TechPlay URL")).toBeNull();
    expect(screen.getByRole("button", { name: "投稿案を作成" })).toBeDisabled();
  });

  it("auto-resolves the calendar event after a photo is added", async () => {
    const user = userEvent.setup();
    mocks.resolveCalendarEventContext.mockResolvedValue({
      provider: "mock",
      calendarLookupStatus: "found",
      techPlayFetchStatus: "fetched",
      manualTechPlayMode: false,
      searchWindowLabel: "today and around now",
      selectedEvent: {
        eventId: "mock-current-tableau-user-group",
        summary: "Tableau User Group Tokyo 2026",
        description: "Live session",
        location: "Tokyo",
        start: "2026-06-14T02:30:00.000Z",
        end: "2026-06-14T04:30:00.000Z",
        htmlLink:
          "https://calendar.google.com/calendar/u/0/r/eventedit/mock-current",
        techplayUrls: ["https://techplay.jp/event/example"],
        score: 100,
        scoreReasons: ["TechPlay URL detected."],
      },
      candidates: [
        {
          eventId: "mock-current-tableau-user-group",
          summary: "Tableau User Group Tokyo 2026",
          description: "Live session",
          location: "Tokyo",
          start: "2026-06-14T02:30:00.000Z",
          end: "2026-06-14T04:30:00.000Z",
          htmlLink:
            "https://calendar.google.com/calendar/u/0/r/eventedit/mock-current",
          techplayUrls: ["https://techplay.jp/event/example"],
          score: 100,
          scoreReasons: ["TechPlay URL detected."],
        },
      ],
      detectedTechPlayUrl: "https://techplay.jp/event/example",
      techplayPreview: {
        techplayUrl: "https://techplay.jp/event/example",
        eventName: "Tableau User Group Tokyo 2026",
        eventDateText: "2026/06/14 11:30",
        summary: "Live summary.",
        sourceTitle: "Tableau User Group Tokyo 2026 - TECH PLAY",
        sourceDescription: "Live summary.",
        extractedFrom: "jsonld",
      },
      resolvedEventName: "Tableau User Group Tokyo 2026",
      warnings: [],
      notes: [],
    });
    mocks.uploadActionRunInputImage.mockResolvedValue({
      objectKey: "client-input-images/mock-upload/venue.jpg",
      contentType: "image/jpeg",
      byteLength: 11,
      width: 1,
      height: 1,
      source: "uploaded_image",
    });

    render(<PrActionPanel dashboardContext={dashboardContext} />);

    const fileInput = screen.getByLabelText("写真を選ぶ");
    const photo = new File(["photo-bytes"], "venue.jpg", {
      type: "image/jpeg",
    });

    await user.upload(fileInput, photo);

    await waitFor(() => {
      expect(mocks.resolveCalendarEventContext).toHaveBeenCalled();
    });
    expect(mocks.uploadActionRunInputImage).toHaveBeenCalled();
    expect(mocks.resolveCalendarEventContext.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        postType: "開催中の実況",
        venuePhoto: {
          fileName: "venue.jpg",
          sizeLabel: "11 B",
        },
      }),
    );
    expect(
      (await screen.findAllByText("イベント情報を取得しました")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Tableau User Group Tokyo 2026")).toBeVisible();
    expect(
      screen.getByText("Googleカレンダーから検出 / TechPlay情報 取得済み"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "投稿案を作成" })).toBeEnabled();
  });

  it("shows the manual TechPlay fallback when the calendar search cannot resolve", async () => {
    const user = userEvent.setup();
    mocks.resolveCalendarEventContext.mockResolvedValue({
      provider: "mock",
      calendarLookupStatus: "not_found",
      techPlayFetchStatus: "not_found",
      manualTechPlayMode: true,
      searchWindowLabel: "today and around now",
      candidates: [],
      warnings: ["Google Calendar event could not be found automatically."],
      notes: [],
    });
    mocks.uploadActionRunInputImage.mockResolvedValue({
      objectKey: "client-input-images/mock-upload/venue.jpg",
      contentType: "image/jpeg",
      byteLength: 11,
      width: 1,
      height: 1,
      source: "uploaded_image",
    });

    render(<PrActionPanel dashboardContext={dashboardContext} />);

    const fileInput = screen.getByLabelText("写真を選ぶ");
    const photo = new File(["photo-bytes"], "venue.jpg", {
      type: "image/jpeg",
    });

    await user.upload(fileInput, photo);
    const fallbackMessages = await screen.findAllByText(
      "イベント情報を自動取得できませんでした。",
    );
    expect(fallbackMessages.length).toBeGreaterThan(0);
    const manualTechPlayButton = await screen.findByRole("button", {
      name: "手動でTechPlay URLを入力する",
    });
    expect(manualTechPlayButton).toBeVisible();

    await user.click(manualTechPlayButton);
    expect(await screen.findByLabelText("TechPlay URL")).toBeVisible();
  });

  it("creates a draft from the generated preview and keeps Slack unposted", async () => {
    const user = userEvent.setup();
    mocks.resolveCalendarEventContext.mockResolvedValue({
      provider: "mock",
      calendarLookupStatus: "found",
      techPlayFetchStatus: "fetched",
      manualTechPlayMode: false,
      searchWindowLabel: "today and around now",
      selectedEvent: {
        eventId: "mock-current-tableau-user-group",
        summary: "Tableau User Group Tokyo 2026",
        description: "Live session",
        location: "Tokyo",
        start: "2026-06-14T02:30:00.000Z",
        end: "2026-06-14T04:30:00.000Z",
        htmlLink:
          "https://calendar.google.com/calendar/u/0/r/eventedit/mock-current",
        techplayUrls: ["https://techplay.jp/event/example"],
        score: 100,
        scoreReasons: ["TechPlay URL detected."],
      },
      candidates: [
        {
          eventId: "mock-current-tableau-user-group",
          summary: "Tableau User Group Tokyo 2026",
          description: "Live session",
          location: "Tokyo",
          start: "2026-06-14T02:30:00.000Z",
          end: "2026-06-14T04:30:00.000Z",
          htmlLink:
            "https://calendar.google.com/calendar/u/0/r/eventedit/mock-current",
          techplayUrls: ["https://techplay.jp/event/example"],
          score: 100,
          scoreReasons: ["TechPlay URL detected."],
        },
      ],
      detectedTechPlayUrl: "https://techplay.jp/event/example",
      techplayPreview: {
        techplayUrl: "https://techplay.jp/event/example",
        eventName: "Tableau User Group Tokyo 2026",
        eventDateText: "2026/06/14 11:30",
        summary: "Live summary.",
        sourceTitle: "Tableau User Group Tokyo 2026 - TECH PLAY",
        sourceDescription: "Live summary.",
        extractedFrom: "jsonld",
      },
      resolvedEventName: "Tableau User Group Tokyo 2026",
      warnings: [],
      notes: [],
    });
    mocks.uploadActionRunInputImage.mockResolvedValue({
      objectKey: "client-input-images/mock-upload/venue.jpg",
      contentType: "image/jpeg",
      byteLength: 11,
      width: 1,
      height: 1,
      source: "uploaded_image",
    });
    mocks.createActionRun.mockResolvedValue({
      actionRunId: "action-run-1",
      jobType: "action_run",
      status: "queued",
      stage: "queued",
      pollUrl: "/action-runs/action-run-1",
      retryAfterMs: 1500,
      ownerToken: "owner-token-1",
    });
    const analysisResult = {
      summary: "Generated summary",
      suggestedSlackPostText: "Draft post",
      hashtags: ["#Tableau"],
      evidence: [],
      checks: [],
    };
    mocks.getActionRun.mockResolvedValue({
      actionRunId: "action-run-1",
      jobType: "action_run",
      status: "completed",
      stage: "completed",
      progressMessages: [
        {
          stage: "queued",
          message: "Action run request accepted.",
          at: "2026-06-18T11:31:14.030Z",
        },
        {
          stage: "running_mcp_tools",
          message: "Running Tableau MCP fixed analysis...",
          at: "2026-06-18T11:31:16.008Z",
        },
      ],
      result: analysisResult,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:02.000Z",
      completedAt: "2026-06-14T00:00:02.000Z",
      expiresAt: Date.now() + 60_000,
      ownerType: "authenticated",
    });

    render(
      <PrActionPanel
        dashboardContext={dashboardContext}
        authToken="auth-token"
      />,
    );

    await user.upload(
      screen.getByLabelText("写真を選ぶ"),
      new File(["photo-bytes"], "venue.jpg", { type: "image/jpeg" }),
    );
    await waitFor(() => {
      expect(mocks.uploadActionRunInputImage).toHaveBeenCalled();
    });
    await screen.findAllByText("イベント情報を取得しました");
    await user.click(screen.getByRole("button", { name: "投稿案を作成" }));

    expect(screen.getByText("投稿プレビュー")).toBeVisible();
    expect(
      screen.getByText(
        "Slackにはまだ投稿されません。確認用の下書きリクエストを作成します。",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "下書きを作成する" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "下書きを作成する" }));

    expect(mocks.createActionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        postType: "開催中の実況",
        eventName: "Tableau User Group Tokyo 2026",
        techplayUrl: "https://techplay.jp/event/example",
        currentSituation: expect.stringContaining("会場写真:venue.jpg"),
        inputImage: expect.objectContaining({
          objectKey: "client-input-images/mock-upload/venue.jpg",
          source: "library",
        }),
      }),
      "auth-token",
      undefined,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "下書き作成リクエストを送信しました",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "回答生成ステータス" }),
      ).not.toBeInTheDocument(),
    );

    await user.click(screen.getByText("根拠・チェック結果を見る"));
  });

  it("does not create an action run when image upload fails", async () => {
    const user = userEvent.setup();
    mocks.resolveCalendarEventContext.mockResolvedValue({
      provider: "mock",
      calendarLookupStatus: "found",
      techPlayFetchStatus: "fetched",
      manualTechPlayMode: false,
      searchWindowLabel: "today and around now",
      selectedEvent: {
        eventId: "mock-current-tableau-user-group",
        summary: "Tableau User Group Tokyo 2026",
        description: "Live session",
        location: "Tokyo",
        start: "2026-06-14T02:30:00.000Z",
        end: "2026-06-14T04:30:00.000Z",
        htmlLink:
          "https://calendar.google.com/calendar/u/0/r/eventedit/mock-current",
        techplayUrls: ["https://techplay.jp/event/example"],
        score: 100,
        scoreReasons: ["TechPlay URL detected."],
      },
      candidates: [],
      detectedTechPlayUrl: "https://techplay.jp/event/example",
      resolvedEventName: "Tableau User Group Tokyo 2026",
      warnings: [],
      notes: [],
    });
    mocks.uploadActionRunInputImage.mockRejectedValue(
      new TypeError(
        'Invalid character in header content ["content-disposition"]',
      ),
    );

    render(<PrActionPanel dashboardContext={dashboardContext} />);

    await user.upload(
      screen.getByLabelText("写真を選ぶ"),
      new File(["photo-bytes"], "会場写真 2026 #1.jpeg", {
        type: "image/jpeg",
      }),
    );

    expect(
      await screen.findByText(
        "画像のアップロードに失敗しました。もう一度選択してください。",
      ),
    ).toBeVisible();
    expect(mocks.createActionRun).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "投稿案を作成" })).toBeDisabled();
  });
});
