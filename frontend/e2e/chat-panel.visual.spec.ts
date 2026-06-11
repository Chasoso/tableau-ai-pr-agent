import { expect, test, type Page } from "@playwright/test";

async function mockApis(page: Page) {
  await page.route("**/api/context", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        dashboardContextPatch: {
          workbookName: "Mock Sales Workbook",
        },
      }),
    });
  });

  await page.route("**/api/notion/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connected: false,
        status: "disconnected",
        targetParentPageIdConfigured: true,
        targetDatabaseIdConfigured: false,
      }),
    });
  });
}

test.describe("chat panel visual", () => {
  test("@visual matches the baseline on initial render", async ({ page }) => {
    await mockApis(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const panel = page.locator(".chat-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveScreenshot("chat-panel-initial.png", {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixelRatio: 0.01,
    });
  });
});
