import { render, screen } from "@testing-library/react";
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
  dashboardName: "Overview",
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
});

describe("PrActionPanel", () => {
  it("renders the input and preview panels", () => {
    render(
      <PrActionPanel
        dashboardContext={dashboardContext}
        userDisplayName="Aki"
      />,
    );

    expect(screen.getByRole("heading", { name: "AI PR Action" })).toBeVisible();
    expect(screen.getByLabelText("Event name")).toHaveValue(
      "Tableau User Group Tokyo 2026",
    );
    expect(screen.getByLabelText("TechPlay URL")).toHaveValue(
      "https://techplay.jp/event/example",
    );
    expect(screen.getByText("Slack draft")).toBeVisible();
    expect(screen.getByText("Evidence")).toBeVisible();
    expect(screen.getByText("Checks")).toBeVisible();
    expect(
      screen.getByText(
        "Upload a venue photo from your phone to capture the atmosphere.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Drive reference")).toBeVisible();
    expect(screen.getByLabelText("Reference mode")).toHaveValue(
      "sample_markdown",
    );
    expect(screen.getByLabelText("Reference title")).toHaveValue(
      "Drive brief: event messaging",
    );
    expect(screen.getByText("Sales Workbook")).toBeVisible();
    expect(screen.getByText("Aki")).toBeVisible();
  });

  it("sends an action run request and shows the queued response", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("button", { name: "Run action" }));

    expect(mocks.createActionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        postType: "\u4e8b\u524d\u544a\u77e5",
        eventName: "Tableau User Group Tokyo 2026",
        techplayUrl: "https://techplay.jp/event/example",
      }),
      "auth-token",
    );
    expect(screen.getByText("Action run queued")).toBeVisible();
    expect(screen.getByText("action-run-1")).toBeVisible();
    expect(
      screen.getByText(
        "https://images.example.com/pr-action-images/action-run-1/poster.svg",
      ),
    ).toBeVisible();
  });

  it("loads TechPlay metadata and autofills the event name", async () => {
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

    await user.click(screen.getByRole("button", { name: "Load TechPlay" }));

    expect(mocks.previewTechPlayEvent).toHaveBeenCalledWith({
      techplayUrl: "https://techplay.jp/event/example",
    });
    expect(screen.getByLabelText("Event name")).toHaveValue("Sample Event");
    expect(screen.getByText("TechPlay preview")).toBeVisible();
    expect(screen.getByText("Sample summary.")).toBeVisible();
  });

  it("uploads a venue photo and shows the selected preview", async () => {
    const user = userEvent.setup();

    render(<PrActionPanel dashboardContext={dashboardContext} />);

    const fileInput = screen.getByLabelText("Photo file");
    const photo = new File(["photo-bytes"], "venue.jpg", {
      type: "image/jpeg",
    });

    await user.upload(fileInput, photo);
    await user.selectOptions(
      screen.getByLabelText("Photo usage"),
      "background",
    );

    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByAltText("Selected venue photo: venue.jpg"),
    ).toBeVisible();
    expect(screen.getByText("venue.jpg (Use as background)")).toBeVisible();
    expect(screen.getByLabelText("Photo usage")).toHaveValue("background");
    expect(
      screen.getByText("Venue photo is set to Use as background."),
    ).toBeVisible();
  });

  it("switches drive references to the no reference mode", async () => {
    const user = userEvent.setup();

    render(<PrActionPanel dashboardContext={dashboardContext} />);

    await user.selectOptions(screen.getByLabelText("Reference mode"), "none");

    expect(screen.getByText("No Drive reference selected.")).toBeVisible();
    expect(screen.getByLabelText("Reference title")).toBeDisabled();
    expect(screen.getByLabelText("Reference Markdown")).toBeDisabled();
    expect(screen.getByText("No Drive reference selected yet.")).toBeVisible();
  });
});
