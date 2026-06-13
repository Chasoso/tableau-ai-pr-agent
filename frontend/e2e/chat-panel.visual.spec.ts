import { expect, test } from "@playwright/test";

test.describe("AI PR Action visual", () => {
  test("@visual matches the baseline on initial render", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const panel = page.locator(".pr-agent-shell");
    await expect(panel).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "AI PR Action" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Input" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
    await expect(page.getByText("Draft only")).toBeVisible();
    await expect(page.getByText("Run action")).toBeVisible();

    await expect(panel).toHaveScreenshot("ai-pr-action-initial.png", {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixelRatio: 0.01,
    });
  });
});
