import { expect, test } from "@playwright/test";

test.skip(
  process.env.PW_VITE_AUTH_REQUIRED !== "true",
  "requires PW_VITE_AUTH_REQUIRED=true",
);

test.describe("auth gate visual", () => {
  test("shows the sign-in screen when auth is required", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator(".auth-state")).toBeVisible();
    await expect(page.locator(".auth-card")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Tableau PR Assistant" }),
    ).toBeVisible();
    await expect(page.getByText("Sign in to continue.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.locator(".pr-agent-shell")).toHaveCount(0);

    await expect(page.locator(".auth-state")).toHaveScreenshot(
      "tableau-pr-assistant-auth-state.png",
      {
        animations: "disabled",
        caret: "hide",
        scale: "css",
        maxDiffPixelRatio: 0.01,
      },
    );
  });
});
