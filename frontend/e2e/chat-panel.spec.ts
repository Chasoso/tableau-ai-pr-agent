import { expect, test, type Page } from "@playwright/test";
import { mockPrPostAgentApis, seedPrPostAgentState } from "./pr-post-agent-e2e";

async function uploadVenuePhoto(page: Page) {
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "venue.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("photo-bytes"),
  });
}

test.describe("PR投稿エージェント", () => {
  test("shows the chat shell on first load", async ({ page }) => {
    await seedPrPostAgentState(page);
    await mockPrPostAgentApis(page);
    await page.goto("/");

    await expect(page.locator(".pr-post-agent-shell")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "PR投稿エージェント" }),
    ).toBeVisible();
    await expect(
      page.getByText("過去の投稿を分析し、最適な投稿を提案します。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("まずは、投稿シーンを教えてください。"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開催中の実況" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "+" })).toBeVisible();
  });

  test("generates a live-post draft after selecting a scene and uploading a photo", async ({
    page,
  }) => {
    await seedPrPostAgentState(page);
    await mockPrPostAgentApis(page);
    await page.goto("/");

    await page.getByRole("button", { name: "開催中の実況" }).click();
    await expect(
      page.getByText("投稿する画像をアップロードしてください。"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "カメラを起動" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "ライブラリから選択" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "画像を投稿しない" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "ライブラリから選択" }).click();
    await uploadVenuePhoto(page);

    await expect(
      page
        .locator(".pr-post-agent-bubble.user")
        .getByText("画像をアップロードしました。")
        .first(),
    ).toBeVisible();

    await expect(
      page.getByText("過去投稿の傾向をもとに作成しました"),
    ).toBeVisible();
    await expect(page.locator(".pr-post-agent-draft-summary")).toContainText(
      "開催中投稿では短文 + 写真つきが多いです。",
    );
    await expect(
      page.getByRole("button", { name: "Slackに投稿" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Xに投稿" })).toBeVisible();

    await page.getByRole("button", { name: "Slackに投稿" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Slackに投稿" })
      .click();

    await expect(page.locator(".pr-post-agent-posted").first()).toContainText(
      "Slackに投稿しました。",
    );
    await expect(
      page.locator(".pr-post-agent-posted").first().getByRole("link"),
    ).toBeVisible();
  });
});
