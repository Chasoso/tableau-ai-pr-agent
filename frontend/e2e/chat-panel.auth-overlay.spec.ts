import { expect, test } from "@playwright/test";

test.skip(
  process.env.PW_VITE_AUTH_REQUIRED !== "true",
  "requires PW_VITE_AUTH_REQUIRED=true",
);

test.describe("auth overlay visual", () => {
  test("shows unauthenticated overlay over the initial screen", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator(".chat-panel")).toBeVisible();
    await expect(page.locator(".auth-overlay")).toBeVisible();
    await expect(page.locator(".auth-overlay-card")).toBeVisible();
    await expect(page.getByRole("button", { name: "ログイン" })).toBeVisible();

    await expect(page.locator(".starter-user-row button")).toHaveCount(3);
    await expect(
      page.locator(".starter-user-row button").first(),
    ).toBeDisabled();
    await expect(page.locator(".message-input textarea")).toBeDisabled();
    await expect(page.locator(".message-input button")).toBeDisabled();
    await expect(page.locator(".plus-action-button")).toBeDisabled();

    await expect(page.locator(".chat-panel")).toHaveScreenshot(
      "chat-panel-unauth-overlay.png",
      {
        animations: "disabled",
        caret: "hide",
        scale: "css",
        maxDiffPixelRatio: 0.01,
      },
    );
  });
});
