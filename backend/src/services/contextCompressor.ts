import type { ChatRequest } from "../types/chat";
import type {
  DatasourceFieldProfile,
  QueryDatasourceInsight,
  TableauAdditionalContext,
} from "../types/tableau";

const REDACTED_KEYS =
  /token|secret|password|jwt|authorization|credential|cookie/i;

export type CompressedDashboardContext = {
  dashboardName: string;
  workbookName: string;
  workbookId: string;
  viewName: string;
  viewId: string;
  worksheets: string[];
  filters: string[];
  parameters: string[];
  dataSources: string[];
  provider: TableauAdditionalContext["provider"];
  intent: string;
  answerableFromDashboardContext: boolean;
  needsMcp: boolean;
  workbookMetadata: string;
  additionalMetadata: string;
  mcpTools: string[];
  mcpToolResults: string[];
  mcpObservations: string[];
  datasourceFieldEvidence: string[];
  queryInsights: string[];
  warnings: string[];
};

export function compressDashboardContext(
  request: ChatRequest,
  additionalContext: TableauAdditionalContext,
): CompressedDashboardContext {
  const dashboardContext = request.dashboardContext;

  return {
    dashboardName: dashboardContext.dashboardName,
    workbookName:
      dashboardContext.workbookName ??
      extractName(additionalContext.workbook) ??
      "not available",
    workbookId: dashboardContext.workbookId ?? "not available",
    viewName: dashboardContext.viewName ?? "not available",
    viewId: dashboardContext.viewId ?? "not available",
    worksheets: dashboardContext.worksheets
      .map((worksheet) => worksheet.name)
      .filter(Boolean),
    filters: dashboardContext.filters.map((filter) => {
      const values = filter.appliedValues?.length
        ? filter.appliedValues.join(", ")
        : "not specified";
      return `${filter.worksheetName ? `${filter.worksheetName} / ` : ""}${filter.fieldName}: ${values}`;
    }),
    parameters: dashboardContext.parameters.map((parameter) => {
      const value = parameter.currentValue ?? "not specified";
      return `${parameter.name}: ${String(value)}`;
    }),
    dataSources: [
      ...extractAnswerDatasourceNames(
        dashboardContext.dataSources?.map((datasource) => datasource.name) ??
          [],
        additionalContext,
      ),
    ].filter(unique),
    provider: additionalContext.provider,
    intent: additionalContext.mcpExecutionDebug?.intent ?? "unknown",
    answerableFromDashboardContext:
      additionalContext.mcpExecutionDebug?.answerableFromDashboardContext ??
      false,
    needsMcp: additionalContext.mcpExecutionDebug?.needsMcp ?? false,
    workbookMetadata: safeJsonSnippet(additionalContext.workbook, 1600),
    additionalMetadata: safeJsonSnippet(additionalContext.metadata, 2400),
    mcpTools:
      additionalContext.mcpTools?.map((tool) => tool.name).slice(0, 20) ?? [],
    mcpToolResults:
      additionalContext.mcpToolResults?.map((result) => {
        const prefix = `${result.toolName}: ${result.status}`;
        return result.summary
          ? `${prefix} - ${result.summary}`
          : result.warning
            ? `${prefix} - ${result.warning}`
            : prefix;
      }) ?? [],
    mcpObservations:
      additionalContext.mcpObservations?.map((observation) => {
        const status = observation.success ? "success" : "failed";
        const reason =
          observation.resultSummary || observation.errorMessage || "no details";
        return `${observation.tool} (${status}) purpose=${observation.purpose}; ${reason}`.slice(
          0,
          420,
        );
      }) ?? [],
    datasourceFieldEvidence: renderDatasourceFieldEvidence(
      additionalContext.datasourceFieldProfiles ?? [],
    ),
    queryInsights: renderQueryInsights(additionalContext.queryInsights ?? []),
    warnings: additionalContext.warnings ?? [],
  };
}

export function renderCompressedContext(
  context: CompressedDashboardContext,
): string {
  return [
    `Dashboard: ${context.dashboardName}`,
    `Workbook: ${context.workbookName}`,
    `Workbook ID: ${context.workbookId}`,
    `View Name: ${context.viewName}`,
    `View ID: ${context.viewId}`,
    `Worksheets: ${context.worksheets.join(", ") || "none"}`,
    `Filters: ${context.filters.join("; ") || "none"}`,
    `Parameters: ${context.parameters.join("; ") || "none"}`,
    `Data sources: ${context.dataSources.join(", ") || "not available"}`,
    `Additional context provider: ${context.provider}`,
    `Question intent: ${context.intent}`,
    `Answerable from dashboard context: ${String(context.answerableFromDashboardContext)}`,
    `Needs MCP: ${String(context.needsMcp)}`,
    `Workbook metadata: ${context.workbookMetadata || "not available"}`,
    `Additional metadata: ${context.additionalMetadata || "not available"}`,
    `MCP tools: ${context.mcpTools.join(", ") || "not available"}`,
    `MCP tool results: ${context.mcpToolResults.join("\n") || "not available"}`,
    `MCP observations: ${context.mcpObservations.join("\n") || "not available"}`,
    `Datasource field evidence: ${context.datasourceFieldEvidence.join("\n") || "not available"}`,
    `Query insights: ${context.queryInsights.join("\n") || "not available"}`,
    `Warnings: ${context.warnings.join("; ") || "none"}`,
  ].join("\n");
}

export function safeJsonSnippet(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) {
    return "";
  }

  const text = JSON.stringify(redact(value));
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      REDACTED_KEYS.test(key) ? "[REDACTED]" : redact(child),
    ]),
  );
}

function extractName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function extractAnswerDatasourceNames(
  dashboardDatasourceNames: string[],
  additionalContext: TableauAdditionalContext,
): string[] {
  if (additionalContext.normalizedContext?.datasources?.length) {
    return additionalContext.normalizedContext.datasources
      .map((datasource) => datasource.name.trim())
      .filter(Boolean);
  }
  return dashboardDatasourceNames.map((name) => name.trim()).filter(Boolean);
}

function unique(value: string, index: number, values: string[]): boolean {
  return value.trim().length > 0 && values.indexOf(value) === index;
}

function renderDatasourceFieldEvidence(
  profiles: DatasourceFieldProfile[],
): string[] {
  return profiles.slice(0, 5).map((profile) => {
    const topFields = profile.fieldNames.slice(0, 40).join(", ");
    const suffix = profile.fieldNames.length > 40 ? ", ..." : "";
    return `${profile.datasourceName} fields (${profile.fieldCount}): ${topFields}${suffix}`;
  });
}

function renderQueryInsights(insights: QueryDatasourceInsight[]): string[] {
  return insights.slice(0, 3).map((insight) => {
    const preview = insight.rows
      .slice(0, 5)
      .map((row) => `${row.label ?? "(value)"}=${row.value ?? "null"}`)
      .join(", ");
    return `${insight.datasourceName} ${insight.metricField}${insight.dimensionField ? ` by ${insight.dimensionField}` : ""}: ${preview}`;
  });
}
