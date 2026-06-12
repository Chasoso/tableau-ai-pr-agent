import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PrActionPanel from "./PrActionPanel";
import type { DashboardContext } from "../types/tableau";

const mocks = vi.hoisted(() => ({
  createActionRun: vi.fn(),
  previewTechPlayEvent: vi.fn(),
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
});
