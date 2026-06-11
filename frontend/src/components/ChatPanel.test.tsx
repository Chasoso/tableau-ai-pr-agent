import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "./ChatPanel";
import type { DashboardContext } from "../types/tableau";

const mocks = vi.hoisted(() => ({
  createChatJob: vi.fn(),
  getChatJob: vi.fn(),
  loadChatJobOwnerToken: vi.fn(),
  storeChatJobOwnerToken: vi.fn(),
  getNotionStatus: vi.fn(),
  savePostIdeaToNotion: vi.fn(),
  startNotionConnect: vi.fn(),
}));

vi.mock("../api/chatApi", () => ({
  createChatJob: mocks.createChatJob,
  getChatJob: mocks.getChatJob,
}));

vi.mock("../api/chatJobOwnerToken", () => ({
  loadChatJobOwnerToken: mocks.loadChatJobOwnerToken,
  storeChatJobOwnerToken: mocks.storeChatJobOwnerToken,
}));

vi.mock("../api/notionApi", () => ({
  getNotionStatus: mocks.getNotionStatus,
  savePostIdeaToNotion: mocks.savePostIdeaToNotion,
  startNotionConnect: mocks.startNotionConnect,
}));

const dashboardContext: DashboardContext = {
  dashboardName: "Overview",
  workbookName: "Sales Workbook",
  worksheets: [{ name: "Summary" }],
  filters: [],
  parameters: [],
  capturedAt: "2026-06-07T00:00:00.000Z",
};

beforeEach(() => {
  mocks.createChatJob.mockReset();
  mocks.getChatJob.mockReset();
  mocks.loadChatJobOwnerToken.mockReset();
  mocks.storeChatJobOwnerToken.mockReset();
  mocks.getNotionStatus.mockReset();
  mocks.savePostIdeaToNotion.mockReset();
  mocks.startNotionConnect.mockReset();

  mocks.loadChatJobOwnerToken.mockReturnValue(null);
  mocks.getNotionStatus.mockResolvedValue({
    connected: false,
    targetParentPageIdConfigured: false,
    targetDatabaseIdConfigured: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function flushEffects() {
  await act(async () => {});
}

describe("ChatPanel", () => {
  it("shows the auth overlay, surfaces auth errors, and calls sign-in", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn().mockResolvedValue(undefined);

    render(
      <ChatPanel
        dashboardContext={dashboardContext}
        isAuthenticated={false}
        authOverlay={{
          isSigningIn: false,
          error: "Authentication failed.",
          onSignIn,
        }}
      />,
    );

    const authCard = document.querySelector(
      ".auth-overlay-card",
    ) as HTMLElement | null;
    expect(authCard).not.toBeNull();
    expect(authCard).toHaveTextContent("Tableau Assistant");
    expect(authCard).toHaveTextContent("Authentication failed.");

    const loginButton = authCard?.querySelector(
      "button",
    ) as HTMLButtonElement | null;
    expect(loginButton).not.toBeNull();
    expect(loginButton).toBeEnabled();

    await user.click(loginButton as HTMLButtonElement);
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("creates a job, polls it, and renders the final answer", async () => {
    const user = userEvent.setup();

    mocks.createChatJob.mockResolvedValue({
      jobId: "job-1",
      status: "queued",
      stage: "queued",
      pollUrl: "/chat-jobs/job-1",
      retryAfterMs: 1500,
      ownerToken: "owner-token-1",
    });

    mocks.getChatJob.mockResolvedValue({
      jobId: "job-1",
      status: "completed",
      stage: "completed",
      progressMessages: [
        {
          at: "2026-06-07T00:00:01.000Z",
          stage: "loading_dashboard_context",
          message: "Loading dashboard context...",
          debug: { provider: "tableau-mcp", toolCallCount: 2 },
        },
      ],
      result: {
        answer: "## Final answer\n\nCompleted successfully.",
        sessionId: "session-1",
        messageId: "message-1",
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:01.000Z",
      expiresAt: 1_999_999_999,
      ownerType: "anonymous",
    });

    render(<ChatPanel dashboardContext={dashboardContext} isAuthenticated />);

    await user.type(screen.getByLabelText("質問"), "What changed?");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await flushEffects();
    expect(screen.getByText("Final answer")).toBeVisible();

    expect(mocks.createChatJob).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "What changed?",
        sessionId: undefined,
      }),
      undefined,
      undefined,
    );
    expect(mocks.getChatJob).toHaveBeenCalledWith(
      "job-1",
      undefined,
      "owner-token-1",
    );
    expect(mocks.storeChatJobOwnerToken).toHaveBeenCalledWith("owner-token-1");
  });

  it("shows an error and stops polling when the job fails", async () => {
    const user = userEvent.setup();

    mocks.createChatJob.mockResolvedValue({
      jobId: "job-failed",
      status: "queued",
      stage: "queued",
      pollUrl: "/chat-jobs/job-failed",
      retryAfterMs: 1500,
      ownerToken: "owner-token-failed",
    });

    mocks.getChatJob.mockResolvedValue({
      jobId: "job-failed",
      status: "failed",
      stage: "failed",
      progressMessages: [
        {
          at: "2026-06-07T00:00:01.000Z",
          stage: "planning",
          message: "Planning failed.",
          debug: { provider: "tableau-mcp" },
        },
      ],
      error: {
        code: "worker_failed",
        message: "Worker failed.",
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:02.000Z",
      expiresAt: 1_999_999_999,
      ownerType: "anonymous",
    });

    render(<ChatPanel dashboardContext={dashboardContext} isAuthenticated />);

    await user.type(screen.getByLabelText("質問"), "What changed?");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await flushEffects();
    expect(
      screen.getByText(/Worker failed\./, { selector: ".error-banner" }),
    ).toBeVisible();
    expect(mocks.getChatJob).toHaveBeenCalledWith(
      "job-failed",
      undefined,
      "owner-token-failed",
    );
    expect(mocks.storeChatJobOwnerToken).toHaveBeenCalledWith(
      "owner-token-failed",
    );
  });

  it("keeps a compact single progress card while polling and re-enables sending after completion", async () => {
    vi.useFakeTimers();
    try {
      mocks.createChatJob.mockResolvedValue({
        jobId: "job-progress",
        status: "queued",
        stage: "queued",
        pollUrl: "/chat-jobs/job-progress",
        retryAfterMs: 1500,
        ownerToken: "owner-token-progress",
      });

      mocks.getChatJob
        .mockResolvedValueOnce({
          jobId: "job-progress",
          status: "queued",
          stage: "queued",
          progressMessages: [
            {
              at: "2026-06-07T00:00:01.000Z",
              stage: "queued",
              message: "Job queued.",
            },
          ],
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:01.000Z",
          expiresAt: 1_999_999_999,
          ownerType: "anonymous",
        })
        .mockResolvedValueOnce({
          jobId: "job-progress",
          status: "running",
          stage: "planning",
          progressMessages: [
            {
              at: "2026-06-07T00:00:01.000Z",
              stage: "queued",
              message: "Job queued.",
            },
            {
              at: "2026-06-07T00:00:02.000Z",
              stage: "planning",
              message: "Planning query fields.",
            },
          ],
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:02.000Z",
          expiresAt: 1_999_999_999,
          ownerType: "anonymous",
        })
        .mockResolvedValueOnce({
          jobId: "job-progress",
          status: "completed",
          stage: "completed",
          progressMessages: [
            {
              at: "2026-06-07T00:00:01.000Z",
              stage: "queued",
              message: "Job queued.",
            },
            {
              at: "2026-06-07T00:00:02.000Z",
              stage: "planning",
              message: "Planning query fields.",
            },
            {
              at: "2026-06-07T00:00:03.000Z",
              stage: "completed",
              message: "Answer ready.",
            },
          ],
          result: {
            answer: "## Final answer\n\nJob completed.",
            sessionId: "session-progress",
            messageId: "message-progress",
          },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:03.000Z",
          expiresAt: 1_999_999_999,
          ownerType: "anonymous",
        });

      render(<ChatPanel dashboardContext={dashboardContext} isAuthenticated />);

      fireEvent.change(screen.getByLabelText("質問"), {
        target: {
          value:
            "エンゲージメントが高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "送信" }));

      await flushEffects();
      expect(screen.getByLabelText("質問")).toBeDisabled();
      expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
      expect(document.querySelectorAll(".job-progress-inline")).toHaveLength(1);
      expect(screen.getByText("Job queued.")).toBeVisible();
      expect(mocks.getChatJob).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      await flushEffects();
      expect(mocks.getChatJob).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Planning query fields.")).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      await flushEffects();
      await flushEffects();
      expect(mocks.getChatJob).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Final answer")).toBeVisible();
      expect(screen.getByLabelText("質問")).toBeEnabled();
      expect(mocks.getChatJob.mock.calls[0]?.[2]).toBe("owner-token-progress");
      expect(mocks.getChatJob.mock.calls[1]?.[2]).toBe("owner-token-progress");
      expect(mocks.getChatJob.mock.calls[2]?.[2]).toBe("owner-token-progress");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a markdown error response when polling fails with a completed job error", async () => {
    const user = userEvent.setup();

    mocks.createChatJob.mockResolvedValue({
      jobId: "job-markdown-error",
      status: "queued",
      stage: "queued",
      pollUrl: "/chat-jobs/job-markdown-error",
      retryAfterMs: 1500,
      ownerToken: "owner-token-markdown",
    });
    mocks.getChatJob.mockResolvedValue({
      jobId: "job-markdown-error",
      status: "failed",
      stage: "failed",
      progressMessages: [
        {
          at: "2026-06-07T00:00:01.000Z",
          stage: "failed",
          message: "Failed.",
        },
      ],
      error: {
        code: "worker_failed",
        message: "## 回答できなかった理由\n\n- 実データの取得に失敗しました。",
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:02.000Z",
      expiresAt: 1_999_999_999,
      ownerType: "anonymous",
    });

    render(<ChatPanel dashboardContext={dashboardContext} isAuthenticated />);

    await user.type(screen.getByLabelText("質問"), "What changed?");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await flushEffects();
    expect(
      screen.getByText(/回答できなかった理由/, { selector: ".error-banner" }),
    ).toBeVisible();
    expect(
      screen.getByText(/実データの取得に失敗しました。/, {
        selector: ".error-banner",
      }),
    ).toBeVisible();
    await flushEffects();
    expect(screen.getByLabelText("質問")).toBeEnabled();
  });

  it("retries a transient polling failure before completing", async () => {
    vi.useFakeTimers();
    try {
      mocks.createChatJob.mockResolvedValue({
        jobId: "job-retry",
        status: "queued",
        stage: "queued",
        pollUrl: "/chat-jobs/job-retry",
        retryAfterMs: 1500,
        ownerToken: "owner-token-retry",
      });

      mocks.getChatJob
        .mockRejectedValueOnce(new Error("temporary polling failure"))
        .mockResolvedValueOnce({
          jobId: "job-retry",
          status: "completed",
          stage: "completed",
          progressMessages: [
            {
              at: "2026-06-07T00:00:01.000Z",
              stage: "completed",
              message: "Recovered after a retry.",
            },
          ],
          result: {
            answer: "## Final answer\n\nRecovered after a retry.",
            sessionId: "session-retry",
            messageId: "message-retry",
          },
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:03.000Z",
          expiresAt: 1_999_999_999,
          ownerType: "anonymous",
        });

      render(<ChatPanel dashboardContext={dashboardContext} isAuthenticated />);

      fireEvent.change(screen.getByLabelText("質問"), {
        target: {
          value:
            "エンゲージメント率が高い傾向にある投稿について、ハッシュタグごとに傾向を洗い出してください。",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "送信" }));

      await flushEffects();
      expect(screen.getByText("temporary polling failure")).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await flushEffects();
      expect(mocks.getChatJob).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/Recovered after a retry/)).toBeVisible();
      expect(screen.queryByText("temporary polling failure")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the Notion popup and refreshes status after the connect flow completes", async () => {
    const user = userEvent.setup();
    const popup = {
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      location: {
        href: "about:blank",
        assign: vi.fn(),
      },
    } as unknown as Window;

    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    mocks.startNotionConnect.mockResolvedValue("https://example.com/notion");
    mocks.getNotionStatus
      .mockResolvedValueOnce({
        connected: false,
        status: "disconnected",
        targetParentPageIdConfigured: false,
        targetDatabaseIdConfigured: false,
      })
      .mockResolvedValueOnce({
        connected: true,
        status: "connected",
        targetParentPageIdConfigured: true,
        targetDatabaseIdConfigured: true,
      });

    render(
      <ChatPanel
        dashboardContext={dashboardContext}
        authToken="auth-token"
        isAuthenticated
      />,
    );

    await flushEffects();

    const actionButton = document.querySelector(
      ".plus-action-button",
    ) as HTMLButtonElement | null;
    expect(actionButton).not.toBeNull();
    await user.click(actionButton as HTMLButtonElement);

    const menuItem = document.querySelector(
      ".action-menu-item",
    ) as HTMLButtonElement | null;
    expect(menuItem).not.toBeNull();
    await user.click(menuItem as HTMLButtonElement);

    expect(openSpy).toHaveBeenCalledWith(
      "about:blank",
      "tableau-chat-notion-connect",
      "popup,width=520,height=720",
    );
    expect(mocks.startNotionConnect).toHaveBeenCalledWith(
      { redirectAfter: window.location.href },
      "auth-token",
    );
    expect(popup.location.assign).toHaveBeenCalledWith(
      "https://example.com/notion",
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "tableau-chat.notion.complete", ok: true },
        origin: window.location.origin,
      }),
    );

    await flushEffects();
    expect(mocks.getNotionStatus).toHaveBeenCalledTimes(2);

    await user.click(actionButton as HTMLButtonElement);
    const connectedMenuItem = document.querySelector(
      ".action-menu-item",
    ) as HTMLButtonElement | null;
    expect(connectedMenuItem).not.toBeNull();
    expect(connectedMenuItem).toBeDisabled();
  });

  it("shows a popup-blocked error when Notion cannot open a window", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(
      <ChatPanel
        dashboardContext={dashboardContext}
        authToken="auth-token"
        isAuthenticated
      />,
    );

    await flushEffects();

    const actionButton = document.querySelector(
      ".plus-action-button",
    ) as HTMLButtonElement | null;
    expect(actionButton).not.toBeNull();
    await user.click(actionButton as HTMLButtonElement);

    const menuItem = document.querySelector(
      ".action-menu-item",
    ) as HTMLButtonElement | null;
    expect(menuItem).not.toBeNull();
    await user.click(menuItem as HTMLButtonElement);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(mocks.startNotionConnect).not.toHaveBeenCalled();
    expect(document.querySelector(".error-banner")).not.toBeNull();
  });

  it("saves a generated Notion draft after a completed job", async () => {
    const user = userEvent.setup();

    mocks.createChatJob.mockResolvedValue({
      jobId: "job-notion-draft",
      status: "queued",
      stage: "queued",
      pollUrl: "/chat-jobs/job-notion-draft",
      retryAfterMs: 1500,
      ownerToken: "owner-token-notion",
    });
    mocks.getChatJob.mockResolvedValue({
      jobId: "job-notion-draft",
      status: "completed",
      stage: "completed",
      progressMessages: [
        {
          at: "2026-06-07T00:00:01.000Z",
          stage: "completed",
          message: "Draft prepared.",
        },
      ],
      result: {
        answer: "## Final answer\n\nPrepared a draft for Notion.",
        sessionId: "session-notion",
        messageId: "message-notion",
        notionPostIdeaDraft: {
          title: "High engagement hashtag draft",
          reason: "The dashboard shows a repeatable pattern worth sharing.",
          suggestedPostText:
            "A short post about how hashtag posts perform best when engagement stays high.",
          summary: "Summary for save flow coverage.",
          datasourceName: "X Account Analytics Contents",
          periodLabel: "2026-05",
          rankingItems: [
            { label: "Hashtag", value: "#tableau" },
            { label: "Engagement rate", value: "4.2%" },
          ],
          metricSummary: {
            impressions: 12345,
            engagementRate: 0.042,
          },
          referencePostUrl: "https://example.com/post/1",
          source: "chat",
        },
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:02.000Z",
      expiresAt: 1_999_999_999,
      ownerType: "anonymous",
    });
    mocks.getNotionStatus.mockResolvedValue({
      connected: true,
      status: "connected",
      targetParentPageIdConfigured: true,
      targetDatabaseIdConfigured: true,
    });
    mocks.savePostIdeaToNotion.mockResolvedValue({
      pageUrl: "https://notion.so/page-1",
    });

    render(
      <ChatPanel
        dashboardContext={dashboardContext}
        authToken="auth-token"
        isAuthenticated
      />,
    );

    await user.type(screen.getByLabelText("質問"), "What changed?");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await flushEffects();
    expect(document.querySelector(".notion-confirm-card")).not.toBeNull();

    const saveButton = document.querySelector(
      ".notion-confirm-card .primary",
    ) as HTMLButtonElement | null;
    expect(saveButton).not.toBeNull();
    expect(saveButton).toBeEnabled();

    await user.click(saveButton as HTMLButtonElement);
    await flushEffects();

    expect(mocks.savePostIdeaToNotion).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "High engagement hashtag draft",
        datasourceName: "X Account Analytics Contents",
        metricSummary: { impressions: 12345, engagementRate: 0.042 },
      }),
      "auth-token",
    );
    expect(document.querySelector(".notion-confirm-card")).toBeNull();
  });
});
