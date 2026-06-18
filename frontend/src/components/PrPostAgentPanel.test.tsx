// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrPostAgentPanel from "./PrPostAgentPanel";
import type { DashboardContext } from "../types/tableau";

const mocks = vi.hoisted(() => ({
  ensureChatJobOwnerToken: vi.fn(),
  loadGoogleCalendarConnectionStatus: vi.fn(),
  startGoogleCalendarConnection: vi.fn(),
  resolveCalendarEventContext: vi.fn(),
  fetchTechPlayEventInfo: vi.fn(),
  analyzePastPostsWithTableau: vi.fn(),
  generatePrPostDraft: vi.fn(),
  postToSlack: vi.fn(),
  postToBluesky: vi.fn(),
  uploadActionRunInputImage: vi.fn(),
  prepareImageAnalysisPayload: vi.fn(),
}));

vi.mock("../api/chatJobOwnerToken", () => ({
  ensureChatJobOwnerToken: mocks.ensureChatJobOwnerToken,
}));

vi.mock("../services/googleCalendarConnection", () => ({
  loadGoogleCalendarConnectionStatus: mocks.loadGoogleCalendarConnectionStatus,
  startGoogleCalendarConnection: mocks.startGoogleCalendarConnection,
}));

vi.mock("../api/actionRunImageApi", () => ({
  uploadActionRunInputImage: mocks.uploadActionRunInputImage,
}));

vi.mock("../utils/prepareImageAnalysisPayload", () => ({
  prepareImageAnalysisPayload: mocks.prepareImageAnalysisPayload,
}));

vi.mock("../services/prPostAgent", () => ({
  resolveCalendarEventContext: mocks.resolveCalendarEventContext,
  fetchTechPlayEventInfo: mocks.fetchTechPlayEventInfo,
  analyzePastPostsWithTableau: mocks.analyzePastPostsWithTableau,
  generatePrPostDraft: mocks.generatePrPostDraft,
  postToSlack: mocks.postToSlack,
  postToBluesky: mocks.postToBluesky,
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
  mocks.ensureChatJobOwnerToken.mockReturnValue("owner-token-1");
  mocks.loadGoogleCalendarConnectionStatus.mockResolvedValue({
    connected: true,
  });
  mocks.startGoogleCalendarConnection.mockResolvedValue(undefined);
  mocks.resolveCalendarEventContext.mockResolvedValue(
    buildCalendarResolveResponse(),
  );
  mocks.fetchTechPlayEventInfo.mockResolvedValue({
    techplayUrl: "https://techplay.jp/event/996372",
    eventName:
      "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性〜Viz表現・AI・コミュニティから考える次の一歩〜",
    eventDateText: "2026/06/19 18:30 - 20:30",
    summary: "TechPlay summary",
    sourceTitle: "TechPlay title",
    sourceDescription: "TechPlay summary",
    extractedFrom: "jsonld",
  });
  mocks.analyzePastPostsWithTableau.mockResolvedValue(buildAnalysisResult());
  mocks.generatePrPostDraft.mockResolvedValue(buildGeneratedDraft());
  mocks.postToSlack.mockResolvedValue({
    actionRunId: "action-run-1",
    jobType: "action_run",
    status: "completed",
    stage: "completed",
    progressMessages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ownerType: "anonymous",
    slackWebhook: {
      sent: true,
      skipped: false,
      statusCode: 200,
    },
  });
  mocks.postToBluesky.mockResolvedValue({
    actionRunId: "action-run-1",
    jobType: "action_run",
    status: "completed",
    stage: "completed",
    progressMessages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ownerType: "anonymous",
    blueskyPost: {
      sent: true,
      skipped: false,
      statusCode: 200,
      postUri: "at://did:plc:abc123/app.bsky.feed.post/3lzwxyz",
      cid: "cid-123",
    },
  });
  mocks.prepareImageAnalysisPayload.mockResolvedValue({
    originalDataUrl: "data:image/jpeg;base64,Zm9v",
    analysisDataUrl: "data:image/jpeg;base64,Zm9v",
    compressionLabel: "mock",
    width: 640,
    height: 480,
  });
  mocks.uploadActionRunInputImage.mockResolvedValue({
    objectKey: "client-input-images/mock-upload/venue.jpg",
    contentType: "image/jpeg",
    byteLength: 11,
    width: 640,
    height: 480,
    source: "uploaded_image",
  });

  window.localStorage.setItem(
    "tableau-ai-pr-agent.service-connections.anon:owner-token-1",
    JSON.stringify({ google: true, slack: true }),
  );
});

afterEach(() => {
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe("PrPostAgentPanel", () => {
  it("shows the Slack approval modal with post text, image, and collapsible details, then sends edited text", async () => {
    const user = userEvent.setup();

    render(<PrPostAgentPanel dashboardContext={dashboardContext} />);

    await user.click(screen.getByRole("button", { name: "開催中の実況" }));
    await waitFor(() => {
      expect(mocks.resolveCalendarEventContext).toHaveBeenCalled();
    });

    await user.click(
      screen.getByRole("button", { name: "ライブラリから選択" }),
    );
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    await user.upload(
      fileInput!,
      new File(["photo-bytes"], "venue.jpg", { type: "image/jpeg" }),
    );

    await screen.findByRole("button", { name: "この案を採用" });

    await user.click(screen.getByRole("button", { name: "この案を採用" }));

    const approvalDialog = await screen.findByRole("dialog", {
      name: "Slack post approval",
    });
    expect(approvalDialog).not.toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "投稿文" }) as HTMLTextAreaElement)
        .value,
    ).toBe(
      "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性〜Viz表現・AI・コミュニティから考える次の一歩〜\n\n2026/06/19 18:30 - 20:30の告知を、現場感を込めてお届けします。\n\nhttps://techplay.jp/event/996372\n#Tableau #HokuTUG",
    );
    expect(
      within(approvalDialog).getByRole("img", { name: "venue.jpg" }),
    ).toBeTruthy();
    expect(within(approvalDialog).getByText("Evidence")).toBeTruthy();
    expect(within(approvalDialog).getByText("Checks")).toBeTruthy();
    expect(
      within(approvalDialog).getByText("Tableau signals / Debug info"),
    ).toBeTruthy();

    const postTextBox = screen.getByRole("textbox", { name: "投稿文" });
    await user.clear(postTextBox);
    await user.type(postTextBox, "Edited Slack post text");
    await user.click(screen.getByRole("button", { name: "Slackに投稿" }));

    await waitFor(() => {
      expect(mocks.postToSlack).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedSuggestionText:
            "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性〜Viz表現・AI・コミュニティから考える次の一歩〜\n\n2026/06/19 18:30 - 20:30の告知を、現場感を込めてお届けします。\n\nhttps://techplay.jp/event/996372\n#Tableau #HokuTUG",
          editedText: "Edited Slack post text",
        }),
      );
    });
    expect(screen.getByRole("button", { name: "この案を採用" })).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Slack post approval" }),
    ).toBeNull();
  });
});

function buildCalendarResolveResponse() {
  return {
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
      techplayUrls: ["https://techplay.jp/event/996372"],
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
        techplayUrls: ["https://techplay.jp/event/996372"],
        score: 100,
        scoreReasons: ["TechPlay URL detected."],
      },
    ],
    detectedTechPlayUrl: "https://techplay.jp/event/996372",
    techplayPreview: {
      techplayUrl: "https://techplay.jp/event/996372",
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
  };
}

function buildAnalysisResult() {
  return {
    actionRunId: "action-run-1",
    ownerToken: "owner-token-1",
    result: {
      summary: "analysis summary",
      suggestedSlackPostText: "draft text",
      hashtags: ["#Tableau"],
      evidence: ["Evidence 1", "Evidence 2"],
      checks: ["Check 1", "Check 2"],
      generatedPostSuggestions: [
        {
          text: "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性〜Viz表現・AI・コミュニティから考える次の一歩〜\n\n2026/06/19 18:30 - 20:30の告知を、現場感を込めてお届けします。\n\nhttps://techplay.jp/event/996372\n#Tableau #HokuTUG",
          rationale: "Use the event context and image.",
          usedEvidence: {
            photo: true,
            event: true,
            survey: true,
            postPerformance: true,
            accountOverview: true,
          },
          warnings: [],
        },
      ],
      attachedImage: {
        source: "original_input_image",
        objectKey: "client-input-images/mock-upload/venue.jpg",
        url: "blob:venue-photo",
        contentType: "image/jpeg",
        byteLength: 11,
        width: 640,
        height: 480,
      },
      evidencePack: {
        photoContext: {
          available: true,
          source: "actual_image",
          summary: "Photo summary",
          detectedTopics: ["Tableau"],
          visibleText: ["Tableau"],
          observedItems: ["stage"],
          sceneInference: "conference scene",
          eventFeel: "energetic",
          postableElements: ["speaker"],
          subjectCandidates: ["audience"],
        },
        eventContext: {
          available: true,
          source: "techplay",
          eventName: "Tableau User Group Tokyo 2026",
          eventUrl: "https://techplay.jp/event/996372",
          eventDescription: "Live summary.",
          venue: "Tokyo",
          eventDateText: "2026/06/14 11:30",
        },
        surveyInsight: {
          available: true,
          sourceStatus: "queried",
          datasourceKey: "survey",
          queryRowCount: 5,
          warnings: [],
        },
        postPerformanceInsight: {
          available: true,
          sourceStatus: "queried",
          datasourceKey: "post-performance",
          queryRowCount: 10,
          warnings: [],
        },
        accountOverviewInsight: {
          available: false,
          sourceStatus: "skipped",
          datasourceKey: "account-overview",
          queryRowCount: 0,
          warnings: ["query_tool_not_called"],
          skippedReason: "query_tool_not_called",
        },
        canGeneratePost: true,
        generationBlockers: [],
      },
      canGeneratePost: true,
      generationBlockers: [],
      analysisSections: [
        {
          key: "photo_context",
          title: "Photo context",
          question: "What is visible?",
          summary: "Conference photo",
          rows: [{ label: "People", value: 10 }],
        },
      ],
      primaryOutputType: "generated_post_suggestions",
      draftReview: {
        status: "pass",
        riskLevel: "low",
        missingFields: [],
        issues: [],
        checklist: [],
        notes: [],
      },
      safetyReview: {
        status: "pending_manual_review",
        required: true,
        checklist: ["Confirm the text", "Confirm the image"],
        notes: ["Human approval is required before posting."],
      },
    },
  };
}

function buildGeneratedDraft() {
  return {
    postType: "開催中の実況",
    eventName: "Tableau User Group Tokyo 2026",
    techplayUrl: "https://techplay.jp/event/996372",
    calendarResult: buildCalendarResolveResponse(),
    analysis: buildAnalysisResult(),
    summaryLines: ["summary"],
    evidenceLines: ["evidence"],
    checkLines: ["check"],
    slackPostText:
      "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性〜Viz表現・AI・コミュニティから考える次の一歩〜",
    blueskyPostText:
      "【6/19(金)開催】第8回北陸Tableauユーザー会 広がるTableauの可能性〜Viz表現・AI・コミュニティから考える次の一歩〜",
    hashtags: ["#Tableau"],
    imageCaption: "Venue photo",
    image: null,
  };
}
