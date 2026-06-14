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

const analysisResult = {
  summary: "開催中投稿では短文 + 写真つきが多いです。",
  suggestedSlackPostText:
    "#北陸Tableauユーザー会 #HokuTUG\nMCPについて、みんなで勉強中！",
  hashtags: ["#Tableau", "#TechPlay", "#HokuTUG"],
  evidence: ["短文投稿が多い", "写真つき投稿の反応が良い"],
  checks: ["開催中実況向けの文量です"],
  imageCaption: "会場の写真",
};

async function mockApis(page: Page) {
  await page.route("**/api/auth/google/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        connectionId: "google-connection-1",
        provider: "google",
        accountEmail: "demo@example.com",
        accountName: "Demo User",
        updatedAt: "2026-06-14T00:00:00.000Z",
      }),
    });
  });

  await page.route("**/api/calendar/resolve", async (route) => {
    const requestBody = route.request().postDataJSON() as {
      postType?: string;
      dashboardContext?: { dashboardName?: string };
      venuePhoto?: { fileName?: string; sizeLabel?: string } | null;
    };

    expect(requestBody.postType).toBeTruthy();
    expect(requestBody.dashboardContext?.dashboardName).toBe(dashboardName);

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
        techplayPreview: null,
        resolvedEventName: "Tableau User Group Tokyo 2026",
        warnings: [],
        notes: [],
      }),
    });
  });

  await page.route("**/api/techplay/preview", async (route) => {
    const requestBody = route.request().postDataJSON() as {
      techplayUrl?: string;
    };

    expect(requestBody.techplayUrl).toBe(calendarTechPlayUrl);

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        techplayUrl: calendarTechPlayUrl,
        eventName: "Tableau User Group Tokyo 2026",
        eventDateText: "2026/06/14 11:30",
        summary: "Live summary.",
        sourceTitle: "Tableau User Group Tokyo 2026 - TECH PLAY",
        sourceDescription: "Live summary.",
        extractedFrom: "jsonld",
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

  await page.route("**/api/action-runs/*/approval", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        actionRunId: "action-run-1",
        jobType: "action_run",
        status: "completed",
        stage: "completed",
        progressMessages: [],
        result: analysisResult,
        slackWebhook: {
          sent: true,
          skipped: false,
          statusCode: 200,
        },
        createdAt: "2026-06-14T00:00:00.000Z",
        updatedAt: "2026-06-14T00:00:02.000Z",
        completedAt: "2026-06-14T00:00:02.000Z",
        expiresAt: Date.now() + 60_000,
        ownerType: "authenticated",
      }),
    });
  });

  await page.route("**/api/action-runs/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      !url.pathname.endsWith("/approval")
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          actionRunId: "action-run-1",
          jobType: "action_run",
          status: "completed",
          stage: "completed",
          progressMessages: [],
          result: analysisResult,
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z",
          completedAt: "2026-06-14T00:00:02.000Z",
          expiresAt: Date.now() + 60_000,
          ownerType: "authenticated",
        }),
      });
      return;
    }

    await route.fallback();
  });
}

async function uploadVenuePhoto(page: Page) {
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "venue.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("photo-bytes"),
  });
}

test.describe("PR投稿エージェント", () => {
  test("shows the chat shell on first load", async ({ page }) => {
    await mockApis(page);
    await page.goto("/");

    await expect(page.locator(".pr-post-agent-shell")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "PR投稿エージェント" }),
    ).toBeVisible();
    await expect(
      page.getByText("過去の投稿を分析し、最適な投稿を提案します。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "事前告知" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開催中の実況" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "+" })).toBeVisible();
    await expect(page.getByText("投稿設定")).toHaveCount(0);
  });

  test("generates a live-post draft after selecting a scene and uploading a photo", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await page.getByRole("button", { name: "開催中の実況" }).click();
    await expect(
      page.getByText("投稿する画像をアップロードしてください。"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "カメラを起動" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "ライブラリから選択" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "画像を投稿しない" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "ライブラリから選択" }).click();
    await uploadVenuePhoto(page);

    await expect(
      page
        .locator(".pr-post-agent-bubble.user")
        .getByText("画像をアップロードしました。")
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "プレビューを表示" }),
    ).toBeVisible();

    await expect(
      page.getByText("過去投稿の傾向をもとに作成しました"),
    ).toBeVisible();
    await expect(page.locator(".pr-post-agent-draft-summary")).toContainText(
      "開催中投稿では短文 + 写真つきが多い",
    );
    await expect(page.locator(".pr-post-agent-draft-summary")).toContainText(
      "#HokuTUG と #Tableau を優先",
    );
    await expect(
      page.getByRole("button", { name: "Slackに投稿" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Xに投稿" })).toBeVisible();

    await page.getByRole("button", { name: "Slackに投稿" }).click();
    await expect(page.getByRole("dialog", { name: "投稿確認" })).toBeVisible();
    await page
      .getByRole("dialog", { name: "投稿確認" })
      .getByRole("button", { name: "Slackに投稿" })
      .click();

    await expect(page.locator(".pr-post-agent-posted").first()).toContainText(
      "Slackに投稿しました。",
    );
    await expect(
      page.locator(".pr-post-agent-posted").first().getByRole("link"),
    ).toBeVisible();
  });
});
