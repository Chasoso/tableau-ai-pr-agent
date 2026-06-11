import { describe, expect, it } from "vitest";
import { parseQuestionPeriod } from "../src/utils/questionPeriod";

describe("questionPeriod", () => {
  it("parses a year-only request into a full year range", () => {
    const period = parseQuestionPeriod("2026年に最もFavoriteを集めたViz", {
      referenceDate: "2026-06-03T00:00:00.000Z",
    });

    expect(period).toEqual({
      kind: "year",
      label: "2026年",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      raw: "2026年",
      warnings: [],
    });
  });

  it("parses a year-month-day request into a single-day range", () => {
    const period = parseQuestionPeriod("2026年5月12日のFavorite数を教えて", {
      referenceDate: "2026-06-03T00:00:00.000Z",
    });

    expect(period).toEqual({
      kind: "day",
      label: "2026年5月12日",
      startDate: "2026-05-12",
      endDate: "2026-05-12",
      raw: "2026年5月12日",
      warnings: [],
    });
  });

  it("parses a relative week request using the reference date", () => {
    const period = parseQuestionPeriod("直近1週間のFavorite数ランキング", {
      referenceDate: "2026-06-03T00:00:00.000Z",
    });

    expect(period).toEqual({
      kind: "relative",
      label: "直近1週間",
      startDate: "2026-05-28",
      endDate: "2026-06-03",
      raw: "直近1週間",
      warnings: [],
    });
  });

  it("parses an explicit date range and preserves order", () => {
    const period = parseQuestionPeriod("2026年5月1日から2026年5月31日まで", {
      referenceDate: "2026-06-03T00:00:00.000Z",
    });

    expect(period).toEqual({
      kind: "range",
      label: "2026年5月1日〜2026年5月31日",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      raw: "2026年5月1日〜2026年5月31日",
      warnings: [],
    });
  });
});
