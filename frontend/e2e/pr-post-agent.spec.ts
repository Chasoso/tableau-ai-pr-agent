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
    await expect(page.locator(".analysis-details-summary")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".suggestion-carousel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".suggestion-card")).toHaveCount(3, {
      timeout: 15_000,
    });
    await expect(page.locator(".analysis-details-summary")).toHaveText(
      "詳細を見る",
    );

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
    const dialog = page.getByRole("dialog", { name: "Slack post approval" });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".suggestion-card")).toHaveCount(1);
    await expect(dialog.getByRole("textbox", { name: "投稿文" })).toBeVisible();
    await expect(dialog.getByRole("img")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Slackに投稿" }),
    ).toBeEnabled();

    const editedSlackText =
      "#Tableau #TechPlay #HokuTUG\nEdited Slack post text.";
    await dialog.getByRole("textbox", { name: "投稿文" }).fill(editedSlackText);
    await expect(dialog.getByRole("textbox", { name: "投稿文" })).toHaveValue(
      editedSlackText,
    );

    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    await page.unroute("**/api/action-runs/*/approval").catch(() => undefined);
    await page.route("**/api/action-runs/*/approval", async (route) => {
      const requestBody = route.request().postDataJSON() as {
        approved?: boolean;
        selectedSuggestionText?: string;
        editedText?: string;
        selectedSuggestionId?: string;
      };
      expect(requestBody.approved).toBe(true);
      expect(requestBody.selectedSuggestionText).toBeTruthy();
      expect(requestBody.editedText).toBe(editedSlackText);
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
      page.getByRole("dialog", { name: "Bluesky投稿の承認" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("dialog", { name: "Bluesky投稿の承認" })
        .getByText("Blueskyへの投稿がリクエストされました"),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Bluesky投稿の承認" })
      .getByRole("button", { name: "Blueskyに投稿" })
      .click();
    await expect(page.locator(".pr-post-agent-posted")).toHaveCount(2);
    await expect(page.locator(".pr-post-agent-posted").last()).toContainText(
      "Blueskyに投稿しました",
    );
    await expect(
      page.getByRole("dialog", { name: "Bluesky投稿の承認" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Slack投稿の承認" }),
    ).toHaveCount(0);
    await expect(page.locator(".suggestion-card")).toHaveCount(1);
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
    await expect(page.locator(".analysis-details-summary")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".suggestion-card")).toHaveCount(3, {
      timeout: 15_000,
    });

    await page
      .locator(".suggestion-card")
      .first()
      .getByRole("button", { name: "この案を採用" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Slack post approval" });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".suggestion-card")).toHaveCount(1);
    await expect(dialog.getByRole("textbox", { name: "投稿文" })).toBeVisible();
    await expect(dialog.getByRole("img")).toHaveCount(0);

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
    await expect(page.locator(".suggestion-card")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Slackに投稿" }),
    ).toBeVisible();
  });
});
