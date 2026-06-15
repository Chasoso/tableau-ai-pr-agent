import { createRequire } from "node:module";
import { delimiter } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getTableauConnectedAppSecrets } from "../aws/secrets";
import { getConfig } from "../config";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  safeErrorDetails,
  safeHash,
} from "../logging";
import { TableauMcpMetadataCacheRepository } from "../repositories/tableauMcpMetadataCacheRepository";
import {
  classifyQuestionIntent,
  resolveAllowedToolNames,
  TableauMcpToolPlanner,
  type ClassifiedQuestionIntent,
  type PlannedMcpToolCall,
} from "../services/tableauMcpToolPlanner";
import {
  interpretQuestion,
  matchesMetricFieldIntent,
} from "../services/questionInterpretation";
import type {
  DatasourceFieldDetail,
  DatasourceFieldProfile,
  McpExecutionDebug,
  McpObservation,
  QuestionInterpretation,
  QueryDatasourceExecutionDebug,
  QueryDatasourceInsight,
  ResolvedDatasourceRef,
  NormalizedTableauContext,
  TableauDatasourceRef,
  TableauProjectRef,
  TableauViewRef,
  TableauWorkbookRef,
  TableauAdditionalContext,
  QuestionRankingTarget,
  TableauMcpToolResultSummary,
  TableauMcpToolSummary,
} from "../types/tableau";
import type {
  GetAdditionalContextInput,
  TableauContextProvider,
} from "./contextProvider";

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export type RawMcpToolResult = {
  toolName: string;
  result: unknown;
  args?: Record<string, unknown>;
  debug?: QueryDatasourceExecutionDebug;
};

const TOOL_RESULT_SUMMARY_LIMIT = 1_800;
const TOOL_RESULT_PREVIEW_LIMIT = 360;
const TOOL_CACHE_KEY_MAX_LENGTH = 1200;
const QUERY_DIMENSION_ALIAS = "rank_label";
const QUERY_METRIC_ALIAS = "rank_metric";
const metadataCacheRepository = new TableauMcpMetadataCacheRepository();

type QueryFieldSpec = {
  fieldCaption: string | undefined;
  fieldAlias: string | undefined;
  function: string | undefined;
  calculation: string | undefined;
};

type QueryFieldSummary = {
  fieldCaption?: string;
  fieldAlias?: string;
  function?: string;
  calculation?: string;
};

type GroupedTrendFieldPlan = {
  fields: Record<string, unknown>[];
  derivedMetricsComputedInApp: string[];
  selectedMetricFieldCaption?: string;
};

type CacheEntry = {
  expiresAt: number;
  result: unknown;
};

const metadataToolCache = new Map<string, CacheEntry>();
const mcpStartupFailureCache = new Map<string, CacheEntry>();
const MCP_STARTUP_FAILURE_CACHE_TTL_MS = 60_000;

export type ToolPreconditionResult = {
  ok: boolean;
  reason?: string;
  recoverable?: boolean;
  suggestedTools?: string[];
};

type McpExecutionState = {
  intent: ClassifiedQuestionIntent;
  dashboardContext: GetAdditionalContextInput["dashboardContext"];
  calledToolNames: Set<string>;
  executedToolResults: TableauMcpToolResultSummary[];
  rawToolResults: RawMcpToolResult[];
};

export class TableauMcpContextProvider implements TableauContextProvider {
  readonly name = "tableau-mcp" as const;

  async getAdditionalContext(
    input: GetAdditionalContextInput,
  ): Promise<TableauAdditionalContext> {
    const config = getConfig();
    const mcpConfig = config.tableau.mcp;
    const effectiveQuestion = input.planningQuestion?.trim() || input.question;
    const questionInterpretation =
      input.questionInterpretation ??
      interpretQuestion({
        question: effectiveQuestion,
        dashboardContext: input.dashboardContext,
      });
    const planningInput =
      effectiveQuestion === input.question
        ? { ...input, questionInterpretation }
        : {
            ...input,
            question: effectiveQuestion,
            questionInterpretation,
          };

    if (mcpConfig.transport === "http") {
      return callHttpMcpStub(planningInput);
    }

    if (mcpConfig.transport !== "stdio") {
      return {
        provider: this.name,
        warnings: [
          `Tableau MCP transport '${mcpConfig.transport}' is not supported. Use 'stdio' for the Lambda PoC.`,
        ],
      };
    }

    if (!input.tableauSubject) {
      return {
        provider: this.name,
        warnings: [
          "Tableau MCP lookup skipped because no authenticated Tableau subject was available.",
        ],
      };
    }

    const startupValidation = validateMcpStartupConfiguration(config.tableau);
    if (!startupValidation.ok) {
      logWarn("tableau.mcp.preflight_failed", {
        reason: startupValidation.reason,
        dashboardName: input.dashboardContext.dashboardName,
        questionRewritten: effectiveQuestion !== input.question,
      });
      return {
        provider: this.name,
        mcpConnectionFailed: true,
        mcpFailureStage: "startup",
        mcpFailureReason: startupValidation.reason,
        warnings: [startupValidation.reason],
      };
    }

    const startupFailureCacheKey = buildMcpStartupFailureCacheKey({
      tableauConfig: config.tableau,
      mcpConfig,
    });
    const cachedStartupFailure = getCachedMcpStartupFailure(
      startupFailureCacheKey,
    );
    if (cachedStartupFailure) {
      logWarn("tableau.mcp.startup_failure_cached", {
        dashboardName: input.dashboardContext.dashboardName,
        questionRewritten: effectiveQuestion !== input.question,
        serverUrlSummary: summarizeServerUrl(config.tableau.serverUrl),
      });
      return cachedStartupFailure;
    }

    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;
    let mcpStderrTail = "";
    let serverUrlSummary: McpServerUrlSummary | undefined;
    let runtimeSummary: McpRuntimeSummary | undefined;
    let startupCompleted = false;

    try {
      const connectedApp = await getTableauConnectedAppSecrets();
      if (
        !connectedApp.clientId.trim() ||
        !connectedApp.secretId.trim() ||
        !connectedApp.secretValue.trim()
      ) {
        const reason =
          "Tableau Connected App secrets are missing required values.";
        logWarn("tableau.mcp.preflight_failed", {
          reason,
          dashboardName: input.dashboardContext.dashboardName,
          questionRewritten: effectiveQuestion !== input.question,
        });
        return {
          provider: this.name,
          mcpConnectionFailed: true,
          mcpFailureStage: "startup",
          mcpFailureReason: reason,
          warnings: [reason],
        };
      }
      const command = resolveMcpCommand(mcpConfig.command);
      const args = resolveMcpArgs(command, mcpConfig.args);
      const env = buildMcpEnvironment({
        tableauSubject: input.tableauSubject,
        connectedApp,
      });
      serverUrlSummary = summarizeServerUrl(config.tableau.serverUrl);
      runtimeSummary = summarizeMcpRuntime({
        command,
        args,
      });

      logInfo("tableau.mcp.stdio.started", {
        commandSource: mcpConfig.command ? "configured" : "package",
        commandBaseName: summarizeCommandBaseName(command),
        argsCount: args.length,
        authMode: mcpConfig.authMode,
        tableauSubjectHash: safeHash(input.tableauSubject),
        serverUrlSummary,
        runtimeSummary,
        dashboardName: input.dashboardContext.dashboardName,
        workbookNamePresent: Boolean(input.dashboardContext.workbookName),
        questionRewritten: effectiveQuestion !== input.question,
      });

      transport = new StdioClientTransport({
        command,
        args,
        env,
        stderr: "pipe",
      });
      installMcpTransportDiagnostics(transport, {
        command,
        args,
        authMode: mcpConfig.authMode || "direct-trust",
        tableauSubjectHash: safeHash(input.tableauSubject),
        serverUrlSummary,
        dashboardName: input.dashboardContext.dashboardName,
      });
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        // Keep a short sanitized tail so startup failures can be diagnosed without leaking secrets.
        mcpStderrTail = appendSanitizedStderrTail(mcpStderrTail, chunk);
      });
      client = new Client({
        name: "tableau-ai-pr-agent-backend",
        version: "0.1.0",
      });

      await client.connect(transport);
      const toolsResponse = await client.listTools(undefined, {
        timeout: mcpConfig.timeoutMs,
      });
      startupCompleted = true;
      const tools = toolsResponse.tools as McpTool[];
      const allowedToolNames = resolveAllowedToolNames(
        tools,
        mcpConfig.allowedTools,
      );
      logDebug("tableau.mcp.tools.listed", {
        toolCount: tools.length,
        allowedToolCount: allowedToolNames.length,
        allowlistConfiguredCount: mcpConfig.allowedTools.length,
        toolNames: tools.map((tool) => tool.name),
        allowedToolNames,
        tools: tools.map((tool) => summarizeListedTool(tool)),
      });
      const intent =
        input.intentHint ??
        classifyQuestionIntent(
          effectiveQuestion,
          input.dashboardContext,
          allowedToolNames,
          questionInterpretation.requestType,
          questionInterpretation,
        );
      const effectiveMaxToolCalls = Math.max(
        0,
        Math.min(mcpConfig.maxToolCalls, intent.maxToolCalls),
      );
      const toolSummaries = tools.map(toToolSummary);
      const initialToolSelection = await selectInitialTools(
        tools,
        mcpConfig.allowedTools,
        planningInput,
        intent,
        effectiveMaxToolCalls,
      );
      const toolQueue = [...initialToolSelection.selections];
      const toolResults: TableauMcpToolResultSummary[] = [];
      const rawToolResults: RawMcpToolResult[] = [];
      const observations: McpObservation[] = [];
      const calledToolNames = new Set<string>();
      let executedToolCallCount = 0;
      let dataReplanAttempted = false;
      let planningTimeMs = initialToolSelection.planningTimeMs;
      const executionStartedAt = Date.now();
      const blockedToolNames = [...initialToolSelection.blockedTools];
      const recoverablePreconditionSuggestions = new Set<string>();
      let hasRecoverablePreconditionFailure = false;
      let fallbackReason: string | undefined;
      const analysisIntentQuestion =
        isAggregateAnalysisQuestion(effectiveQuestion);

      logInfo("tableau.mcp.intent.classified", {
        intent: intent.intent,
        confidence: intent.confidence,
        needsMcp: intent.needsMcp,
        answerableFromDashboardContext: intent.answerableFromDashboardContext,
        maxToolCalls: effectiveMaxToolCalls,
      });

      if (!intent.needsMcp || effectiveMaxToolCalls === 0) {
        fallbackReason =
          "Intent indicates dashboard context is sufficient or question is unsupported.";
      }

      while (intent.needsMcp && executedToolCallCount < effectiveMaxToolCalls) {
        if (!toolQueue.length) {
          const remainingToolBudget =
            effectiveMaxToolCalls - executedToolCallCount;
          const analysisRecoverySelection =
            buildDataAnalysisQueryRecoverySelection({
              tools,
              allowedToolNames,
              input: planningInput,
              intent,
              calledToolNames,
              rawToolResults,
              observations,
              remainingToolBudget,
            });
          if (analysisRecoverySelection) {
            toolQueue.push(analysisRecoverySelection);
            logInfo("tableau.mcp.query.recovery_planned", {
              reason: "analysis_question_with_resolved_datasource_identifier",
              remainingToolBudget,
            });
            continue;
          }
          const metadataRecoverySelection =
            buildMetadataIdentifierRecoverySelection({
              tools,
              allowedToolNames,
              input: planningInput,
              intent,
              calledToolNames,
              rawToolResults,
              observations,
              remainingToolBudget,
            });
          if (metadataRecoverySelection) {
            toolQueue.push(metadataRecoverySelection);
            continue;
          }

          if (
            !dataReplanAttempted &&
            shouldReplanForDatasourceQuery(
              intent,
              toolResults,
              calledToolNames,
              hasRecoverablePreconditionFailure,
              recoverablePreconditionSuggestions,
              analysisIntentQuestion,
            ) &&
            executedToolCallCount < effectiveMaxToolCalls
          ) {
            dataReplanAttempted = true;
            const replanStartedAt = Date.now();
            const replannedTools = await selectPlannedTools(
              tools,
              mcpConfig.allowedTools,
              planningInput,
              intent,
              effectiveMaxToolCalls,
              {
                observations: toolResults,
                calledToolNames,
                preferredRecoveryTools: [...recoverablePreconditionSuggestions],
              },
            );
            planningTimeMs += Date.now() - replanStartedAt;
            blockedToolNames.push(...replannedTools.blockedTools);
            const readyReplannedTools = replannedTools.selections.filter(
              (selection) => selection.status === "ready",
            );
            if (readyReplannedTools.length) {
              toolQueue.push(...readyReplannedTools);
              continue;
            }
          }

          break;
        }

        const parallelBatch = collectParallelizableToolBatch(
          toolQueue,
          calledToolNames,
        );
        if (parallelBatch.length > 1) {
          toolQueue.splice(0, parallelBatch.length);
          const executions = parallelBatch.map((selection) => ({
            selection,
            startedAt: Date.now(),
            promise: executeToolWithCache({
              client: client!,
              toolName: selection.tool.name,
              args: selection.arguments,
              tableauSubject: input.tableauSubject,
              timeoutMs: mcpConfig.timeoutMs,
            }),
          }));
          const settledExecutions = await Promise.allSettled(
            executions.map((execution) => execution.promise),
          );
          for (let index = 0; index < executions.length; index += 1) {
            const execution = executions[index];
            const settled = settledExecutions[index];
            const outcome = await processSelectionOutcome({
              selection: execution.selection,
              startedAt: execution.startedAt,
              resolved:
                settled.status === "fulfilled" ? settled.value : undefined,
              error: settled.status === "rejected" ? settled.reason : undefined,
              tools,
              loopInput: planningInput,
              intent,
              calledToolNames,
              toolResults,
              rawToolResults,
              observations,
              recoverablePreconditionSuggestions,
              setRecoverablePreconditionFailure(value) {
                hasRecoverablePreconditionFailure = value;
              },
              debugLogResults: mcpConfig.debugLogResults,
            });
            if (outcome.countedExecution) {
              executedToolCallCount += 1;
            }
            if (outcome.followUp) {
              toolQueue.unshift(outcome.followUp);
            }
          }
          continue;
        }

        const selection = toolQueue.shift();
        if (!selection) {
          break;
        }

        if (selection.status === "skipped") {
          toolResults.push(selection);
          observations.push({
            tool: selection.toolName,
            purpose: "Skipped before execution",
            argsSummary: {},
            success: false,
            resultSummary: "",
            errorMessage: selection.warning,
          });
          continue;
        }

        if (calledToolNames.has(selection.tool.name)) {
          continue;
        }

        const precondition = checkToolPreconditions(
          selection.tool.name,
          selection.arguments,
          {
            intent,
            dashboardContext: input.dashboardContext,
            calledToolNames,
            executedToolResults: toolResults,
            rawToolResults,
          },
        );
        if (!precondition.ok) {
          const warning = precondition.reason ?? "Tool precondition failed.";
          blockedToolNames.push(selection.tool.name);
          logWarn("tableau.mcp.tool.precondition_blocked", {
            toolName: selection.tool.name,
            metadataToolArgsKeys: Object.keys(selection.arguments),
            schemaRequiredArgs: selection.tool.inputSchema?.required ?? [],
            identifierResolutionFailedReason: warning,
          });
          if (precondition.recoverable) {
            hasRecoverablePreconditionFailure = true;
            for (const suggestedToolName of precondition.suggestedTools ?? []) {
              recoverablePreconditionSuggestions.add(suggestedToolName);
            }
          }
          toolResults.push({
            toolName: selection.tool.name,
            status: "skipped",
            warning,
          });
          observations.push({
            tool: selection.tool.name,
            purpose: selection.reason ?? "Collect Tableau Cloud context",
            argsSummary: summarizeToolArguments(selection.arguments),
            success: false,
            resultSummary: "",
            errorMessage: warning,
          });
          continue;
        }

        const toolStartedAt = Date.now();
        try {
          const execution = await executeToolWithCache({
            client: client!,
            toolName: selection.tool.name,
            args: selection.arguments,
            tableauSubject: input.tableauSubject,
            timeoutMs: mcpConfig.timeoutMs,
          });
          const outcome = await processSelectionOutcome({
            selection,
            startedAt: toolStartedAt,
            resolved: execution,
            tools,
            loopInput: planningInput,
            intent,
            calledToolNames,
            toolResults,
            rawToolResults,
            observations,
            recoverablePreconditionSuggestions,
            setRecoverablePreconditionFailure(value) {
              hasRecoverablePreconditionFailure = value;
            },
            debugLogResults: mcpConfig.debugLogResults,
          });
          if (outcome.countedExecution) {
            executedToolCallCount += 1;
          }
          if (outcome.followUp) {
            toolQueue.unshift(outcome.followUp);
          }
        } catch (error) {
          const outcome = await processSelectionOutcome({
            selection,
            startedAt: toolStartedAt,
            error,
            tools,
            loopInput: planningInput,
            intent,
            calledToolNames,
            toolResults,
            rawToolResults,
            observations,
            recoverablePreconditionSuggestions,
            setRecoverablePreconditionFailure(value) {
              hasRecoverablePreconditionFailure = value;
            },
            debugLogResults: mcpConfig.debugLogResults,
          });
          if (outcome.countedExecution) {
            executedToolCallCount += 1;
          }
          if (outcome.followUp) {
            toolQueue.unshift(outcome.followUp);
          }
        }
      }

      const executionTimeMs = Date.now() - executionStartedAt;
      logInfo("tableau.mcp.stdio.completed", {
        toolCount: toolSummaries.length,
        calledToolCount: toolResults.filter(
          (result) => result.status === "success",
        ).length,
        failedToolCount: toolResults.filter(
          (result) => result.status === "failed",
        ).length,
        selectedTools: toolResults.map((result) => result.toolName),
        blockedToolCount: blockedToolNames.length,
        planningTimeMs,
        executionTimeMs,
      });
      const extractedWorkbook = extractWorkbookFromToolResults(
        toolResults,
        planningInput,
      );
      const extractedDatasources = extractDatasourcesFromRawToolResults(
        rawToolResults,
        planningInput,
      );
      const normalizedContext = normalizeTableauContext({
        dashboardContext: planningInput.dashboardContext,
        workbook: extractedWorkbook,
        rawToolResults,
        datasources: extractedDatasources,
      });
      const answerContextDatasources = normalizedContext.datasources;
      const datasourceFieldProfiles =
        extractDatasourceFieldProfilesFromRawToolResults(
          rawToolResults,
          answerContextDatasources,
        );
      const queryInsights = extractQueryDatasourceInsightsFromRawToolResults(
        rawToolResults,
        answerContextDatasources,
        questionInterpretation,
      );
      const derivedWarnings = toolResults
        .filter(
          (result) => result.status === "failed" || result.status === "skipped",
        )
        .map(
          (result) => `${result.toolName}: ${result.warning ?? result.status}`,
        );
      if (
        toolResults.some(
          (result) =>
            result.toolName === "query-datasource" &&
            result.status === "success",
        ) &&
        queryInsights.length === 0
      ) {
        derivedWarnings.push(
          "query-datasource returned results that did not safely match the requested metric or did not include numeric aggregate values.",
        );
      }
      const metadataCallSucceeded = toolResults.some(
        (result) =>
          result.toolName === "get-datasource-metadata" &&
          result.status === "success",
      );
      const hasMetadata = metadataCallSucceeded;
      if (
        intent.intent === "metadata_lookup" &&
        !hasMetadata &&
        !fallbackReason
      ) {
        fallbackReason =
          "Datasource metadata could not be resolved from current dashboard/workbook context.";
      }
      logInfo("tableau.mcp.datasources.extracted", {
        rawExtractedDatasourceCount: extractedDatasources.length,
        normalizedDatasourceCount: normalizedContext.datasources.length,
        answerContextDatasourceCount: answerContextDatasources.length,
        normalizedProjectCount: normalizedContext.projects.length,
        matchedKnownDatasource: hasDatasourceMatchingDashboardContext(
          answerContextDatasources,
          input,
        ),
        hasMetadata,
      });
      logInfo("tableau.mcp.workbook.extracted", {
        workbookNamePresent: Boolean(extractedWorkbook?.name),
        workbookNameHash: safeHash(extractedWorkbook?.name),
        workbookIdHash: safeHash(extractedWorkbook?.id),
      });

      const executionDebug: McpExecutionDebug = {
        intent: intent.intent,
        intentConfidence: intent.confidence,
        answerableFromDashboardContext: intent.answerableFromDashboardContext,
        needsMcp: intent.needsMcp,
        maxToolCalls: effectiveMaxToolCalls,
        plannerReasonBrief: initialToolSelection.reasonBrief,
        plannedTools: initialToolSelection.plannedTools,
        blockedTools: blockedToolNames,
        executedTools: toolResults
          .filter((result) => result.status === "success")
          .map((result) => result.toolName),
        skippedTools: toolResults
          .filter((result) => result.status === "skipped")
          .map((result) => result.toolName),
        toolCallCount: toolResults.filter(
          (result) => result.status === "success",
        ).length,
        replanUsed: dataReplanAttempted,
        timingMs: {
          planning: planningTimeMs,
          execution: executionTimeMs,
        },
        ...(fallbackReason ? { fallbackReason } : {}),
      };

      return {
        provider: this.name,
        workbook: extractedWorkbook,
        datasources: answerContextDatasources,
        datasourceFieldProfiles,
        queryInsights,
        normalizedContext,
        questionInterpretation,
        metadata: {
          transport: "stdio",
          toolCount: toolSummaries.length,
          calledTools: toolResults.map((result) => result.toolName),
          workbookExtracted: Boolean(extractedWorkbook),
          toolPlanningEnabled: mcpConfig.toolPlanningEnabled,
          intent: intent.intent,
          hasMetadata,
          datasourceFieldProfiles,
          planningQuestion: effectiveQuestion,
        },
        mcpTools: toolSummaries,
        mcpToolResults: toolResults,
        mcpObservations: observations,
        mcpExecutionDebug: executionDebug,
        warnings: derivedWarnings,
      };
    } catch (error) {
      const safeDetails = safeErrorDetails(error);
      if (!startupCompleted) {
        cacheMcpStartupFailure(startupFailureCacheKey, {
          provider: this.name,
          mcpConnectionFailed: true,
          mcpFailureStage: "startup",
          mcpFailureReason: summarizeMcpFailureReason(error, mcpStderrTail),
          warnings: [
            "Tableau MCP lookup failed before usable observations were collected.",
          ],
        });
      }
      const logFailure = startupCompleted ? logError : logWarn;
      logFailure("tableau.mcp.lookup.failed", {
        ...safeDetails,
        ...(serverUrlSummary ? { serverUrlSummary } : {}),
        ...(runtimeSummary ? { runtimeSummary } : {}),
        stderrTail: mcpStderrTail || undefined,
      });
      if (mcpStderrTail) {
        logWarn("tableau.mcp.stderr.tail", {
          stderrTail: mcpStderrTail,
        });
      }
      return {
        provider: this.name,
        mcpConnectionFailed: true,
        mcpFailureStage: "startup",
        mcpFailureReason: summarizeMcpFailureReason(error, mcpStderrTail),
        warnings: [
          "Tableau MCP lookup failed before usable observations were collected.",
        ],
      };
    } finally {
      await transport?.close().catch((error) => {
        logWarn("tableau.mcp.transport.close_failed", safeErrorDetails(error));
      });
    }
  }
}

export function clearTableauMcpRuntimeCaches(): void {
  metadataToolCache.clear();
  mcpStartupFailureCache.clear();
}

async function callHttpMcpStub(
  input: GetAdditionalContextInput,
): Promise<TableauAdditionalContext> {
  const config = getConfig().tableau.mcp;

  if (!config.serverUrl) {
    return {
      provider: "tableau-mcp",
      mcpConnectionFailed: true,
      mcpFailureStage: "http",
      mcpFailureReason: "Tableau MCP server URL is not configured.",
      warnings: [
        "Tableau MCP server URL is not configured. Using dashboard context only.",
      ],
    };
  }

  try {
    const response = await fetch(trimTrailingSlash(config.serverUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        operation: "get_dashboard_context",
        dashboardContext: sanitizeDashboardContext(input.dashboardContext),
        question: input.question,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      return {
        provider: "tableau-mcp",
        mcpConnectionFailed: true,
        mcpFailureStage: "http",
        mcpFailureReason: `Tableau MCP HTTP lookup failed with status ${response.status}.`,
        warnings: [
          `Tableau MCP HTTP lookup failed with status ${response.status}.`,
        ],
      };
    }

    const body = (await response.json()) as TableauAdditionalContext;
    return {
      provider: "tableau-mcp",
      workbook: body.workbook,
      datasources: body.datasources ?? [],
      normalizedContext: body.normalizedContext,
      questionInterpretation: body.questionInterpretation,
      metadata: body.metadata,
      mcpTools: body.mcpTools ?? [],
      mcpToolResults: body.mcpToolResults ?? [],
      mcpObservations: body.mcpObservations ?? [],
      mcpExecutionDebug: body.mcpExecutionDebug,
      warnings: body.warnings ?? [],
    };
  } catch {
    return {
      provider: "tableau-mcp",
      mcpConnectionFailed: true,
      mcpFailureStage: "http",
      mcpFailureReason: "Tableau MCP HTTP lookup failed.",
      warnings: [
        "Tableau MCP HTTP lookup failed. Using dashboard context only.",
      ],
    };
  }
}

function resolveMcpCommand(configuredCommand: string): string {
  if (configuredCommand) {
    return configuredCommand;
  }

  return process.execPath;
}

function resolveMcpArgs(command: string, configuredArgs: string[]): string[] {
  if (configuredArgs.length) {
    return configuredArgs;
  }

  if (command !== process.execPath) {
    return [];
  }

  const requireFromRuntime = createRequire(__filename);
  return [requireFromRuntime.resolve("@tableau/mcp-server")];
}

function buildMcpEnvironment(input: {
  tableauSubject: string;
  connectedApp: { clientId: string; secretId: string; secretValue: string };
}): Record<string, string> {
  const config = getConfig();

  return compactEnv({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    SERVER: config.tableau.serverUrl,
    SITE_NAME: config.tableau.siteContentUrl,
    TRANSPORT: "stdio",
    AUTH: config.tableau.mcp.authMode || "direct-trust",
    JWT_SUB_CLAIM: input.tableauSubject,
    CONNECTED_APP_CLIENT_ID: input.connectedApp.clientId,
    CONNECTED_APP_SECRET_ID: input.connectedApp.secretId,
    CONNECTED_APP_SECRET_VALUE: input.connectedApp.secretValue,
    DISABLE_LOG_MASKING: "false",
    PRODUCT_TELEMETRY_ENABLED: "false",
    TELEMETRY_PROVIDER: "noop",
  });
}

type McpStartupValidation =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

function validateMcpStartupConfiguration(
  tableauConfig: ReturnType<typeof getConfig>["tableau"],
): McpStartupValidation {
  const serverUrl = tableauConfig.serverUrl?.trim();
  if (!serverUrl) {
    return {
      ok: false,
      reason: "Tableau MCP server URL is not configured.",
    };
  }

  try {
    const parsed = new URL(trimTrailingSlash(serverUrl));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: "Tableau MCP server URL must use http or https.",
      };
    }
  } catch {
    return {
      ok: false,
      reason: "Tableau MCP server URL is invalid.",
    };
  }

  if (!tableauConfig.siteContentUrl?.trim()) {
    return {
      ok: false,
      reason: "Tableau site content URL is not configured.",
    };
  }

  return { ok: true };
}

function buildMcpStartupFailureCacheKey(input: {
  tableauConfig: ReturnType<typeof getConfig>["tableau"];
  mcpConfig: ReturnType<typeof getConfig>["tableau"]["mcp"];
}): string {
  return [
    input.tableauConfig.serverUrl.trim(),
    input.tableauConfig.siteContentUrl.trim(),
    input.mcpConfig.transport,
    input.mcpConfig.authMode,
    input.mcpConfig.command.trim(),
    input.mcpConfig.args.join("\u0000"),
  ].join("|");
}

function getCachedMcpStartupFailure(
  cacheKey: string,
): TableauAdditionalContext | undefined {
  pruneStartupFailureCache();
  const cached = mcpStartupFailureCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  return cached.result as TableauAdditionalContext;
}

function cacheMcpStartupFailure(
  cacheKey: string,
  result: TableauAdditionalContext,
): void {
  mcpStartupFailureCache.set(cacheKey, {
    expiresAt: Date.now() + MCP_STARTUP_FAILURE_CACHE_TTL_MS,
    result,
  });
}

function pruneStartupFailureCache(): void {
  const now = Date.now();
  for (const [key, entry] of mcpStartupFailureCache.entries()) {
    if (entry.expiresAt <= now) {
      mcpStartupFailureCache.delete(key);
    }
  }
}

function appendSanitizedStderrTail(
  currentTail: string,
  chunk: Buffer | string,
): string {
  const chunkText = Buffer.isBuffer(chunk)
    ? chunk.toString("utf8")
    : String(chunk);
  const merged = sanitizeMcpStderr(`${currentTail}${chunkText}`);
  return merged.slice(-4_096);
}

function sanitizeMcpStderr(text: string): string {
  return text
    .replace(/\b\d{12}\b/g, "<account-id>")
    .replace(/arn:aws[a-zA-Z-]*:[^\s]+/g, "<aws-arn>")
    .replace(/https?:\/\/[^\s]+/g, "<url>")
    .replace(/s3:\/\/[^\s]+/g, "s3://<bucket-or-key>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, "<redacted-token>");
}

function summarizeMcpFailureReason(error: unknown, stderrTail: string): string {
  const safeDetails = safeErrorDetails(error);
  const errorMessage =
    typeof safeDetails.errorMessage === "string" && safeDetails.errorMessage
      ? safeDetails.errorMessage
      : undefined;
  const baseReason =
    errorMessage ??
    (typeof safeDetails.errorName === "string"
      ? safeDetails.errorName
      : "UnknownError");

  if (!stderrTail) {
    return `Tableau MCP child process failed to start: ${baseReason}`;
  }

  return `Tableau MCP child process failed to start: ${baseReason}. Stderr tail: ${stderrTail}`;
}

function compactEnv(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

type McpServerUrlSummary = {
  protocol: string;
  hasHost: boolean;
  hostHash?: string;
  hasPath: boolean;
  hasQuery: boolean;
  siteContentUrlPresent: boolean;
};

type McpRuntimeSummary = {
  cwd: string;
  nodeOptionsPresent: boolean;
  nodeOptionsHash?: string;
  pathSegmentCount: number;
  commandIsNode: boolean;
  commandBaseName: string;
  argsCount: number;
};

type McpTransportDiagnostics = {
  command: string;
  args: string[];
  authMode: string;
  tableauSubjectHash?: string;
  serverUrlSummary: McpServerUrlSummary;
  dashboardName: string;
};

function summarizeServerUrl(serverUrl: string): McpServerUrlSummary {
  const parsed = new URL(trimTrailingSlash(serverUrl));
  return {
    protocol: parsed.protocol.replace(/:$/, ""),
    hasHost: Boolean(parsed.hostname),
    ...(parsed.hostname ? { hostHash: safeHash(parsed.hostname) } : {}),
    hasPath: parsed.pathname !== "/" && parsed.pathname.trim() !== "",
    hasQuery: Boolean(parsed.search),
    siteContentUrlPresent: Boolean(getConfig().tableau.siteContentUrl?.trim()),
  };
}

function summarizeMcpRuntime(input: {
  command: string;
  args: string[];
}): McpRuntimeSummary {
  const pathValue = process.env.PATH?.trim() ?? "";
  const nodeOptions = process.env.NODE_OPTIONS?.trim() ?? "";
  return {
    cwd: process.cwd(),
    nodeOptionsPresent: Boolean(nodeOptions),
    ...(nodeOptions ? { nodeOptionsHash: safeHash(nodeOptions) } : {}),
    pathSegmentCount: pathValue ? pathValue.split(delimiter).length : 0,
    commandIsNode: input.command === process.execPath,
    commandBaseName: summarizeCommandBaseName(input.command),
    argsCount: input.args.length,
  };
}

function summarizeCommandBaseName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "unknown";
  }

  const normalized = trimmed.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function installMcpTransportDiagnostics(
  transport: StdioClientTransport,
  diagnostics: McpTransportDiagnostics,
): void {
  const transportWithProcess = transport as unknown as {
    start?: () => Promise<void>;
    _process?: {
      pid?: number | null;
      exitCode: number | null;
      signalCode?: NodeJS.Signals | null;
      once: {
        (event: "error", listener: (error: unknown) => void): void;
        (
          event: "exit",
          listener: (exitCode: number | null, signal: string | null) => void,
        ): void;
      };
    };
    onerror?: (error: unknown) => void;
  };

  if (typeof transportWithProcess.start !== "function") {
    return;
  }

  const originalStart = transportWithProcess.start.bind(transportWithProcess);
  let processHooksInstalled = false;
  let processExitLogged = false;

  transportWithProcess.onerror = (error: unknown) => {
    logWarn("tableau.mcp.stdio.transport.error", {
      ...diagnostics,
      ...safeErrorDetails(error),
    });
  };

  transportWithProcess.start = async () => {
    try {
      await originalStart();
      installChildProcessHooks();
    } catch (error) {
      logWarn("tableau.mcp.stdio.start_failed", {
        ...diagnostics,
        ...safeErrorDetails(error),
      });
      throw error;
    }
  };

  function installChildProcessHooks(): void {
    if (processHooksInstalled) {
      return;
    }

    const childProcess = transportWithProcess._process;
    if (!childProcess) {
      logDebug("tableau.mcp.stdio.process_unavailable", diagnostics);
      return;
    }

    processHooksInstalled = true;
    childProcess.once("error", (error: unknown) => {
      logError("tableau.mcp.stdio.process.error", {
        ...diagnostics,
        ...safeErrorDetails(error),
      });
    });
    childProcess.once(
      "exit",
      (exitCode: number | null, signal: string | null) => {
        logProcessExit(exitCode, signal);
      },
    );

    if (childProcess.exitCode !== null) {
      logProcessExit(childProcess.exitCode, childProcess.signalCode ?? null);
    }
  }

  function logProcessExit(
    exitCode: number | null,
    signal: string | null,
  ): void {
    if (processExitLogged) {
      return;
    }

    processExitLogged = true;
    const payload = {
      ...diagnostics,
      pid: transportWithProcess._process?.pid ?? undefined,
      exitCode,
      signal,
    };
    if (exitCode !== 0 || signal) {
      logWarn("tableau.mcp.stdio.process.exited", payload);
    } else {
      logDebug("tableau.mcp.stdio.process.exited", payload);
    }
  }
}

export type SelectedTool =
  | {
      status: "ready";
      tool: McpTool;
      arguments: Record<string, unknown>;
      reason?: string;
      dependsOnTool?: string;
    }
  | {
      status: "skipped";
      toolName: string;
      warning: string;
    };

async function selectInitialTools(
  tools: McpTool[],
  allowedTools: string[],
  input: GetAdditionalContextInput,
  intent: ClassifiedQuestionIntent,
  maxToolCalls: number,
): Promise<{
  selections: SelectedTool[];
  blockedTools: string[];
  plannedTools: string[];
  reasonBrief?: string;
  stopFallback?: boolean;
  planningTimeMs: number;
}> {
  const ruleBased = buildRuleBasedInitialSelections(
    tools,
    allowedTools,
    input,
    intent,
    maxToolCalls,
  );
  if (ruleBased.selections.length > 0) {
    return {
      ...ruleBased,
      planningTimeMs: 0,
    };
  }
  if (ruleBased.stopFallback) {
    return {
      ...ruleBased,
      planningTimeMs: 0,
    };
  }

  const plannerStartedAt = Date.now();
  const plannedSelections = await selectPlannedTools(
    tools,
    allowedTools,
    input,
    intent,
    maxToolCalls,
  );
  const planningTimeMs = Date.now() - plannerStartedAt;
  if (
    plannedSelections.selections.some(
      (selection) => selection.status === "ready",
    )
  ) {
    return {
      ...plannedSelections,
      planningTimeMs,
    };
  }

  const resolvedAllowedToolNames = resolveAllowedToolNames(tools, allowedTools);
  const allowlistedTools = tools.filter((tool) =>
    resolvedAllowedToolNames.includes(tool.name),
  );
  const candidates = allowedTools.length
    ? allowlistedTools
    : getDefaultToolCandidates(allowlistedTools, input);

  logInfo("tableau.mcp.tools.selected", {
    availableToolCount: tools.length,
    selectedTools: candidates.map((tool) => tool.name),
    allowlistSource: getAllowlistSource(allowedTools),
  });

  return {
    selections: candidates.map((tool) => {
      const args = inferToolArguments(tool, input);
      if (!args) {
        return {
          status: "skipped",
          toolName: tool.name,
          warning: "Required arguments could not be inferred safely.",
        };
      }

      return {
        status: "ready",
        tool,
        arguments: args,
      };
    }),
    blockedTools: [],
    plannedTools: candidates.map((tool) => tool.name),
    reasonBrief: "Fallback tool selection without LLM planning.",
    planningTimeMs,
  };
}

export function buildRuleBasedInitialSelections(
  tools: McpTool[],
  allowedTools: string[],
  input: GetAdditionalContextInput,
  intent: ClassifiedQuestionIntent,
  maxToolCalls: number,
): {
  selections: SelectedTool[];
  blockedTools: string[];
  plannedTools: string[];
  reasonBrief?: string;
  stopFallback?: boolean;
} {
  if (intent.intent !== "metadata_lookup" || maxToolCalls <= 0) {
    return {
      selections: [],
      blockedTools: [],
      plannedTools: [],
      stopFallback: false,
    };
  }

  const allowedToolNames = resolveAllowedToolNames(tools, allowedTools);
  const knownDatasourceWithId = input.dashboardContext.dataSources?.find(
    (datasource) => {
      const id = readString(datasource.id);
      return Boolean(id && looksLikeIdentifier(id));
    },
  );
  const knownDatasourceName = chooseKnownDatasourceName(input);
  const selections: SelectedTool[] = [];
  const plannedTools: string[] = [];
  const blockedTools: string[] = [];

  if (
    knownDatasourceWithId &&
    allowedToolNames.includes("get-datasource-metadata")
  ) {
    const metadataTool = tools.find(
      (tool) => tool.name === "get-datasource-metadata",
    );
    if (metadataTool) {
      const args = inferPlannedToolArguments(
        metadataTool,
        {
          datasourceLuid: readString(knownDatasourceWithId.id),
        },
        input,
      );
      if (args) {
        selections.push({
          status: "ready",
          tool: metadataTool,
          arguments: args,
          reason:
            "Dashboard context already has datasource id. Retrieve datasource fields directly.",
        });
        plannedTools.push("get-datasource-metadata");
      }
    }
  } else if (knownDatasourceName) {
    const listDatasourcesSelection = buildReadySelectionFromToolName(
      tools,
      "list-datasources",
      input,
      {
        reason:
          "Resolve datasource id from dashboard datasource name before metadata lookup.",
        allowlist: allowedToolNames,
      },
    );
    if (listDatasourcesSelection) {
      selections.push(listDatasourcesSelection);
      plannedTools.push("list-datasources");
    } else {
      const searchContentSelection = buildReadySelectionFromToolName(
        tools,
        "search-content",
        input,
        {
          reason:
            "Resolve datasource id from Tableau Cloud content search before metadata lookup.",
          allowlist: allowedToolNames,
        },
      );
      if (searchContentSelection) {
        selections.push(searchContentSelection);
        plannedTools.push("search-content");
      } else {
        blockedTools.push("list-datasources");
        blockedTools.push("search-content");
        return {
          selections: [],
          blockedTools,
          plannedTools,
          reasonBrief:
            "Datasource names are known, but datasource-resolution tools are not allowlisted.",
          stopFallback: true,
        };
      }
    }
  } else {
    const workbookResolutionTools = [
      "list-views",
      "list-workbooks",
      "get-workbook",
    ] as const;
    for (const toolName of workbookResolutionTools) {
      const selection = buildReadySelectionFromToolName(
        tools,
        toolName,
        input,
        {
          reason:
            "Resolve workbook/view context to infer datasource candidates.",
          allowlist: allowedToolNames,
        },
      );
      if (selection) {
        selections.push(selection);
        plannedTools.push(toolName);
      }
      if (selections.length >= maxToolCalls) {
        break;
      }
    }
  }

  return {
    selections: selections.slice(0, maxToolCalls),
    blockedTools,
    plannedTools,
    reasonBrief:
      selections.length > 0
        ? "Applied rule-based metadata lookup flow before planner."
        : "No safe rule-based metadata flow available.",
    stopFallback: false,
  };
}

function buildReadySelectionFromToolName(
  tools: McpTool[],
  toolName: string,
  input: GetAdditionalContextInput,
  options: {
    reason: string;
    allowlist: string[];
  },
): SelectedTool | undefined {
  if (!options.allowlist.includes(toolName)) {
    return undefined;
  }

  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return undefined;
  }

  const args = inferToolArguments(tool, input);
  if (!args) {
    return undefined;
  }

  return {
    status: "ready",
    tool,
    arguments: args,
    reason: options.reason,
  };
}

async function selectPlannedTools(
  tools: McpTool[],
  allowedTools: string[],
  input: GetAdditionalContextInput,
  intent: ClassifiedQuestionIntent,
  maxToolCalls: number,
  options: {
    observations?: TableauMcpToolResultSummary[];
    calledToolNames?: Set<string>;
    preferredRecoveryTools?: string[];
  } = {},
): Promise<{
  selections: SelectedTool[];
  blockedTools: string[];
  plannedTools: string[];
  reasonBrief?: string;
}> {
  const config = getConfig();
  if (
    !config.tableau.mcp.toolPlanningEnabled ||
    maxToolCalls <= 0 ||
    !intent.needsMcp
  ) {
    return { selections: [], blockedTools: [], plannedTools: [] };
  }

  const planner = new TableauMcpToolPlanner();
  const allowedToolNames = resolveAllowedToolNames(tools, allowedTools);
  const plan = await planner.plan({
    question: input.question,
    dashboardContext: input.dashboardContext,
    tools,
    maxToolCalls,
    allowedToolNames,
    observations: options.observations,
    previouslyCalledToolNames: [...(options.calledToolNames ?? [])],
    intentHint: intent,
  });

  if (!plan?.toolCalls.length) {
    return {
      selections: [],
      blockedTools: [],
      plannedTools: [],
      reasonBrief: plan?.reasonBrief ?? intent.reasonBrief,
    };
  }

  const blockedTools: string[] = [];
  const plannedTools = plan.toolCalls.map((call) => call.toolName);
  const plannedSelections = plan.toolCalls
    .filter(
      (call) =>
        !(
          options.preferredRecoveryTools?.length &&
          call.toolName === "get-datasource-metadata"
        ),
    )
    .map((call) =>
      buildSelectionFromPlannedCall(
        call,
        tools,
        allowedToolNames,
        input,
        options.calledToolNames ?? new Set<string>(),
        blockedTools,
      ),
    );
  const recoverySelections =
    options.preferredRecoveryTools?.flatMap((toolName) => {
      if (options.calledToolNames?.has(toolName)) {
        return [];
      }
      const selection = buildReadySelectionFromToolName(
        tools,
        toolName,
        input,
        {
          reason: "Recovery step to resolve datasource/workbook identifiers.",
          allowlist: allowedToolNames,
        },
      );
      return selection ? [selection] : [];
    }) ?? [];
  const seenTools = new Set<string>();
  const selections = [...recoverySelections, ...plannedSelections].filter(
    (selection) => {
      const toolName = getSelectionToolName(selection);
      if (seenTools.has(toolName)) {
        return false;
      }

      seenTools.add(toolName);
      return true;
    },
  );
  logInfo("tableau.mcp.tools.planned", {
    availableToolCount: tools.length,
    selectedTools: selections.map(getSelectionToolName),
    allowlistSource: getAllowlistSource(allowedTools),
    readyToolCount: selections.filter(
      (selection) => selection.status === "ready",
    ).length,
    skippedToolCount: selections.filter(
      (selection) => selection.status === "skipped",
    ).length,
    blockedTools,
    intent: plan.intent,
    reasonBrief: plan.reasonBrief,
  });

  return {
    selections,
    blockedTools,
    plannedTools,
    reasonBrief: plan.reasonBrief,
  };
}

function getAllowlistSource(
  allowedTools: string[],
): "configured" | "dynamic_mcp" {
  return allowedTools.length > 0 ? "configured" : "dynamic_mcp";
}

function buildSelectionFromPlannedCall(
  call: PlannedMcpToolCall,
  tools: McpTool[],
  allowedToolNames: string[],
  input: GetAdditionalContextInput,
  calledToolNames: Set<string>,
  blockedTools: string[],
): SelectedTool {
  const tool = tools.find((candidate) => candidate.name === call.toolName);
  if (!tool) {
    blockedTools.push(call.toolName);
    return {
      status: "skipped",
      toolName: call.toolName,
      warning: "Planned tool is not available from the MCP server.",
    };
  }

  if (!allowedToolNames.includes(tool.name)) {
    blockedTools.push(tool.name);
    return {
      status: "skipped",
      toolName: tool.name,
      warning: "Planned tool is not allowlisted.",
    };
  }

  if (calledToolNames.has(tool.name)) {
    return {
      status: "skipped",
      toolName: tool.name,
      warning: "Planned tool was already called.",
    };
  }

  const args = inferPlannedToolArguments(tool, call.arguments, input);
  if (!args) {
    blockedTools.push(tool.name);
    return {
      status: "skipped",
      toolName: tool.name,
      warning: "Planned tool arguments could not be validated safely.",
    };
  }

  return {
    status: "ready",
    tool,
    arguments: args,
    reason: call.purpose ?? call.reason,
    dependsOnTool: call.dependsOnTool,
  };
}

function getSelectionToolName(selection: SelectedTool): string {
  return selection.status === "ready"
    ? selection.tool.name
    : selection.toolName;
}

const PARALLEL_SAFE_TOOL_NAMES = new Set([
  "list-workbooks",
  "list-views",
  "list-datasources",
  "search-content",
  "get-workbook",
  "get-datasource-metadata",
]);

function collectParallelizableToolBatch(
  toolQueue: SelectedTool[],
  calledToolNames: Set<string>,
): Extract<SelectedTool, { status: "ready" }>[] {
  const scheduledToolNames = new Set(calledToolNames);
  const batch: Extract<SelectedTool, { status: "ready" }>[] = [];

  for (const selection of toolQueue) {
    if (selection.status !== "ready") {
      break;
    }

    if (selection.dependsOnTool) {
      break;
    }

    if (!PARALLEL_SAFE_TOOL_NAMES.has(selection.tool.name)) {
      break;
    }

    if (scheduledToolNames.has(selection.tool.name)) {
      break;
    }

    batch.push(selection);
    scheduledToolNames.add(selection.tool.name);

    if (batch.length >= 3) {
      break;
    }
  }

  return batch;
}

async function processSelectionOutcome(params: {
  selection: Extract<SelectedTool, { status: "ready" }>;
  startedAt: number;
  resolved?: {
    result: unknown;
    cacheHit: boolean;
    queryDebug?: QueryDatasourceExecutionDebug;
  };
  error?: unknown;
  tools: McpTool[];
  loopInput: GetAdditionalContextInput;
  intent: ClassifiedQuestionIntent;
  calledToolNames: Set<string>;
  toolResults: TableauMcpToolResultSummary[];
  rawToolResults: RawMcpToolResult[];
  observations: McpObservation[];
  recoverablePreconditionSuggestions: Set<string>;
  setRecoverablePreconditionFailure: (value: boolean) => void;
  debugLogResults: boolean;
}): Promise<{ followUp?: SelectedTool; countedExecution: boolean }> {
  const {
    selection,
    startedAt,
    resolved,
    error,
    tools,
    loopInput,
    intent,
    calledToolNames,
    toolResults,
    rawToolResults,
    observations,
    recoverablePreconditionSuggestions,
    setRecoverablePreconditionFailure,
    debugLogResults,
  } = params;

  if (error) {
    const errorMessage = summarizeErrorMessage(error);
    logWarn("tableau.mcp.tool.failed", {
      toolName: selection.tool.name,
      ...safeErrorDetails(error),
    });
    toolResults.push({
      toolName: selection.tool.name,
      status: "failed",
      warning: errorMessage,
    });
    observations.push({
      tool: selection.tool.name,
      purpose: selection.reason ?? "Collect Tableau Cloud context",
      argsSummary: summarizeToolArguments(selection.arguments),
      success: false,
      resultSummary: "",
      errorMessage,
    });
    if (
      intent.intent === "metadata_lookup" &&
      selection.tool.name === "get-datasource-metadata"
    ) {
      setRecoverablePreconditionFailure(true);
      for (const toolName of [
        "list-datasources",
        "search-content",
        "list-views",
        "get-workbook",
        "list-workbooks",
      ]) {
        recoverablePreconditionSuggestions.add(toolName);
      }
    }
    return { countedExecution: false };
  }

  if (!resolved) {
    throw new Error("Tool execution outcome was not resolved.");
  }

  const result = resolved.result;
  if (isMcpErrorResult(result)) {
    const errorCategory = classifyMcpErrorCategory(result);
    const errorMessage = buildMcpErrorMessage(result, errorCategory);
    toolResults.push({
      toolName: selection.tool.name,
      status: "failed",
      warning: errorMessage,
    });
    rawToolResults.push({
      toolName: selection.tool.name,
      result,
      ...(resolved?.queryDebug ? { debug: resolved.queryDebug } : {}),
    });
    observations.push({
      tool: selection.tool.name,
      purpose: selection.reason ?? "Collect Tableau Cloud context",
      argsSummary: summarizeToolArguments(selection.arguments),
      success: false,
      resultSummary: errorCategory,
      errorMessage,
      rawResultPreview: summarizeToolResultPreview(result),
    });
    calledToolNames.add(selection.tool.name);
    const errorText = extractTextFromToolResult(result);
    if (selection.tool.name === "query-datasource") {
      logDebug("tableau.mcp.query.execution_failed", {
        toolName: selection.tool.name,
        durationMs: Date.now() - startedAt,
        errorCategory,
        errorPreview: errorText.slice(0, 220),
        queryArgsSummary: summarizeQueryDatasourceArgs(selection.arguments),
      });
    }
    logWarn("tableau.mcp.tool.error_result", {
      toolName: selection.tool.name,
      durationMs: Date.now() - startedAt,
      errorCategory,
      textLength: errorText.length,
      textHash: safeHash(errorText),
    });
    if (
      intent.intent === "metadata_lookup" &&
      selection.tool.name === "get-datasource-metadata"
    ) {
      setRecoverablePreconditionFailure(true);
      for (const toolName of [
        "list-datasources",
        "search-content",
        "list-views",
        "get-workbook",
        "list-workbooks",
      ]) {
        recoverablePreconditionSuggestions.add(toolName);
      }
    }
    return { countedExecution: true };
  }

  const resultSummary = summarizeToolResult(result);
  toolResults.push({
    toolName: selection.tool.name,
    status: "success",
    summary: resultSummary,
  });
  rawToolResults.push({
    toolName: selection.tool.name,
    result,
    args: selection.arguments,
    ...(resolved?.queryDebug ? { debug: resolved.queryDebug } : {}),
  });
  observations.push({
    tool: selection.tool.name,
    purpose: selection.reason ?? "Collect Tableau Cloud context",
    argsSummary: summarizeToolArguments(selection.arguments),
    success: true,
    resultSummary,
    rawResultPreview: summarizeToolResultPreview(result),
  });
  logMcpToolResultDebug(selection.tool.name, result, debugLogResults);
  calledToolNames.add(selection.tool.name);
  logInfo("tableau.mcp.tool.completed", {
    toolName: selection.tool.name,
    durationMs: Date.now() - startedAt,
    cacheHit: resolved.cacheHit,
  });

  const followUp = buildFollowUpToolSelection(
    selection.tool.name,
    result,
    tools,
    calledToolNames,
    loopInput,
  );
  return {
    countedExecution: true,
    followUp,
  };
}

export function inferPlannedToolArguments(
  tool: McpTool,
  plannedArguments: Record<string, unknown> | undefined,
  input: GetAdditionalContextInput,
): Record<string, unknown> | undefined {
  const knownArguments = inferKnownToolArguments(tool.name, input);
  const merged = {
    ...(knownArguments ?? {}),
    ...(plannedArguments ?? {}),
  };

  if (tool.name === "query-datasource") {
    return validateQueryDatasourceArguments(merged, input);
  }

  const required = tool.inputSchema?.required ?? [];
  for (const propertyName of required) {
    if (
      merged[propertyName] === undefined ||
      merged[propertyName] === null ||
      merged[propertyName] === ""
    ) {
      const inferred = inferValueForProperty(propertyName, input);
      if (inferred === undefined) {
        return undefined;
      }

      merged[propertyName] = inferred;
    }
  }

  const validated = validateArgumentsAgainstSchema(
    merged,
    tool.inputSchema?.properties ?? {},
  );
  if (!validated) {
    return undefined;
  }

  return validateToolSpecificArguments(
    tool.name,
    validated,
    input,
    tool.inputSchema?.required ?? [],
  );
}

export function checkToolPreconditions(
  toolName: string,
  args: Record<string, unknown>,
  state: McpExecutionState,
): ToolPreconditionResult {
  if (toolName !== "get-datasource-metadata") {
    return { ok: true };
  }

  const directIdentifier = readDatasourceIdentifierFromArgs(args);
  if (directIdentifier) {
    return { ok: true };
  }

  const resolvedFromObservations = resolveDatasourceIdentifier(
    state.dashboardContext.dataSources?.map((datasource) => datasource.name) ??
      [],
    [],
    [],
    {
      rawToolResults: state.rawToolResults,
      workbookName: state.dashboardContext.workbookName ?? undefined,
      dashboardName: state.dashboardContext.dashboardName,
      viewName: state.dashboardContext.viewName ?? undefined,
      worksheetNames: state.dashboardContext.worksheets.map(
        (worksheet) => worksheet.name,
      ),
    },
  );
  if (
    resolvedFromObservations.some((candidate) =>
      hasResolvableDatasourceIdentifier(candidate),
    )
  ) {
    return {
      ok: false,
      recoverable: true,
      reason:
        "Datasource candidate was found but identifier has not been bound to metadata tool arguments yet.",
      suggestedTools: ["list-datasources", "search-content"],
    };
  }

  const knownIds = state.dashboardContext.dataSources
    ?.map((datasource) => readString(datasource.id))
    .filter((value): value is string => Boolean(value));
  if (knownIds?.length) {
    return {
      ok: false,
      recoverable: true,
      reason:
        "Datasource id exists in dashboard context but is not bound to get-datasource-metadata arguments.",
      suggestedTools: ["list-datasources"],
    };
  }

  const knownNames = state.dashboardContext.dataSources
    ?.map((datasource) => readString(datasource.name))
    .filter((value): value is string => Boolean(value));
  if (knownNames?.length) {
    return {
      ok: false,
      recoverable: true,
      reason:
        "Datasource identifier is missing. Resolve datasource id from datasource name first.",
      suggestedTools: ["list-datasources", "search-content"],
    };
  }

  if (
    !state.calledToolNames.has("list-views") ||
    !state.calledToolNames.has("list-workbooks")
  ) {
    return {
      ok: false,
      recoverable: true,
      reason:
        "Datasource identifier is missing. Resolve workbook/view context first.",
      suggestedTools: [
        "list-views",
        "list-workbooks",
        "get-workbook",
        "search-content",
      ],
    };
  }

  return {
    ok: false,
    recoverable: false,
    reason: "Datasource identifier is still unresolved after context lookup.",
  };
}

function validateArgumentsAgainstSchema(
  args: Record<string, unknown>,
  properties: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const validKeys = Object.keys(properties);
  if (!validKeys.length) {
    return args;
  }

  const sanitized = Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        validKeys.includes(key) && isSafeToolArgumentValue(value, 0),
    ),
  );
  return sanitized;
}

function validateToolSpecificArguments(
  toolName: string,
  args: Record<string, unknown>,
  input: GetAdditionalContextInput,
  required: string[],
): Record<string, unknown> | undefined {
  if (toolName === "get-workbook") {
    const workbookId =
      readString(args.workbookId) ??
      readString(args.workbookLuid) ??
      readString(args.id) ??
      readString(args.workbook_id);
    if (!workbookId || !looksLikeIdentifier(workbookId)) {
      return undefined;
    }

    return args;
  }

  if (toolName === "get-datasource-metadata") {
    const identifier = readDatasourceIdentifierFromArgs(args);
    if (!identifier) {
      return undefined;
    }

    const knownDatasourceNames = new Set(
      input.dashboardContext.dataSources
        ?.map((datasource) => datasource.name.trim().toLowerCase())
        .filter(Boolean) ?? [],
    );
    if (knownDatasourceNames.has(identifier.trim().toLowerCase())) {
      return undefined;
    }

    const requiredLower = required.map((key) => key.toLowerCase());
    const requiresIdLike = requiredLower.some(
      (key) =>
        key.includes("id") ||
        key.includes("luid") ||
        key.includes("contenturl"),
    );
    if (requiresIdLike && !looksLikeIdentifier(identifier)) {
      return undefined;
    }

    return args;
  }

  return args;
}

function validateQueryDatasourceArguments(
  args: Record<string, unknown>,
  input: GetAdditionalContextInput,
): Record<string, unknown> | undefined {
  const config = getConfig().tableau.mcp;
  const datasourceLuid =
    readString(args.datasourceLuid) ?? readString(args.datasourceId);
  const query = args.query;
  if (
    !datasourceLuid ||
    !query ||
    typeof query !== "object" ||
    Array.isArray(query)
  ) {
    logDebug("tableau.mcp.query.validation_rejected", {
      reason: "missing_datasource_or_query",
      queryArgsSummary: summarizeQueryDatasourceArgs(args),
    });
    return undefined;
  }

  const knownDatasourceIds = new Set(
    input.dashboardContext.dataSources
      ?.map((datasource) => readString(datasource.id))
      .filter((id): id is string => Boolean(id && looksLikeIdentifier(id))) ??
      [],
  );
  if (knownDatasourceIds.size > 0 && !knownDatasourceIds.has(datasourceLuid)) {
    logDebug("tableau.mcp.query.validation_rejected", {
      reason: "datasource_not_in_dashboard_context",
      queryArgsSummary: summarizeQueryDatasourceArgs(args),
      knownDatasourceIdCount: knownDatasourceIds.size,
      datasourceLuidHash: safeHash(datasourceLuid),
    });
    return undefined;
  }

  const queryRecord = query as Record<string, unknown>;
  const fieldsBeforeDedupe = Array.isArray(queryRecord.fields)
    ? queryRecord.fields.filter(
        (field): field is Record<string, unknown> =>
          Boolean(field) && typeof field === "object" && !Array.isArray(field),
      )
    : undefined;
  const dedupedFields = fieldsBeforeDedupe
    ? dedupeQueryDatasourceFields(fieldsBeforeDedupe)
    : undefined;
  if (
    !dedupedFields ||
    dedupedFields.length === 0 ||
    dedupedFields.length > Math.max(config.queryDatasourceMaxFields, 1)
  ) {
    logDebug("tableau.mcp.query.validation_rejected", {
      reason: "field_count_out_of_bounds",
      queryArgsSummary: summarizeQueryDatasourceArgs(args),
      queryFieldsBeforeDedupe: summarizeQueryFieldSpecs(
        fieldsBeforeDedupe ?? [],
      ),
      queryFieldsAfterDedupe: summarizeQueryFieldSpecs(dedupedFields ?? []),
      maxFields: Math.max(config.queryDatasourceMaxFields, 1),
    });
    return undefined;
  }

  if (!containsAggregateField(dedupedFields)) {
    logDebug("tableau.mcp.query.validation_rejected", {
      reason: "missing_aggregate_field",
      queryArgsSummary: summarizeQueryDatasourceArgs(args),
      queryFieldsBeforeDedupe: summarizeQueryFieldSpecs(
        fieldsBeforeDedupe ?? [],
      ),
      queryFieldsAfterDedupe: summarizeQueryFieldSpecs(dedupedFields ?? []),
    });
    return undefined;
  }

  if (
    containsSensitiveFieldName(dedupedFields) ||
    containsSensitiveFieldNameFromFilters(queryRecord.filters)
  ) {
    logDebug("tableau.mcp.query.validation_rejected", {
      reason: "sensitive_field_detected",
      queryArgsSummary: summarizeQueryDatasourceArgs(args),
      queryFieldsBeforeDedupe: summarizeQueryFieldSpecs(
        fieldsBeforeDedupe ?? [],
      ),
      queryFieldsAfterDedupe: summarizeQueryFieldSpecs(dedupedFields ?? []),
    });
    return undefined;
  }

  const limit =
    typeof args.limit === "number"
      ? Math.floor(args.limit)
      : Math.floor(config.queryDatasourceMaxLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    logDebug("tableau.mcp.query.validation_rejected", {
      reason: "invalid_limit",
      queryArgsSummary: summarizeQueryDatasourceArgs(args),
      maxLimit: config.queryDatasourceMaxLimit,
    });
    return undefined;
  }

  return {
    datasourceLuid,
    query: {
      ...queryRecord,
      fields: dedupedFields,
    },
    limit: Math.min(limit, config.queryDatasourceMaxLimit),
  };
}

function containsAggregateField(fields: unknown[]): boolean {
  return fields.some((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      return false;
    }

    const fn = readString(
      (field as Record<string, unknown>).function,
    )?.toUpperCase();
    if (!fn) {
      return false;
    }

    return [
      "SUM",
      "AVG",
      "MEDIAN",
      "COUNT",
      "COUNTD",
      "MIN",
      "MAX",
      "STDEV",
      "VAR",
      "YEAR",
      "QUARTER",
      "MONTH",
      "WEEK",
      "DAY",
      "TRUNC_YEAR",
      "TRUNC_QUARTER",
      "TRUNC_MONTH",
      "TRUNC_WEEK",
      "TRUNC_DAY",
      "AGG",
    ].includes(fn);
  });
}

function containsSensitiveFieldName(fields: unknown[]): boolean {
  const sensitivePattern =
    /(email|e-mail|phone|tel|mobile|address|ssn|social|credit[\s_-]*card|token|secret|password|cookie|authorization|bearer|api[\s_-]*key|\buser[\s_-]*id\b|\bemployee[\s_-]*id\b)/i;
  return fields.some((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      return false;
    }

    const caption = readString((field as Record<string, unknown>).fieldCaption);
    return Boolean(caption && sensitivePattern.test(caption));
  });
}

function containsSensitiveFieldNameFromFilters(filters: unknown): boolean {
  if (!Array.isArray(filters)) {
    return false;
  }

  const sensitivePattern =
    /(email|phone|address|ssn|credit[\s_-]*card|token|secret|password|cookie|authorization|bearer|api[\s_-]*key|\buser[\s_-]*id\b|\bemployee[\s_-]*id\b)/i;
  return filters.some((filter) => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      return false;
    }

    const field = (filter as Record<string, unknown>).field;
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      return false;
    }

    const caption = readString((field as Record<string, unknown>).fieldCaption);
    return Boolean(caption && sensitivePattern.test(caption));
  });
}

function isSafeToolArgumentValue(value: unknown, depth: number): boolean {
  if (depth > 5) {
    return false;
  }

  if (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return (
      value.length <= 50 &&
      value.every((item) => isSafeToolArgumentValue(item, depth + 1))
    );
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every((item) =>
      isSafeToolArgumentValue(item, depth + 1),
    );
  }

  return false;
}

function getDefaultToolCandidates(
  tools: McpTool[],
  input: GetAdditionalContextInput,
): McpTool[] {
  const preferredNames = isDatasourceAnalysisQuestion(input.question)
    ? ["list-datasources", "get-datasource-metadata"]
    : input.dashboardContext.workbookName
      ? [
          "list-workbooks",
          "get-workbook",
          "list-views",
          "list-datasources",
          "search-content",
        ]
      : ["list-views", "search-content", "list-workbooks", "list-datasources"];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const preferred = preferredNames.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [tool] : [];
  });

  if (preferred.length) {
    return preferred;
  }

  return tools
    .filter((tool) =>
      /list.*workbook|list.*view|list.*datasource|get.*datasource.*metadata|search.*content/i.test(
        tool.name,
      ),
    )
    .sort(
      (left, right) => getToolPriority(left.name) - getToolPriority(right.name),
    );
}

function getToolPriority(toolName: string): number {
  if (toolName === "list-workbooks") {
    return 10;
  }
  if (toolName === "get-workbook") {
    return 20;
  }
  if (toolName === "list-views") {
    return 30;
  }
  if (toolName === "list-datasources") {
    return 40;
  }
  if (toolName === "get-datasource-metadata") {
    return 45;
  }
  if (toolName === "search-content") {
    return 50;
  }
  return 100;
}

export function buildMetadataIdentifierRecoverySelection(input: {
  tools: McpTool[];
  allowedToolNames: string[];
  input: GetAdditionalContextInput;
  intent: ClassifiedQuestionIntent;
  calledToolNames: Set<string>;
  rawToolResults: RawMcpToolResult[];
  observations: McpObservation[];
  remainingToolBudget: number;
}): SelectedTool | undefined {
  if (
    input.intent.intent !== "metadata_lookup" ||
    input.remainingToolBudget <= 0
  ) {
    return undefined;
  }

  const knownDatasourceNames =
    input.input.dashboardContext.dataSources
      ?.map((datasource) => datasource.name.trim())
      .filter(Boolean) ?? [];
  if (!knownDatasourceNames.length) {
    return undefined;
  }

  const resolved = resolveDatasourceIdentifier(
    knownDatasourceNames,
    input.observations,
    input.tools,
    {
      rawToolResults: input.rawToolResults,
      workbookName: input.input.dashboardContext.workbookName ?? undefined,
      dashboardName: input.input.dashboardContext.dashboardName,
      viewName: input.input.dashboardContext.viewName ?? undefined,
      worksheetNames: input.input.dashboardContext.worksheets.map(
        (worksheet) => worksheet.name,
      ),
    },
  );
  const matchedDatasourceCount = resolved.length;
  const selectedIdentifierPresent = resolved.some(
    hasResolvableDatasourceIdentifier,
  );
  const listDatasourcesCalled =
    input.calledToolNames.has("list-datasources") ||
    input.rawToolResults.some(
      (result) => result.toolName === "list-datasources",
    );
  const searchContentCalled =
    input.calledToolNames.has("search-content") ||
    input.rawToolResults.some((result) => result.toolName === "search-content");

  if (matchedDatasourceCount <= 0 || selectedIdentifierPresent) {
    return undefined;
  }

  if (!listDatasourcesCalled) {
    const selection = buildReadySelectionFromToolName(
      input.tools,
      "list-datasources",
      input.input,
      {
        reason:
          "Recovery step: resolve datasource identifier from datasource listing.",
        allowlist: input.allowedToolNames,
      },
    );
    if (selection) {
      return selection;
    }
  }

  if (listDatasourcesCalled && !searchContentCalled) {
    const selection = buildReadySelectionFromToolName(
      input.tools,
      "search-content",
      input.input,
      {
        reason:
          "Recovery step: resolve datasource identifier from content search.",
        allowlist: input.allowedToolNames,
      },
    );
    if (selection) {
      return selection;
    }
  }

  return undefined;
}

export function buildDataAnalysisQueryRecoverySelection(input: {
  tools: McpTool[];
  allowedToolNames: string[];
  input: GetAdditionalContextInput;
  intent: ClassifiedQuestionIntent;
  calledToolNames: Set<string>;
  rawToolResults: RawMcpToolResult[];
  observations: McpObservation[];
  remainingToolBudget: number;
}): SelectedTool | undefined {
  if (!["metadata_lookup", "data_analysis"].includes(input.intent.intent)) {
    return undefined;
  }

  if (
    input.input.questionInterpretation?.requestType === "field_inventory" ||
    input.input.questionInterpretation?.requestType === "datasource_inventory"
  ) {
    return undefined;
  }

  if (
    input.remainingToolBudget <= 0 ||
    input.calledToolNames.has("query-datasource")
  ) {
    return undefined;
  }

  if (!isAggregateAnalysisQuestion(input.input.question)) {
    return undefined;
  }

  const queryTool = input.tools.find(
    (tool) => tool.name === "query-datasource",
  );
  if (!queryTool || !input.allowedToolNames.includes("query-datasource")) {
    return undefined;
  }

  const knownDatasourceNames =
    input.input.dashboardContext.dataSources
      ?.map((datasource) => datasource.name.trim())
      .filter(Boolean) ?? [];
  if (!knownDatasourceNames.length) {
    return undefined;
  }

  const resolved = resolveDatasourceIdentifier(
    knownDatasourceNames,
    input.observations,
    input.tools,
    {
      rawToolResults: input.rawToolResults,
      workbookName: input.input.dashboardContext.workbookName ?? undefined,
      dashboardName: input.input.dashboardContext.dashboardName,
      viewName: input.input.dashboardContext.viewName ?? undefined,
      worksheetNames: input.input.dashboardContext.worksheets.map(
        (worksheet) => worksheet.name,
      ),
    },
  );
  const selectedDatasource = selectBestResolvedDatasource(resolved);
  if (!selectedDatasource) {
    return undefined;
  }

  const plannedArgs = buildAggregateQueryDatasourceArgs(
    selectedDatasource,
    input.rawToolResults,
    input.input.questionInterpretation ??
      interpretQuestion({
        question: input.input.question,
        dashboardContext: input.input.dashboardContext,
      }),
  );
  if (!plannedArgs) {
    logInfo("tableau.mcp.query.recovery_skipped", {
      reason: "aggregate_query_args_not_buildable",
      resolvedDatasourceCount: resolved.length,
    });
    return undefined;
  }

  const args = inferPlannedToolArguments(queryTool, plannedArgs, input.input);
  if (!args) {
    logInfo("tableau.mcp.query.recovery_skipped", {
      reason: "aggregate_query_args_rejected_by_safety_guards",
      resolvedDatasourceCount: resolved.length,
    });
    return undefined;
  }

  return {
    status: "ready",
    tool: queryTool,
    arguments: args,
    reason:
      "Run a small aggregate datasource query to answer ranking/comparison analysis questions.",
  };
}

function shouldReplanForDatasourceQuery(
  intent: ClassifiedQuestionIntent,
  toolResults: TableauMcpToolResultSummary[],
  calledToolNames: Set<string>,
  hasRecoverablePreconditionFailure: boolean,
  recoverablePreconditionSuggestions: Set<string>,
  analysisIntentQuestion: boolean,
): boolean {
  if (!getConfig().tableau.mcp.toolPlanningEnabled) {
    return false;
  }

  const metadataLookupNeedsRecovery =
    intent.intent === "metadata_lookup" &&
    (hasRecoverablePreconditionFailure ||
      toolResults.some(
        (result) =>
          result.toolName === "get-datasource-metadata" &&
          (result.status === "failed" || result.status === "skipped"),
      ));
  const dataAnalysisNeedsRecovery =
    (intent.intent === "data_analysis" ||
      (intent.intent === "metadata_lookup" && analysisIntentQuestion)) &&
    !calledToolNames.has("query-datasource") &&
    toolResults.some(
      (result) =>
        result.status === "success" &&
        ["list-datasources", "get-datasource-metadata"].includes(
          result.toolName,
        ),
    );

  if (!metadataLookupNeedsRecovery && !dataAnalysisNeedsRecovery) {
    return false;
  }

  if (!metadataLookupNeedsRecovery) {
    return dataAnalysisNeedsRecovery;
  }

  const hasSuggestedRecoveryTool = [...recoverablePreconditionSuggestions].some(
    (toolName) =>
      [
        "list-datasources",
        "search-content",
        "list-views",
        "get-workbook",
        "list-workbooks",
      ].includes(toolName),
  );
  const hasAnyRecoveryToolAttempted = toolResults.some((result) =>
    [
      "list-datasources",
      "search-content",
      "list-views",
      "get-workbook",
      "list-workbooks",
    ].includes(result.toolName),
  );

  return hasSuggestedRecoveryTool || !hasAnyRecoveryToolAttempted;
}

function isDataQuestion(question: string): boolean {
  return /view|views|count|sum|average|avg|rank|ranking|top|bottom|trend|month|week|day|date|record|row|data|datasource|データ|集計|ランキング|推移|日|週|月/i.test(
    question,
  );
}

function isAggregateAnalysisQuestion(question: string): boolean {
  return /query|aggregate|max|min|highest|lowest|most|least|top|bottom|rank|ranking|compare|sum|average|avg|count|countd|trend|increase|decrease|growth|クエリ|集計|最大|最小|最も|最多|ランキング|比較|推移|傾向|洗い出し|高い|低い|ごと|別|ハッシュタグ|増加|減少|直近|過去|今週|先週|今月|先月|今年|昨年|去年/.test(
    question.toLowerCase(),
  );
}

function isDatasourceAnalysisQuestion(question: string): boolean {
  return (
    isDataQuestion(question) ||
    /metadata|field|schema|column|datasource|フィールド|データソース|メタデータ|列|項目|値|傾向/i.test(
      question,
    )
  );
}

async function executeToolWithCache(input: {
  client: Client;
  toolName: string;
  args: Record<string, unknown>;
  tableauSubject: string | undefined;
  timeoutMs: number;
}): Promise<{
  result: unknown;
  cacheHit: boolean;
  queryDebug?: QueryDatasourceExecutionDebug;
}> {
  const config = getConfig().tableau.mcp;
  const queryNormalization =
    input.toolName === "query-datasource"
      ? normalizeQueryDatasourceArguments(input.args)
      : undefined;
  const executionArgs = queryNormalization?.normalizedArgs ?? input.args;
  if (!config.metadataCacheEnabled || !isCacheableToolName(input.toolName)) {
    if (input.toolName === "query-datasource") {
      logInfo("tableau.mcp.query.execution_started", {
        queryDatasourceCalled: true,
        queryFieldsBeforeDedupe:
          queryNormalization?.queryFieldsBeforeDedupe ?? [],
        queryFieldsAfterDedupe:
          queryNormalization?.queryFieldsAfterDedupe ?? [],
        dedupedFieldCount: queryNormalization?.dedupedFieldCount ?? 0,
        queryArgsSummary: summarizeQueryDatasourceArgs(executionArgs),
      });
    }
    const result = await callMcpToolWithQueryRetry({
      client: input.client,
      toolName: input.toolName,
      args: executionArgs,
      timeoutMs: input.timeoutMs,
      queryNormalization,
    });
    return {
      result: result.result,
      cacheHit: false,
      ...(result.queryDebug ? { queryDebug: result.queryDebug } : {}),
    };
  }

  pruneMetadataToolCache();
  const cacheKey = buildCacheKey(
    input.tableauSubject,
    input.toolName,
    executionArgs,
  );
  const cached = metadataToolCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logDebug("tableau.mcp.metadata_cache.hit", {
      toolName: input.toolName,
      cacheSource: "memory",
    });
    return { result: cached.result, cacheHit: true };
  }

  try {
    const persisted = await metadataCacheRepository.get(cacheKey);
    if (persisted !== null) {
      metadataToolCache.set(cacheKey, {
        result: persisted,
        expiresAt: Date.now() + Math.max(config.metadataCacheTtlMs, 1000),
      });
      logDebug("tableau.mcp.metadata_cache.hit", {
        toolName: input.toolName,
        cacheSource: "dynamo",
      });
      return { result: persisted, cacheHit: true };
    }
  } catch (error) {
    logWarn("tableau.mcp.metadata_cache.read_failed", {
      toolName: input.toolName,
      ...safeErrorDetails(error),
    });
  }

  if (input.toolName === "query-datasource") {
    logInfo("tableau.mcp.query.execution_started", {
      queryDatasourceCalled: true,
      queryFieldsBeforeDedupe:
        queryNormalization?.queryFieldsBeforeDedupe ?? [],
      queryFieldsAfterDedupe: queryNormalization?.queryFieldsAfterDedupe ?? [],
      dedupedFieldCount: queryNormalization?.dedupedFieldCount ?? 0,
      queryArgsSummary: summarizeQueryDatasourceArgs(executionArgs),
    });
  }
  const result = await callMcpToolWithQueryRetry({
    client: input.client,
    toolName: input.toolName,
    args: executionArgs,
    timeoutMs: input.timeoutMs,
    queryNormalization,
  });
  metadataToolCache.set(cacheKey, {
    result: result.result,
    expiresAt: Date.now() + Math.max(config.metadataCacheTtlMs, 1000),
  });
  try {
    await metadataCacheRepository.put({
      cacheKey,
      subjectHash: safeHash(input.tableauSubject) ?? "anonymous",
      toolName: input.toolName,
      argsHash: safeHash(stableStringify(executionArgs)) ?? "unknown",
      result: result.result,
      createdAt: new Date().toISOString(),
      expiresAt:
        Math.floor(Date.now() / 1000) +
        Math.max(
          1,
          Math.floor(Math.max(config.metadataCacheTtlMs, 1000) / 1000),
        ),
    });
    logDebug("tableau.mcp.metadata_cache.stored", {
      toolName: input.toolName,
      cacheSource: "dynamo",
    });
  } catch (error) {
    logWarn("tableau.mcp.metadata_cache.write_failed", {
      toolName: input.toolName,
      ...safeErrorDetails(error),
    });
  }
  return {
    result: result.result,
    cacheHit: false,
    ...(result.queryDebug ? { queryDebug: result.queryDebug } : {}),
  };
}

async function callMcpToolWithQueryRetry(input: {
  client: Client;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  queryNormalization?: {
    normalizedArgs: Record<string, unknown>;
    queryFieldsBeforeDedupe: QueryFieldSummary[];
    queryFieldsAfterDedupe: QueryFieldSummary[];
    dedupedFieldCount: number;
  };
}): Promise<{
  result: unknown;
  queryDebug?: QueryDatasourceExecutionDebug;
}> {
  const result = await input.client.callTool(
    {
      name: input.toolName,
      arguments: input.args,
    },
    undefined,
    { timeout: input.timeoutMs },
  );
  if (
    input.toolName === "query-datasource" &&
    isMcpErrorResult(result) &&
    isRecoverableQueryUniquenessError(result)
  ) {
    const queryDebugBase = {
      recoverableQueryErrorDetected: true,
      queryRetryAttempt: 1,
      queryRetrySucceeded: false,
      failedQueryArgs: input.args,
      errorPreview: summarizeQueryErrorPreview(result),
      errorCategory: classifyMcpErrorCategory(result),
    } satisfies QueryDatasourceExecutionDebug;
    logWarn("tableau.mcp.query.recoverable_error_detected", {
      queryDatasourceCalled: true,
      ...queryDebugBase,
      failedQueryArgsPreserved: Boolean(queryDebugBase.failedQueryArgs),
      queryArgsSummary: summarizeQueryDatasourceArgs(input.args),
      queryFieldsBeforeDedupe:
        input.queryNormalization?.queryFieldsBeforeDedupe ?? [],
      queryFieldsAfterDedupe:
        input.queryNormalization?.queryFieldsAfterDedupe ?? [],
      dedupedFieldCount: input.queryNormalization?.dedupedFieldCount ?? 0,
    });
    logInfo("tableau.mcp.query.retry_attempt", {
      queryDatasourceCalled: true,
      queryRetryAttempt: 1,
      failedQueryArgsPreserved: Boolean(queryDebugBase.failedQueryArgs),
      queryArgsSummary: summarizeQueryDatasourceArgs(
        input.queryNormalization?.normalizedArgs ?? input.args,
      ),
    });
    const retryResult = await input.client.callTool(
      {
        name: input.toolName,
        arguments: input.queryNormalization?.normalizedArgs ?? input.args,
      },
      undefined,
      { timeout: input.timeoutMs },
    );
    const succeeded = !isMcpErrorResult(retryResult);
    logInfo("tableau.mcp.query.retry_succeeded", {
      queryDatasourceCalled: true,
      queryRetryAttempt: 1,
      queryRetrySucceeded: succeeded,
      failedQueryArgsPreserved: Boolean(queryDebugBase.failedQueryArgs),
      queryArgsSummary: summarizeQueryDatasourceArgs(
        input.queryNormalization?.normalizedArgs ?? input.args,
      ),
    });
    return {
      result: retryResult,
      queryDebug: {
        ...queryDebugBase,
        queryRetrySucceeded: succeeded,
      },
    };
  }

  return { result };
}

function isCacheableToolName(toolName: string): boolean {
  return [
    "list-workbooks",
    "get-workbook",
    "list-views",
    "list-datasources",
    "get-datasource-metadata",
  ].includes(toolName);
}

function pruneMetadataToolCache(): void {
  const now = Date.now();
  for (const [key, entry] of metadataToolCache.entries()) {
    if (entry.expiresAt <= now) {
      metadataToolCache.delete(key);
    }
  }
}

function buildCacheKey(
  subject: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const raw = `${safeHash(subject) ?? "anonymous"}|${toolName}|${safeHash(stableStringify(args)) ?? "noargs"}`;
  return raw.length > TOOL_CACHE_KEY_MAX_LENGTH
    ? raw.slice(0, TOOL_CACHE_KEY_MAX_LENGTH)
    : raw;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function summarizeToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args)
      .slice(0, 12)
      .map(([key, value]) => {
        if (typeof value === "string") {
          return [key, value.slice(0, 120)];
        }

        if (
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null
        ) {
          return [key, value];
        }

        if (Array.isArray(value)) {
          return [key, `array(${value.length})`];
        }

        if (value && typeof value === "object") {
          return [
            key,
            `object(${Object.keys(value as Record<string, unknown>).length})`,
          ];
        }

        return [key, String(value)];
      }),
  );
}

function summarizeQueryDatasourceArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const datasourceLuid =
    readString(args.datasourceLuid) ?? readString(args.datasourceId);
  const query =
    args.query && typeof args.query === "object" && !Array.isArray(args.query)
      ? (args.query as Record<string, unknown>)
      : undefined;
  const fields = Array.isArray(query?.fields) ? query.fields : [];
  const filters = Array.isArray(query?.filters) ? query.filters : [];

  return {
    datasourceLuidHash: safeHash(datasourceLuid),
    limit: typeof args.limit === "number" ? Math.floor(args.limit) : args.limit,
    fieldCount: fields.length,
    fields: fields.slice(0, 6).map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        return "invalid";
      }
      const record = field as Record<string, unknown>;
      return {
        fieldCaption: readString(record.fieldCaption),
        fieldAlias: readString(record.fieldAlias),
        function: readString(record.function),
      };
    }),
    filterCount: filters.length,
    filters: filters.slice(0, 4).map((filter) => {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
        return "invalid";
      }
      const record = filter as Record<string, unknown>;
      const field =
        record.field &&
        typeof record.field === "object" &&
        !Array.isArray(record.field)
          ? (record.field as Record<string, unknown>)
          : undefined;
      return {
        fieldCaption: readString(field?.fieldCaption),
        filterType: readString(record.filterType),
        quantitativeFilterType: readString(record.quantitativeFilterType),
        periodType: readString(record.periodType),
        dateRangeType: readString(record.dateRangeType),
        minDate: readString(record.minDate),
        maxDate: readString(record.maxDate),
      };
    }),
  };
}

function summarizeQueryFieldSpecs(
  fields: Array<Record<string, unknown>>,
): QueryFieldSummary[] {
  return fields.slice(0, 12).map((field) => ({
    fieldCaption: readString(field.fieldCaption),
    fieldAlias: readString(field.fieldAlias),
    function: readString(field.function),
    calculation: readString(field.calculation),
  }));
}

function inferDerivedMetricsComputedInApp(
  queryFieldSpecs: QueryFieldSpec[],
  questionInterpretation: QuestionInterpretation | undefined,
): string[] {
  const computed: string[] = [];
  const metricIntent = questionInterpretation?.metricIntent;
  const fieldCaptions = queryFieldSpecs
    .map((field) => field.fieldCaption ?? "")
    .filter(Boolean);

  const hasEngagementField = fieldCaptions.some((fieldCaption) =>
    /engagement|エンゲージメント/i.test(fieldCaption),
  );
  const hasImpressionField = fieldCaptions.some((fieldCaption) =>
    /impression|インプレッション/i.test(fieldCaption),
  );

  if (
    metricIntent === "engagement_rate" &&
    hasEngagementField &&
    hasImpressionField
  ) {
    computed.push("engagement_rate");
  }

  return computed;
}

function dedupeQueryDatasourceFields(
  fields: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];

  for (const field of fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      continue;
    }

    const record = field as Record<string, unknown>;
    const fieldCaption = readString(record.fieldCaption)?.trim() ?? "";
    const fn = readString(record.function)?.trim().toUpperCase() ?? "";
    const key = `${fieldCaption}|${fn}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(record);
  }

  return deduped;
}

function normalizeQueryDatasourceArguments(args: Record<string, unknown>):
  | {
      normalizedArgs: Record<string, unknown>;
      queryFieldsBeforeDedupe: QueryFieldSummary[];
      queryFieldsAfterDedupe: QueryFieldSummary[];
      dedupedFieldCount: number;
    }
  | undefined {
  const query =
    args.query && typeof args.query === "object" && !Array.isArray(args.query)
      ? (args.query as Record<string, unknown>)
      : undefined;
  if (!query) {
    return undefined;
  }

  const fieldsBeforeDedupe = Array.isArray(query.fields)
    ? query.fields.filter(
        (field): field is Record<string, unknown> =>
          Boolean(field) && typeof field === "object" && !Array.isArray(field),
      )
    : [];
  const fieldsAfterDedupe = dedupeQueryDatasourceFields(fieldsBeforeDedupe);
  return {
    normalizedArgs: {
      ...args,
      query: {
        ...query,
        fields: fieldsAfterDedupe,
      },
    },
    queryFieldsBeforeDedupe: summarizeQueryFieldSpecs(fieldsBeforeDedupe),
    queryFieldsAfterDedupe: summarizeQueryFieldSpecs(fieldsAfterDedupe),
    dedupedFieldCount: fieldsBeforeDedupe.length - fieldsAfterDedupe.length,
  };
}

function summarizeToolResultPreview(result: unknown): string {
  const text =
    extractTextFromToolResult(result) ||
    JSON.stringify(describeValueShape(result));
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > TOOL_RESULT_PREVIEW_LIMIT
    ? `${compact.slice(0, TOOL_RESULT_PREVIEW_LIMIT)}...`
    : compact;
}

function summarizeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Tool call failed.";
  }

  return error.message?.slice(0, 220) || "Tool call failed.";
}

export function isMcpErrorResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }

  return (result as { isError?: unknown }).isError === true;
}

export function classifyMcpErrorCategory(result: unknown): string {
  const text = extractTextFromToolResult(result).toLowerCase();
  if (isRecoverableQueryUniquenessError(result)) {
    return "field_not_unique";
  }
  if (
    text.includes("status code 400") ||
    text.includes("invalid") ||
    text.includes("bad request")
  ) {
    return "request_invalid_or_identifier_missing";
  }
  if (
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("permission")
  ) {
    return "permission_or_auth";
  }
  if (text.includes("not found")) {
    return "resource_not_found";
  }

  return "tool_error";
}

function isRecoverableQueryUniquenessError(result: unknown): boolean {
  const text = extractTextFromToolResult(result).toLowerCase();
  return /field\s+.+isn['’]?t unique/.test(text);
}

function summarizeQueryErrorPreview(result: unknown): string {
  const text = extractTextFromToolResult(result).trim();
  if (!text) {
    return "Query returned an error result.";
  }

  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

export function buildMcpErrorMessage(
  result: unknown,
  category: string,
): string {
  if (category === "field_not_unique") {
    return "Query datasource fields were not unique; duplicate field/function pairs must be removed before retrying.";
  }
  if (category === "request_invalid_or_identifier_missing") {
    return "Datasource metadata request was invalid, often because datasource identifier was missing.";
  }
  if (category === "permission_or_auth") {
    return "Datasource metadata could not be retrieved due to permission or auth constraints.";
  }
  if (category === "resource_not_found") {
    return "Datasource metadata target could not be found from current context.";
  }

  const text = extractTextFromToolResult(result).trim();
  if (!text) {
    return "Tool returned an error result.";
  }

  return `Tool returned an error result: ${text.slice(0, 180)}`;
}

function buildFollowUpToolSelection(
  completedToolName: string,
  result: unknown,
  tools: McpTool[],
  calledToolNames: Set<string>,
  input: GetAdditionalContextInput,
): SelectedTool | undefined {
  if (
    ["list-datasources", "search-content"].includes(completedToolName) &&
    !calledToolNames.has("get-datasource-metadata")
  ) {
    const getDatasourceMetadataTool = tools.find(
      (tool) => tool.name === "get-datasource-metadata",
    );
    const searchContentTool = tools.find(
      (tool) => tool.name === "search-content",
    );
    const resolved = resolveDatasourceIdentifier(
      input.dashboardContext.dataSources?.map(
        (datasource) => datasource.name,
      ) ?? [],
      [],
      tools,
      {
        rawToolResults: [{ toolName: completedToolName, result }],
        workbookName: input.dashboardContext.workbookName ?? undefined,
        dashboardName: input.dashboardContext.dashboardName,
        viewName: input.dashboardContext.viewName ?? undefined,
        worksheetNames: input.dashboardContext.worksheets.map(
          (worksheet) => worksheet.name,
        ),
      },
    );
    const datasourceRef = selectBestResolvedDatasource(resolved);
    if (getDatasourceMetadataTool && datasourceRef) {
      const args = inferPlannedToolArguments(
        getDatasourceMetadataTool,
        buildDatasourceMetadataArgs(datasourceRef),
        input,
      );
      if (args) {
        return {
          status: "ready",
          tool: getDatasourceMetadataTool,
          arguments: args,
          reason:
            "Inspect datasource fields before deciding whether an aggregate query is safe.",
        };
      }
    }

    if (searchContentTool && !calledToolNames.has("search-content")) {
      const recoveryArgs = inferToolArguments(searchContentTool, input);
      if (recoveryArgs) {
        return {
          status: "ready",
          tool: searchContentTool,
          arguments: recoveryArgs,
          reason:
            "Resolve datasource identifier from content search because list-datasources did not yield a safe identifier.",
        };
      }
    }
  }

  if (
    !["list-workbooks", "list-views", "search-content"].includes(
      completedToolName,
    ) ||
    calledToolNames.has("get-workbook")
  ) {
    return undefined;
  }

  const getWorkbookTool = tools.find((tool) => tool.name === "get-workbook");
  if (!getWorkbookTool) {
    return undefined;
  }

  const workbookId = extractBestWorkbookId(
    result,
    input.dashboardContext.workbookName ?? input.dashboardContext.dashboardName,
  );
  if (!workbookId) {
    return undefined;
  }

  return {
    status: "ready",
    tool: getWorkbookTool,
    arguments: { workbookId },
  };
}

function inferToolArguments(
  tool: McpTool,
  input: GetAdditionalContextInput,
): Record<string, unknown> | undefined {
  const knownArguments = inferKnownToolArguments(tool.name, input);
  if (knownArguments) {
    return knownArguments;
  }

  const required = tool.inputSchema?.required ?? [];
  const properties = tool.inputSchema?.properties ?? {};
  const args: Record<string, unknown> = {};

  for (const propertyName of required) {
    const value = inferValueForProperty(propertyName, input);
    if (value === undefined) {
      return undefined;
    }

    args[propertyName] = value;
  }

  if (!required.length) {
    return {};
  }

  for (const propertyName of Object.keys(properties)) {
    if (propertyName in args) {
      continue;
    }

    const value = inferValueForProperty(propertyName, input);
    if (value !== undefined) {
      args[propertyName] = value;
    }
  }

  return args;
}

function inferKnownToolArguments(
  toolName: string,
  input: GetAdditionalContextInput,
): Record<string, unknown> | undefined {
  const dashboardName = input.dashboardContext.dashboardName;
  const workbookName = input.dashboardContext.workbookName ?? undefined;

  switch (toolName) {
    case "list-workbooks":
      return workbookName
        ? { filter: `name:eq:${escapeFilterValue(workbookName)}`, limit: 10 }
        : { limit: 25 };
    case "get-workbook": {
      const workbookId = readString(input.dashboardContext.workbookId);
      return workbookId && looksLikeIdentifier(workbookId)
        ? { workbookId }
        : undefined;
    }
    case "list-views":
      return workbookName
        ? {
            filter: `workbookName:eq:${escapeFilterValue(workbookName)}`,
            limit: 25,
          }
        : { filter: `name:eq:${escapeFilterValue(dashboardName)}`, limit: 25 };
    case "list-datasources": {
      const datasourceName = chooseKnownDatasourceName(input);
      return datasourceName
        ? { filter: `name:eq:${escapeFilterValue(datasourceName)}`, limit: 10 }
        : { limit: 100 };
    }
    case "get-datasource-metadata": {
      const datasourceId = chooseKnownDatasourceId(input);
      return datasourceId ? { datasourceLuid: datasourceId } : undefined;
    }
    case "search-content":
      return {
        terms: workbookName ?? dashboardName,
        filter: { contentTypes: ["workbook", "view", "datasource"] },
        limit: 10,
      };
    default:
      return undefined;
  }
}

function inferValueForProperty(
  propertyName: string,
  input: GetAdditionalContextInput,
): unknown {
  const normalized = propertyName.toLowerCase();

  if (normalized.includes("workbook") && normalized.includes("id")) {
    const workbookId = readString(input.dashboardContext.workbookId);
    return workbookId && looksLikeIdentifier(workbookId)
      ? workbookId
      : undefined;
  }

  if (
    (normalized.includes("datasource") || normalized.includes("data_source")) &&
    (normalized.includes("id") || normalized.includes("luid"))
  ) {
    return chooseKnownDatasourceId(input);
  }

  if (normalized.includes("workbook") && normalized.includes("name")) {
    return input.dashboardContext.workbookName;
  }

  if (normalized.includes("dashboard") && normalized.includes("name")) {
    return input.dashboardContext.dashboardName;
  }

  if (
    (normalized.includes("view") || normalized.includes("sheet")) &&
    normalized.includes("name")
  ) {
    return (
      input.dashboardContext.worksheets[0]?.name ??
      input.dashboardContext.dashboardName
    );
  }

  if (normalized === "query" || normalized.includes("search")) {
    return (
      input.dashboardContext.workbookName ??
      input.dashboardContext.dashboardName
    );
  }

  if (normalized === "limit" || normalized === "pageSize".toLowerCase()) {
    return 10;
  }

  return undefined;
}

function chooseKnownDatasourceName(
  input: GetAdditionalContextInput,
): string | undefined {
  const datasourceNames =
    input.dashboardContext.dataSources
      ?.map((datasource) => datasource.name.trim())
      .filter(Boolean) ?? [];

  if (!datasourceNames.length) {
    return undefined;
  }

  const normalizedQuestion = input.question.toLowerCase();
  const preferredSocialAnalyticsDatasource = datasourceNames.find((name) =>
    /x account analytics contents/i.test(name),
  );
  if (
    preferredSocialAnalyticsDatasource &&
    /ハッシュタグ|hashtag|hash tag|#|ポスト|投稿|post|tweet|エンゲージメント|impression/i.test(
      normalizedQuestion,
    )
  ) {
    return preferredSocialAnalyticsDatasource;
  }
  return (
    datasourceNames.find((name) =>
      normalizedQuestion.includes(name.toLowerCase()),
    ) ?? (datasourceNames.length === 1 ? datasourceNames[0] : undefined)
  );
}

function chooseKnownDatasourceId(
  input: GetAdditionalContextInput,
): string | undefined {
  const ids =
    input.dashboardContext.dataSources
      ?.map((datasource) => readString(datasource.id))
      .filter((value): value is string =>
        Boolean(value && looksLikeIdentifier(value)),
      ) ?? [];

  if (!ids.length) {
    return undefined;
  }

  return ids[0];
}

function toToolSummary(tool: McpTool): TableauMcpToolSummary {
  return {
    name: tool.name,
    description: tool.description?.slice(0, 240),
  };
}

function summarizeListedTool(tool: McpTool): Record<string, unknown> {
  const properties = tool.inputSchema?.properties ?? {};
  return {
    name: tool.name,
    requiredArgs: tool.inputSchema?.required ?? [],
    propertyKeys: Object.keys(properties).slice(0, 12),
    descriptionPreview: tool.description?.slice(0, 160),
  };
}

function logMcpToolResultDebug(
  toolName: string,
  result: unknown,
  enabled: boolean,
): void {
  if (!enabled) {
    return;
  }

  const text = extractTextFromToolResult(result);
  const parsed = tryParseJson(text);
  const record = parsed ?? result;
  logInfo("tableau.mcp.tool.result_debug", {
    toolName,
    resultShape: describeValueShape(record),
    textLength: text.length,
    textHash: safeHash(text),
  });
}

function describeValueShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: describeValueShape(value[0]),
    };
  }

  if (!value || typeof value !== "object") {
    return { type: typeof value };
  }

  const record = value as Record<string, unknown>;
  return {
    type: "object",
    keys: Object.keys(record).slice(0, 30),
    childShapes: Object.fromEntries(
      Object.entries(record)
        .slice(0, 10)
        .map(([key, child]) => [
          key,
          Array.isArray(child) ? `array(${child.length})` : typeof child,
        ]),
    ),
  };
}

function summarizeToolResult(result: unknown): string {
  const text = (
    extractTextFromToolResult(result) ||
    JSON.stringify(describeValueShape(result))
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > TOOL_RESULT_SUMMARY_LIMIT
    ? `${text.slice(0, TOOL_RESULT_SUMMARY_LIMIT)}...`
    : text;
}

function extractTextFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }

  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    return record.content
      .map((content) => {
        if (!content || typeof content !== "object") {
          return "";
        }

        const contentRecord = content as Record<string, unknown>;
        return typeof contentRecord.text === "string" ? contentRecord.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

export function extractBestWorkbookId(
  result: unknown,
  preferredName: string | undefined,
): string | undefined {
  const text = extractTextFromToolResult(result);
  const parsed = tryParseJson(text) ?? result;
  const workbookIdFromView = findWorkbookIdFromViewRecords(
    parsed,
    preferredName,
  );
  if (workbookIdFromView) {
    return workbookIdFromView;
  }

  const workbookCandidate = findWorkbookCandidates(parsed, {
    preferredWorkbookName: preferredName,
  })[0];
  if (workbookCandidate?.id) {
    return workbookCandidate.id;
  }

  const candidates = findObjectsWithId(parsed);
  const normalizedPreferredName = preferredName?.trim().toLowerCase();
  const matched = normalizedPreferredName
    ? candidates.find(
        (candidate) =>
          candidate.name?.trim().toLowerCase() === normalizedPreferredName,
      )
    : undefined;
  return matched?.id ?? candidates[0]?.id ?? findFirstUuid(text);
}

export function extractWorkbookFromToolResults(
  toolResults: TableauMcpToolResultSummary[],
  input: GetAdditionalContextInput,
): { id?: string; name: string } | undefined {
  const preferredWorkbookName =
    input.dashboardContext.workbookName ?? undefined;
  const parsedResults = toolResults
    .filter((result) => result.status === "success" && result.summary)
    .map((result) => tryParseJson(result.summary ?? "") ?? result.summary);

  const candidates = parsedResults.flatMap((result) =>
    findWorkbookCandidates(result, {
      preferredWorkbookName,
      dashboardName: input.dashboardContext.dashboardName,
      worksheetNames: input.dashboardContext.worksheets.map(
        (worksheet) => worksheet.name,
      ),
    }),
  );
  const exactName = preferredWorkbookName?.trim().toLowerCase();
  const exact = exactName
    ? candidates.find(
        (candidate) => candidate.name.trim().toLowerCase() === exactName,
      )
    : undefined;
  const fromView = candidates.find(
    (candidate) => candidate.source === "view-workbook",
  );
  const selected =
    exact ??
    fromView ??
    candidates.find((candidate) => candidate.source === "workbook") ??
    candidates[0];

  logInfo("tableau.mcp.workbook.candidates", {
    candidateCount: candidates.length,
    selectedSource: selected?.source,
    selectedNameHash: safeHash(selected?.name),
    dashboardNameHash: safeHash(input.dashboardContext.dashboardName),
  });

  return selected ? { id: selected.id, name: selected.name } : undefined;
}

export function extractDatasourcesFromRawToolResults(
  rawToolResults: RawMcpToolResult[],
  input: GetAdditionalContextInput,
): unknown[] {
  const knownNames = getKnownDatasourceNames(input);
  const resolved = resolveDatasourceIdentifier([...knownNames], [], [], {
    rawToolResults,
    workbookName: input.dashboardContext.workbookName ?? undefined,
    dashboardName: input.dashboardContext.dashboardName,
    viewName: input.dashboardContext.viewName ?? undefined,
    worksheetNames: input.dashboardContext.worksheets.map(
      (worksheet) => worksheet.name,
    ),
  });
  const uniqueDatasources = dedupeDatasourceObjects(
    resolved.map((candidate) => ({
      type: "datasource",
      name: candidate.name,
      id: candidate.id,
      luid: candidate.luid,
      contentUrl: candidate.contentUrl,
      projectName: candidate.projectName,
      workbookName: candidate.workbookName,
    })),
  );

  if (!knownNames.size) {
    return uniqueDatasources;
  }

  const matchingDatasources = uniqueDatasources.filter((datasource) => {
    const name = readString((datasource as Record<string, unknown>).name);
    return Boolean(
      name &&
      [...knownNames].some(
        (knownName) =>
          normalizeNameForMatch(knownName) === normalizeNameForMatch(name),
      ),
    );
  });

  if (matchingDatasources.length) {
    return matchingDatasources;
  }

  return [
    ...(input.dashboardContext.dataSources?.map((datasource) => ({
      type: "datasource" as const,
      name: datasource.name,
      id: readString(datasource.id) ?? undefined,
      luid: readString(datasource.id) ?? undefined,
    })) ?? []),
  ];
}

export function extractDatasourceFieldProfilesFromRawToolResults(
  rawToolResults: RawMcpToolResult[],
  normalizedDatasources: TableauDatasourceRef[],
): DatasourceFieldProfile[] {
  const knownNames = new Set(
    normalizedDatasources
      .map((datasource) => normalizeNameForMatch(datasource.name))
      .filter(Boolean),
  );
  const profiles: DatasourceFieldProfile[] = [];

  for (const toolResult of rawToolResults) {
    if (toolResult.toolName !== "get-datasource-metadata") {
      continue;
    }

    for (const payload of parseToolResultPayloads(toolResult.result)) {
      const payloadRecord = isPlainObject(payload) ? payload : undefined;
      if (!payloadRecord) {
        continue;
      }

      const datasourceNameCandidates = [
        readString(payloadRecord.datasourceName),
        readString(payloadRecord.name),
        isPlainObject(payloadRecord.datasourceModel)
          ? readString(
              (payloadRecord.datasourceModel as Record<string, unknown>).name,
            )
          : undefined,
      ].filter((value): value is string => Boolean(value));

      const fieldDetails = dedupeFieldDetails([
        ...extractFieldDetailsFromDatasourceModel(
          payloadRecord.datasourceModel,
        ),
        ...extractFieldDetailsFromFieldGroups(payloadRecord.fieldGroups),
      ]);
      const fieldNames = fieldDetails.map((field) => field.name);

      if (!fieldNames.length) {
        continue;
      }

      const matchedDatasourceName =
        datasourceNameCandidates.find((candidate) =>
          knownNames.has(normalizeNameForMatch(candidate)),
        ) ??
        normalizedDatasources.find((datasource) =>
          knownNames.has(normalizeNameForMatch(datasource.name)),
        )?.name ??
        datasourceNameCandidates[0] ??
        normalizedDatasources[0]?.name ??
        "Unknown datasource";

      profiles.push({
        datasourceName: matchedDatasourceName,
        fields: fieldDetails,
        fieldNames,
        fieldCount: fieldNames.length,
        sourceTool: "get-datasource-metadata",
      });
    }
  }

  return dedupeDatasourceFieldProfiles(profiles);
}

export function extractQueryDatasourceInsightsFromRawToolResults(
  rawToolResults: RawMcpToolResult[],
  normalizedDatasources: TableauDatasourceRef[],
  questionInterpretation?: QuestionInterpretation,
): QueryDatasourceInsight[] {
  const insights: QueryDatasourceInsight[] = [];

  for (const toolResult of rawToolResults) {
    if (toolResult.toolName !== "query-datasource") {
      continue;
    }

    const args = toolResult.args ?? {};
    const datasourceLuid =
      readString(args.datasourceLuid) ??
      readString(args.datasourceId) ??
      undefined;
    const datasourceName =
      normalizedDatasources.find(
        (datasource) =>
          datasource.luid === datasourceLuid ||
          datasource.id === datasourceLuid,
      )?.name ?? "resolved datasource";
    const query = isPlainObject(args.query)
      ? (args.query as Record<string, unknown>)
      : undefined;
    const fields = Array.isArray(query?.fields) ? query.fields : [];
    const dimensionFieldRecord = fields.find((field) => {
      if (!isPlainObject(field)) {
        return false;
      }

      return !readString((field as Record<string, unknown>).function);
    }) as Record<string, unknown> | undefined;
    const metricFieldRecord =
      (fields.find((field) => {
        if (!isPlainObject(field)) {
          return false;
        }

        return (
          Number((field as Record<string, unknown>).sortPriority ?? 0) === 1 ||
          readString((field as Record<string, unknown>).fieldAlias) ===
            QUERY_METRIC_ALIAS ||
          readString((field as Record<string, unknown>).fieldAlias) ===
            "engagement_rate"
        );
      }) as Record<string, unknown> | undefined) ??
      (fields.find((field) => {
        if (!isPlainObject(field)) {
          return false;
        }

        return Boolean(readString((field as Record<string, unknown>).function));
      }) as Record<string, unknown> | undefined);
    const queryFieldSpecs = fields
      .map((field) =>
        isPlainObject(field)
          ? ({
              fieldCaption: readString(
                (field as Record<string, unknown>).fieldCaption,
              ),
              fieldAlias: readString(
                (field as Record<string, unknown>).fieldAlias,
              ),
              function: readString((field as Record<string, unknown>).function),
              calculation: readString(
                (field as Record<string, unknown>).calculation,
              ),
            } satisfies QueryFieldSpec)
          : undefined,
      )
      .filter((field): field is QueryFieldSpec => Boolean(field));
    const queryDebug = toolResult.debug;
    const derivedMetricsComputedInApp = inferDerivedMetricsComputedInApp(
      queryFieldSpecs,
      questionInterpretation,
    );
    const dimensionField =
      readString(dimensionFieldRecord?.fieldCaption) ??
      readString(dimensionFieldRecord?.fieldAlias);
    const dimensionKeyCandidates = [
      readString(dimensionFieldRecord?.fieldAlias),
      readString(dimensionFieldRecord?.fieldCaption),
      QUERY_DIMENSION_ALIAS,
      "Dimension",
    ].filter((value): value is string => Boolean(value));
    const metricField =
      readString(metricFieldRecord?.fieldCaption) ?? "aggregated value";
    const metricKeyCandidates = [
      readString(metricFieldRecord?.fieldAlias),
      readString(metricFieldRecord?.fieldCaption),
      QUERY_METRIC_ALIAS,
      "Aggregated Value",
    ].filter((value): value is string => Boolean(value));
    const queryComputesRequestedMetric = Boolean(
      questionInterpretation?.metricIntent === "engagement_rate" &&
      derivedMetricsComputedInApp.includes("engagement_rate"),
    );

    const rows = extractQueryDatasourceRows(toolResult.result)
      .map((row) =>
        normalizeQueryDatasourceInsightRow(
          row,
          dimensionKeyCandidates,
          metricKeyCandidates,
        ),
      )
      .filter(
        (
          row,
        ): row is {
          label?: string;
          value: number | null;
          raw: Record<string, unknown>;
        } => row !== undefined,
      );
    const requestedMetricText = questionInterpretation?.requestedMetricText;
    const rankingTarget = questionInterpretation?.rankingTarget ?? "unknown";
    const metricMatchConfidence = queryComputesRequestedMetric
      ? 1
      : computeMetricMatchConfidence(metricField, questionInterpretation);
    const dimensionMatchConfidence = computeDimensionMatchConfidence(
      dimensionField,
      questionInterpretation,
      rows,
    );
    const hasMeaningfulRowLabels = rows.some((row) =>
      isMeaningfulInsightLabel(row.label),
    );
    const hasExplicitMetricRequest = Boolean(
      (questionInterpretation?.metricIntent &&
        questionInterpretation.metricIntent !== "unknown") ||
      requestedMetricText,
    );
    const rankingRequested = Boolean(
      questionInterpretation?.asksForRanking ||
      (questionInterpretation?.topN ?? 1) > 1,
    );
    const fulfillsMetricRequest = hasExplicitMetricRequest
      ? metricMatchConfidence >= 0.8 || queryComputesRequestedMetric
      : Boolean(
          !questionInterpretation?.metricIntent ||
          questionInterpretation.metricIntent === "unknown" ||
          matchesMetricFieldIntent(
            metricField,
            questionInterpretation.metricIntent,
          ),
        );
    const fulfillsRankingRequest = rankingRequested
      ? rows.length >= Math.min(questionInterpretation?.topN ?? 10, 10) &&
        hasMeaningfulRowLabels &&
        (rankingTarget === "unknown" || dimensionMatchConfidence >= 0.8)
      : true;
    const fulfillsPeriodRequest = Boolean(
      !questionInterpretation?.period ||
      (questionInterpretation.period.startDate &&
        questionInterpretation.period.endDate),
    );
    const queryDatasourceLogBase = {
      analysisIntent: questionInterpretation?.analysisIntent ?? "unknown",
      groupingIntent: questionInterpretation?.groupingIntent ?? "unknown",
      selectedGroupingField: dimensionField,
      selectedMetricField: metricField,
      queryDatasourceCalled: true,
      queryDatasourceRowCount: rows.length,
      derivedMetricsComputedInApp,
    };

    if (!rows.length) {
      logDebug("tableau.mcp.query.rows_extracted", {
        datasourceNameHash: safeHash(datasourceName),
        datasourceLuidHash: safeHash(datasourceLuid),
        ...queryDatasourceLogBase,
        selectedDimensionField: dimensionField,
        metricField,
        dimensionField,
        requestedMetricIntent:
          questionInterpretation?.metricIntent ?? "unknown",
        requestedMetricText: requestedMetricText ?? null,
        rankingTarget,
        metricMatchConfidence,
        dimensionMatchConfidence,
        requestedTopN: questionInterpretation?.topN,
        actualRowCount: 0,
        sampleLabels: [],
        derivedMetricsComputedInApp,
        rejectedReason: "no_rows",
      });
      continue;
    }

    if (hasExplicitMetricRequest && !fulfillsMetricRequest) {
      logDebug("tableau.mcp.query.rows_extracted", {
        datasourceNameHash: safeHash(datasourceName),
        datasourceLuidHash: safeHash(datasourceLuid),
        ...queryDatasourceLogBase,
        selectedDimensionField: dimensionField,
        metricField,
        dimensionField,
        requestedMetricIntent:
          questionInterpretation?.metricIntent ?? "unknown",
        requestedMetricText: requestedMetricText ?? null,
        rankingTarget,
        metricMatchConfidence,
        dimensionMatchConfidence,
        requestedTopN: questionInterpretation?.topN,
        actualRowCount: rows.length,
        sampleLabels: rows.slice(0, 5).map((row) => row.label ?? "(value)"),
        derivedMetricsComputedInApp,
        rejectedReason: "metric_mismatch",
      });
      continue;
    }

    if (rows.every((row) => row.value === null)) {
      logDebug("tableau.mcp.query.rows_extracted", {
        datasourceNameHash: safeHash(datasourceName),
        datasourceLuidHash: safeHash(datasourceLuid),
        ...queryDatasourceLogBase,
        metricField,
        dimensionField,
        requestedMetricIntent:
          questionInterpretation?.metricIntent ?? "unknown",
        requestedMetricText: requestedMetricText ?? null,
        rankingTarget,
        metricMatchConfidence,
        dimensionMatchConfidence,
        requestedTopN: questionInterpretation?.topN,
        actualRowCount: rows.length,
        sampleLabels: rows.slice(0, 5).map((row) => row.label ?? "(value)"),
        derivedMetricsComputedInApp,
        rejectedReason: "all_values_null",
      });
      continue;
    }

    logDebug("tableau.mcp.query.rows_extracted", {
      datasourceNameHash: safeHash(datasourceName),
      datasourceLuidHash: safeHash(datasourceLuid),
      ...queryDatasourceLogBase,
      selectedDimensionField: dimensionField,
      metricField,
      dimensionField,
      requestedMetricIntent: questionInterpretation?.metricIntent ?? "unknown",
      requestedMetricText: requestedMetricText ?? null,
      rankingTarget,
      metricMatchConfidence,
      dimensionMatchConfidence,
      requestedTopN: questionInterpretation?.topN,
      actualRowCount: rows.length,
      sampleLabels: rows.slice(0, 5).map((row) => row.label ?? "(value)"),
      fulfillsMetricRequest,
      fulfillsRankingRequest,
      fulfillsPeriodRequest,
      derivedMetricsComputedInApp,
    });

    insights.push({
      datasourceName,
      datasourceLuid,
      dimensionField,
      metricField,
      queryFields: queryFieldSpecs,
      rowCount: rows.length,
      actualRowCount: rows.length,
      rows: rows.slice(0, 20),
      requestedMetricIntent: questionInterpretation?.metricIntent,
      requestedMetricText,
      rankingTarget,
      requestedTopN: questionInterpretation?.topN,
      requestedRanking: questionInterpretation?.asksForRanking,
      requestedPeriodStart: questionInterpretation?.period?.startDate,
      requestedPeriodEnd: questionInterpretation?.period?.endDate,
      sourceQuestion: questionInterpretation?.originalQuestion,
      metricMatchConfidence,
      dimensionMatchConfidence,
      fulfillsMetricRequest,
      fulfillsRankingRequest,
      fulfillsPeriodRequest,
      queryDebug: {
        ...queryDebug,
        derivedMetricsComputedInApp,
        selectedDatasourceName: datasourceName,
        selectedGroupingField: dimensionField,
        selectedMetricField: metricField,
        metricIntent: questionInterpretation?.metricIntent,
        groupingIntent: questionInterpretation?.groupingIntent,
      },
    });
  }

  return insights;
}

type WorkbookCandidate = {
  id?: string;
  name: string;
  source: "workbook" | "view-workbook" | "workbookName" | "parentWorkbookName";
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractQueryDatasourceRows(
  result: unknown,
): Record<string, unknown>[] {
  for (const payload of parseToolResultPayloads(result)) {
    const data = findQueryDatasourceDataArray(payload);
    if (data?.length) {
      return data;
    }
  }

  return [];
}

function findQueryDatasourceDataArray(
  value: unknown,
): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) {
    const rows = value.filter((item): item is Record<string, unknown> =>
      isPlainObject(item),
    );
    return rows.length ? rows : undefined;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const directData = Array.isArray(value.data)
    ? value.data.filter((item): item is Record<string, unknown> =>
        isPlainObject(item),
      )
    : undefined;
  if (directData?.length) {
    return directData;
  }

  for (const key of ["result", "queryResult", "payload"]) {
    const nested = findQueryDatasourceDataArray(value[key]);
    if (nested?.length) {
      return nested;
    }
  }

  return undefined;
}

function normalizeQueryDatasourceInsightRow(
  row: Record<string, unknown>,
  dimensionKeyCandidates: string[],
  metricKeyCandidates: string[],
):
  | { label?: string; value: number | null; raw: Record<string, unknown> }
  | undefined {
  const label = dimensionKeyCandidates
    .map((key) => readString(row[key]))
    .find((value) => Boolean(value));
  const value = metricKeyCandidates
    .map((key) => readNumericLike(row[key]))
    .find((candidate) => candidate !== undefined);
  if (label === undefined && value === undefined) {
    return undefined;
  }

  return {
    ...(label ? { label } : {}),
    value: value ?? null,
    raw: row,
  };
}

function computeMetricMatchConfidence(
  metricField: string,
  questionInterpretation: QuestionInterpretation | undefined,
): number {
  if (!questionInterpretation) {
    return 0.5;
  }

  if (
    questionInterpretation.metricIntent !== "unknown" &&
    matchesMetricFieldIntent(metricField, questionInterpretation.metricIntent)
  ) {
    return 1;
  }

  if (
    questionInterpretation.requestedMetricText &&
    matchesRequestedMetricText(
      metricField,
      questionInterpretation.requestedMetricText,
    )
  ) {
    return 0.95;
  }

  if (
    questionInterpretation.metricIntent &&
    questionInterpretation.metricIntent !== "unknown"
  ) {
    return 0;
  }

  return questionInterpretation.requestedMetricText ? 0.2 : 0.5;
}

function computeDimensionMatchConfidence(
  dimensionField: string | undefined,
  questionInterpretation: QuestionInterpretation | undefined,
  rows: Array<{ label?: string; value: number | null }>,
): number {
  if (!dimensionField || !questionInterpretation) {
    return 0;
  }

  if (
    questionInterpretation.rankingTarget === "post" &&
    isPostSpecificDimensionField(dimensionField)
  ) {
    return hasMeaningfulRowLabels(rows) ? 1 : 0.65;
  }

  if (
    questionInterpretation.rankingTarget &&
    questionInterpretation.rankingTarget !== "unknown" &&
    isDimensionFieldAlignedWithRankingTarget(
      dimensionField,
      questionInterpretation.rankingTarget,
    )
  ) {
    return hasMeaningfulRowLabels(rows) ? 0.95 : 0.7;
  }

  return isLikelyLabelField(dimensionField) ? 0.6 : 0.15;
}

function matchesRequestedMetricText(
  fieldName: string,
  requestedMetricText: string,
): boolean {
  const normalizedField = normalizeNameForMatch(fieldName);
  const normalizedRequested = normalizeNameForMatch(requestedMetricText);
  if (!normalizedField || !normalizedRequested) {
    return false;
  }

  return (
    normalizedField === normalizedRequested ||
    normalizedField.includes(normalizedRequested) ||
    normalizedRequested.includes(normalizedField)
  );
}

function hasMeaningfulRowLabels(
  rows: Array<{ label?: string; value: number | null }>,
): boolean {
  return rows.some((row) => isMeaningfulInsightLabel(row.label));
}

function isMeaningfulInsightLabel(label: string | undefined): boolean {
  if (!label) {
    return false;
  }

  const normalized = normalizeNameForMatch(label);
  return Boolean(
    normalized &&
    normalized !== "value" &&
    normalized !== "unknown" &&
    normalized !== "na" &&
    normalized !== "n/a" &&
    normalized !== "名称不明",
  );
}

function isLikelyLabelField(fieldName: string): boolean {
  return /title|name|text|body|content|caption|label|post|tweet|url|link|id|permalink|本文|リンク|id$|名前|名称/i.test(
    fieldName,
  );
}

function isPostSpecificDimensionField(fieldName: string): boolean {
  return (
    /post|tweet|ポスト|投稿/i.test(fieldName) &&
    /title|name|text|body|content|caption|url|link|id|permalink|本文|リンク|id$/i.test(
      fieldName,
    )
  );
}

function scorePostDimensionField(fieldName: string): number {
  let score = 0;
  if (/post|tweet|ポスト|投稿/i.test(fieldName)) {
    score += 80;
  }
  if (/title|name/i.test(fieldName)) {
    score += 20;
  }
  if (/text|body|content|caption|本文/i.test(fieldName)) {
    score += 120;
  }
  if (/url|link|permalink|リンク/i.test(fieldName)) {
    score += 110;
  }
  if (
    /(^|_|\/)(id|postid|tweetid)(_|$)|id$|ID$|ポストID|ポストid/i.test(
      fieldName,
    )
  ) {
    score += 100;
  }
  if (
    /bookmark|impression|view|like|reaction|reply|repost|engagement|count|metric/i.test(
      fieldName,
    )
  ) {
    score -= 180;
  }

  return score;
}

function isDimensionFieldAlignedWithRankingTarget(
  fieldName: string,
  rankingTarget: QuestionRankingTarget,
): boolean {
  switch (rankingTarget) {
    case "post":
      return isPostSpecificDimensionField(fieldName);
    case "viz":
      return /viz|workbook|dashboard|title|name/i.test(fieldName);
    case "author":
      return /author|creator|user|profile|poster/i.test(fieldName);
    case "datasource":
      return /datasource|data source/i.test(fieldName);
    default:
      return false;
  }
}

function extractFieldDetailsFromDatasourceModel(
  value: unknown,
): DatasourceFieldDetail[] {
  if (!isPlainObject(value)) {
    return [];
  }

  const fields = (value as Record<string, unknown>).fields;
  if (!Array.isArray(fields)) {
    return [];
  }

  return fields
    .map((field) =>
      isPlainObject(field)
        ? toDatasourceFieldDetail(
            field as Record<string, unknown>,
            "datasourceModel",
          )
        : undefined,
    )
    .filter((field): field is DatasourceFieldDetail => Boolean(field));
}

function extractFieldDetailsFromFieldGroups(
  value: unknown,
): DatasourceFieldDetail[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const details: DatasourceFieldDetail[] = [];
  for (const group of value) {
    if (!isPlainObject(group)) {
      continue;
    }
    const fields = (group as Record<string, unknown>).fields;
    if (!Array.isArray(fields)) {
      continue;
    }
    for (const field of fields) {
      if (!isPlainObject(field)) {
        continue;
      }
      const detail = toDatasourceFieldDetail(
        field as Record<string, unknown>,
        "fieldGroups",
      );
      if (detail) {
        details.push(detail);
      }
    }
  }

  return details;
}

function toDatasourceFieldDetail(
  field: Record<string, unknown>,
  source: DatasourceFieldDetail["source"],
): DatasourceFieldDetail | undefined {
  const name = readString(field.name) ?? readString(field.fieldName);
  if (!name) {
    return undefined;
  }

  return {
    name,
    dataType: readString(field.dataType) ?? readString(field.datatype),
    role: readString(field.role),
    semanticRole:
      readString(field.semanticRole) ?? readString(field.semantic_type),
    source,
  };
}

function dedupeDatasourceFieldProfiles(
  profiles: DatasourceFieldProfile[],
): DatasourceFieldProfile[] {
  const byDatasource = new Map<string, DatasourceFieldProfile>();
  for (const profile of profiles) {
    const key = normalizeNameForMatch(profile.datasourceName);
    if (!key) {
      continue;
    }
    const existing = byDatasource.get(key);
    if (!existing) {
      byDatasource.set(key, profile);
      continue;
    }

    const mergedFields = dedupeFieldDetails([
      ...existing.fields,
      ...profile.fields,
    ]);
    const mergedFieldNames = mergedFields.map((field) => field.name);
    byDatasource.set(key, {
      ...existing,
      fields: mergedFields,
      fieldNames: mergedFieldNames,
      fieldCount: mergedFieldNames.length,
    });
  }

  return [...byDatasource.values()];
}

function dedupeFieldDetails(
  fieldDetails: DatasourceFieldDetail[],
): DatasourceFieldDetail[] {
  const byName = new Map<string, DatasourceFieldDetail>();

  for (const fieldDetail of fieldDetails) {
    const key = normalizeNameForMatch(fieldDetail.name);
    if (!key) {
      continue;
    }

    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, fieldDetail);
      continue;
    }

    byName.set(key, {
      ...existing,
      ...fieldDetail,
      dataType: existing.dataType ?? fieldDetail.dataType,
      role: existing.role ?? fieldDetail.role,
      semanticRole: existing.semanticRole ?? fieldDetail.semanticRole,
    });
  }

  return [...byName.values()];
}

type WorkbookCandidateOptions = {
  preferredWorkbookName?: string;
  dashboardName?: string;
  worksheetNames?: string[];
};

function findWorkbookCandidates(
  value: unknown,
  options: WorkbookCandidateOptions = {},
): WorkbookCandidate[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return findWorkbookCandidatesInText(value, options);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => findWorkbookCandidates(item, options));
  }

  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidates: WorkbookCandidate[] = [];
  const workbook = record.workbook;
  if (workbook && typeof workbook === "object") {
    const workbookRecord = workbook as Record<string, unknown>;
    const name =
      readString(workbookRecord.name) ??
      readString(workbookRecord.workbookName);
    if (name) {
      candidates.push({
        id: readString(workbookRecord.id),
        name,
        source: "view-workbook",
      });
    }
  }

  const workbookName = readString(record.workbookName);
  if (workbookName) {
    candidates.push({
      id: readString(record.workbookId),
      name: workbookName,
      source: "workbookName",
    });
  }

  const parentWorkbookName = readString(record.parentWorkbookName);
  if (parentWorkbookName) {
    candidates.push({
      id: readString(record.parentWorkbookId) ?? readString(record.workbookId),
      name: parentWorkbookName,
      source: "parentWorkbookName",
    });
  }

  if (looksLikeWorkbookRecord(record)) {
    const name = readString(record.name);
    if (name) {
      candidates.push({
        id: readString(record.id),
        name,
        source: "workbook",
      });
    }
  }

  return [
    ...candidates,
    ...Object.values(record).flatMap((item) =>
      findWorkbookCandidates(item, options),
    ),
  ].filter((candidate) => !isKnownNonWorkbookName(candidate.name, options));
}

function findWorkbookIdFromViewRecords(
  value: unknown,
  preferredViewName: string | undefined,
): string | undefined {
  const candidates = findWorkbookIdCandidatesFromViewRecords(
    value,
    preferredViewName,
  );
  return (
    candidates.find((candidate) => candidate.matchedPreferredView)?.id ??
    candidates[0]?.id
  );
}

function findWorkbookIdCandidatesFromViewRecords(
  value: unknown,
  preferredViewName: string | undefined,
): Array<{ id: string; matchedPreferredView: boolean }> {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      findWorkbookIdCandidatesFromViewRecords(item, preferredViewName),
    );
  }

  const record = value as Record<string, unknown>;
  const workbook = record.workbook;
  const direct =
    workbook && typeof workbook === "object"
      ? [
          {
            id: readString((workbook as Record<string, unknown>).id),
            matchedPreferredView: matchesPreferredViewName(
              record,
              preferredViewName,
            ),
          },
        ].filter(
          (
            candidate,
          ): candidate is { id: string; matchedPreferredView: boolean } =>
            Boolean(candidate.id),
        )
      : [];

  return [
    ...direct,
    ...Object.values(record).flatMap((item) =>
      findWorkbookIdCandidatesFromViewRecords(item, preferredViewName),
    ),
  ];
}

function matchesPreferredViewName(
  record: Record<string, unknown>,
  preferredViewName: string | undefined,
): boolean {
  if (!preferredViewName) {
    return false;
  }

  const normalizedPreferred = preferredViewName.trim().toLowerCase();
  return [record.name, record.title].some(
    (value) => readString(value)?.trim().toLowerCase() === normalizedPreferred,
  );
}

function findWorkbookCandidatesInText(
  text: string,
  options: WorkbookCandidateOptions,
): WorkbookCandidate[] {
  const candidates: WorkbookCandidate[] = [];
  const workbookLine = text.match(/workbook(?:Name)?["'\s:=]+([^\n",}]+)/i);
  if (workbookLine?.[1]) {
    candidates.push({ name: workbookLine[1].trim(), source: "workbookName" });
  }

  if (
    options.preferredWorkbookName &&
    text.includes(options.preferredWorkbookName)
  ) {
    candidates.push({
      name: options.preferredWorkbookName,
      source: "workbookName",
    });
  }

  return candidates.filter(
    (candidate) => !isKnownNonWorkbookName(candidate.name, options),
  );
}

function isKnownNonWorkbookName(
  name: string,
  options: WorkbookCandidateOptions,
): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName) {
    return true;
  }

  const knownNonWorkbookNames = [
    options.dashboardName,
    ...(options.worksheetNames ?? []),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim().toLowerCase());

  return (
    knownNonWorkbookNames.includes(normalizedName) &&
    normalizedName !== options.preferredWorkbookName?.trim().toLowerCase()
  );
}

function looksLikeWorkbookRecord(record: Record<string, unknown>): boolean {
  return (
    typeof record.name === "string" &&
    (Array.isArray(record.views) ||
      Boolean(record.project) ||
      typeof record.contentUrl === "string" ||
      typeof record.sheetCount === "number" ||
      typeof record.displayTabs === "boolean")
  );
}

function parseToolResultPayloads(result: unknown): unknown[] {
  const text = extractTextFromToolResult(result);
  const parsedText = tryParseJson(text);
  if (parsedText !== undefined) {
    return [parsedText];
  }

  return [result];
}

function normalizeDatasourceObject(
  value: unknown,
  explicitName?: string,
): TableauDatasourceRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id =
    readString(record.id) ??
    readString(record.datasourceId) ??
    readString(record.datasource_id);
  const luid =
    readString(record.luid) ?? readString(record.datasourceLuid) ?? id;
  const name =
    explicitName ??
    readString(record.name) ??
    readString(record.datasourceName) ??
    readString(record.dataSourceName);
  if (!name) {
    return undefined;
  }

  const projectName =
    readString(record.projectName) ??
    (record.project && typeof record.project === "object"
      ? readString((record.project as Record<string, unknown>).name)
      : undefined);
  const workbookName =
    readString(record.workbookName) ?? readString(record.parentWorkbookName);

  return {
    type: "datasource",
    name,
    id,
    luid,
    contentUrl: readString(record.contentUrl),
    projectName,
    workbookName,
  };
}

function dedupeDatasourceObjects(
  datasources: Array<TableauDatasourceRef | undefined>,
): TableauDatasourceRef[] {
  const byNormalizedName = new Map<string, TableauDatasourceRef>();

  for (const datasource of datasources) {
    if (!datasource) {
      continue;
    }

    const normalizedName = normalizeNameForMatch(datasource.name);
    if (!normalizedName) {
      continue;
    }

    const existing = byNormalizedName.get(normalizedName);
    if (!existing) {
      byNormalizedName.set(normalizedName, datasource);
      continue;
    }

    byNormalizedName.set(
      normalizedName,
      chooseBetterDatasourceRef(existing, datasource),
    );
  }

  return [...byNormalizedName.values()];
}

function chooseBetterDatasourceRef(
  left: TableauDatasourceRef,
  right: TableauDatasourceRef,
): TableauDatasourceRef {
  const leftScore =
    (hasDatasourceIdentifier(left) ? 2 : 0) +
    (left.projectName ? 1 : 0) +
    (left.workbookName ? 1 : 0);
  const rightScore =
    (hasDatasourceIdentifier(right) ? 2 : 0) +
    (right.projectName ? 1 : 0) +
    (right.workbookName ? 1 : 0);
  return rightScore > leftScore ? right : left;
}

function hasDatasourceIdentifier(candidate: TableauDatasourceRef): boolean {
  return Boolean(
    readString(candidate.luid) ??
    readString(candidate.id) ??
    readString(candidate.contentUrl),
  );
}

function getKnownDatasourceNames(
  input: GetAdditionalContextInput,
): Set<string> {
  return new Set(
    input.dashboardContext.dataSources
      ?.map((datasource) => datasource.name.trim())
      .filter(Boolean) ?? [],
  );
}

function hasDatasourceMatchingDashboardContext(
  datasources: unknown[],
  input: GetAdditionalContextInput,
): boolean {
  const knownNames = [...getKnownDatasourceNames(input)].map((name) =>
    normalizeNameForMatch(name),
  );
  if (!knownNames.length) {
    return false;
  }

  return datasources.some((datasource) => {
    if (!datasource || typeof datasource !== "object") {
      return false;
    }

    const name = readString((datasource as Record<string, unknown>).name);
    return Boolean(name && knownNames.includes(normalizeNameForMatch(name)));
  });
}

type CandidateRejectionReason =
  | "from_dashboard_name"
  | "from_view_name"
  | "from_workbook_name"
  | "from_project_name"
  | "from_worksheet_name"
  | "from_owner_name"
  | "missing_content_type"
  | "name_mismatch"
  | "no_identifier";

type DatasourceResolutionDiagnostics = {
  sources: string[];
  calledResolutionTools: {
    listDatasources: boolean;
    searchContent: boolean;
  };
  rejectedReasonCounts: Record<CandidateRejectionReason, number>;
};

const DATASOURCE_SOURCE_TOOL_NAMES = [
  "list-datasources",
  "search-content",
  "list-views",
  "get-workbook",
  "list-workbooks",
] as const;

function extractDatasourceCandidatesFromRawToolResults(
  rawToolResults: RawMcpToolResult[],
): ResolvedDatasourceRef[] {
  const candidates: ResolvedDatasourceRef[] = [];

  for (const toolResult of rawToolResults) {
    if (
      !DATASOURCE_SOURCE_TOOL_NAMES.includes(
        toolResult.toolName as (typeof DATASOURCE_SOURCE_TOOL_NAMES)[number],
      )
    ) {
      continue;
    }

    const payloads = parseToolResultPayloads(toolResult.result);
    for (const payload of payloads) {
      const records = findObjectRecords(payload);
      for (const record of records) {
        const explicitDatasourceName =
          extractExplicitDatasourceName(record) ??
          (toolResult.toolName === "list-datasources" &&
          hasListDatasourceShape(record)
            ? readString(record.name)
            : undefined);
        const contentType =
          readString(record.contentType)?.toLowerCase() ??
          readString(record.type)?.toLowerCase();
        if (!explicitDatasourceName && contentType !== "datasource") {
          continue;
        }

        const normalized = normalizeDatasourceObject(
          record,
          explicitDatasourceName,
        );
        if (!normalized) {
          continue;
        }

        candidates.push({
          name: normalized.name,
          id: normalized.id,
          luid: normalized.luid,
          contentUrl: normalized.contentUrl,
          projectName: normalized.projectName,
          workbookName: normalized.workbookName,
          matchConfidence: 0,
          matchReason: "candidate_extracted",
          source: mapToolNameToDatasourceSource(toolResult.toolName),
        });
      }
    }
  }

  return dedupeResolvedDatasourceRefs(candidates);
}

function mapToolNameToDatasourceSource(
  toolName: string,
): ResolvedDatasourceRef["source"] {
  if (toolName === "search-content") {
    return "search-content";
  }
  if (toolName === "get-workbook") {
    return "get-workbook";
  }
  if (toolName === "list-workbooks") {
    return "list-workbooks";
  }
  if (toolName === "list-views") {
    return "list-views";
  }
  return "list-datasources";
}

function findObjectRecords(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => findObjectRecords(item));
  }

  const record = value as Record<string, unknown>;
  return [
    record,
    ...Object.values(record).flatMap((item) => findObjectRecords(item)),
  ];
}

function extractExplicitDatasourceName(
  record: Record<string, unknown>,
): string | undefined {
  const direct =
    readString(record.datasourceName) ?? readString(record.dataSourceName);
  if (direct) {
    return direct;
  }

  const nestedDatasource =
    record.datasource && typeof record.datasource === "object"
      ? readString((record.datasource as Record<string, unknown>).name)
      : undefined;
  if (nestedDatasource) {
    return nestedDatasource;
  }

  const nestedDataSource =
    record.dataSource && typeof record.dataSource === "object"
      ? readString((record.dataSource as Record<string, unknown>).name)
      : undefined;
  if (nestedDataSource) {
    return nestedDataSource;
  }

  const contentType =
    readString(record.contentType)?.toLowerCase() ??
    readString(record.type)?.toLowerCase();
  if (contentType === "datasource") {
    return readString(record.name);
  }

  return undefined;
}

function hasListDatasourceShape(record: Record<string, unknown>): boolean {
  const name = readString(record.name);
  const id =
    readString(record.id) ??
    readString(record.luid) ??
    readString(record.datasourceId) ??
    readString(record.datasourceLuid);
  const contentUrl = readString(record.contentUrl);
  return Boolean(name && (id || contentUrl));
}

export function resolveDatasourceIdentifier(
  knownDatasourceNames: string[],
  observations: McpObservation[],
  availableToolSchemas: Array<Pick<McpTool, "name" | "inputSchema">>,
  options: {
    rawToolResults?: RawMcpToolResult[];
    workbookName?: string;
    dashboardName?: string;
    viewName?: string;
    worksheetNames?: string[];
    projectNames?: string[];
  } = {},
): ResolvedDatasourceRef[] {
  const normalizedKnownNames = knownDatasourceNames
    .map((name) => name.trim())
    .filter(Boolean);
  const knownMatchKeys = normalizedKnownNames.map(normalizeNameForMatch);
  const rawCandidates = options.rawToolResults?.length
    ? extractDatasourceCandidatesFromRawToolResults(options.rawToolResults)
    : [];
  const rejectionCounts: Record<CandidateRejectionReason, number> = {
    from_dashboard_name: 0,
    from_view_name: 0,
    from_workbook_name: 0,
    from_project_name: 0,
    from_worksheet_name: 0,
    from_owner_name: 0,
    missing_content_type: 0,
    name_mismatch: 0,
    no_identifier: 0,
  };
  const rejectedCandidates: Array<{
    candidate: ResolvedDatasourceRef;
    reason: CandidateRejectionReason;
  }> = [];
  const calledResolutionTools = {
    listDatasources: Boolean(
      options.rawToolResults?.some(
        (result) => result.toolName === "list-datasources",
      ),
    ),
    searchContent: Boolean(
      options.rawToolResults?.some(
        (result) => result.toolName === "search-content",
      ),
    ),
  };

  const dashboardDerivedCandidates = normalizedKnownNames.map((name) => ({
    name,
    matchConfidence: 0.6,
    matchReason: "dashboard_context_hint",
    source: "dashboardContext" as const,
  }));
  rawCandidates.push(...dashboardDerivedCandidates);

  for (const observation of observations) {
    const extractedName =
      readString(observation.argsSummary.datasourceName) ??
      readString(observation.argsSummary.name);
    if (extractedName) {
      rawCandidates.push({
        name: extractedName,
        matchConfidence: 0,
        matchReason: "observation_hint",
        source: "dashboardContext",
      });
    }
  }

  const disallowedNormalizedNames = new Map<string, CandidateRejectionReason>();
  const addDisallowed = (
    name: string | undefined,
    reason: CandidateRejectionReason,
  ): void => {
    const normalized = normalizeNameForMatch(name ?? "");
    if (!normalized) {
      return;
    }
    if (!disallowedNormalizedNames.has(normalized)) {
      disallowedNormalizedNames.set(normalized, reason);
    }
  };
  addDisallowed(options.dashboardName, "from_dashboard_name");
  addDisallowed(options.viewName, "from_view_name");
  addDisallowed(options.workbookName, "from_workbook_name");
  for (const worksheetName of options.worksheetNames ?? []) {
    addDisallowed(worksheetName, "from_worksheet_name");
  }
  for (const projectName of options.projectNames ?? []) {
    addDisallowed(projectName, "from_project_name");
  }

  const rawCandidateCount = rawCandidates.length;
  const scored = rawCandidates
    .map((candidate) => {
      const normalizedCandidate = normalizeNameForMatch(candidate.name);
      const disallowedReason =
        disallowedNormalizedNames.get(normalizedCandidate);
      if (disallowedReason) {
        rejectionCounts[disallowedReason] += 1;
        rejectedCandidates.push({ candidate, reason: disallowedReason });
        return undefined;
      }

      const exactIndex = normalizedKnownNames.findIndex(
        (name) =>
          name.trim().toLowerCase() === candidate.name.trim().toLowerCase(),
      );
      const normalizedIndex = knownMatchKeys.findIndex(
        (key) => key === normalizedCandidate,
      );
      const containsIndex = knownMatchKeys.findIndex(
        (key) =>
          key.includes(normalizedCandidate) ||
          normalizedCandidate.includes(key),
      );
      const singletonFallbackEnabled =
        normalizedKnownNames.length === 1 &&
        rawCandidates.length === 1 &&
        hasResolvableDatasourceIdentifier(candidate);
      if (
        knownMatchKeys.length > 0 &&
        exactIndex < 0 &&
        normalizedIndex < 0 &&
        containsIndex < 0 &&
        !singletonFallbackEnabled
      ) {
        rejectionCounts.name_mismatch += 1;
        rejectedCandidates.push({ candidate, reason: "name_mismatch" });
        return undefined;
      }

      const confidence =
        exactIndex >= 0
          ? 1
          : normalizedIndex >= 0
            ? 0.95
            : containsIndex >= 0
              ? 0.75
              : singletonFallbackEnabled
                ? 0.72
                : 0.4;
      const workbookBoost =
        options.workbookName &&
        candidate.workbookName &&
        normalizeNameForMatch(candidate.workbookName) ===
          normalizeNameForMatch(options.workbookName)
          ? 0.05
          : 0;
      return {
        ...candidate,
        matchConfidence: Math.min(confidence + workbookBoost, 1),
        matchReason:
          exactIndex >= 0
            ? "exact_name_match"
            : normalizedIndex >= 0
              ? "normalized_name_match"
              : containsIndex >= 0
                ? "partial_name_match"
                : singletonFallbackEnabled
                  ? "single_candidate_with_identifier"
                  : "low_confidence_candidate",
      };
    })
    .filter((candidate): candidate is ResolvedDatasourceRef =>
      Boolean(candidate),
    )
    .filter((candidate) => {
      if (candidate.matchConfidence >= (knownMatchKeys.length ? 0.7 : 0.4)) {
        return true;
      }
      rejectionCounts.name_mismatch += 1;
      rejectedCandidates.push({ candidate, reason: "name_mismatch" });
      return false;
    })
    .sort((left, right) => right.matchConfidence - left.matchConfidence);

  const unique = dedupeResolvedDatasourceRefs(scored);
  const unresolvedIdentifierCount = unique.filter(
    (candidate) => !hasResolvableDatasourceIdentifier(candidate),
  ).length;
  if (unresolvedIdentifierCount > 0) {
    rejectionCounts.no_identifier += unresolvedIdentifierCount;
  }
  const diagnostics: DatasourceResolutionDiagnostics = {
    sources: [...new Set(rawCandidates.map((candidate) => candidate.source))],
    calledResolutionTools,
    rejectedReasonCounts: rejectionCounts,
  };
  logInfo("tableau.mcp.datasource.identifier_resolution", {
    knownDatasourceNames: normalizedKnownNames.length,
    candidateDatasourceCount: rawCandidateCount,
    matchedDatasourceCount: unique.length,
    matchMethod: unique[0]?.matchReason ?? "none",
    selectedIdentifierType: selectIdentifierType(unique[0]),
    selectedIdentifierPresent: Boolean(
      unique[0] && hasResolvableDatasourceIdentifier(unique[0]),
    ),
    ambiguousCandidateCount: countAmbiguousCandidates(unique),
    datasourceCandidateSources: diagnostics.sources,
    listDatasourcesCalled: diagnostics.calledResolutionTools.listDatasources,
    searchContentCalled: diagnostics.calledResolutionTools.searchContent,
    rejectedDatasourceCandidateCount: Object.values(
      diagnostics.rejectedReasonCounts,
    ).reduce((sum, count) => sum + count, 0),
    rejectedReasonBreakdown: diagnostics.rejectedReasonCounts,
    schemaRequiredArgs: availableToolSchemas
      .find((tool) => tool.name === "get-datasource-metadata")
      ?.inputSchema?.required?.slice(0, 6),
  });
  if (getConfig().tableau.mcp.debugLogResults) {
    logInfo("tableau.mcp.datasource.identifier_resolution_debug", {
      knownDatasourceCount: normalizedKnownNames.length,
      candidateDatasourceCount: rawCandidateCount,
      knownNamePreview: normalizedKnownNames[0]?.slice(0, 120),
      candidateNamePreview: rawCandidates[0]?.name.slice(0, 120),
      knownNameNormalizedHash: safeHash(knownMatchKeys[0]),
      candidateNameNormalizedHash: safeHash(
        rawCandidates[0]?.name
          ? normalizeNameForMatch(rawCandidates[0].name)
          : undefined,
      ),
      candidateSource: rawCandidates[0]?.source ?? "none",
      candidateHasId: Boolean(readString(rawCandidates[0]?.id)),
      candidateHasLuid: Boolean(readString(rawCandidates[0]?.luid)),
      candidateHasContentUrl: Boolean(readString(rawCandidates[0]?.contentUrl)),
      matchRejectedReason: rejectedCandidates[0]?.reason ?? "none",
    });
  }

  if (
    normalizedKnownNames.length > 0 &&
    unique.length > 0 &&
    !unique.some(hasResolvableDatasourceIdentifier)
  ) {
    const identifierResolutionFailedReason =
      !diagnostics.calledResolutionTools.listDatasources &&
      !diagnostics.calledResolutionTools.searchContent
        ? "datasource_resolution_tools_not_called"
        : diagnostics.calledResolutionTools.listDatasources &&
            !diagnostics.calledResolutionTools.searchContent
          ? "list_datasources_result_has_no_identifier"
          : diagnostics.calledResolutionTools.searchContent
            ? "search_content_result_has_no_identifier"
            : "datasource_identifier_not_resolved_from_dashboard_context";
    logWarn("tableau.mcp.datasource.identifier_resolution_failed", {
      reason: identifierResolutionFailedReason,
      knownDatasourceNames: normalizedKnownNames.length,
      candidateCount: unique.length,
      identifierResolutionFailedReason,
    });
  }

  return unique;
}

function dedupeResolvedDatasourceRefs(
  candidates: ResolvedDatasourceRef[],
): ResolvedDatasourceRef[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key =
      readString(candidate.luid) ??
      readString(candidate.id) ??
      readString(candidate.contentUrl) ??
      normalizeNameForMatch(candidate.name);
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function countAmbiguousCandidates(candidates: ResolvedDatasourceRef[]): number {
  if (candidates.length <= 1) {
    return 0;
  }

  const bestConfidence = candidates[0].matchConfidence;
  return (
    candidates.filter(
      (candidate) =>
        Math.abs(candidate.matchConfidence - bestConfidence) <= 0.051,
    ).length - 1
  );
}

function normalizeNameForMatch(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[()[\]{}<>]/g, "")
    .replace(/[-_.\/\\]/g, "")
    .replace(/\s+/g, "");
}

function buildDatasourceMetadataArgs(
  candidate: ResolvedDatasourceRef,
): Record<string, unknown> {
  return {
    datasourceLuid: candidate.luid ?? candidate.id,
    datasourceId: candidate.id,
    contentUrl: candidate.contentUrl,
  };
}

function buildAggregateQueryDatasourceArgs(
  datasourceRef: ResolvedDatasourceRef,
  rawToolResults: RawMcpToolResult[],
  questionInterpretation: QuestionInterpretation,
): Record<string, unknown> | undefined {
  if (
    questionInterpretation.requestType === "datasource_inventory" ||
    questionInterpretation.requestType === "field_inventory"
  ) {
    logDebug("tableau.mcp.query.skipped_for_request_type", {
      requestType: questionInterpretation.requestType,
      datasourceNameHash: safeHash(datasourceRef.name),
      metricIntent: questionInterpretation.metricIntent,
    });
    return undefined;
  }

  const datasourceLuid =
    readString(datasourceRef.luid) ?? readString(datasourceRef.id);
  if (!datasourceLuid) {
    return undefined;
  }

  const datasourceForProfile: TableauDatasourceRef = {
    type: "datasource",
    name: datasourceRef.name,
    ...(datasourceRef.id ? { id: datasourceRef.id } : {}),
    ...(datasourceRef.luid ? { luid: datasourceRef.luid } : {}),
    ...(datasourceRef.contentUrl
      ? { contentUrl: datasourceRef.contentUrl }
      : {}),
    ...(datasourceRef.projectName
      ? { projectName: datasourceRef.projectName }
      : {}),
    ...(datasourceRef.workbookName
      ? { workbookName: datasourceRef.workbookName }
      : {}),
  };
  const fieldProfiles = extractDatasourceFieldProfilesFromRawToolResults(
    rawToolResults,
    [datasourceForProfile],
  );
  const fieldDetails = fieldProfiles[0]?.fields ?? [];
  const fieldNames = fieldProfiles[0]?.fieldNames ?? [];
  const metricSelection = selectAggregateMetricField(
    fieldDetails,
    questionInterpretation,
  );
  const metricField = metricSelection.fieldName;
  if (!metricField) {
    logDebug("tableau.mcp.query.metric_candidates_scored", {
      datasourceNameHash: safeHash(datasourceRef.name),
      metricIntent: questionInterpretation.metricIntent,
      selectedMetricField: undefined,
      candidates: metricSelection.candidates.slice(0, 8),
    });
    return undefined;
  }

  const dimensionField = chooseAggregateDimensionField(
    fieldDetails,
    questionInterpretation,
  );
  const dateField = chooseAggregateDateField(fieldDetails);
  const period = questionInterpretation.period;
  const isGroupedTrend =
    questionInterpretation.analysisIntent === "grouped_trend" ||
    questionInterpretation.groupingIntent === "hashtag";
  const topN = isGroupedTrend
    ? Math.max(questionInterpretation.topN, 10)
    : questionInterpretation.topN;
  const groupedTrendPlan = isGroupedTrend
    ? buildGroupedTrendQueryFieldSpecs({
        fieldDetails,
        questionInterpretation,
        metricSelection,
      })
    : undefined;
  const queryFieldsBeforeDedupe: Array<Record<string, unknown>> = [];
  if (dimensionField) {
    queryFieldsBeforeDedupe.push({
      fieldCaption: dimensionField,
      fieldAlias: QUERY_DIMENSION_ALIAS,
    });
  }

  if (groupedTrendPlan?.fields.length) {
    queryFieldsBeforeDedupe.push(...groupedTrendPlan.fields);
  } else if (metricSelection.fieldSpec) {
    queryFieldsBeforeDedupe.push(metricSelection.fieldSpec);
  }

  const queryFieldsAfterDedupe = dedupeQueryDatasourceFields(
    queryFieldsBeforeDedupe,
  );
  if (!queryFieldsAfterDedupe.length) {
    return undefined;
  }

  const derivedMetricsComputedInApp =
    groupedTrendPlan?.derivedMetricsComputedInApp ?? [];
  const selectedMetricFieldForQuery =
    groupedTrendPlan?.selectedMetricFieldCaption ?? metricField;
  const queryLimit =
    isGroupedTrend && questionInterpretation.metricIntent === "engagement_rate"
      ? Math.max(topN * 5, 20)
      : topN;

  const filters =
    dateField && period
      ? [
          {
            field: {
              fieldCaption: dateField,
            },
            filterType: "QUANTITATIVE_DATE",
            quantitativeFilterType: "RANGE",
            minDate: period.startDate,
            maxDate: period.endDate,
            includeNulls: false,
          },
        ]
      : undefined;

  const queryArgs = {
    datasourceLuid,
    query: {
      fields: queryFieldsAfterDedupe,
      ...(filters ? { filters } : {}),
    },
    limit: queryLimit,
  };

  logDebug("tableau.mcp.query.aggregate_args_built", {
    selectedDatasourceName: datasourceRef.name,
    datasourceNameHash: safeHash(datasourceRef.name),
    datasourceLuidHash: safeHash(datasourceLuid),
    analysisIntent: questionInterpretation.analysisIntent,
    metricIntent: questionInterpretation.metricIntent,
    requestedMetricText: questionInterpretation.requestedMetricText ?? null,
    groupingIntent: questionInterpretation.groupingIntent ?? "unknown",
    groupingFieldHint: questionInterpretation.groupingFieldHint ?? [],
    selectedGroupingField: dimensionField,
    rankingTarget: questionInterpretation.rankingTarget ?? "unknown",
    metricField,
    selectedMetricField: selectedMetricFieldForQuery,
    derivedMetricFormula: questionInterpretation.derivedMetricFormula ?? null,
    dimensionField,
    dateField,
    periodStart: period?.startDate,
    periodEnd: period?.endDate,
    topN,
    queryLimit,
    fieldNameCount: fieldNames.length,
    componentFieldCount: metricSelection.componentFields?.length ?? 0,
    hasFilters: Boolean(filters?.length),
    queryFieldsBeforeDedupe: summarizeQueryFieldSpecs(queryFieldsBeforeDedupe),
    queryFieldsAfterDedupe: summarizeQueryFieldSpecs(queryFieldsAfterDedupe),
    dedupedFieldCount:
      queryFieldsBeforeDedupe.length - queryFieldsAfterDedupe.length,
    derivedMetricsComputedInApp,
    queryArgsSummary: summarizeQueryDatasourceArgs(queryArgs),
  });
  logDebug("tableau.mcp.query.metric_candidates_scored", {
    datasourceNameHash: safeHash(datasourceRef.name),
    metricIntent: questionInterpretation.metricIntent,
    requestedMetricText: questionInterpretation.requestedMetricText ?? null,
    selectedMetricField: selectedMetricFieldForQuery,
    componentFields: metricSelection.componentFields,
    candidates: metricSelection.candidates.slice(0, 8),
  });

  return queryArgs;
}

function chooseAggregateDimensionField(
  fieldDetails: DatasourceFieldDetail[],
  questionInterpretation: QuestionInterpretation,
): string | undefined {
  const trimmed = fieldDetails
    .map((fieldDetail) => fieldDetail.name.trim())
    .filter(Boolean);
  if (!trimmed.length) {
    return undefined;
  }

  const preferredHints = questionInterpretation.groupingFieldHint ?? [];
  const hintHit = findFieldByHints(trimmed, preferredHints);
  if (hintHit) {
    return hintHit;
  }

  if (questionInterpretation.groupingIntent === "hashtag") {
    const hashtagCandidates = trimmed
      .map((fieldName) => ({
        fieldName,
        score: scoreHashtagDimensionField(fieldName),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.fieldName.length - left.fieldName.length;
      });
    const selectedHashtagCandidate = hashtagCandidates.find(
      (candidate) => candidate.score > 0,
    );
    if (selectedHashtagCandidate) {
      return selectedHashtagCandidate.fieldName;
    }
  }

  if (questionInterpretation.rankingTarget === "post") {
    const postCandidates = trimmed
      .map((fieldName) => ({
        fieldName,
        score: scorePostDimensionField(fieldName),
        postSpecific: isPostSpecificDimensionField(fieldName),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.fieldName.length - left.fieldName.length;
      });
    const selectedPostCandidate = postCandidates.find(
      (candidate) => candidate.postSpecific && candidate.score > 0,
    );
    if (selectedPostCandidate) {
      return selectedPostCandidate.fieldName;
    }
    return undefined;
  }

  if (questionInterpretation.groupingIntent === "author") {
    const authorHit = trimmed.find((fieldName) =>
      /author|creator|user|profile/i.test(fieldName),
    );
    if (authorHit) {
      return authorHit;
    }
  }

  const rankedPatterns = [
    /workbook.*(title|name)/i,
    /(title|name)$/i,
    /(name|title)/i,
  ];
  for (const pattern of rankedPatterns) {
    const hit = trimmed.find((fieldName) => pattern.test(fieldName));
    if (hit) {
      return hit;
    }
  }

  return trimmed[0];
}

function findFieldByHints(
  fieldNames: string[],
  hints: string[],
): string | undefined {
  const normalizedFieldNames = fieldNames.map((fieldName) => ({
    fieldName,
    normalized: normalizeNameForMatch(fieldName),
  }));
  for (const hint of hints) {
    const normalizedHint = normalizeNameForMatch(hint);
    const exactMatch = normalizedFieldNames.find(
      (candidate) =>
        candidate.normalized === normalizedHint ||
        candidate.normalized.includes(normalizedHint) ||
        normalizedHint.includes(candidate.normalized),
    );
    if (exactMatch) {
      return exactMatch.fieldName;
    }
  }
  return undefined;
}

function scoreHashtagDimensionField(fieldName: string): number {
  const normalized = normalizeNameForMatch(fieldName);
  if (!normalized) {
    return 0;
  }
  if (/hashtag normalized/.test(normalized)) {
    return 120;
  }
  if (/hashtag|hash tag|ハッシュタグ/.test(normalized)) {
    return 100;
  }
  if (/tag/.test(normalized) && /hash/.test(normalized)) {
    return 85;
  }
  if (/position|rank/.test(normalized) && /hashtag/.test(normalized)) {
    return 70;
  }
  return 0;
}

function escapeTableauCalculationName(value: string): string {
  return value.replace(/]/g, "\\]");
}

type AggregateMetricCandidate = {
  fieldName: string;
  dataType?: string;
  role?: string;
  score: number;
  reasons: string[];
};

type AggregateMetricSelection = {
  fieldName?: string;
  fieldSpec?: Record<string, unknown>;
  candidates: AggregateMetricCandidate[];
  componentFields?: string[];
};

export function selectAggregateMetricField(
  fieldDetails: DatasourceFieldDetail[],
  questionInterpretation: QuestionInterpretation,
): AggregateMetricSelection {
  if (questionInterpretation.metricIntent === "reactions") {
    const componentFields = fieldDetails
      .filter(
        (fieldDetail) =>
          fieldDetail.name.trim().length > 0 &&
          isNumericFieldDetail(fieldDetail) &&
          isMeasureFieldDetail(fieldDetail) &&
          /reaction/i.test(fieldDetail.name),
      )
      .map((fieldDetail) => fieldDetail.name);
    const reactionCandidates = fieldDetails
      .filter((fieldDetail) => fieldDetail.name.trim().length > 0)
      .map((fieldDetail) => {
        const reasons: string[] = [];
        let score = 0;

        if (/reaction/i.test(fieldDetail.name)) {
          score += 90;
          reasons.push("reaction_component_match");
        }
        if (isNumericFieldDetail(fieldDetail)) {
          score += 80;
          reasons.push("numeric_type");
        } else {
          score -= 30;
          reasons.push("non_numeric_penalty");
        }
        if (isMeasureFieldDetail(fieldDetail)) {
          score += 35;
          reasons.push("measure_role");
        }
        if (
          /path|url|repo|title|name|description|profile|view/i.test(
            fieldDetail.name,
          )
        ) {
          score -= 90;
          reasons.push("non_metric_name_penalty");
        }

        return {
          fieldName: fieldDetail.name,
          dataType: fieldDetail.dataType,
          role: fieldDetail.role ?? fieldDetail.semanticRole,
          score,
          reasons,
        };
      })
      .sort((left, right) => right.score - left.score);

    if (componentFields.length >= 2) {
      return {
        fieldName: "Total Reactions",
        fieldSpec: {
          fieldCaption: "Total Reactions",
          calculation: componentFields
            .map((fieldName) => `SUM([${fieldName.replace(/]/g, "\\]")}])`)
            .join(" + "),
          fieldAlias: QUERY_METRIC_ALIAS,
          sortDirection: "DESC",
          sortPriority: 1,
        },
        candidates: [
          {
            fieldName: "Total Reactions",
            dataType: "NUMBER",
            role: "MEASURE",
            score: 999,
            reasons: ["composite_reaction_metric", ...componentFields],
          },
          ...reactionCandidates,
        ],
        componentFields,
      };
    }

    return {
      fieldName: undefined,
      candidates: reactionCandidates,
      componentFields,
    };
  }

  if (questionInterpretation.metricIntent === "engagement_rate") {
    const directRateCandidates = fieldDetails
      .filter((fieldDetail) => fieldDetail.name.trim().length > 0)
      .map((fieldDetail) => {
        const reasons: string[] = [];
        let score = 0;
        if (
          /engagement.?rate|engagement_rate|エンゲージメント率|率/i.test(
            fieldDetail.name,
          )
        ) {
          score += 200;
          reasons.push("explicit_rate_field");
        }
        if (isNumericFieldDetail(fieldDetail)) {
          score += 70;
          reasons.push("numeric_type");
        } else {
          score -= 40;
          reasons.push("non_numeric_penalty");
        }
        if (isMeasureFieldDetail(fieldDetail)) {
          score += 25;
          reasons.push("measure_role");
        }
        return {
          fieldName: fieldDetail.name,
          dataType: fieldDetail.dataType,
          role: fieldDetail.role ?? fieldDetail.semanticRole,
          score,
          reasons,
        };
      })
      .sort((left, right) => right.score - left.score);
    const directRateField = directRateCandidates.find(
      (candidate) => candidate.score >= 200,
    );
    if (directRateField) {
      return {
        fieldName: directRateField.fieldName,
        fieldSpec: {
          fieldCaption: directRateField.fieldName,
          function: "AVG",
          fieldAlias: QUERY_METRIC_ALIAS,
          sortDirection: "DESC",
          sortPriority: 1,
        },
        candidates: directRateCandidates,
      };
    }

    const engagementField = fieldDetails.find((fieldDetail) =>
      /engagement|エンゲージメント/i.test(fieldDetail.name),
    )?.name;
    const impressionField = fieldDetails.find((fieldDetail) =>
      /impression|インプレッション/i.test(fieldDetail.name),
    )?.name;
    if (engagementField && impressionField) {
      const formula = `SUM([${escapeTableauCalculationName(
        engagementField,
      )}]) / SUM([${escapeTableauCalculationName(impressionField)}])`;
      return {
        fieldName: "エンゲージメント率",
        fieldSpec: {
          fieldCaption: "エンゲージメント率",
          calculation: formula,
          fieldAlias: QUERY_METRIC_ALIAS,
          sortDirection: "DESC",
          sortPriority: 1,
        },
        candidates: [
          {
            fieldName: "エンゲージメント率",
            dataType: "NUMBER",
            role: "MEASURE",
            score: 999,
            reasons: [
              "derived_engagement_rate_formula",
              engagementField,
              impressionField,
            ],
          },
          ...directRateCandidates,
        ],
        componentFields: [engagementField, impressionField],
      };
    }
  }

  const candidates = fieldDetails
    .filter((fieldDetail) => fieldDetail.name.trim().length > 0)
    .map((fieldDetail) => {
      const reasons: string[] = [];
      let score = 0;

      if (
        questionInterpretation.requestedMetricText &&
        matchesRequestedMetricText(
          fieldDetail.name,
          questionInterpretation.requestedMetricText,
        )
      ) {
        score += 220;
        reasons.push("requested_metric_text_exact_match");
      } else if (questionInterpretation.requestedMetricText) {
        score -= 120;
        reasons.push("requested_metric_text_mismatch");
      }

      if (
        questionInterpretation.metricIntent !== "unknown" &&
        matchesMetricFieldIntent(
          fieldDetail.name,
          questionInterpretation.metricIntent,
        )
      ) {
        score += 140;
        reasons.push("metric_intent_match");
      }

      if (isNumericFieldDetail(fieldDetail)) {
        score += 80;
        reasons.push("numeric_type");
      } else if (isDateFieldDetail(fieldDetail)) {
        score -= 80;
        reasons.push("date_type_penalty");
      } else {
        score -= 30;
        reasons.push("non_numeric_penalty");
      }

      if (isMeasureFieldDetail(fieldDetail)) {
        score += 35;
        reasons.push("measure_role");
      }

      if (
        /count|total|number|sum|sales|profit|revenue|amount|score|rate/i.test(
          fieldDetail.name,
        )
      ) {
        score += 25;
        reasons.push("aggregate_name_hint");
      }

      if (questionInterpretation.metricIntent === "impressions") {
        if (/impression|インプレッション/i.test(fieldDetail.name)) {
          score += 90;
          reasons.push("impression_priority_boost");
        } else {
          score -= 80;
          reasons.push("impression_mismatch_penalty");
        }
      }

      if (questionInterpretation.metricIntent === "post_count") {
        if (
          /post count|posts count|post数|ポスト数|投稿数|件数/i.test(
            fieldDetail.name,
          )
        ) {
          score += 80;
          reasons.push("post_count_priority_boost");
        }
      }

      if (
        /path|url|repo|title|name|description|profile/i.test(fieldDetail.name)
      ) {
        score -= 90;
        reasons.push("non_metric_name_penalty");
      }

      return {
        fieldName: fieldDetail.name,
        dataType: fieldDetail.dataType,
        role: fieldDetail.role ?? fieldDetail.semanticRole,
        score,
        reasons,
      };
    })
    .sort((left, right) => right.score - left.score);

  const selected = candidates.find((candidate) => candidate.score > 0);
  return {
    fieldName: selected?.fieldName,
    fieldSpec: selected
      ? {
          fieldCaption: selected.fieldName,
          function: "SUM",
          fieldAlias: QUERY_METRIC_ALIAS,
          sortDirection: "DESC",
          sortPriority: 1,
        }
      : undefined,
    candidates,
  };
}

function buildGroupedTrendQueryFieldSpecs(input: {
  fieldDetails: DatasourceFieldDetail[];
  questionInterpretation: QuestionInterpretation;
  metricSelection: AggregateMetricSelection;
}): GroupedTrendFieldPlan {
  const fieldNames = input.fieldDetails
    .map((fieldDetail) => fieldDetail.name.trim())
    .filter(Boolean);
  const engagementField =
    fieldNames.find((fieldName) =>
      /engagement|エンゲージメント/i.test(fieldName),
    ) ?? undefined;
  const impressionField =
    fieldNames.find((fieldName) =>
      /impression|インプレッション/i.test(fieldName),
    ) ?? undefined;
  const postIdField =
    fieldNames.find((fieldName) =>
      /ポストid|ポストID|post id|post id|post_id|tweet id|tweet id|url|link/i.test(
        fieldName,
      ),
    ) ?? undefined;
  const fields: Record<string, unknown>[] = [];
  const derivedMetricsComputedInApp: string[] = [];
  const metricIntent = input.questionInterpretation.metricIntent;
  const pushMetricField = (
    fieldCaption: string | undefined,
    fieldAlias: string,
    sortPriority: number,
  ): void => {
    if (!fieldCaption) {
      return;
    }
    fields.push({
      fieldCaption,
      function: "SUM",
      fieldAlias,
      sortDirection: "DESC",
      sortPriority,
    });
  };

  const selectedMetricFieldCaption = (() => {
    if (metricIntent === "impressions" || metricIntent === "views") {
      return impressionField ?? input.metricSelection.fieldName;
    }
    if (metricIntent === "engagements" || metricIntent === "engagement_rate") {
      return engagementField ?? input.metricSelection.fieldName;
    }
    if (metricIntent === "post_count") {
      return postIdField ?? input.metricSelection.fieldName;
    }
    return input.metricSelection.fieldName;
  })();

  if (postIdField) {
    fields.push({
      fieldCaption: postIdField,
      function: "COUNT",
      fieldAlias: "post_count",
      sortDirection: "DESC",
      sortPriority: 3,
    });
  } else {
    fields.push({
      fieldCaption:
        input.fieldDetails[0]?.name ??
        input.questionInterpretation.groupingFieldHint?.[0] ??
        "post_count",
      function: "COUNT",
      fieldAlias: "post_count",
      sortDirection: "DESC",
      sortPriority: 3,
    });
  }

  if (metricIntent === "engagement_rate") {
    if (engagementField) {
      pushMetricField(engagementField, "engagement_total", 1);
    }
    if (impressionField) {
      pushMetricField(impressionField, "impression_total", 2);
    }
    if (engagementField && impressionField) {
      derivedMetricsComputedInApp.push("engagement_rate");
    }
  } else if (metricIntent === "impressions" || metricIntent === "views") {
    if (impressionField) {
      pushMetricField(impressionField, "impression_total", 1);
    }
    if (engagementField) {
      pushMetricField(engagementField, "engagement_total", 2);
    }
  } else if (metricIntent === "engagements") {
    if (engagementField) {
      pushMetricField(engagementField, "engagement_total", 1);
    }
    if (impressionField) {
      pushMetricField(impressionField, "impression_total", 2);
    }
  } else if (selectedMetricFieldCaption) {
    pushMetricField(selectedMetricFieldCaption, QUERY_METRIC_ALIAS, 1);
  }

  return {
    fields: dedupeQueryDatasourceFields(fields),
    derivedMetricsComputedInApp,
    selectedMetricFieldCaption,
  };
}

function chooseAggregateDateField(
  fieldDetails: DatasourceFieldDetail[],
): string | undefined {
  const trimmed = fieldDetails.filter((fieldDetail) => fieldDetail.name.trim());
  if (!trimmed.length) {
    return undefined;
  }

  const typedDateHit = trimmed.find((fieldDetail) =>
    isDateFieldDetail(fieldDetail),
  );
  if (typedDateHit) {
    return typedDateHit.name;
  }

  const patterns = [
    /date.*time/i,
    /datetime/i,
    /date/i,
    /time/i,
    /timestamp/i,
    /\(jst\)/i,
  ];
  for (const pattern of patterns) {
    const hit = trimmed.find((fieldDetail) => pattern.test(fieldDetail.name));
    if (hit) {
      return hit.name;
    }
  }

  return undefined;
}

function isNumericFieldDetail(fieldDetail: DatasourceFieldDetail): boolean {
  const haystack =
    `${fieldDetail.dataType ?? ""} ${fieldDetail.role ?? ""} ${fieldDetail.semanticRole ?? ""}`.toLowerCase();
  return /int|integer|long|short|float|double|decimal|number|numeric|real|measure|quantitative/.test(
    haystack,
  );
}

function isMeasureFieldDetail(fieldDetail: DatasourceFieldDetail): boolean {
  const haystack =
    `${fieldDetail.role ?? ""} ${fieldDetail.semanticRole ?? ""}`.toLowerCase();
  return /measure|quantitative/.test(haystack);
}

function isDateFieldDetail(fieldDetail: DatasourceFieldDetail): boolean {
  const haystack =
    `${fieldDetail.name} ${fieldDetail.dataType ?? ""}`.toLowerCase();
  return /date|datetime|time|timestamp/.test(haystack);
}

function selectBestResolvedDatasource(
  candidates: ResolvedDatasourceRef[],
): ResolvedDatasourceRef | undefined {
  const resolvable = candidates.filter(hasResolvableDatasourceIdentifier);
  if (!resolvable.length) {
    return undefined;
  }

  const best = resolvable[0];
  if (!best) {
    return undefined;
  }

  if (countAmbiguousCandidates(resolvable) > 0) {
    return undefined;
  }

  return best;
}

function hasResolvableDatasourceIdentifier(
  candidate: ResolvedDatasourceRef,
): boolean {
  return Boolean(
    readString(candidate.luid) ??
    readString(candidate.id) ??
    readString(candidate.contentUrl),
  );
}

function selectIdentifierType(
  candidate: ResolvedDatasourceRef | undefined,
): string {
  if (!candidate) {
    return "none";
  }
  if (candidate.luid) {
    return "luid";
  }
  if (candidate.id) {
    return "id";
  }
  if (candidate.contentUrl) {
    return "contentUrl";
  }
  return "none";
}

function readDatasourceIdentifierFromArgs(
  args: Record<string, unknown>,
): string | undefined {
  return (
    readString(args.datasourceLuid) ??
    readString(args.datasourceId) ??
    readString(args.datasource_id) ??
    readString(args.id) ??
    readString(args.contentUrl)
  );
}

function looksLikeIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  if (/^[A-Za-z0-9_-]{8,}$/.test(trimmed)) {
    return true;
  }

  if (trimmed.includes("/") || trimmed.includes(":")) {
    return true;
  }

  return false;
}

export function normalizeTableauContext(input: {
  dashboardContext: GetAdditionalContextInput["dashboardContext"];
  workbook: { id?: string; name: string } | undefined;
  rawToolResults: RawMcpToolResult[];
  datasources: unknown[];
}): NormalizedTableauContext {
  const workbookName =
    input.workbook?.name ?? input.dashboardContext.workbookName ?? undefined;
  const workbook: TableauWorkbookRef | undefined = workbookName
    ? {
        type: "workbook",
        name: workbookName,
        id:
          input.workbook?.id ??
          readString(input.dashboardContext.workbookId) ??
          undefined,
      }
    : undefined;
  const rawDatasourceCandidates = extractDatasourceCandidatesFromRawToolResults(
    input.rawToolResults,
  );
  const listDatasourcesCalled = input.rawToolResults.some(
    (result) => result.toolName === "list-datasources",
  );
  const searchContentCalled = input.rawToolResults.some(
    (result) => result.toolName === "search-content",
  );
  const resolvedDatasources = dedupeDatasourceObjects(
    (input.datasources as TableauDatasourceRef[]) ?? [],
  );
  const fallbackDatasources = dedupeDatasourceObjects(
    rawDatasourceCandidates.map((candidate) => ({
      type: "datasource" as const,
      name: candidate.name,
      id: candidate.id,
      luid: candidate.luid,
      contentUrl: candidate.contentUrl,
      projectName: candidate.projectName,
      workbookName: candidate.workbookName,
    })),
  );
  // Hotfix: do not re-expand to site-wide datasource candidates when narrowed matches already exist.
  const datasources = resolvedDatasources.length
    ? resolvedDatasources
    : fallbackDatasources;

  const projects = dedupeProjects(
    extractProjectRefsFromRawToolResults(
      input.rawToolResults,
      datasources,
    ).concat(
      datasources
        .map((datasource) => datasource.projectName)
        .filter((name): name is string => Boolean(name))
        .map((name) => ({ type: "project" as const, name })),
    ),
  );
  const views = dedupeViews(
    extractViewRefsFromRawToolResults(input.rawToolResults, workbookName),
  );
  const project = projects[0];

  logInfo("tableau.mcp.datasource.normalization", {
    datasourceSelectionSource: resolvedDatasources.length
      ? "resolved"
      : "fallback_raw_candidates",
    resolvedDatasourceCount: resolvedDatasources.length,
    fallbackDatasourceCount: fallbackDatasources.length,
    extractedDatasourceCount: datasources.length,
    extractedProjectCount: projects.length,
    excludedProjectAsDatasourceCount: projects.filter((projectRef) =>
      datasources.some(
        (datasource) =>
          normalizeNameForMatch(datasource.name) ===
          normalizeNameForMatch(projectRef.name),
      ),
    ).length,
    datasourceCandidateSources: [
      ...new Set(rawDatasourceCandidates.map((candidate) => candidate.source)),
    ],
    contentType: "datasource",
    projectNamePresent: datasources.some((datasource) =>
      Boolean(datasource.projectName),
    ),
    listDatasourcesCalled,
    searchContentCalled,
  });

  return {
    dashboard: {
      name: input.dashboardContext.dashboardName,
    },
    workbook,
    project,
    views,
    datasources,
    projects,
  };
}

function extractProjectRefsFromRawToolResults(
  rawToolResults: RawMcpToolResult[],
  datasources: TableauDatasourceRef[],
): TableauProjectRef[] {
  const fromDatasourceProjects = datasources
    .map((datasource) => datasource.projectName)
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ type: "project" as const, name }));
  const fromProjectContent = rawToolResults
    .filter((result) => result.toolName === "search-content")
    .flatMap((result) => parseToolResultPayloads(result.result))
    .flatMap(findObjectRecords)
    .filter(
      (record) =>
        (
          readString(record.contentType) ?? readString(record.type)
        )?.toLowerCase() === "project",
    )
    .map((record) => ({
      type: "project" as const,
      name: readString(record.name) ?? "Unknown project",
      id: readString(record.id) ?? readString(record.luid),
    }));

  return [...fromDatasourceProjects, ...fromProjectContent];
}

function extractViewRefsFromRawToolResults(
  rawToolResults: RawMcpToolResult[],
  workbookName?: string,
): TableauViewRef[] {
  return rawToolResults
    .filter(
      (result) =>
        result.toolName === "list-views" ||
        result.toolName === "search-content",
    )
    .flatMap((result) => parseToolResultPayloads(result.result))
    .flatMap(findObjectRecords)
    .filter((record) => {
      const contentType =
        readString(record.contentType)?.toLowerCase() ??
        readString(record.type)?.toLowerCase();
      return (
        contentType === "view" ||
        (resultLooksLikeViewRecord(record) && contentType !== "datasource")
      );
    })
    .map((record) => ({
      type: "view" as const,
      name:
        readString(record.name) ?? readString(record.title) ?? "Unknown view",
      id: readString(record.id) ?? readString(record.luid),
      workbookName:
        readString(record.workbookName) ??
        readString(record.parentWorkbookName) ??
        workbookName,
      workbookId:
        readString(record.workbookId) ??
        (record.workbook && typeof record.workbook === "object"
          ? readString((record.workbook as Record<string, unknown>).id)
          : undefined),
      projectName: readString(record.projectName),
    }));
}

function resultLooksLikeViewRecord(record: Record<string, unknown>): boolean {
  return Boolean(
    readString(record.sheetType) ||
    record.workbook ||
    readString(record.viewUrlname) ||
    readString(record.parentWorkbookName),
  );
}

function dedupeProjects(projects: TableauProjectRef[]): TableauProjectRef[] {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const key = readString(project.id) ?? normalizeNameForMatch(project.name);
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function dedupeViews(views: TableauViewRef[]): TableauViewRef[] {
  const seen = new Set<string>();
  return views.filter((view) => {
    const key = readString(view.id) ?? normalizeNameForMatch(view.name);
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumericLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function tryParseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function findObjectsWithId(
  value: unknown,
): Array<{ id: string; name?: string }> {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(findObjectsWithId);
  }

  const record = value as Record<string, unknown>;
  const direct =
    typeof record.id === "string"
      ? [
          {
            id: record.id,
            name: typeof record.name === "string" ? record.name : undefined,
          },
        ]
      : [];

  return [...direct, ...Object.values(record).flatMap(findObjectsWithId)];
}

function findFirstUuid(text: string): string | undefined {
  return text.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0];
}

function escapeFilterValue(value: string): string {
  return value.replace(/[,&]/g, " ").trim();
}

function sanitizeDashboardContext(
  input: GetAdditionalContextInput["dashboardContext"],
) {
  return {
    dashboardName: input.dashboardName,
    workbookName: input.workbookName,
    worksheetNames: input.worksheets.map((worksheet) => worksheet.name),
    filterFields: input.filters.map((filter) => filter.fieldName),
    parameterNames: input.parameters.map((parameter) => parameter.name),
    capturedAt: input.capturedAt,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}
