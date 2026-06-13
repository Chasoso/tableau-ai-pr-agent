import { expect, test, type Page } from "@playwright/test";

async function mockApis(page: Page) {
  await page.route("**/api/techplay/preview", async (route) => {
    const requestBody = route.request().postDataJSON() as {
      techplayUrl?: string;
    };

    expect(requestBody.techplayUrl).toContain("techplay.jp");

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        techplayUrl: "https://techplay.jp/event/983048",
        eventName: "Sample Event",
        eventDateText: "2025/08/08 18:30",
        summary: "Sample summary.",
        sourceTitle: "Sample Event - TECH PLAY",
        sourceDescription: "Sample summary.",
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
    expect(requestBody.eventName).toBeTruthy();
    expect(requestBody.techplayUrl).toBeTruthy();
    expect(requestBody.currentSituation).toBeTruthy();
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

test.describe("AI PR Action panel", () => {
  test("shows the input and preview panels without the legacy chat shell", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await expect(page.locator(".pr-agent-shell")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "AI PR Action" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Input" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
    await expect(page.getByText("Draft only")).toBeVisible();
    await expect(
      page.getByText("Mock Sales Workbook", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".chat-panel")).toHaveCount(0);
  });

  test("loads TechPlay metadata and autofills the event name", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Load TechPlay" }).click();

    await expect(page.getByText("TechPlay preview")).toBeVisible();
    await expect(page.getByText("Sample summary.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Event name" })).toHaveValue(
      "Sample Event",
    );
    await expect(page.getByText("jsonld")).toBeVisible();
  });

  test("uploads a venue photo and shows the selected preview", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: "venue.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("photo-bytes"),
    });
    await page.getByLabel("Photo usage").selectOption("background");

    await expect(
      page.getByAltText("Selected venue photo: venue.jpg"),
    ).toBeVisible();
    await expect(page.locator(".venue-photo-preview strong")).toHaveText(
      "venue.jpg",
    );
    await expect(page.locator(".venue-photo-preview-copy")).toContainText(
      "Use as background",
    );
    await expect(
      page.getByText("Venue photo is set to Use as background."),
    ).toBeVisible();
  });

  test("submits a typed draft request and renders the queued response", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await page
      .getByRole("textbox", { name: "Event name" })
      .fill("Tableau User Group Tokyo 2026");
    await page
      .getByRole("textbox", { name: "TechPlay URL" })
      .fill("https://techplay.jp/event/983048");
    await page
      .getByRole("textbox", { name: "Current situation" })
      .fill("The venue is filling up.");

    await page.getByRole("button", { name: "Run action" }).click();

    await expect(page.getByText("Action run queued")).toBeVisible();
    await expect(page.locator(".pr-agent-status-card")).toContainText(
      "action-run-1",
    );
    await expect(page.locator(".pr-agent-status-card")).toContainText("queued");
    await expect(
      page.getByText(
        "Configure VITE_PR_ACTION_IMAGE_PUBLIC_BASE_URL to display a URL.",
      ),
    ).toBeVisible();
  });

  test("shows an error banner when the action run API returns an error", async ({
    page,
  }) => {
    await page.route("**/api/techplay/preview", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          techplayUrl: "https://techplay.jp/event/983048",
          eventName: "Sample Event",
          eventDateText: "2025/08/08 18:30",
          summary: "Sample summary.",
          sourceTitle: "Sample Event - TECH PLAY",
          sourceDescription: "Sample summary.",
          extractedFrom: "jsonld",
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

    await page
      .getByRole("textbox", { name: "Event name" })
      .fill("Error demo event");
    await page.getByRole("button", { name: "Run action" }).click();

    await expect(
      page.getByText("Action run request failed for demo."),
    ).toBeVisible();
    await expect(page.locator(".pr-agent-shell")).toBeVisible();
  });
});
