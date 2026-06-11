import type { ChatHistoryRecord, ChatRequest } from "../types/chat";
import type {
  McpObservation,
  TableauAdditionalContext,
} from "../types/tableau";
import {
  compressDashboardContext,
  renderCompressedContext,
} from "./contextCompressor";

const MAX_HISTORY_QUESTION_CHARS = 300;
const MAX_HISTORY_ANSWER_CHARS = 700;

export type PromptBuildOptions = {
  agentPlanSummary?: string;
  investigationQuestion?: string;
  evaluationSummary?: string;
  evidenceGaps?: string[];
};

export function buildPrompt(
  request: ChatRequest,
  additionalContext: TableauAdditionalContext,
  recentHistory: ChatHistoryRecord[] = [],
  options: PromptBuildOptions = {},
): string {
  const compressedContext = compressDashboardContext(
    request,
    additionalContext,
  );
  const observationCount = additionalContext.mcpObservations?.length ?? 0;
  const observationDigest = summarizeMcpObservations(
    additionalContext.mcpObservations,
  );
  const executionDebug = additionalContext.mcpExecutionDebug;

  return [
    "You are a Tableau dashboard assistant.",
    "Answer directly to the user's question using dashboard context and MCP observations.",
    "Use evidence from the provided context. Do not make claims beyond obtained data.",
    "If information is missing, explain what is missing instead of guessing.",
    "Do not infer confidential row-level details that were not provided.",
    "Avoid generic Tableau theory unless the user explicitly asks how-to guidance.",
    "Do not provide long HTTP status explanations, internal stack-like diagnostics, or 'contact support' unless the user explicitly asks for troubleshooting steps.",
    "If MCP metadata lookup failed, explain what identifier or context was missing in plain user language.",
    "If MCP lookup failed before usable observations were collected, do not fabricate rankings, totals, or datasource-wide conclusions from the current dashboard scope.",
    "Do not ask the user to run MCP tools or CLI commands such as query-datasource. Describe what the app could not resolve instead.",
    "Never mention internal MCP tool names such as get-datasource-metadata, query-datasource, list-datasources, or search-content in the user-facing answer.",
    "Do not tell the user to execute internal MCP tools.",
    "If metadata is unavailable because an identifier is missing, explain that the application could not resolve the Tableau datasource identifier.",
    "Do not ask the user to provide datasource id unless the product explicitly supports manual id input.",
    "Do not ask the user to provide datasource ID when datasource names are already known from context.",
    "Do not confuse Tableau project names with datasource names.",
    "If datasource field evidence is present, list only those field names. Do not invent additional field names.",
    "If aggregated query results or ranking rows are present, answer with those results directly. Do not describe hypothetical SQL or execution steps.",
    options.agentPlanSummary ? `Agent plan: ${options.agentPlanSummary}` : "",
    options.investigationQuestion
      ? `Tool-planning question: ${options.investigationQuestion}`
      : "",
    options.evaluationSummary
      ? `Evidence evaluation: ${options.evaluationSummary}`
      : "",
    options.evidenceGaps?.length
      ? `Remaining evidence gaps: ${options.evidenceGaps.join("; ")}`
      : "",
    "If follow-up action is useful, suggest exactly one next check.",
    "When answering, clarify scope with phrases like 'In this dashboard context' or 'From retrieved Tableau Cloud information'.",
    observationCount
      ? "You received MCP observations. Prioritize them as evidence over assumptions."
      : additionalContext.mcpConnectionFailed
        ? "MCP lookup failed before usable observations were collected. Rely only on dashboard context, clearly mention the limitation, and avoid treating the current filter scope as evidence that the entire datasource is empty."
        : "No MCP observations were collected. Rely only on dashboard context and clearly mention limitations.",
    observationDigest ? `MCP evidence summary: ${observationDigest}` : "",
    "Respond in the same language as the user's question when practical.",
    executionDebug
      ? `Execution summary: intent=${executionDebug.intent}, needsMcp=${String(executionDebug.needsMcp)}, toolCalls=${executionDebug.toolCallCount}, replanUsed=${String(executionDebug.replanUsed)}`
      : "",
    recentHistory.length
      ? [
          "Recent conversation in the same authenticated session:",
          ...recentHistory.flatMap((record, index) => [
            `Turn ${index + 1} user: ${truncateText(record.question, MAX_HISTORY_QUESTION_CHARS)}`,
            `Turn ${index + 1} assistant: ${truncateText(record.answer, MAX_HISTORY_ANSWER_CHARS)}`,
          ]),
          "Use the recent conversation only when it is relevant to the current question.",
        ].join("\n")
      : "",
    `Question: ${request.question}`,
    "Context:",
    renderCompressedContext(compressedContext),
  ].join("\n");
}

function summarizeMcpObservations(
  observations: McpObservation[] | undefined,
): string | undefined {
  if (!observations?.length) {
    return undefined;
  }

  return observations
    .slice(-4)
    .map((observation) => {
      const status = observation.success ? "ok" : "fail";
      const summary =
        observation.resultSummary ||
        observation.errorMessage ||
        observation.rawResultPreview ||
        "no-summary";
      return `${observation.tool}:${status}:${truncateText(summary, 80)}`;
    })
    .join(" | ");
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars).trimEnd()}...`;
}
