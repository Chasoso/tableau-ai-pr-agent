import { expect, test, type Page } from "@playwright/test";

const dashboardName = "Mock Executive Sales Dashboard";
const calendarTechPlayUrl = "https://techplay.jp/event/983048";
const calendarEvent = {
  eventId: "mock-current-tableau-user-group",
  summary: "Tableau User Group Tokyo 2026",
  description: "Live session",
  location: "Tokyo",
  start: "2026-06-14T02:30:00.000Z",
  end: "2026-06-14T04:30:00.000Z",
  htmlLink: "https://calendar.google.com/calendar/u/0/r/eventedit/mock-current",
  techplayUrls: [calendarTechPlayUrl],
  score: 100,
  scoreReasons: ["TechPlay URL detected."],
};

async function mockApis(page: Page) {
  await page.route("**/api/calendar/resolve", async (route) => {
    const requestBody = route.request().postDataJSON() as {
      postType?: string;
      dashboardContext?: { dashboardName?: string };
      venuePhoto?: { fileName?: string; sizeLabel?: string } | null;
    };

    expect(requestBody.postType).toBeTruthy();
    expect(requestBody.dashboardContext?.dashboardName).toBe(dashboardName);
    expect(requestBody.venuePhoto?.fileName).toBe("venue.jpg");

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        provider: "mock",
        calendarLookupStatus: "found",
        techPlayFetchStatus: "fetched",
        manualTechPlayMode: false,
        searchWindowLabel: "today and around now",
        selectedEvent: calendarEvent,
        candidates: [calendarEvent],
        detectedTechPlayUrl: calendarTechPlayUrl,
        techplayPreview: {
          techplayUrl: calendarTechPlayUrl,
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
      }),
    });
  });

  await page.route("**/api/action-runs", async (route) => {
    const requestBody = route.request().postDataJSON() as {
      postType?: string;
      eventName?: string;
      techplayUrl?: string;
      currentSituation?: string;
      dashboardContext?: unknown;
    };

    expect(requestBody.postType).toBeTruthy();
    expect(requestBody.eventName).toBe("Tableau User Group Tokyo 2026");
    expect(requestBody.techplayUrl).toBe(calendarTechPlayUrl);
    expect(requestBody.currentSituation).toContain("venue.jpg");
    expect(requestBody.dashboardContext).toBeTruthy();

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        actionRunId: "action-run-1",
        jobType: "action_run",
        status: "queued",
        stage: "queued",
        pollUrl: "/action-runs/action-run-1",
        retryAfterMs: 1500,
        ownerToken: "owner-token-1",
      }),
    });
  });
}

async function uploadVenuePhoto(page: Page) {
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "venue.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("photo-bytes"),
  });
}

test.describe("Tableau PR Assistant panel", () => {
  test("shows the assistant-style shell without the legacy chat panel", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await expect(page.locator(".pr-agent-shell")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Tableau PR Assistant" }),
    ).toBeVisible();
    await expect(page.getByText(`参照中：${dashboardName}`)).toBeVisible();
    await expect(page.getByRole("heading", { name: "投稿設定" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "投稿プレビュー" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "投稿案を作成" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "投稿案を作成" }),
    ).toBeDisabled();
    await expect(page.locator(".chat-panel")).toHaveCount(0);
    await expect(page.getByText("TechPlay URL")).toHaveCount(0);
  });

  test("auto-resolves calendar context after a venue photo is added", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await uploadVenuePhoto(page);

    await expect(page.locator(".pr-agent-mini-confirm")).toBeVisible();
    await expect(page.locator(".pr-agent-mini-confirm")).toContainText(
      "イベント情報を取得しました",
    );
    await expect(page.locator(".pr-agent-mini-confirm")).toContainText(
      "Tableau User Group Tokyo 2026",
    );
    await expect(page.locator(".pr-agent-mini-confirm")).toContainText(
      "Googleカレンダーから検出",
    );
    await expect(page.locator(".pr-agent-mini-confirm")).toContainText(
      "TechPlay情報 取得済み",
    );
    await expect(
      page.getByRole("button", { name: "投稿案を作成" }),
    ).toBeEnabled();
  });

  test("creates a preview and submits a draft request", async ({ page }) => {
    await mockApis(page);
    await page.goto("/");

    await uploadVenuePhoto(page);
    await expect(page.locator(".pr-agent-mini-confirm")).toBeVisible();

    await page.getByRole("button", { name: "投稿案を作成" }).click();

    await expect(page.locator(".pr-agent-preview-card")).toBeVisible();
    await expect(page.locator(".pr-agent-preview-card")).toContainText(
      "Tableau User Group Tokyo 2026",
    );
    await expect(
      page.getByRole("button", { name: "下書きを作成する" }),
    ).toBeVisible();
    await expect(page.getByText("Slackにはまだ投稿されません。")).toBeVisible();

    await page.getByRole("button", { name: "下書きを作成する" }).click();

    await expect(page.getByRole("status")).toHaveText(
      "下書き作成リクエストを送信しました",
    );
    await expect(page.getByText("根拠・チェック結果を見る")).toBeVisible();

    await page.locator(".pr-agent-details > summary").click();
    await expect(page.getByText("Action Run ID")).toBeVisible();
    await expect(page.locator(".pr-agent-status-grid")).toContainText(
      "action-run-1",
    );
    await expect(page.locator(".pr-agent-status-grid")).toContainText("queued");
  });

  test("shows an error banner when the draft request fails", async ({
    page,
  }) => {
    await page.route("**/api/calendar/resolve", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          provider: "mock",
          calendarLookupStatus: "found",
          techPlayFetchStatus: "fetched",
          manualTechPlayMode: false,
          searchWindowLabel: "today and around now",
          selectedEvent: calendarEvent,
          candidates: [calendarEvent],
          detectedTechPlayUrl: calendarTechPlayUrl,
          techplayPreview: {
            techplayUrl: calendarTechPlayUrl,
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
        }),
      });
    });
    await page.route("**/api/action-runs", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Action run request failed for demo.",
        }),
      });
    });

    await page.goto("/");
    await uploadVenuePhoto(page);
    await page.getByRole("button", { name: "投稿案を作成" }).click();
    await page.getByRole("button", { name: "下書きを作成する" }).click();

    await expect(
      page.getByText("Action run request failed for demo."),
    ).toBeVisible();
    await expect(page.locator(".pr-agent-shell")).toBeVisible();
  });
});
