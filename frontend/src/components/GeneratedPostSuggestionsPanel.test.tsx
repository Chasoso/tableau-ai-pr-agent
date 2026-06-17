// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import GeneratedPostSuggestionsPanel from "./GeneratedPostSuggestionsPanel";

describe("GeneratedPostSuggestionsPanel", () => {
  it("shows the primary suggestion first and surfaces the evidence summary", () => {
    render(
      <GeneratedPostSuggestionsPanel
        primaryOutputType="generated_post_suggestions"
        suggestions={[
          {
            text: "案1の本文",
            rationale:
              "画像情報を使用しています。イベント情報を使用しています。",
            usedEvidence: {
              photo: true,
              event: true,
              survey: false,
              postPerformance: true,
              accountOverview: false,
            },
            warnings: [],
          },
          {
            text: "案2の本文",
            rationale: "画像情報を使用しています。",
            usedEvidence: {
              photo: true,
              event: true,
              survey: false,
              postPerformance: false,
              accountOverview: false,
            },
            warnings: ["note"],
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "生成済み投稿案" }),
    ).toBeVisible();
    expect(screen.getByText("案1")).toBeVisible();
    expect(screen.getByText("優先表示")).toBeVisible();
    expect(screen.getByText("案1の本文")).toBeVisible();
    const primarySuggestion = screen.getAllByRole("article")[0];
    expect(within(primarySuggestion).getByText("根拠")).toBeVisible();
    expect(
      within(primarySuggestion).getByText("画像 / イベント / 過去投稿"),
    ).toBeVisible();
    expect(within(primarySuggestion).getByText("注意")).toBeVisible();
    expect(within(primarySuggestion).getByText("なし")).toBeVisible();
    expect(screen.getByText("2案")).toBeVisible();
  });
});
