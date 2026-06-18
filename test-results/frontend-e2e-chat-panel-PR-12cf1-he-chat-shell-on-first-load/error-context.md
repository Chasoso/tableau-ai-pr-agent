# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: frontend\e2e\chat-panel.spec.ts >> PR投稿エージェント >> shows the chat shell on first load
- Location: frontend\e2e\chat-panel.spec.ts:13:7

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | import { mockPrPostAgentApis, seedPrPostAgentState } from "./pr-post-agent-e2e";
  3   | 
  4   | async function uploadVenuePhoto(page: Page) {
  5   |   await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
  6   |     name: "venue.jpg",
  7   |     mimeType: "image/jpeg",
  8   |     buffer: Buffer.from("photo-bytes"),
  9   |   });
  10  | }
  11  | 
  12  | test.describe("PR投稿エージェント", () => {
  13  |   test("shows the chat shell on first load", async ({ page }) => {
  14  |     await seedPrPostAgentState(page);
  15  |     await mockPrPostAgentApis(page);
> 16  |     await page.goto("/");
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  17  | 
  18  |     await expect(page.locator(".pr-post-agent-shell")).toBeVisible();
  19  |     await expect(
  20  |       page.getByRole("heading", { name: "PR投稿エージェント" }),
  21  |     ).toBeVisible();
  22  |     await expect(
  23  |       page.getByText("過去の投稿を分析し、最適な投稿を提案します。", {
  24  |         exact: true,
  25  |       }),
  26  |     ).toBeVisible();
  27  |     await expect(
  28  |       page.getByText("まずは、投稿シーンを教えてください。"),
  29  |     ).toBeVisible();
  30  |     await expect(
  31  |       page.getByRole("button", { name: "開催中の実況" }),
  32  |     ).toBeVisible();
  33  |     await expect(page.getByRole("button", { name: "+" })).toBeVisible();
  34  |   });
  35  | 
  36  |   test("generates a live-post draft after selecting a scene and uploading a photo", async ({
  37  |     page,
  38  |   }) => {
  39  |     await seedPrPostAgentState(page);
  40  |     await mockPrPostAgentApis(page);
  41  |     await page.goto("/");
  42  | 
  43  |     await page.getByRole("button", { name: "開催中の実況" }).click();
  44  |     await expect(
  45  |       page.getByText("投稿する画像をアップロードしてください。"),
  46  |     ).toBeVisible();
  47  |     await expect(
  48  |       page.getByRole("button", { name: "カメラを起動" }),
  49  |     ).toBeVisible();
  50  |     await expect(
  51  |       page.getByRole("button", { name: "ライブラリから選択" }),
  52  |     ).toBeVisible();
  53  |     await expect(
  54  |       page.getByRole("button", { name: "画像を投稿しない" }),
  55  |     ).toBeVisible();
  56  | 
  57  |     await page.getByRole("button", { name: "ライブラリから選択" }).click();
  58  |     const uploadResponsePromise = page.waitForResponse(
  59  |       (response) =>
  60  |         response.request().method() === "POST" &&
  61  |         response.url().endsWith("/api/action-run-input-images"),
  62  |     );
  63  |     await uploadVenuePhoto(page);
  64  |     const uploadResponse = await uploadResponsePromise;
  65  |     expect(uploadResponse.status()).toBe(201);
  66  | 
  67  |     const uploadSummary = page.locator(".pr-post-agent-upload-card summary");
  68  |     await expect(uploadSummary).toHaveText("›画像をアップロードしました");
  69  |     await expect(page.locator(".pr-post-agent-upload-preview")).toHaveCount(0);
  70  |     await uploadSummary.click();
  71  |     await expect(page.locator(".pr-post-agent-upload-preview")).toBeVisible();
  72  | 
  73  |     await expect(page.locator(".suggestion-carousel")).toBeVisible();
  74  |     await expect(page.locator(".suggestion-card")).toHaveCount(3);
  75  |     await expect(
  76  |       page.getByRole("region", { name: "回答生成ステータス" }),
  77  |     ).toBeVisible();
  78  |     await expect(page.locator(".analysis-details-summary")).toHaveText(
  79  |       "詳細を見る",
  80  |     );
  81  |     await expect(
  82  |       page.locator(".suggestion-card").first().getByRole("img"),
  83  |     ).toBeVisible();
  84  |     await expect(page.locator(".suggestion-carousel")).toBeVisible();
  85  | 
  86  |     const firstSuggestion = page.locator(".suggestion-card").first();
  87  |     await expect(
  88  |       firstSuggestion.getByRole("button", { name: "この案を採用" }),
  89  |     ).toBeVisible();
  90  | 
  91  |     await firstSuggestion.getByRole("button", { name: "この案を採用" }).click();
  92  |     await expect(
  93  |       page.getByRole("dialog", { name: "Slack投稿の承認" }),
  94  |     ).toBeVisible();
  95  |     await expect(page.locator(".suggestion-card")).toHaveCount(1);
  96  |     await expect(page.locator(".pr-post-agent-approval-bar")).toBeVisible();
  97  | 
  98  |     await page
  99  |       .getByRole("dialog")
  100 |       .getByRole("button", { name: "Slackに投稿" })
  101 |       .click();
  102 | 
  103 |     await expect(page.locator(".pr-post-agent-posted").first()).toContainText(
  104 |       "Slackに投稿しました",
  105 |     );
  106 |     await expect(
  107 |       page.locator(".pr-post-agent-posted").first().getByRole("link"),
  108 |     ).toBeVisible();
  109 |     await expect(page.locator(".suggestion-card")).toHaveCount(1);
  110 |   });
  111 | });
  112 | 
```