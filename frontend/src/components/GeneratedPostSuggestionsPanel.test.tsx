// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import GeneratedPostSuggestionsPanel from "./GeneratedPostSuggestionsPanel";

describe("GeneratedPostSuggestionsPanel", () => {
  it("shows the primary suggestion first and marks it as the main output", () => {
    render(
      <GeneratedPostSuggestionsPanel
        primaryOutputType="generated_post_suggestions"
        suggestions={[
          {
            text: "北陸Tableauユーザー会、まもなくスタートです！",
            rationale: "画像とイベント情報の両方を使った短めの導入。",
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
            text: "会場の熱気が少しずつ高まってきました。",
            rationale: "現場感を少し強めた変化案。",
            usedEvidence: {
              photo: true,
              event: true,
              survey: false,
              postPerformance: false,
              accountOverview: false,
            },
            warnings: ["ハッシュタグは最小限推奨"],
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "生成済み投稿案" }),
    ).toBeVisible();
    expect(screen.getByText("最優先案")).toBeVisible();
    expect(screen.getByText("主表示")).toBeVisible();
    expect(
      screen.getByText("北陸Tableauユーザー会、まもなくスタートです！"),
    ).toBeVisible();
    expect(screen.getByText("画像 / イベント / 過去投稿")).toBeVisible();
    expect(screen.getByText("ハッシュタグは最小限推奨")).toBeVisible();
    expect(screen.getByText("2案")).toBeVisible();
  });
});
