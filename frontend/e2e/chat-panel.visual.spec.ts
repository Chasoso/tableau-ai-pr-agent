import { expect, test } from "@playwright/test";

test.describe("Tableau PR Assistant visual", () => {
  test("@visual matches the baseline on initial render", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const panel = page.locator(".pr-agent-shell");
    await expect(panel).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Tableau PR Assistant" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "投稿設定" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "投稿プレビュー" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "投稿案を作成" }),
    ).toBeVisible();

    await expect(panel).toHaveScreenshot("tableau-pr-assistant-initial.png", {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixelRatio: 0.01,
    });
  });
});
