export type QuestionPeriodKind =
  | "year"
  | "month"
  | "day"
  | "relative"
  | "range";

export type QuestionPeriod = {
  kind: QuestionPeriodKind;
  label: string;
  startDate: string;
  endDate: string;
  raw: string;
  warnings: string[];
};

export type QuestionPeriodParseOptions = {
  referenceDate?: string | Date;
};

const JST_OFFSET_MINUTES = 9 * 60;

export function parseQuestionPeriod(
  question: string,
  options: QuestionPeriodParseOptions = {},
): QuestionPeriod | undefined {
  const normalized = normalizeQuestion(question);
  const reference = getJstDateParts(options.referenceDate ?? new Date());

  return (
    parseExplicitRange(normalized, reference) ??
    parseRelativePeriod(normalized, reference) ??
    parseDatePeriod(normalized, reference, "day") ??
    parseDatePeriod(normalized, reference, "month") ??
    parseDatePeriod(normalized, reference, "year")
  );
}

function parseExplicitRange(
  question: string,
  reference: JstDateParts,
): QuestionPeriod | undefined {
  const patterns = [
    /(?<start>(?:20\d{2}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|20\d{2}[\/\-年]\d{1,2}[\/\-月]|\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]|\d{1,2}日))\s*(?:から|to|〜|～|~|-|–|―)\s*(?<end>(?:20\d{2}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|20\d{2}[\/\-年]\d{1,2}[\/\-月]|\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/\-月]|\d{1,2}日))/u,
  ];

  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match?.groups?.start || !match.groups.end) {
      continue;
    }

    const startParts = parseDateExpression(match.groups.start, reference);
    const endParts = parseDateExpression(
      match.groups.end,
      startParts ?? reference,
    );
    if (!startParts || !endParts) {
      continue;
    }

    const startDate = toYmd(startParts);
    const endDate = toYmd(endParts);
    if (startDate > endDate) {
      return {
        kind: "range",
        label: `${formatDisplayDate(endParts)}〜${formatDisplayDate(startParts)}`,
        startDate: endDate,
        endDate: startDate,
        raw: `${match.groups.start}〜${match.groups.end}`,
        warnings: ["Range endpoints were reversed and have been normalized."],
      };
    }

    return {
      kind: "range",
      label: `${formatDisplayDate(startParts)}〜${formatDisplayDate(endParts)}`,
      startDate,
      endDate,
      raw: `${match.groups.start}〜${match.groups.end}`,
      warnings: [],
    };
  }

  return undefined;
}

function parseRelativePeriod(
  question: string,
  reference: JstDateParts,
): QuestionPeriod | undefined {
  const compact = question.replace(/\s+/g, "");

  const numericRelativePatterns: Array<{
    pattern: RegExp;
    kind: "day" | "week";
    labelBuilder: (value: number) => string;
    rangeBuilder: (
      value: number,
      ref: JstDateParts,
    ) => { startDate: string; endDate: string };
  }> = [
    {
      pattern: /(?:直近|過去|past|last)\s*(\d{1,3})\s*(?:日|day|days)/i,
      kind: "day",
      labelBuilder: (value) => `直近${value}日`,
      rangeBuilder: (value, ref) => {
        const endDate = toYmd(ref);
        const start = shiftYmd(ref, -(value - 1));
        return { startDate: start, endDate };
      },
    },
    {
      pattern: /(?:直近|過去|past|last)\s*(\d{1,3})\s*(?:週間|週|week|weeks)/i,
      kind: "week",
      labelBuilder: (value) => `直近${value}週間`,
      rangeBuilder: (value, ref) => {
        const endDate = toYmd(ref);
        const start = shiftYmd(ref, -(value * 7 - 1));
        return { startDate: start, endDate };
      },
    },
  ];

  for (const candidate of numericRelativePatterns) {
    const match = compact.match(candidate.pattern);
    if (!match?.[1]) {
      continue;
    }

    const value = Number.parseInt(match[1], 10);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    const { startDate, endDate } = candidate.rangeBuilder(value, reference);
    return {
      kind: "relative",
      label: candidate.labelBuilder(value),
      startDate,
      endDate,
      raw: match[0],
      warnings: [],
    };
  }

  const keywordPatterns: Array<{
    pattern: RegExp;
    label: string;
    range: (ref: JstDateParts) => { startDate: string; endDate: string };
  }> = [
    {
      pattern: /^(?:今週|thisweek)$/i,
      label: "今週",
      range: (ref) => {
        const start = toYmd(startOfWeek(ref));
        return { startDate: start, endDate: toYmd(ref) };
      },
    },
    {
      pattern: /^(?:先週|lastweek)$/i,
      label: "先週",
      range: (ref) => {
        const currentWeekStart = startOfWeek(ref);
        const start = shiftYmd(currentWeekStart, -7);
        const end = shiftYmd(currentWeekStart, -1);
        return { startDate: start, endDate: end };
      },
    },
    {
      pattern: /^(?:今月|thismonth)$/i,
      label: "今月",
      range: (ref) => {
        const start = `${ref.year.toString().padStart(4, "0")}-${ref.month.toString().padStart(2, "0")}-01`;
        return { startDate: start, endDate: toYmd(ref) };
      },
    },
    {
      pattern: /^(?:先月|lastmonth)$/i,
      label: "先月",
      range: (ref) => {
        const prevMonth = shiftMonth(ref, -1);
        const start = `${prevMonth.year.toString().padStart(4, "0")}-${prevMonth.month.toString().padStart(2, "0")}-01`;
        const end = endOfMonth(prevMonth);
        return { startDate: start, endDate: end };
      },
    },
    {
      pattern: /^(?:今年|thisyear)$/i,
      label: "今年",
      range: (ref) => {
        const start = `${ref.year.toString().padStart(4, "0")}-01-01`;
        return { startDate: start, endDate: toYmd(ref) };
      },
    },
    {
      pattern: /^(?:昨年|去年|lastyear)$/i,
      label: "昨年",
      range: (ref) => {
        const prevYear = ref.year - 1;
        const start = `${prevYear.toString().padStart(4, "0")}-01-01`;
        const end = `${prevYear.toString().padStart(4, "0")}-12-31`;
        return { startDate: start, endDate: end };
      },
    },
  ];

  for (const candidate of keywordPatterns) {
    if (!candidate.pattern.test(compact)) {
      continue;
    }

    const { startDate, endDate } = candidate.range(reference);
    return {
      kind: "relative",
      label: candidate.label,
      startDate,
      endDate,
      raw: compact.match(candidate.pattern)?.[0] ?? candidate.label,
      warnings: [],
    };
  }

  return undefined;
}

function parseDatePeriod(
  question: string,
  reference: JstDateParts,
  kind: "year" | "month" | "day",
): QuestionPeriod | undefined {
  const orderedCandidates =
    kind === "day"
      ? [
          /\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/,
          /(20\d{2})年(\d{1,2})月(\d{1,2})日/,
          /(20\d{2})年(\d{1,2})月(\d{1,2})/,
          /(20\d{2})\/(\d{1,2})\/(\d{1,2})/,
        ]
      : kind === "month"
        ? [
            /\b(20\d{2})[\/\-](\d{1,2})\b/,
            /(20\d{2})年(\d{1,2})月/,
            /(20\d{2})\/(\d{1,2})/,
          ]
        : [/(20\d{2})年/, /\b(20\d{2})\b/];

  for (const pattern of orderedCandidates) {
    const match = question.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const year = Number.parseInt(match[1], 10);
    if (!Number.isFinite(year)) {
      continue;
    }

    if (kind === "day") {
      const month = Number.parseInt(match[2] ?? "", 10);
      const day = Number.parseInt(match[3] ?? "", 10);
      if (
        !Number.isFinite(month) ||
        !Number.isFinite(day) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31
      ) {
        continue;
      }

      const startDate = toYmd({ year, month, day });
      return {
        kind: "day",
        label: `${year}年${month}月${day}日`,
        startDate,
        endDate: startDate,
        raw: match[0],
        warnings: [],
      };
    }

    if (kind === "month") {
      const month = Number.parseInt(match[2] ?? "", 10);
      if (!Number.isFinite(month) || month < 1 || month > 12) {
        continue;
      }

      const startDate = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-01`;
      const endDate = endOfMonth({ year, month, day: 1 });
      return {
        kind: "month",
        label: `${year}年${month}月`,
        startDate,
        endDate,
        raw: match[0],
        warnings: [],
      };
    }

    const startDate = `${year.toString().padStart(4, "0")}-01-01`;
    const endDate = `${year.toString().padStart(4, "0")}-12-31`;
    return {
      kind: "year",
      label: `${year}年`,
      startDate,
      endDate,
      raw: match[0],
      warnings: [],
    };
  }

  return undefined;
}

type JstDateParts = {
  year: number;
  month: number;
  day: number;
};

function parseDateExpression(
  value: string,
  fallback: JstDateParts,
): JstDateParts | undefined {
  const compact = value.trim();
  const dateMatch =
    compact.match(/^(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})$/) ??
    compact.match(/^(20\d{2})年(\d{1,2})月(\d{1,2})日?$/) ??
    compact.match(/^(20\d{2})[\/\-](\d{1,2})$/) ??
    compact.match(/^(20\d{2})年(\d{1,2})月$/) ??
    compact.match(/^(20\d{2})年$/) ??
    compact.match(/^(\d{1,2})[\/\-](\d{1,2})日?$/) ??
    compact.match(/^(\d{1,2})月(\d{1,2})日?$/) ??
    compact.match(/^(\d{1,2})[\/\-](\d{1,2})$/) ??
    compact.match(/^(\d{1,2})月$/) ??
    compact.match(/^(\d{1,2})日$/);

  if (!dateMatch) {
    return undefined;
  }

  const year = Number.parseInt(dateMatch[1] ?? `${fallback.year}`, 10);
  const month = Number.parseInt(dateMatch[2] ?? `${fallback.month}`, 10);
  const day = Number.parseInt(dateMatch[3] ?? `${fallback.day}`, 10);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return undefined;
  }

  return { year, month, day };
}

function getJstDateParts(referenceDate: string | Date): JstDateParts {
  const date =
    referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  const shifted = new Date(date.getTime() + JST_OFFSET_MINUTES * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function startOfWeek(reference: JstDateParts): JstDateParts {
  const utc = toUtcDate(reference);
  const dayOfWeek = utc.getUTCDay();
  const delta = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return fromUtcDate(addDays(utc, delta));
}

function shiftYmd(reference: JstDateParts, deltaDays: number): string {
  return toYmd(fromUtcDate(addDays(toUtcDate(reference), deltaDays)));
}

function shiftMonth(
  reference: JstDateParts,
  deltaMonths: number,
): JstDateParts {
  const utc = toUtcDate({ ...reference, day: 1 });
  utc.setUTCMonth(utc.getUTCMonth() + deltaMonths);
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: 1,
  };
}

function endOfMonth(reference: JstDateParts): string {
  const utc = toUtcDate({ ...reference, day: 1 });
  utc.setUTCMonth(utc.getUTCMonth() + 1);
  utc.setUTCDate(0);
  return toYmd(fromUtcDate(utc));
}

function addDays(date: Date, deltaDays: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + deltaDays);
  return next;
}

function toUtcDate(parts: JstDateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function fromUtcDate(date: Date): JstDateParts {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function toYmd(parts: JstDateParts): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function formatDisplayDate(parts: JstDateParts): string {
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

function normalizeQuestion(question: string): string {
  return question.trim().replace(/\u3000/g, " ");
}
