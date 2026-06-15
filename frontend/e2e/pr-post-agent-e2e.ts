import { expect, type Page } from "@playwright/test";

export const dashboardName = "Mock Executive Sales Dashboard";
export const calendarTechPlayUrl = "https://techplay.jp/event/983048";
export const calendarEvent = {
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

export const e2eOwnerToken = "e2e-owner-token";
export const e2eServiceConnections = {
  google: true,
  slack: true,
  x: false,
};

export const analysisResult = {
  summary: "開催中投稿では短文 + 写真つきが多いです。",
  suggestedSlackPostText:
    "#Tableau #TechPlay #HokuTUG\nMCPで整理した開催中の実況です。",
  hashtags: ["#Tableau", "#TechPlay", "#HokuTUG"],
  evidence: ["短文投稿が多い", "写真つきの投稿が目立つ"],
  checks: ["開催中の実況であることを確認"],
  imageCaption: "会場の写真",
};

export async function seedPrPostAgentState(
  page: Page,
  input: {
    ownerToken?: string;
    serviceConnections?: typeof e2eServiceConnections;
  } = {},
) {
  const ownerToken = input.ownerToken ?? e2eOwnerToken;
  const serviceConnections = input.serviceConnections ?? e2eServiceConnections;

  await page.addInitScript(
    ({ nextOwnerToken, nextServiceConnections }) => {
      localStorage.setItem(
        "tableau-ai-pr-agent.job.owner-token",
        nextOwnerToken,
      );
      localStorage.setItem("tableau-chat.job.owner-token", nextOwnerToken);
      localStorage.setItem(
        `tableau-ai-pr-agent.service-connections.anon:${nextOwnerToken}`,
        JSON.stringify(nextServiceConnections),
      );
    },
    {
      nextOwnerToken: ownerToken,
      nextServiceConnections: serviceConnections,
    },
  );
}

export async function mockPrPostAgentApis(page: Page) {
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
