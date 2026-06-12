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
    const tableauSubject = resolveTableauSubject(input.authenticatedUser);
    const fixedAnalyses: ActionRunAnalysisSection[] = [];

    for (const analysis of FIXED_ANALYSES) {
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
    }

    const warnings = fixedAnalyses.flatMap((section) => section.warnings ?? []);

    return {
      summary: buildSummary(input.request, fixedAnalyses),
      suggestedSlackPostText: buildSuggestedSlackPostText(
        input.request,
        fixedAnalyses,
      ),
      hashtags: buildHashtags(input.request),
      evidence: buildEvidenceLines(input.request, fixedAnalyses),
      checks: buildChecks(input.request),
      imageCaption: buildImageCaption(input.request, fixedAnalyses),
      analysisSections: fixedAnalyses,
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

function selectPrimaryInsight(
  additionalContext: TableauAdditionalContext,
): QueryDatasourceInsight | undefined {
  return additionalContext.queryInsights?.[0];
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
  const keyPoints = analysisSections
    .slice(0, 2)
    .flatMap((section) => section.rows.slice(0, 1).map((row) => row.label))
    .filter((label): label is string => Boolean(label));
  const keyPointText = keyPoints.length
    ? `The main signals are ${keyPoints.join(" / ")}.`
    : "The fixed Tableau MCP analysis framework was prepared.";

  return `${request.eventName} ${request.postType} draft prepared. ${keyPointText}`;
}

function buildSuggestedSlackPostText(
  request: ActionRunRequest,
  analysisSections: ActionRunAnalysisSection[],
): string {
  const topHighlights = analysisSections
    .flatMap((section) => section.rows.slice(0, 1))
    .map((row) => `${row.label}${row.value === null ? "" : ` (${row.value})`}`)
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);

  return [
    `${request.postType} | ${request.eventName}`,
    "",
    `Current status: ${request.currentSituation.trim()}.`,
    topHighlights.length
      ? `Tableau fixed analysis suggests ${topHighlights.join(" / ")}.`
      : "Tableau fixed analysis was prepared for the draft.",
    "",
    `More info: ${request.techplayUrl}`,
  ].join("\n");
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
    "Check for people or sensitive content before publishing.",
  ];
}

function buildImageCaption(
  request: ActionRunRequest,
  analysisSections: ActionRunAnalysisSection[],
): string {
  const topLabel =
    analysisSections.flatMap((section) => section.rows.slice(0, 1))[0]?.label ??
    "in progress";

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
