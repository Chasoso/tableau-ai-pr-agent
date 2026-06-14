import { expect, test } from "@playwright/test";

test.describe("PR投稿エージェント visual", () => {
  test("@visual matches the baseline on initial render", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const panel = page.locator(".pr-post-agent-shell");
    await expect(panel).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "PR投稿エージェント" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "事前告知" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開催中の実況" }),
    ).toBeVisible();
  });
});
