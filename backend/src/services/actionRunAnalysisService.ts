import { getConfig } from "../config";
import { DirectTableauApiContextProvider } from "../tableau/directTableauApiContextProvider";
import { MockTableauContextProvider } from "../tableau/mockTableauContextProvider";
import { TableauMcpContextProvider } from "../tableau/tableauMcpContextProvider";
import type { TableauContextProvider } from "../tableau/contextProvider";
import type { AuthenticatedUser } from "../types/auth";
import type {
  ActionRunAnalysisSection,
  ActionRunRequest,
  ActionRunResult,
} from "../types/actionRun";
import type {
  QueryDatasourceInsight,
  TableauAdditionalContext,
} from "../types/tableau";

type FixedAnalysis = {
  key: ActionRunAnalysisSection["key"];
  title: string;
  question: string;
  leadIn: string;
};

const FIXED_ANALYSES: FixedAnalysis[] = [
  {
    key: "post_type_distribution",
    title: "Post type distribution",
    question:
      "For this X post dataset, show the top 5 post types by post count.",
    leadIn: "Checked post type counts.",
  },
  {
    key: "keyword_tendency",
    title: "Keyword and hashtag tendency",
    question:
      "For this X post dataset, show the top 10 keywords or hashtags by post count.",
    leadIn: "Checked frequent keywords and hashtags.",
  },
  {
    key: "weekday_time_tendency",
    title: "Weekday and time tendency",
    question:
      "For this X post dataset, check the distribution by weekday and by time band.",
    leadIn: "Checked weekday and time-band bias.",
  },
  {
    key: "image_presence_tendency",
    title: "Image presence tendency",
    question:
      "For this X post dataset, compare post counts with images and without images.",
    leadIn: "Checked image-vs-no-image trend.",
  },
];

export class ActionRunAnalysisService {
  constructor(
    private readonly tableauContextProvider = createTableauContextProvider(),
  ) {}

  async analyzeActionRun(input: {
    request: ActionRunRequest;
    authenticatedUser?: AuthenticatedUser;
  }): Promise<ActionRunResult> {
    const demoMode = getConfig().demoMode;
    const tableauSubject = resolveTableauSubject(input.authenticatedUser);
    const fixedAnalyses: ActionRunAnalysisSection[] = [];

    for (const analysis of FIXED_ANALYSES) {
      if (demoMode) {
        fixedAnalyses.push(buildDemoAnalysisSection(analysis));
        continue;
      }

      try {
        const additionalContext =
          await this.tableauContextProvider.getAdditionalContext({
            question: analysis.question,
            planningQuestion: analysis.question,
            dashboardContext: input.request.dashboardContext,
            authenticatedUser: input.authenticatedUser,
            tableauSubject,
          });

        fixedAnalyses.push(
          buildAnalysisSection({
            analysis,
            additionalContext,
          }),
        );
      } catch (error) {
        fixedAnalyses.push(
          buildFallbackAnalysisSection({
            analysis,
            error,
          }),
        );
      }
    }

    const warnings = fixedAnalyses.flatMap((section) => section.warnings ?? []);
    const qualityReview = evaluateSuggestedSlackPostQuality({
      request: input.request,
      analysisSections: fixedAnalyses,
      suggestedSlackPostText: buildSuggestedSlackPostText(
        input.request,
        fixedAnalyses,
      ),
    });
    const suggestedSlackPostText = qualityReview.finalText;

    return {
      summary: buildSummary(input.request, fixedAnalyses),
      suggestedSlackPostText,
      hashtags: buildHashtags(input.request),
      evidence: buildEvidenceLines(input.request, fixedAnalyses),
      checks: buildChecks(input.request),
      imageCaption: buildImageCaption(input.request, fixedAnalyses),
      analysisSections: fixedAnalyses,
      safetyReview: buildSafetyReview({
        request: input.request,
        warnings,
      }),
      debug: {
        source: "stub",
        requestEcho: {
          postType: input.request.postType,
          eventName: input.request.eventName,
          techplayUrl: input.request.techplayUrl,
          currentSituation: input.request.currentSituation,
        },
        tableau: {
          provider: this.tableauContextProvider.name,
          analysisQuestions: FIXED_ANALYSES.map(
            (analysis) => analysis.question,
          ),
          warnings,
          qualityReview: {
            score: qualityReview.score,
            issues: qualityReview.issues,
            signals: qualityReview.signals,
            draftLength: qualityReview.originalLength,
            refinedLength: qualityReview.finalLength,
          },
        },
      },
    };
  }
}

function createTableauContextProvider(): TableauContextProvider {
  switch (getConfig().tableau.contextProvider) {
    case "direct-api":
      return new DirectTableauApiContextProvider();
    case "mcp":
      return new TableauMcpContextProvider();
    case "mock":
    default:
      return new MockTableauContextProvider();
  }
}

function resolveTableauSubject(
  authenticatedUser?: AuthenticatedUser,
): string | undefined {
  const config = getConfig();
  return (
    authenticatedUser?.tableauSubject ??
    (config.tableau.defaultSubject || undefined)
  );
}

function buildAnalysisSection(input: {
  analysis: FixedAnalysis;
  additionalContext: TableauAdditionalContext;
}): ActionRunAnalysisSection {
  const insight = selectPrimaryInsight(input.additionalContext);
  const rows = insight?.rows ?? [];
  const topRows = rows.slice(0, 5).map((row) => ({
    label: row.label?.trim() || "(label unavailable)",
    value: row.value,
  }));
  const warnings = [
    ...(input.additionalContext.warnings ?? []),
    ...(insight?.queryDebug?.errorPreview
      ? [insight.queryDebug.errorPreview]
      : []),
  ].filter((value): value is string => Boolean(value));

  return {
    key: input.analysis.key,
    title: input.analysis.title,
    question: input.analysis.question,
    summary: buildSectionSummary({
      leadIn: input.analysis.leadIn,
      insight,
      topRows,
      warnings,
    }),
    rows: topRows,
    datasourceName: insight?.datasourceName,
    dimensionField: insight?.dimensionField,
    metricField: insight?.metricField,
    ...(warnings.length ? { warnings } : {}),
  };
}

function buildDemoAnalysisSection(
  analysis: FixedAnalysis,
): ActionRunAnalysisSection {
  return buildFallbackAnalysisSection({
    analysis,
    error: new Error("Demo mode fixed analysis was used."),
  });
}

function buildFallbackAnalysisSection(input: {
  analysis: FixedAnalysis;
  error: unknown;
}): ActionRunAnalysisSection {
  const warning =
    input.error instanceof Error
      ? input.error.message
      : "Tableau fallback analysis was used.";

  return {
    key: input.analysis.key,
    title: input.analysis.title,
    question: input.analysis.question,
    summary: `${input.analysis.leadIn} Demo fallback analysis was used because Tableau MCP results were unavailable.`,
    rows: buildFallbackRows(input.analysis.key),
    warnings: [warning],
  };
}

function selectPrimaryInsight(
  additionalContext: TableauAdditionalContext,
): QueryDatasourceInsight | undefined {
  return additionalContext.queryInsights?.[0];
}

function buildFallbackRows(
  key: ActionRunAnalysisSection["key"],
): Array<{ label: string; value: number | null }> {
  switch (key) {
    case "post_type_distribution":
      return [
        { label: "事前告知", value: 12 },
        { label: "開催中", value: 9 },
        { label: "お礼", value: 6 },
      ];
    case "keyword_tendency":
      return [
        { label: "#Tableau", value: 14 },
        { label: "#TechPlay", value: 11 },
        { label: "#Community", value: 8 },
      ];
    case "weekday_time_tendency":
      return [
        { label: "土曜 10時台", value: 10 },
        { label: "平日 19時台", value: 8 },
        { label: "日曜 14時台", value: 5 },
      ];
    case "image_presence_tendency":
      return [
        { label: "画像あり", value: 13 },
        { label: "画像なし", value: 7 },
      ];
  }
}

function buildSectionSummary(input: {
  leadIn: string;
  insight: QueryDatasourceInsight | undefined;
  topRows: Array<{ label: string; value: number | null }>;
  warnings: string[];
}): string {
  if (!input.insight) {
    return `${input.leadIn} Tableau MCP results were not available.`;
  }

  if (!input.topRows.length) {
    return `${input.leadIn} No row data was returned, so the trend is inconclusive.`;
  }

  const firstRow = input.topRows[0];
  const valueText =
    firstRow.value === null
      ? "count unavailable"
      : `${firstRow.value.toLocaleString()} posts`;
  const warningText = input.warnings.length
    ? " Some warnings were returned."
    : "";

  return `${input.leadIn} The top item was "${firstRow.label}" with ${valueText}.${warningText}`.trim();
}

function buildSummary(
  request: ActionRunRequest,
  analysisSections: ActionRunAnalysisSection[],
): string {
  const keyPointText = buildTableauSignalSummary(analysisSections);

  return `${request.eventName} ${request.postType} draft prepared. ${keyPointText}`;
}

function buildSuggestedSlackPostText(
  request: ActionRunRequest,
  analysisSections: ActionRunAnalysisSection[],
): string {
  const topHighlights = collectTableauSignals(analysisSections).slice(0, 3);
  const currentSituation = normalizeSentenceFragment(request.currentSituation);
  const postTypeAngle = buildPostTypeAngle(request.postType);

  return [
    `${request.postType} | ${request.eventName}`,
    "",
    `Current status: ${currentSituation}.`,
    topHighlights.length
      ? `Tableau signals: ${topHighlights.join(" / ")}.`
      : "Tableau signals: fixed analysis was prepared for the draft.",
    `Action angle: ${postTypeAngle}.`,
    "",
    `More info: ${request.techplayUrl}`,
  ].join("\n");
}

function evaluateSuggestedSlackPostQuality(input: {
  request: ActionRunRequest;
  analysisSections: ActionRunAnalysisSection[];
  suggestedSlackPostText: string;
}): {
  finalText: string;
  score: number;
  issues: string[];
  signals: string[];
  originalLength: number;
  finalLength: number;
} {
  const originalText = input.suggestedSlackPostText;
  const signals = collectTableauSignals(input.analysisSections);
  const normalizedLines = originalText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => Boolean(line));
  const dedupedLines: string[] = [];
  const seen = new Set<string>();
  for (const line of normalizedLines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedupedLines.push(line);
  }

  const cleanedSignals = Array.from(
    new Set(signals.map((signal) => signal.replace(/\s+/gu, " ").trim())),
  ).filter((signal) => Boolean(signal));
  const revisedText = [
    `${input.request.postType} | ${input.request.eventName}`,
    "",
    `Current status: ${normalizeSentenceFragment(input.request.currentSituation)}.`,
    cleanedSignals.length
      ? `Tableau signals: ${cleanedSignals.slice(0, 3).join(" / ")}.`
      : "Tableau signals: fixed analysis was prepared for the draft.",
    `Action angle: ${buildPostTypeAngle(input.request.postType)}.`,
    "",
    `More info: ${input.request.techplayUrl}`,
  ]
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n");

  const issues: string[] = [];
  if (dedupedLines.length !== normalizedLines.length) {
    issues.push("Duplicate lines were removed from the draft.");
  }
  if (cleanedSignals.length === 0) {
    issues.push("No Tableau signals were available for the draft.");
  }
  if (revisedText.length > 420) {
    issues.push("Draft length is still long for Slack and should be reviewed.");
  }

  const score = clampScore(
    45 +
      Math.min(cleanedSignals.length, 3) * 15 -
      (dedupedLines.length !== normalizedLines.length ? 10 : 0) -
      (revisedText.length > 420 ? 10 : 0),
  );

  return {
    finalText: revisedText,
    score,
    issues,
    signals: cleanedSignals,
    originalLength: originalText.length,
    finalLength: revisedText.length,
  };
}

function buildHashtags(request: ActionRunRequest): string[] {
  const hashtags = new Set<string>(["#Tableau", "#TechPlay"]);
  for (const token of request.eventName.split(/\s+/u)) {
    const cleaned = token.replace(/[^A-Za-z0-9]/g, "").trim();
    if (cleaned.length >= 2) {
      hashtags.add(`#${cleaned}`);
    }
  }
  return [...hashtags].slice(0, 5);
}

function buildChecks(request: ActionRunRequest): string[] {
  return [
    "Confirm the event name and TechPlay URL match.",
    "Confirm the current situation matches the venue reality.",
    `Confirm the requested post type "${request.postType}" is appropriate.`,
    "Check for faces, badges, name tags, and sensitive content before publishing.",
    "If a photo is attached, strip EXIF metadata before posting.",
  ];
}

function buildSafetyReview(input: {
  request: ActionRunRequest;
  warnings: string[];
}): NonNullable<ActionRunResult["safetyReview"]> {
  const notes = [
    "Human approval is required before any Slack post is sent.",
    "Review any uploaded photo for faces, badges, slides, and screens before posting.",
    "Strip EXIF metadata from any uploaded photo before reuse.",
    ...input.warnings.map((warning) => `Tableau warning: ${warning}`),
  ];

  return {
    status: "pending_manual_review",
    required: true,
    checklist: buildChecks(input.request),
    notes,
  };
}

function buildImageCaption(
  request: ActionRunRequest,
  analysisSections: ActionRunAnalysisSection[],
): string {
  const topLabel = collectTableauSignals(analysisSections)[0] ?? "in progress";

  return `${request.eventName} ${request.postType} image draft. Emphasize ${topLabel}.`;
}

function buildEvidenceLines(
  request: ActionRunRequest,
  fixedAnalyses: ActionRunAnalysisSection[],
): string[] {
  return [
    `Event name: ${request.eventName}`,
    `Current situation: ${request.currentSituation}`,
    ...fixedAnalyses.map((section) => `${section.title}: ${section.summary}`),
  ];
}

function collectTableauSignals(
  analysisSections: ActionRunAnalysisSection[],
): string[] {
  return analysisSections
    .map((section) => {
      const firstRow = section.rows[0];
      const label = firstRow?.label?.trim() || section.title;
      const value =
        firstRow?.value === undefined
          ? null
          : firstRow?.value === null
            ? null
            : firstRow.value;
      const valueText =
        value === null
          ? "count unavailable"
          : `${value.toLocaleString()} posts`;
      return `${section.title}: ${label} (${valueText})`;
    })
    .filter((signal) => Boolean(signal));
}

function buildTableauSignalSummary(
  analysisSections: ActionRunAnalysisSection[],
): string {
  const signals = collectTableauSignals(analysisSections).slice(0, 2);
  if (!signals.length) {
    return "The fixed Tableau MCP analysis framework was prepared.";
  }

  return `The main Tableau signals are ${signals.join(" / ")}.`;
}

function buildPostTypeAngle(postType: ActionRunRequest["postType"]): string {
  switch (postType) {
    case "\u958b\u50ac\u76f4\u524d\u30ea\u30de\u30a4\u30f3\u30c9":
      return "remind people to head to the venue";
    case "\u958b\u50ac\u4e2d\u306e\u5b9f\u6cc1":
      return "share a live atmosphere update";
    case "\u958b\u50ac\u5f8c\u306e\u304a\u793c\u30fb\u30ec\u30dd\u30fc\u30c8":
      return "thank attendees and summarize the event";
    case "\u6b21\u56de\u53c2\u52a0\u306e\u547c\u3073\u304b\u3051":
      return "invite people to the next event";
    case "\u4e8b\u524d\u544a\u77e5":
    default:
      return "announce the upcoming event clearly";
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeSentenceFragment(text: string): string {
  return text.trim().replace(/[。．.]+$/u, "");
}
