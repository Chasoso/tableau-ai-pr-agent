import { expect, test } from "@playwright/test";

test.skip(
  process.env.PW_VITE_AUTH_REQUIRED !== "true",
  "requires PW_VITE_AUTH_REQUIRED=true",
);

test.describe("auth gate", () => {
  test("shows the sign-in screen when auth is required", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator(".auth-state")).toBeVisible();
    await expect(page.locator(".auth-card")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "PR投稿エージェント" }),
    ).toBeVisible();
    await expect(page.getByText("Sign in to continue.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.locator(".pr-post-agent-shell")).toHaveCount(0);
  });
});
