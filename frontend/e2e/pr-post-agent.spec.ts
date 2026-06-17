import { expect, test, type Page } from "@playwright/test";
import {
  analysisResult,
  mockPrPostAgentApis,
  seedPrPostAgentState,
} from "./pr-post-agent-e2e";

async function uploadVenuePhoto(page: Page) {
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "venue.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("photo-bytes"),
  });
}

test.describe("PR post agent", () => {
  test("shows suggestion cards, opens approval modal, and posts only after approval", async ({
    page,
  }) => {
    await seedPrPostAgentState(page);
    await mockPrPostAgentApis(page);
    await page.goto("/");

    await page.getByRole("button", { name: "開催中の実況" }).click();
    await page.getByRole("button", { name: "ライブラリから選択" }).click();
    await uploadVenuePhoto(page);

    await expect(page.locator(".suggestion-card")).toHaveCount(3);
    await expect(
      page.getByRole("heading", { name: "生成済み投稿案" }),
    ).toBeVisible();
    await expect(page.getByText("詳細を見る")).toBeVisible();

    const hasHorizontalScroll = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(hasHorizontalScroll).toBe(false);

    await page
      .locator(".suggestion-card")
      .first()
      .getByRole("button", { name: "この案を採用" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Slack投稿の承認" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("Slackへの投稿がリクエストされました"),
    ).toBeVisible();
    await expect(dialog.getByRole("img")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Slackに投稿" }),
    ).toBeEnabled();

    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    await page.unroute("**/api/action-runs/*/approval").catch(() => undefined);
    await page.route("**/api/action-runs/*/approval", async (route) => {
      await approvalGate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          actionRunId: "action-run-1",
          jobType: "action_run",
          status: "completed",
          stage: "completed",
          progressMessages: [],
          result: analysisResult,
          slackWebhook: {
            sent: true,
            skipped: false,
            statusCode: 200,
          },
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:02.000Z",
          completedAt: "2026-06-14T00:00:02.000Z",
          expiresAt: Date.now() + 60_000,
          ownerType: "authenticated",
        }),
      });
    });

    await dialog.getByRole("button", { name: "Slackに投稿" }).click();
    await expect(
      dialog.getByRole("button", { name: "投稿中..." }),
    ).toBeDisabled();

    releaseApproval();

    await expect(page.locator(".pr-post-agent-posted").first()).toContainText(
      "Slackに投稿しました",
    );
    await expect(
      page.getByRole("dialog", { name: "Slack投稿の承認" }),
    ).toHaveCount(0);
  });

  test("keeps the selected suggestion visible when Slack approval fails", async ({
    page,
  }) => {
    await seedPrPostAgentState(page);
    await mockPrPostAgentApis(page);
    await page.goto("/");

    await page.getByRole("button", { name: "開催中の実況" }).click();
    await page.getByRole("button", { name: "ライブラリから選択" }).click();
    await uploadVenuePhoto(page);
    await expect(page.locator(".suggestion-card")).toHaveCount(3);

    await page
      .locator(".suggestion-card")
      .first()
      .getByRole("button", { name: "この案を採用" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Slack投稿の承認" });
    await expect(dialog).toBeVisible();

    await page.unroute("**/api/action-runs/*/approval").catch(() => undefined);
    await page.route("**/api/action-runs/*/approval", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Slack webhook failed." }),
      });
    });

    await dialog.getByRole("button", { name: "Slackに投稿" }).click();
    await expect(
      dialog.getByRole("button", { name: "投稿中..." }),
    ).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText(
      "Slack webhook failed.",
    );
    await expect(dialog).toBeVisible();
    await expect(page.locator(".suggestion-card")).toHaveCount(3);
  });
});
