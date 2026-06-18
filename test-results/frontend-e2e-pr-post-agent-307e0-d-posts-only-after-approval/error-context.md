# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: frontend\e2e\pr-post-agent.spec.ts >> PR post agent >> shows suggestion cards, opens approval modal, and posts only after approval
- Location: frontend\e2e\pr-post-agent.spec.ts:17:7

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | import {
  3   |   analysisResult,
  4   |   mockPrPostAgentApis,
  5   |   seedPrPostAgentState,
  6   | } from "./pr-post-agent-e2e";
  7   | 
  8   | async function uploadVenuePhoto(page: Page) {
  9   |   await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
  10  |     name: "venue.jpg",
  11  |     mimeType: "image/jpeg",
  12  |     buffer: Buffer.from("photo-bytes"),
  13  |   });
  14  | }
  15  | 
  16  | test.describe("PR post agent", () => {
  17  |   test("shows suggestion cards, opens approval modal, and posts only after approval", async ({
  18  |     page,
  19  |   }) => {
  20  |     await seedPrPostAgentState(page);
  21  |     await mockPrPostAgentApis(page);
> 22  |     await page.goto("/");
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  23  | 
  24  |     await page.getByRole("button", { name: "開催中の実況" }).click();
  25  |     await page.getByRole("button", { name: "ライブラリから選択" }).click();
  26  |     await uploadVenuePhoto(page);
  27  |     await expect(
  28  |       page.getByRole("region", { name: "回答生成ステータス" }),
  29  |     ).toBeVisible();
  30  | 
  31  |     await expect(page.locator(".suggestion-card")).toHaveCount(3);
  32  |     await expect(page.locator(".suggestion-carousel")).toBeVisible();
  33  |     await expect(page.locator(".analysis-details-summary")).toHaveText(
  34  |       "詳細を見る",
  35  |     );
  36  | 
  37  |     const hasHorizontalScroll = await page.evaluate(
  38  |       () =>
  39  |         document.documentElement.scrollWidth >
  40  |         document.documentElement.clientWidth,
  41  |     );
  42  |     expect(hasHorizontalScroll).toBe(false);
  43  | 
  44  |     await page
  45  |       .locator(".suggestion-card")
  46  |       .first()
  47  |       .getByRole("button", { name: "この案を採用" })
  48  |       .click();
  49  |     const dialog = page.getByRole("dialog", { name: "Slack投稿の承認" });
  50  |     await expect(dialog).toBeVisible();
  51  |     await expect(page.locator(".suggestion-card")).toHaveCount(1);
  52  |     await expect(
  53  |       dialog.getByText("Slackへの投稿がリクエストされました"),
  54  |     ).toBeVisible();
  55  |     await expect(
  56  |       dialog.getByRole("button", { name: "Slackに投稿" }),
  57  |     ).toBeEnabled();
  58  | 
  59  |     let releaseApproval!: () => void;
  60  |     const approvalGate = new Promise<void>((resolve) => {
  61  |       releaseApproval = resolve;
  62  |     });
  63  |     await page.unroute("**/api/action-runs/*/approval").catch(() => undefined);
  64  |     await page.route("**/api/action-runs/*/approval", async (route) => {
  65  |       await approvalGate;
  66  |       await route.fulfill({
  67  |         contentType: "application/json",
  68  |         body: JSON.stringify({
  69  |           actionRunId: "action-run-1",
  70  |           jobType: "action_run",
  71  |           status: "completed",
  72  |           stage: "completed",
  73  |           progressMessages: [],
  74  |           result: analysisResult,
  75  |           slackWebhook: {
  76  |             sent: true,
  77  |             skipped: false,
  78  |             statusCode: 200,
  79  |           },
  80  |           createdAt: "2026-06-14T00:00:00.000Z",
  81  |           updatedAt: "2026-06-14T00:00:02.000Z",
  82  |           completedAt: "2026-06-14T00:00:02.000Z",
  83  |           expiresAt: Date.now() + 60_000,
  84  |           ownerType: "authenticated",
  85  |         }),
  86  |       });
  87  |     });
  88  | 
  89  |     await dialog.getByRole("button", { name: "Slackに投稿" }).click();
  90  |     await expect(
  91  |       dialog.getByRole("button", { name: "投稿中..." }),
  92  |     ).toBeDisabled();
  93  | 
  94  |     releaseApproval();
  95  | 
  96  |     await expect(page.locator(".pr-post-agent-posted").first()).toContainText(
  97  |       "Slackに投稿しました",
  98  |     );
  99  |     await expect(
  100 |       page.getByRole("dialog", { name: "Bluesky投稿の承認" }),
  101 |     ).toBeVisible();
  102 |     await expect(
  103 |       page
  104 |         .getByRole("dialog", { name: "Bluesky投稿の承認" })
  105 |         .getByText("Blueskyへの投稿がリクエストされました"),
  106 |     ).toBeVisible();
  107 |     await page
  108 |       .getByRole("dialog", { name: "Bluesky投稿の承認" })
  109 |       .getByRole("button", { name: "Blueskyに投稿" })
  110 |       .click();
  111 |     await expect(page.locator(".pr-post-agent-posted")).toHaveCount(2);
  112 |     await expect(page.locator(".pr-post-agent-posted").last()).toContainText(
  113 |       "Blueskyに投稿しました",
  114 |     );
  115 |     await expect(
  116 |       page.getByRole("dialog", { name: "Bluesky投稿の承認" }),
  117 |     ).toHaveCount(0);
  118 |     await expect(
  119 |       page.getByRole("dialog", { name: "Slack投稿の承認" }),
  120 |     ).toHaveCount(0);
  121 |     await expect(page.locator(".suggestion-card")).toHaveCount(1);
  122 |   });
```