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
  primaryOutputType: "generated_post_suggestions",
  summary: "A photo-led draft is ready.",
  suggestedSlackPostText:
    "#Tableau #TechPlay #HokuTUG\nA strong event recap draft.",
  hashtags: ["#Tableau", "#TechPlay", "#HokuTUG"],
  evidence: ["photo", "event"],
  checks: ["preview approved"],
  imageCaption: "event photo",
  generatedPostSuggestions: [
    {
      text: "#Tableau #TechPlay\nThe event energy comes through in this version.",
      rationale: "Uses the image and event context.",
      usedEvidence: {
        photo: true,
        event: true,
        survey: false,
        postPerformance: false,
        accountOverview: true,
      },
      warnings: [],
    },
    {
      text: "#Tableau #TechPlay\nThis version leads with analysis results.",
      rationale: "Focuses on Tableau insights.",
      usedEvidence: {
        photo: false,
        event: true,
        survey: true,
        postPerformance: false,
        accountOverview: false,
      },
      warnings: ["URL is a little long"],
    },
    {
      text: "#Tableau #TechPlay\nA friendly invite-style draft.",
      rationale: "Mixes event and account context.",
      usedEvidence: {
        photo: true,
        event: true,
        survey: false,
        postPerformance: true,
        accountOverview: false,
      },
      warnings: [],
    },
  ],
  attachedImage: {
    source: "original_input_image",
    objectKey: "client-input-images/mock-upload/venue.jpg",
    url: "https://images.example.com/client-input-images/mock-upload/venue.jpg",
    contentType: "image/jpeg",
    width: 1,
    height: 1,
  },
  evidencePack: {
    photoContext: {
      available: true,
      source: "actual_image",
      summary: "The photo shows the venue.",
      observedItems: ["venue", "speaker"],
      visibleText: ["Tableau", "Meetup"],
      eventFeel: "lively",
      postableElements: ["venue photo"],
      subjectCandidates: ["study session"],
    },
    eventContext: {
      available: true,
      source: "google_calendar",
      eventName: "Tableau User Group Tokyo 2026",
      eventUrl: calendarTechPlayUrl,
      eventDescription: "Event overview",
      venue: "Tokyo",
      eventDateText: "2026/06/14 11:30",
    },
    surveyInsight: {
      available: true,
      sourceStatus: "queried",
      datasourceKey: "survey",
      summary: "Survey feedback is positive.",
    },
    postPerformanceInsight: {
      available: true,
      sourceStatus: "queried",
      datasourceKey: "post-perf",
      summary: "Image posts perform well.",
    },
    accountOverviewInsight: {
      available: true,
      sourceStatus: "queried",
      datasourceKey: "account",
      summary: "This account often uses event photos.",
    },
    canGeneratePost: true,
    generationBlockers: [],
  },
  analysisSections: [
    {
      key: "photo_context",
      title: "画像解析結果",
      question: "What is in the image?",
      summary: "It shows the event venue.",
      rows: [{ label: "items", value: 2 }],
      details: {
        observedItems: ["venue", "speaker"],
        ocrText: "Tableau Meetup",
        eventFeel: "lively",
      },
    },
    {
      key: "survey_insight",
      title: "アンケート分析結果",
      question: "How was the response?",
      summary: "Feedback is positive.",
      rows: [{ label: "count", value: 10 }],
    },
    {
      key: "post_performance_insight",
      title: "投稿実績分析結果",
      question: "How are past posts performing?",
      summary: "Image posts are strong.",
      rows: [{ label: "lift", value: 3 }],
    },
    {
      key: "account_overview_insight",
      title: "アカウント概要",
      question: "What is the account like?",
      summary: "Event photos are a common pattern.",
      rows: [{ label: "freq", value: 5 }],
    },
  ],
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
        eventSource: "resolved",
        isFallbackEvent: false,
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

  await page.route("**/api/action-run-input-images", async (route) => {
    const requestBody = route.request().postDataJSON() as {
      fileName?: string;
      dataUrl?: string;
      contentType?: string;
      byteLength?: number;
      width?: number;
      height?: number;
      source?: string;
    };

    expect(requestBody.fileName).toBeTruthy();
    expect(requestBody.dataUrl).toMatch(/^data:image\//);
    expect(requestBody.contentType).toBeTruthy();
    expect(requestBody.byteLength).toBeGreaterThan(0);
    expect(requestBody.source).toBe("library");

    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        objectKey: "client-input-images/mock-upload/venue.jpg",
        contentType: requestBody.contentType ?? "image/jpeg",
        byteLength: requestBody.byteLength ?? 0,
        width: requestBody.width,
        height: requestBody.height,
        source: "uploaded_image",
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
      inputImage?: { objectKey?: string; source?: string };
    };

    expect(requestBody.postType).toBeTruthy();
    expect(requestBody.eventName).toBe("Tableau User Group Tokyo 2026");
    expect(requestBody.techplayUrl).toBe(calendarTechPlayUrl);
    expect(requestBody.dashboardContext).toBeTruthy();
    expect(requestBody.inputImage?.objectKey).toBe(
      "client-input-images/mock-upload/venue.jpg",
    );
    expect(requestBody.inputImage?.source).toBe("library");

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
        inputImageObjectKey: "client-input-images/mock-upload/venue.jpg",
        inputImageContentType: "image/jpeg",
        inputImageBytes: 11,
        inputImageWidth: 1,
        inputImageHeight: 1,
      }),
    });
  });

  await page.route("**/api/action-runs/*/approval", async (route) => {
    const requestBody = route.request().postDataJSON() as {
      approved?: boolean;
      selectedSuggestionText?: string;
      selectedSuggestionId?: string;
    };
    expect(requestBody.approved).toBe(true);
    expect(requestBody.selectedSuggestionText).toBeTruthy();

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
