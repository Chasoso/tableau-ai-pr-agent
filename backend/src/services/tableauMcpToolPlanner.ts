import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { getConfig } from "../config";
import { logError, logInfo, logWarn, safeErrorDetails } from "../logging";
import type {
  DashboardContext,
  QuestionInterpretation,
  QuestionIntent,
  QuestionRequestType,
} from "../types/tableau";

export type PlannerToolFilterMode = "strict" | "soft" | "off";
export type PlannerIntentClassifierMode = "heuristic" | "hybrid";
export type PlannerArgumentSanitizeMode = "drop" | "mask";

export type McpToolForPlanning = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export type PlannedMcpToolCall = {
  toolName: string;
  arguments?: Record<string, unknown>;
  purpose?: string;
  reason?: string;
  dependsOnTool?: string;
};

export type IntentPolicy = {
  maxToolCalls: number;
  needsMcp: boolean;
  answerableFromDashboardContext: boolean;
};

export const QUESTION_INTENT_POLICY: Record<QuestionIntent, IntentPolicy> = {
  dashboard_explanation: {
    maxToolCalls: 3,
    needsMcp: false,
    answerableFromDashboardContext: true,
  },
  filter_or_selection_state: {
    maxToolCalls: 3,
    needsMcp: false,
    answerableFromDashboardContext: true,
  },
  metadata_lookup: {
    maxToolCalls: 5,
    needsMcp: true,
    answerableFromDashboardContext: false,
  },
  data_analysis: {
    maxToolCalls: 8,
    needsMcp: true,
    answerableFromDashboardContext: false,
  },
  content_search: {
    maxToolCalls: 5,
    needsMcp: true,
    answerableFromDashboardContext: false,
  },
  how_to_use_tableau: {
    maxToolCalls: 2,
    needsMcp: false,
    answerableFromDashboardContext: true,
  },
  unsupported: {
    maxToolCalls: 0,
    needsMcp: false,
    answerableFromDashboardContext: false,
  },
};

export type ClassifiedQuestionIntent = {
  intent: QuestionIntent;
  confidence: number;
  reasonBrief: string;
  answerableFromDashboardContext: boolean;
  needsMcp: boolean;
  maxToolCalls: number;
};

export type McpToolPlan = {
  intent: QuestionIntent;
  confidence: number;
  answerableFromDashboardContext: boolean;
  needsMcp: boolean;
  reasonBrief: string;
  maxToolCalls: number;
  toolCalls: PlannedMcpToolCall[];
};

export type McpToolPlannerInput = {
  question: string;
  dashboardContext: DashboardContext;
  tools: McpToolForPlanning[];
  maxToolCalls: number;
  allowedToolNames: string[];
  observations?: Array<{
    toolName: string;
    status: string;
    summary?: string;
    warning?: string;
  }>;
  previouslyCalledToolNames?: string[];
  intentHint?: ClassifiedQuestionIntent;
};

const PREFERRED_TOOL_NAMES_FOR_INTENT: Record<QuestionIntent, string[]> = {
  dashboard_explanation: ["list-workbooks", "get-workbook", "list-views"],
  filter_or_selection_state: ["list-views", "get-workbook"],
  metadata_lookup: [
    "list-datasources",
    "get-datasource-metadata",
    "list-views",
    "get-workbook",
  ],
  data_analysis: [
    "list-datasources",
    "get-datasource-metadata",
    "query-datasource",
    "list-views",
  ],
  content_search: [
    "search-content",
    "list-workbooks",
    "list-views",
    "list-datasources",
  ],
  how_to_use_tableau: [],
  unsupported: [],
};

type ArgumentSanitizeOptions = {
  mode: PlannerArgumentSanitizeMode;
  maxDepth: number;
  maxArrayLength: number;
  maxObjectKeys: number;
};

function getArgumentSanitizeOptionsFromConfig(): ArgumentSanitizeOptions {
  const mcpConfig = getConfig().tableau.mcp;
  return {
    mode: mcpConfig.argSanitizeMode,
    maxDepth: Math.max(1, mcpConfig.argMaxDepth),
    maxArrayLength: Math.max(1, mcpConfig.argMaxArrayLength),
    maxObjectKeys: Math.max(1, mcpConfig.argMaxObjectKeys),
  };
}

export function filterAllowedToolNamesByIntent(
  allowedToolNames: string[],
  intent: QuestionIntent,
  mode: PlannerToolFilterMode,
): string[] {
  if (mode !== "strict") {
    return [...allowedToolNames];
  }

  const preferred = PREFERRED_TOOL_NAMES_FOR_INTENT[intent];
  if (!preferred.length) {
    return [...allowedToolNames];
  }

  return allowedToolNames.filter((toolName) => preferred.includes(toolName));
}

export class TableauMcpToolPlanner {
  constructor(
    private readonly client = new BedrockRuntimeClient({
      region: getConfig().model.bedrock.region,
    }),
  ) {}

  async plan(input: McpToolPlannerInput): Promise<McpToolPlan | undefined> {
    const config = getConfig();
    const mcpConfig = config.tableau.mcp;
    const intentClassifierMode = mcpConfig.intentClassifierMode;
    const hasConfiguredAllowlist = input.allowedToolNames.length > 0;
    const effectiveIntentToolFilterMode: PlannerToolFilterMode =
      hasConfiguredAllowlist ? mcpConfig.intentToolFilterMode : "off";

    if (!mcpConfig.toolPlanningEnabled) {
      return undefined;
    }

    if (config.model.provider !== "bedrock") {
      logWarn("tableau.mcp.tool_planner.skipped", {
        reason: "MODEL_PROVIDER is not bedrock.",
      });
      return undefined;
    }

    const intent =
      input.intentHint ??
      classifyQuestionIntent(
        input.question,
        input.dashboardContext,
        input.allowedToolNames,
      );
    if (!intent.needsMcp || intent.maxToolCalls <= 0) {
      logInfo("tableau.mcp.tool_planner.skipped", {
        reason: "Intent indicates MCP is unnecessary.",
        intent: intent.intent,
      });
      return {
        intent: intent.intent,
        confidence: intent.confidence,
        answerableFromDashboardContext: intent.answerableFromDashboardContext,
        needsMcp: false,
        reasonBrief: intent.reasonBrief,
        maxToolCalls: 0,
        toolCalls: [],
      };
    }

    const baseAllowedToolNames = resolveAllowedToolNames(
      input.tools,
      input.allowedToolNames,
    );
    const allowedToolNames = filterAllowedToolNamesByIntent(
      baseAllowedToolNames,
      intent.intent,
      effectiveIntentToolFilterMode,
    );
    const maxToolCalls = Math.max(
      0,
      Math.min(input.maxToolCalls, intent.maxToolCalls),
    );
    const preferredToolNames = PREFERRED_TOOL_NAMES_FOR_INTENT[
      intent.intent
    ].filter((toolName) => baseAllowedToolNames.includes(toolName));
    const bedrockDebugEnabled = config.model.bedrock.debugLogPromptExchange;
    const bedrockDebugMaxChars = config.model.bedrock.debugMaxChars;
    const prompt = buildPlannerPrompt({
      ...input,
      maxToolCalls,
      allowedToolNames,
      intent,
      preferredToolNames,
      allowIntentReclassification: intentClassifierMode === "hybrid",
    });

    const startedAt = Date.now();
    try {
      logInfo("tableau.mcp.tool_planner.started", {
        modelId: config.model.bedrock.modelId,
        maxToolCalls,
        availableToolCount: input.tools.length,
        allowedToolCount: allowedToolNames.length,
        baseAllowedToolCount: baseAllowedToolNames.length,
        intentToolFilterMode: effectiveIntentToolFilterMode,
        intentClassifierMode,
        observationCount: input.observations?.length ?? 0,
        promptLength: prompt.length,
        intent: intent.intent,
        intentConfidence: intent.confidence,
      });
      if (bedrockDebugEnabled) {
        const promptSnapshot = clipForDebugLog(prompt, bedrockDebugMaxChars);
        logInfo("tableau.mcp.tool_planner.prompt_debug", {
          modelId: config.model.bedrock.modelId,
          promptLength: prompt.length,
          promptPreviewLength: promptSnapshot.text.length,
          promptPreviewTruncated: promptSnapshot.truncated,
          promptPreview: promptSnapshot.text,
        });
      }

      const response = await this.client.send(
        new ConverseCommand({
          modelId: config.model.bedrock.modelId,
          messages: [
            {
              role: "user",
              content: [{ text: prompt }],
            },
          ],
          inferenceConfig: {
            maxTokens: mcpConfig.plannerMaxOutputTokens,
            temperature: 0,
          },
        }),
      );

      const text =
        response.output?.message?.content
          ?.map((content) => ("text" in content ? content.text : ""))
          .filter(Boolean)
          .join("\n")
          .trim() ?? "";
      if (bedrockDebugEnabled) {
        const responseSnapshot = clipForDebugLog(text, bedrockDebugMaxChars);
        logInfo("tableau.mcp.tool_planner.response_debug", {
          modelId: config.model.bedrock.modelId,
          responseLength: text.length,
          responsePreviewLength: responseSnapshot.text.length,
          responsePreviewTruncated: responseSnapshot.truncated,
          responsePreview: responseSnapshot.text,
        });
      }
      const plan = parseToolPlanResponse(
        text,
        intent,
        getArgumentSanitizeOptionsFromConfig(),
      );

      if (!plan?.toolCalls.length) {
        logWarn("tableau.mcp.tool_planner.empty_plan", {
          responseLength: text.length,
          durationMs: Date.now() - startedAt,
        });
        return {
          intent: intent.intent,
          confidence: intent.confidence,
          answerableFromDashboardContext: intent.answerableFromDashboardContext,
          needsMcp: intent.needsMcp,
          reasonBrief: intent.reasonBrief,
          maxToolCalls,
          toolCalls: [],
        };
      }

      const filteredToolCalls = plan.toolCalls
        .filter((call) => allowedToolNames.includes(call.toolName))
        .slice(0, maxToolCalls);
      const blockedToolCount = Math.max(
        plan.toolCalls.length - filteredToolCalls.length,
        0,
      );
      const effectiveIntent =
        intentClassifierMode === "hybrid" ? plan.intent : intent.intent;
      const effectiveReasonBrief =
        intentClassifierMode === "hybrid"
          ? plan.reasonBrief
          : intent.reasonBrief;
      const effectiveConfidence =
        intentClassifierMode === "hybrid" ? plan.confidence : intent.confidence;
      const effectiveNeedsMcp =
        intentClassifierMode === "hybrid" ? plan.needsMcp : intent.needsMcp;
      const effectiveAnswerableFromContext =
        intentClassifierMode === "hybrid"
          ? plan.answerableFromDashboardContext
          : intent.answerableFromDashboardContext;

      logInfo("tableau.mcp.tool_planner.completed", {
        plannedToolCount: filteredToolCalls.length,
        plannedTools: filteredToolCalls.map((call) => call.toolName),
        blockedToolCount,
        durationMs: Date.now() - startedAt,
      });
      return {
        ...plan,
        intent: effectiveIntent,
        confidence: effectiveConfidence,
        answerableFromDashboardContext: effectiveAnswerableFromContext,
        needsMcp: effectiveNeedsMcp,
        reasonBrief: effectiveReasonBrief,
        maxToolCalls,
        toolCalls: filteredToolCalls,
      };
    } catch (error) {
      logError("tableau.mcp.tool_planner.failed", {
        ...safeErrorDetails(error),
        durationMs: Date.now() - startedAt,
      });
      return undefined;
    }
  }
}

export function classifyQuestionIntent(
  question: string,
  dashboardContext: DashboardContext,
  allowedToolNames: string[] = [],
  requestTypeHint?: QuestionRequestType,
  questionInterpretation?: Pick<
    QuestionInterpretation,
    "metricIntent" | "groupingIntent" | "analysisIntent" | "rankingTarget"
  >,
): ClassifiedQuestionIntent {
  const normalizedQuestion = question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const hasQuestionMark = /[?\uFF1F]/u.test(question);
  const containsAny = (keywords: string[]): boolean =>
    keywords.some((keyword) =>
      containsNormalizedPlannerKeyword(normalizedQuestion, keyword),
    );
  const interpretedMetricIntent =
    questionInterpretation?.metricIntent ?? "unknown";
  const interpretedGroupingIntent =
    questionInterpretation?.groupingIntent ?? "unknown";
  const interpretedAnalysisIntent =
    questionInterpretation?.analysisIntent ?? "unknown";
  const hasMetricAndGroupingIntent =
    interpretedMetricIntent !== "unknown" &&
    interpretedGroupingIntent !== "unknown";
  const hasAnalysisIntentHint =
    interpretedAnalysisIntent === "grouped_trend" || hasMetricAndGroupingIntent;
  const hasGroupedAnalysisKeywords = containsAny([
    "\u50be\u5411",
    "\u6d17\u3044\u51fa\u3057",
    "\u6bd4\u8f03",
    "\u30e9\u30f3\u30ad\u30f3\u30b0",
    "\u4e0a\u4f4d",
    "\u4e0b\u4f4d",
    "\u9ad8\u3044",
    "\u4f4e\u3044",
    "\u30cf\u30c3\u30b7\u30e5\u30bf\u30b0",
    "\u3054\u3068",
    "\u5225",
    "trend",
    "trends",
    "breakdown",
    "compare",
    "comparison",
    "ranking",
    "rank",
    "high",
    "higher",
    "low",
    "lower",
    "top",
    "bottom",
    "by",
    "each",
    "per",
    "every",
    "group",
    "grouped",
    "hashtag",
    "hash tag",
    "#",
  ]);

  if (requestTypeHint === "datasource_inventory") {
    const policy = QUESTION_INTENT_POLICY.dashboard_explanation;
    return {
      intent: "dashboard_explanation",
      confidence: 0.96,
      reasonBrief:
        "The question explicitly asks which datasources are used, so a lightweight dashboard-context answer should be preferred.",
      answerableFromDashboardContext: policy.answerableFromDashboardContext,
      needsMcp: false,
      maxToolCalls: 0,
    };
  }

  if (requestTypeHint === "field_inventory") {
    const policy = QUESTION_INTENT_POLICY.metadata_lookup;
    return {
      intent: "metadata_lookup",
      confidence: 0.96,
      reasonBrief:
        "The question explicitly asks for datasource fields or schema, so metadata lookup should run before any aggregate analysis.",
      answerableFromDashboardContext: policy.answerableFromDashboardContext,
      needsMcp: policy.needsMcp,
      maxToolCalls: policy.maxToolCalls,
    };
  }
  const hasHowToKeywords = containsAny([
    "how to",
    "how do i",
    "steps",
    "procedure",
    "\u4f7f\u3044\u65b9",
    "\u3084\u308a\u65b9",
    "\u65b9\u6cd5",
    "\u624b\u9806",
  ]);
  const hasFilterKeywords = containsAny([
    "filter",
    "filtered",
    "selection",
    "selected mark",
    "parameter",
    "where",
    "slice",
    "drill",
    "\u30d5\u30a3\u30eb\u30bf",
    "\u7d5e\u308a\u8fbc\u307f",
    "\u30d1\u30e9\u30e1\u30fc\u30bf",
  ]);
  const hasMetadataKeywords = containsAny([
    "field",
    "schema",
    "column",
    "metric definition",
    "datasource",
    "data source",
    "metadata",
    "workbook id",
    "view id",
    "\u30d5\u30a3\u30fc\u30eb\u30c9",
    "\u30b9\u30ad\u30fc\u30de",
    "\u30e1\u30bf\u30c7\u30fc\u30bf",
    "\u30c7\u30fc\u30bf\u30bd\u30fc\u30b9",
  ]);
  const hasAnalysisKeywords = containsAny([
    "sum",
    "average",
    "avg",
    "count",
    "countd",
    "rank",
    "ranking",
    "top",
    "bottom",
    "trend",
    "month",
    "week",
    "day",
    "compare",
    "increase",
    "decrease",
    "growth",
    "\u50be\u5411",
    "\u6d17\u3044\u51fa\u3057",
    "\u9ad8\u3044",
    "\u4f4e\u3044",
    "\u30cf\u30c3\u30b7\u30e5\u30bf\u30b0",
    "\u3054\u3068",
    "\u5225",
    "\u30e9\u30f3\u30ad\u30f3\u30b0",
    "\u63a8\u79fb",
    "\u96c6\u8a08",
    "\u6bd4\u8f03",
    "\u5897\u52a0",
    "\u6e1b\u5c11",
    "\u6210\u9577",
  ]);
  const hasStrongAnalysisKeywords = containsAny([
    "query",
    "aggregate",
    "max",
    "min",
    "highest",
    "lowest",
    "most",
    "least",
    "top",
    "bottom",
    "rank",
    "ranking",
    "compare",
    "sum",
    "average",
    "avg",
    "count",
    "countd",
    "trend",
    "increase",
    "decrease",
    "growth",
    "\u30af\u30a8\u30ea",
    "\u96c6\u8a08",
    "\u6700\u5927",
    "\u6700\u5c0f",
    "\u6700\u591a",
    "\u6700\u3082",
    "\u6bd4\u8f03",
    "\u50be\u5411",
    "\u6d17\u3044\u51fa\u3057",
    "\u30cf\u30c3\u30b7\u30e5\u30bf\u30b0",
    "\u3054\u3068",
    "\u5225",
  ]);
  const hasContentSearchKeywords = containsAny([
    "search",
    "find",
    "locate",
    "where is",
    "which workbook",
    "which view",
    "content",
    "asset",
    "\u691c\u7d22",
    "\u63a2\u3057\u3066",
    "\u3069\u3053",
  ]);
  const hasDashboardExplanationKeywords = containsAny([
    "what is this dashboard",
    "describe this dashboard",
    "overview",
    "summary",
    "\u3053\u306e\u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9",
    "\u6982\u8981",
    "\u8981\u7d04",
  ]);
  const asksForDatasourceInventory =
    containsAny([
      "\u4f7f\u308f\u308c\u3066\u3044\u308b\u30c7\u30fc\u30bf\u30bd\u30fc\u30b9",
      "\u4f7f\u7528\u3057\u3066\u3044\u308b\u30c7\u30fc\u30bf\u30bd\u30fc\u30b9",
      "\u30c7\u30fc\u30bf\u30bd\u30fc\u30b9\u3092\u6559\u3048\u3066",
      "which datasource",
      "which data source",
      "used datasource",
      "data source used",
    ]) &&
    !containsAny([
      "field",
      "schema",
      "column",
      "metadata",
      "\u30d5\u30a3\u30fc\u30eb\u30c9",
      "\u30b9\u30ad\u30fc\u30de",
      "\u30e1\u30bf\u30c7\u30fc\u30bf",
    ]);

  const knownDatasourceMentioned =
    dashboardContext.dataSources?.some((dataSource) =>
      normalizedQuestion.includes(
        dataSource.name.normalize("NFKC").toLowerCase(),
      ),
    ) ?? false;
  const hasRelativePeriodKeywords = containsAny([
    "\u5148\u9031",
    "\u4eca\u9031",
    "\u5148\u6708",
    "\u4eca\u6708",
    "\u6628\u5e74",
    "\u4eca\u5e74",
    "\u904e\u53bb",
    "month",
    "week",
    "day",
  ]);
  const hasSearchTool = allowedToolNames.includes("search-content");
  const hasQueryTool = allowedToolNames.includes("query-datasource");
  const hasAnalysisOrGroupingSignal =
    hasAnalysisKeywords ||
    hasStrongAnalysisKeywords ||
    hasGroupedAnalysisKeywords ||
    hasMetricAndGroupingIntent ||
    hasAnalysisIntentHint;
  const clueCount =
    Number(hasHowToKeywords) +
    Number(hasFilterKeywords) +
    Number(hasMetadataKeywords) +
    Number(hasRelativePeriodKeywords) +
    Number(hasAnalysisKeywords) +
    Number(hasContentSearchKeywords) +
    Number(hasDashboardExplanationKeywords) +
    Number(knownDatasourceMentioned);

  if (asksForDatasourceInventory) {
    const policy = QUESTION_INTENT_POLICY.dashboard_explanation;
    return {
      intent: "dashboard_explanation",
      confidence: 0.92,
      reasonBrief:
        "The question asks for the datasources used by the active dashboard, which can usually be answered from dashboard context without running deep analysis.",
      answerableFromDashboardContext: policy.answerableFromDashboardContext,
      needsMcp: false,
      maxToolCalls: 0,
    };
  }

  if (hasMetricAndGroupingIntent || hasAnalysisIntentHint) {
    const policy = QUESTION_INTENT_POLICY.data_analysis;
    return {
      intent: "data_analysis",
      confidence: hasMetricAndGroupingIntent ? 0.96 : 0.9,
      reasonBrief:
        "The question combines a metric with a grouping or grouped trend cue, so a datasource aggregate query should be prioritized.",
      answerableFromDashboardContext: policy.answerableFromDashboardContext,
      needsMcp: policy.needsMcp,
      maxToolCalls: policy.maxToolCalls,
    };
  }

  if (hasRelativePeriodKeywords && hasQueryTool) {
    const policy = QUESTION_INTENT_POLICY.data_analysis;
    return {
      intent: "data_analysis",
      confidence: 0.86,
      reasonBrief:
        "The question asks for time-bounded analysis, so an aggregate datasource query should be prioritized.",
      answerableFromDashboardContext: policy.answerableFromDashboardContext,
      needsMcp: policy.needsMcp,
      maxToolCalls: policy.maxToolCalls,
    };
  }

  let intent: QuestionIntent = "unsupported";
  let confidence = 0.45;
  let reasonBrief =
    "The question does not clearly map to a supported Tableau context workflow.";

  if (hasHowToKeywords) {
    intent = "how_to_use_tableau";
    confidence = hasFilterKeywords || hasMetadataKeywords ? 0.72 : 0.82;
    reasonBrief =
      "The question asks procedural Tableau usage guidance rather than dashboard data retrieval.";
  } else if (
    hasStrongAnalysisKeywords &&
    (hasQueryTool || knownDatasourceMentioned || hasMetadataKeywords)
  ) {
    intent = "data_analysis";
    confidence = hasQueryTool ? 0.89 : 0.8;
    reasonBrief =
      "The question asks for computed or ranked results, so aggregated datasource query should be prioritized.";
  } else if (
    hasFilterKeywords &&
    !hasMetadataKeywords &&
    !hasAnalysisKeywords
  ) {
    intent = "filter_or_selection_state";
    confidence = 0.82;
    reasonBrief =
      "The question focuses on current filters, selections, or parameter state.";
  } else if (hasMetadataKeywords || knownDatasourceMentioned) {
    intent = "metadata_lookup";
    confidence = hasAnalysisKeywords
      ? 0.78
      : knownDatasourceMentioned
        ? 0.84
        : 0.74;
    reasonBrief = hasAnalysisKeywords
      ? "The question includes datasource/field metadata cues, so metadata lookup should run before analysis."
      : "The question asks about datasources, fields, or workbook/view metadata.";
  } else if (
    hasAnalysisKeywords ||
    (knownDatasourceMentioned && hasQueryTool)
  ) {
    intent = "data_analysis";
    confidence = hasQueryTool ? 0.86 : 0.68;
    reasonBrief =
      "The question asks for aggregated values, trends, or ranking analysis.";
  } else if (hasContentSearchKeywords && hasSearchTool) {
    intent = "content_search";
    confidence = 0.78;
    reasonBrief = "The question asks to locate Tableau Cloud content.";
  } else if (
    !hasAnalysisOrGroupingSignal &&
    (hasDashboardExplanationKeywords || dashboardContext.worksheets.length > 0)
  ) {
    intent = "dashboard_explanation";
    confidence = hasDashboardExplanationKeywords ? 0.76 : 0.56;
    reasonBrief =
      "The question can likely be handled from the active dashboard context.";
  }

  if (clueCount >= 2 && hasQuestionMark) {
    confidence = Math.max(0.55, confidence - 0.07);
    reasonBrief = `${reasonBrief} Multiple intent clues were detected, so this classification may need adjustment.`;
  }

  const policy = QUESTION_INTENT_POLICY[intent];
  return {
    intent,
    confidence,
    reasonBrief,
    answerableFromDashboardContext: policy.answerableFromDashboardContext,
    needsMcp: policy.needsMcp,
    maxToolCalls: policy.maxToolCalls,
  };
}

function containsNormalizedPlannerKeyword(
  normalizedQuestion: string,
  keyword: string,
): boolean {
  const normalizedKeyword = keyword
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedKeyword) {
    return false;
  }

  const hasAsciiLetterOrDigit = /[a-z0-9]/i.test(normalizedKeyword);
  if (!hasAsciiLetterOrDigit) {
    return normalizedQuestion.includes(normalizedKeyword);
  }

  const paddedQuestion = ` ${normalizedQuestion} `;
  const paddedKeyword = ` ${normalizedKeyword} `;
  if (normalizedKeyword.includes(" ")) {
    return paddedQuestion.includes(paddedKeyword);
  }

  return normalizedQuestion.split(" ").includes(normalizedKeyword);
}
export function parseToolPlanResponse(
  text: string,
  fallbackIntent?: ClassifiedQuestionIntent,
  sanitizeOptions: ArgumentSanitizeOptions = getArgumentSanitizeOptionsFromConfig(),
): McpToolPlan | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const toolCallsSource = Array.isArray(record.toolCalls)
      ? record.toolCalls
      : Array.isArray(record.steps)
        ? record.steps
        : [];
    const normalizedCalls = toolCallsSource
      .map((call) => normalizeToolCall(call, sanitizeOptions))
      .filter((call): call is PlannedMcpToolCall => Boolean(call));

    const intent =
      readIntent(record.intent) ?? fallbackIntent?.intent ?? "unsupported";
    const confidence = clampNumber(
      record.confidence,
      0,
      1,
      fallbackIntent?.confidence ?? 0.6,
    );
    const answerableFromDashboardContext =
      typeof record.answerableFromDashboardContext === "boolean"
        ? record.answerableFromDashboardContext
        : (fallbackIntent?.answerableFromDashboardContext ?? false);
    const needsMcp =
      typeof record.needsMcp === "boolean"
        ? record.needsMcp
        : (fallbackIntent?.needsMcp ?? true);
    const reasonBrief =
      typeof record.reasonBrief === "string" && record.reasonBrief.trim()
        ? record.reasonBrief.trim().slice(0, 220)
        : (fallbackIntent?.reasonBrief ??
          "Planner selected MCP tools for this question.");
    const maxToolCalls = clampNumber(
      record.maxToolCalls,
      0,
      12,
      fallbackIntent?.maxToolCalls ?? normalizedCalls.length,
    );

    return {
      intent,
      confidence,
      answerableFromDashboardContext,
      needsMcp,
      reasonBrief,
      maxToolCalls,
      toolCalls: normalizedCalls.slice(0, maxToolCalls),
    };
  } catch {
    return undefined;
  }
}

export function resolveAllowedToolNames(
  tools: McpToolForPlanning[],
  configuredAllowedTools: string[],
): string[] {
  const availableToolNames = tools.map((tool) => tool.name).filter(Boolean);
  if (!configuredAllowedTools.length) {
    return [...new Set(availableToolNames)];
  }

  const available = new Set(availableToolNames);
  return configuredAllowedTools.filter((toolName) => available.has(toolName));
}

function normalizeToolCall(
  value: unknown,
  sanitizeOptions: ArgumentSanitizeOptions,
): PlannedMcpToolCall | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const toolName =
    typeof record.toolName === "string"
      ? record.toolName
      : typeof record.tool === "string"
        ? record.tool
        : "";
  if (!toolName.trim()) {
    return undefined;
  }

  const args =
    record.arguments && isPlainObject(record.arguments)
      ? sanitizeToolArguments(record.arguments, sanitizeOptions)
      : undefined;
  const purpose =
    typeof record.purpose === "string"
      ? record.purpose.slice(0, 220)
      : undefined;
  const reason =
    typeof record.reason === "string" ? record.reason.slice(0, 220) : undefined;
  const dependsOnTool =
    typeof record.dependsOnTool === "string"
      ? record.dependsOnTool.trim()
      : typeof record.dependsOn === "string"
        ? record.dependsOn.trim()
        : undefined;

  return {
    toolName: toolName.trim(),
    ...(args ? { arguments: args } : {}),
    ...(purpose ? { purpose } : {}),
    ...(reason ? { reason } : {}),
    ...(dependsOnTool ? { dependsOnTool } : {}),
  };
}

function sanitizeToolArguments(
  value: unknown,
  options: ArgumentSanitizeOptions,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value).slice(0, options.maxObjectKeys);
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    const isSensitive =
      /token|secret|password|jwt|authorization|credential|cookie/i.test(key);
    if (options.mode === "drop" && isSensitive) {
      continue;
    }

    const sanitizedValue = sanitizeJsonValue(child, 0, options);
    if (sanitizedValue === undefined && options.mode === "drop") {
      continue;
    }

    if (isSensitive && options.mode === "mask") {
      sanitized[key] = "__REDACTED__";
      continue;
    }

    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue;
    }
  }

  return Object.keys(sanitized).length ? sanitized : undefined;
}

function sanitizeJsonValue(
  value: unknown,
  depth: number,
  options: ArgumentSanitizeOptions,
): unknown {
  if (depth > options.maxDepth) {
    return undefined;
  }

  if (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const sanitizedItems = value
      .slice(0, options.maxArrayLength)
      .map((item) => sanitizeJsonValue(item, depth + 1, options))
      .filter((item): item is unknown => item !== undefined);
    return sanitizedItems;
  }

  if (isPlainObject(value)) {
    const sanitizedObject: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(
      0,
      options.maxObjectKeys,
    )) {
      const isSensitive =
        /token|secret|password|jwt|authorization|credential|cookie/i.test(key);
      if (isSensitive && options.mode === "drop") {
        continue;
      }

      if (isSensitive && options.mode === "mask") {
        sanitizedObject[key] = "__REDACTED__";
        continue;
      }

      const sanitizedChild = sanitizeJsonValue(child, depth + 1, options);
      if (sanitizedChild !== undefined) {
        sanitizedObject[key] = sanitizedChild;
      }
    }
    return sanitizedObject;
  }

  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) {
    return fenced;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  return undefined;
}

function readIntent(value: unknown): QuestionIntent | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (
    normalized === "dashboard_explanation" ||
    normalized === "filter_or_selection_state" ||
    normalized === "metadata_lookup" ||
    normalized === "data_analysis" ||
    normalized === "content_search" ||
    normalized === "how_to_use_tableau" ||
    normalized === "unsupported"
  ) {
    return normalized;
  }

  return undefined;
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function clipForDebugLog(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  return {
    text: `${value.slice(0, maxChars)}...`,
    truncated: true,
  };
}

function buildPlannerPrompt(
  input: McpToolPlannerInput & {
    allowedToolNames: string[];
    intent: ClassifiedQuestionIntent;
    maxToolCalls: number;
    preferredToolNames: string[];
    allowIntentReclassification: boolean;
  },
): string {
  return [
    "You are a strict planner for Tableau MCP tool calls.",
    "Return JSON only and follow the schema exactly.",
    "Keep reasonBrief and purpose short.",
    "Never invent IDs. If an ID is unknown, leave args empty and add dependsOnTool.",
    "Use only allowlisted tools.",
    input.allowIntentReclassification
      ? "You may adjust intent when the question and observations strongly disagree with the initial classifier."
      : "Treat the classified intent as fixed for this request.",
    "Avoid query-datasource unless aggregate analysis is required.",
    "For query-datasource, always include a small limit and aggregate fields.",
    `Maximum tool calls: ${input.maxToolCalls}`,
    `Allowed tools: ${input.allowedToolNames.join(", ") || "none"}`,
    `Preferred tools for this intent: ${input.preferredToolNames.join(", ") || "none"}`,
    `Classified intent: ${input.intent.intent} (confidence=${input.intent.confidence.toFixed(2)})`,
    `Intent reason: ${input.intent.reasonBrief}`,
    `Previously called tools: ${input.previouslyCalledToolNames?.join(", ") || "none"}`,
    "Available tool summaries:",
    JSON.stringify(buildToolSummaries(input.tools, input.allowedToolNames)),
    "Previous observations:",
    JSON.stringify(
      (input.observations ?? []).map((observation) => ({
        toolName: observation.toolName,
        status: observation.status,
        summary: observation.summary?.slice(0, 800),
        warning: observation.warning,
      })),
    ),
    "Dashboard context summary:",
    JSON.stringify({
      dashboardName: input.dashboardContext.dashboardName,
      workbookName: input.dashboardContext.workbookName,
      worksheetNames: input.dashboardContext.worksheets.map(
        (worksheet) => worksheet.name,
      ),
      filterNames: input.dashboardContext.filters.map(
        (filter) => filter.fieldName,
      ),
      parameterNames: input.dashboardContext.parameters.map(
        (parameter) => parameter.name,
      ),
      dataSourceHints: input.dashboardContext.dataSources?.map(
        (datasource) => ({
          name: datasource.name,
          id: datasource.id,
        }),
      ),
    }),
    `User question: ${input.question}`,
    'Schema: {"intent":"data_analysis","confidence":0.0,"answerableFromDashboardContext":false,"needsMcp":true,"reasonBrief":"short reason","maxToolCalls":4,"toolCalls":[{"toolName":"list-datasources","purpose":"short purpose","arguments":{},"dependsOnTool":"optional-tool-name"}]}',
  ].join("\n");
}

function buildToolSummaries(
  tools: McpToolForPlanning[],
  allowedToolNames: string[],
): Array<Record<string, unknown>> {
  const allowed = new Set(allowedToolNames);
  return tools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description?.slice(0, 280),
      required: tool.inputSchema?.required ?? [],
      properties: Object.keys(tool.inputSchema?.properties ?? {}).slice(0, 20),
    }));
}
