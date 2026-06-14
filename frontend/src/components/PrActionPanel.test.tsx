import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrActionPanel from "./PrActionPanel";
import type { DashboardContext } from "../types/tableau";

const mocks = vi.hoisted(() => ({
  createActionRun: vi.fn(),
  previewTechPlayEvent: vi.fn(),
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
}));

vi.mock("../api/techplayApi", () => ({
  previewTechPlayEvent: mocks.previewTechPlayEvent,
}));

const dashboardContext: DashboardContext = {
  dashboardName: "Mock Executive Sales Dashboard",
  workbookName: "Sales Workbook",
  worksheets: [{ name: "Summary" }],
  filters: [],
  parameters: [],
  capturedAt: "2026-06-07T00:00:00.000Z",
};

const createObjectURLMock = vi.fn(() => "blob:venue-photo");
const revokeObjectURLMock = vi.fn();

beforeEach(() => {
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
  mocks.previewTechPlayEvent.mockReset();
});

describe("PrActionPanel", () => {
  it("renders the assistant-style action flow", () => {
    render(<PrActionPanel dashboardContext={dashboardContext} />);

    expect(
      screen.getByRole("heading", { name: "Tableau PR Assistant" }),
    ).toBeVisible();
    expect(screen.getByText("参照中：")).toBeVisible();
    expect(screen.getByText("Mock Executive Sales Dashboard")).toBeVisible();
    expect(screen.getByText("投稿設定")).toBeVisible();
    expect(screen.getByRole("heading", { name: "会場写真" })).toBeVisible();
    expect(screen.getAllByText("イベント情報").length).toBeGreaterThan(0);
    expect(screen.getAllByText("補足メモ").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "投稿案を作成" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "＋ 会場写真を追加" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "イベント情報を取得" }),
    ).toBeVisible();
    expect(screen.getByText("投稿プレビュー")).toBeVisible();
    expect(screen.queryByText("今の状況")).toBeNull();
    expect(screen.queryByText("下書きを作成する")).toBeNull();
    expect(screen.getByRole("button", { name: "投稿案を作成" })).toBeDisabled();
  });

  it("loads TechPlay metadata and reveals manual event name editing only when asked", async () => {
    const user = userEvent.setup();
    mocks.previewTechPlayEvent.mockResolvedValue({
      techplayUrl: "https://techplay.jp/event/983048",
      eventName: "Sample Event",
      eventDateText: "2025/08/08 18:30",
      summary: "Sample summary.",
      sourceTitle: "Sample Event - TECH PLAY",
      sourceDescription: "Sample summary.",
      extractedFrom: "jsonld",
    });

    render(<PrActionPanel dashboardContext={dashboardContext} />);

    await user.click(
      screen.getByRole("button", { name: "イベント情報を取得" }),
    );

    expect(mocks.previewTechPlayEvent).toHaveBeenCalledWith({
      techplayUrl: "https://techplay.jp/event/example",
    });
    expect(screen.getByText("取得済み：")).toBeVisible();
    expect(screen.getByText("Sample Event")).toBeVisible();
    expect(screen.queryByLabelText("手入力イベント名")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "イベント名を入力する" }),
    );
    expect(screen.getByLabelText("手入力イベント名")).toHaveValue(
      "Sample Event",
    );
  });

  it("uploads a venue photo and shows the selected preview", async () => {
    const user = userEvent.setup();

    render(<PrActionPanel dashboardContext={dashboardContext} />);

    const fileInput = screen.getByLabelText("写真を選ぶ");
    const photo = new File(["photo-bytes"], "venue.jpg", {
      type: "image/jpeg",
    });

    await user.upload(fileInput, photo);
    await user.selectOptions(screen.getByLabelText("写真の用途"), "background");

    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByAltText("Selected venue photo: venue.jpg"),
    ).toBeVisible();
    expect(screen.getByText("venue.jpg (背景)")).toBeVisible();
  });

  it("switches drive references to the no reference mode", async () => {
    const user = userEvent.setup();

    render(<PrActionPanel dashboardContext={dashboardContext} />);

    await user.click(screen.getByRole("button", { name: "＋ 参考メモを追加" }));
    await user.selectOptions(screen.getByLabelText("参照モード"), "none");

    expect(screen.getByLabelText("参考メモタイトル")).toBeDisabled();
    expect(screen.getByLabelText("参考メモ本文")).toBeDisabled();
    expect(screen.getByText("参考メモを閉じる")).toBeVisible();
  });

  it("creates a draft from the generated preview and keeps Slack unposted", async () => {
    const user = userEvent.setup();
    mocks.previewTechPlayEvent.mockResolvedValue({
      techplayUrl: "https://techplay.jp/event/983048",
      eventName: "Sample Event",
      eventDateText: "2025/08/08 18:30",
      summary: "Sample summary.",
      sourceTitle: "Sample Event - TECH PLAY",
      sourceDescription: "Sample summary.",
      extractedFrom: "jsonld",
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

    render(
      <PrActionPanel
        dashboardContext={dashboardContext}
        authToken="auth-token"
      />,
    );

    const fileInput = screen.getByLabelText("写真を選ぶ");
    const photo = new File(["photo-bytes"], "venue.jpg", {
      type: "image/jpeg",
    });
    await user.upload(fileInput, photo);
    await user.click(
      screen.getByRole("button", { name: "イベント情報を取得" }),
    );

    await user.click(screen.getByRole("button", { name: "投稿案を作成" }));

    expect(screen.getByText("チェック済み")).toBeVisible();
    expect(screen.getByText(/Slackにはまだ投稿されません/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "下書きを作成する" }),
    ).toBeVisible();
    expect(screen.getByText("もう少し短く")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "下書きを作成する" }));

    expect(mocks.createActionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        postType: "事前告知",
        techplayUrl: "https://techplay.jp/event/example",
        currentSituation: expect.stringContaining("会場写真:venue.jpg"),
      }),
      "auth-token",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "下書き作成リクエストを送信しました",
    );

    await user.click(screen.getByText("根拠・チェック結果を見る"));

    expect(screen.getByText("action-run-1")).toBeVisible();
    expect(
      screen.getByText(
        "https://images.example.com/pr-action-images/action-run-1/poster.svg",
      ),
    ).toBeVisible();

    const details = screen.getByText("action-run-1").closest("section");
    expect(details).not.toBeNull();
    expect(
      within(details as HTMLElement).getByText("Action Run ID"),
    ).toBeVisible();
  });
});
