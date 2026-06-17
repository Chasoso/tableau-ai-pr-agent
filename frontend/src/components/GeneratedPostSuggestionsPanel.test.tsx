// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GeneratedPostSuggestionsPanel from "./GeneratedPostSuggestionsPanel";

describe("GeneratedPostSuggestionsPanel", () => {
  it("renders suggestion cards with the attached image and evidence chips", async () => {
    const user = userEvent.setup();
    const onSelectSuggestion = vi.fn();

    render(
      <GeneratedPostSuggestionsPanel
        primaryOutputType="generated_post_suggestions"
        attachedImage={{
          src: "https://images.example.com/input-image.jpg",
          alt: "添付予定画像",
          label: "添付予定画像",
        }}
        evidencePack={{
          canGeneratePost: true,
          generationBlockers: [],
          photoContext: {
            available: true,
            source: "actual_image",
            summary: "写真には会場の様子が映っています。",
            visibleText: ["Tableau", "Meetup"],
            observedItems: ["会場", "登壇者"],
            eventFeel: "にぎやか",
            postableElements: ["会場写真"],
            subjectCandidates: ["勉強会"],
          },
          eventContext: {
            available: true,
            source: "google_calendar",
            eventName: "Tableau User Group Tokyo 2026",
            eventUrl: "https://example.com/event",
            eventDescription: "イベント概要",
            venue: "Tokyo",
            eventDateText: "2026/06/14 11:30",
          },
          surveyInsight: {
            available: true,
            sourceStatus: "queried",
            datasourceKey: "survey",
          },
          postPerformanceInsight: {
            available: true,
            sourceStatus: "queried",
            datasourceKey: "post-perf",
          },
          accountOverviewInsight: {
            available: true,
            sourceStatus: "queried",
            datasourceKey: "account",
          },
        }}
        analysisSections={[
          {
            key: "photo_context",
            title: "画像解析",
            question: "何が写っているか",
            summary: "会場写真です。",
            rows: [{ label: "要素", value: 2 }],
          },
          {
            key: "survey_insight",
            title: "アンケート",
            question: "反応はどうか",
            summary: "好意的です。",
            rows: [{ label: "件数", value: 10 }],
          },
        ]}
        selectedSuggestionId="suggestion-0"
        suggestions={[
          {
            text: "#Tableau #TechPlay\n会場の熱量が伝わる投稿です。",
            rationale: "画像とイベント情報を使っています。",
            usedEvidence: {
              photo: true,
              event: true,
              survey: false,
              postPerformance: false,
              accountOverview: true,
            },
            warnings: [],
          },
          {
            text: "#Tableau #TechPlay\n分析結果を前面に出した案です。",
            rationale: "Tableau分析を重視しています。",
            usedEvidence: {
              photo: false,
              event: true,
              survey: true,
              postPerformance: false,
              accountOverview: false,
            },
            warnings: ["URLが少し長い"],
          },
        ]}
        onSelectSuggestion={onSelectSuggestion}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "生成済み投稿案" }),
    ).toBeVisible();
    expect(screen.getByText("2案")).toBeVisible();

    const cards = Array.from(
      document.querySelectorAll(".suggestion-card"),
    ) as HTMLElement[];
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("投稿案1")).toBeVisible();
    expect(within(cards[0]).getByText("投稿文")).toBeVisible();
    expect(within(cards[0]).getByText("画像")).toBeVisible();
    expect(within(cards[0]).getByText("イベント")).toBeVisible();
    expect(within(cards[0]).getByText("アカウント概要")).toBeVisible();
    expect(
      within(cards[0]).getByRole("img", { name: "添付予定画像" }),
    ).toBeVisible();
    expect(
      within(cards[0]).queryByText("URLが少し長い"),
    ).not.toBeInTheDocument();

    await user.click(
      within(cards[0]).getByRole("button", { name: "この案を採用" }),
    );
    expect(onSelectSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestionId: "suggestion-0",
        index: 0,
      }),
    );

    const details = screen.getByText("詳細を見る").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    await user.click(screen.getByText("詳細を見る"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("画像から読み取った内容")).toBeInTheDocument();
    expect(screen.getByText("イベント情報")).toBeInTheDocument();
    expect(screen.getByText("Tableau分析結果")).toBeInTheDocument();
  });
});
