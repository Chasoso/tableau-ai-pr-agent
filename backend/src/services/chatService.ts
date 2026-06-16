import { randomUUID } from "node:crypto";
import { getConfig } from "../config";
import { logDebug, logInfo, logWarn, safeHash } from "../logging";
import {
  createChatHistoryRepository,
  type ChatHistoryRepository,
} from "../repositories/chatHistoryRepository";
import { DirectTableauApiContextProvider } from "../tableau/directTableauApiContextProvider";
import { MockTableauContextProvider } from "../tableau/mockTableauContextProvider";
import { resolveTableauDirectTrustAuthContext } from "../tableau/tableauDirectTrustAuth";
import { TableauMcpContextProvider } from "../tableau/tableauMcpContextProvider";
import type { TableauContextProvider } from "../tableau/contextProvider";
import type { AuthenticatedUser } from "../types/auth";
import type {
  ChatRequest,
  ChatResponse,
  ContextRequest,
  ContextResponse,
} from "../types/chat";
import type { NotionRankingItem } from "../types/notion";
import type {
  DashboardContext,
  DatasourceFieldProfile,
  QueryDatasourceInsight,
  QuestionInterpretation,
} from "../types/tableau";
import {
  detectRankingIntent,
  interpretQuestion,
  matchesMetricFieldIntent,
  metricIntentLabel,
} from "./questionInterpretation";
import {
  BedrockAnswerGenerator,
  MockAnswerGenerator,
  type AnswerGenerator,
} from "./answerGenerator";
import {
  BedrockChatAgent,
  NoopChatAgent,
  runLightweightAgentLoop,
  type ChatAgent,
} from "./chatAgent";
import {
  createNoopChatProgressReporter,
  type ChatProgressReporter,
} from "./chatProgress";
import { buildPrompt } from "./promptBuilder";

export class ChatService {
  constructor(
    private readonly contextProvider: TableauContextProvider,
    private readonly answerGenerator: AnswerGenerator,
    private readonly repository: ChatHistoryRepository,
    private readonly chatAgent: ChatAgent = new NoopChatAgent(),
  ) {}

  async generateAnswer(
    request: ChatRequest,
    authenticatedUser?: AuthenticatedUser,
    options: {
      getRemainingTimeInMillis?: () => number;
      progressReporter?: ChatProgressReporter;
      conversationOwnerKey?: string;
    } = {},
  ): Promise<ChatResponse> {
    const config = getConfig();
    const sessionId = request.sessionId || randomUUID();
    const messageId = randomUUID();
    const progressReporter =
      options.progressReporter ?? createNoopChatProgressReporter();
    const requestInterpretation = interpretQuestion({
      question: request.question,
      dashboardContext: request.dashboardContext,
    });
    const tableauAuth = resolveTableauDirectTrustAuthContext({
      authenticatedUser,
    });
    const tableauSubject = tableauAuth.subject;
    const ownerUserId =
      options.conversationOwnerKey ?? authenticatedUser?.userId;
    await progressReporter.report({
      stage: "loading_history",
      message: "会話履歴を確認中...",
      debug: {
        sessionId,
        messageId,
      },
    });
    const recentHistory = await this.repository.listRecentBySession({
      sessionId,
      ownerUserId,
      limit: config.chatMemoryMessageLimit,
    });
    logInfo("chat.service.context_lookup.started", {
      provider: this.contextProvider.name,
      sessionId,
      messageId,
      dashboardName: request.dashboardContext.dashboardName,
      worksheetCount: request.dashboardContext.worksheets.length,
      filterCount: request.dashboardContext.filters.length,
      parameterCount: request.dashboardContext.parameters.length,
      authenticated: Boolean(authenticatedUser),
      authTokenUse: authenticatedUser?.tokenUse,
      hasAuthenticatedEmail: Boolean(authenticatedUser?.email),
      tableauSubjectHash: safeHash(tableauSubject),
      historyCount: recentHistory.length,
    });
    logDebug("chat.message.input_debug", {
      sessionId,
      messageId,
      questionLength: request.question.length,
      question: clipForDebugLog(request.question),
    });
    const fastPathAnswer = buildDatasourceInventoryFastPathAnswer(
      request,
      requestInterpretation,
    );
    if (fastPathAnswer) {
      logInfo("chat.service.fast_path_answer.used", {
        sessionId,
        messageId,
        requestType: requestInterpretation.requestType,
        requestTypeConfidence: requestInterpretation.requestTypeConfidence,
        requestTypeSignals: requestInterpretation.requestTypeSignals,
      });
      await progressReporter.report({
        stage: "finalizing",
        message: "回答を保存中...",
        debug: {
          sessionId,
          messageId,
          path: "fast_path",
        },
      });
      return this.persistAndBuildResponse({
        sessionId,
        messageId,
        ownerUserId,
        request,
        answer: fastPathAnswer,
        notionPostIdeaDraft: buildNotionDraft(
          request.question,
          fastPathAnswer,
          request,
          {
            provider: "mock",
            questionInterpretation: requestInterpretation,
          },
        ),
      });
    }
    await progressReporter.report({
      stage: "loading_dashboard_context",
      message: "ダッシュボード情報を取得中...",
      debug: {
        sessionId,
        messageId,
      },
    });
    await progressReporter.report({
      stage: "planning",
      message: "分析計画を作成中...",
      debug: {
        requestType: requestInterpretation.requestType,
        requestTypeConfidence: requestInterpretation.requestTypeConfidence,
        metricIntent: requestInterpretation.metricIntent,
      },
    });
    const agentLoopResult = await runLightweightAgentLoop({
      agent: this.chatAgent,
      contextProvider: this.contextProvider,
      request,
      recentHistory,
      authenticatedUser,
      tableauSubject,
      tableauAuth,
      baseQuestionInterpretation: requestInterpretation,
      getRemainingTimeInMillis: options.getRemainingTimeInMillis,
    });
    const additionalContext = agentLoopResult.additionalContext;
    await progressReporter.report({
      stage: "running_mcp_tools",
      message: "MCP ツールを実行中...",
      toolName:
        additionalContext.mcpExecutionDebug?.executedTools?.at(-1) ??
        additionalContext.mcpExecutionDebug?.plannedTools?.at(0),
      debug: {
        provider: additionalContext.provider,
        toolCallCount: additionalContext.mcpExecutionDebug?.toolCallCount,
        plannedTools: additionalContext.mcpExecutionDebug?.plannedTools,
        executedTools: additionalContext.mcpExecutionDebug?.executedTools,
        replanUsed: additionalContext.mcpExecutionDebug?.replanUsed,
        fallbackReason: additionalContext.mcpExecutionDebug?.fallbackReason,
        passCount: agentLoopResult.debug?.passCount,
      },
    });
    logInfo("chat.service.context_lookup.completed", {
      provider: additionalContext.provider,
      sessionId,
      messageId,
      datasourceCount: additionalContext.datasources?.length ?? 0,
      hasWorkbook: Boolean(additionalContext.workbook),
      hasMetadata: hasResolvedMetadata(additionalContext),
      warningCount: additionalContext.warnings?.length ?? 0,
      agentPassCount: agentLoopResult.debug?.passCount ?? 0,
    });
    const metadataPathAnswer = buildFieldInventoryAnswerFromContext(
      request,
      additionalContext,
    );
    if (metadataPathAnswer) {
      logInfo("chat.service.metadata_path_answer.used", {
        sessionId,
        messageId,
        requestType: additionalContext.questionInterpretation?.requestType,
        fieldProfileCount:
          additionalContext.datasourceFieldProfiles?.length ?? 0,
      });
      await progressReporter.report({
        stage: "finalizing",
        message: "最終結果を保存中...",
        debug: {
          sessionId,
          messageId,
          path: "metadata_fast_path",
        },
      });
      return this.persistAndBuildResponse({
        sessionId,
        messageId,
        ownerUserId,
        request,
        answer: metadataPathAnswer,
        notionPostIdeaDraft: buildNotionDraft(
          request.question,
          metadataPathAnswer,
          request,
          additionalContext,
        ),
        dashboardContextPatch: buildDashboardContextPatch(
          request,
          additionalContext,
        ),
        debug: {
          usedMock: this.answerGenerator.name === "mock",
          tableauContextProvider: additionalContext.provider,
          ...(config.tableau.mcp.debugLogResults
            ? {
                mcpExecutionDebug: additionalContext.mcpExecutionDebug,
                mcpObservations: additionalContext.mcpObservations,
                agentExecutionDebug: agentLoopResult.debug,
              }
            : {}),
        },
      });
    }
    const remainingTimeBeforeAnswer =
      options.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY;
    if (remainingTimeBeforeAnswer < 8_000) {
      const deadlineFallback = buildDeadlineAwareDeterministicAnswer(
        request,
        additionalContext,
      );
      logWarn("chat.service.answer_generation_skipped_due_to_deadline", {
        sessionId,
        messageId,
        remainingTimeMs: remainingTimeBeforeAnswer,
        provider: additionalContext.provider,
      });
      await progressReporter.report({
        stage: "finalizing",
        message: "最終結果を保存中...",
        debug: {
          sessionId,
          messageId,
          path: "deadline_fallback",
        },
      });
      return this.persistAndBuildResponse({
        sessionId,
        messageId,
        ownerUserId,
        request,
        answer: deadlineFallback,
        notionPostIdeaDraft: buildNotionDraft(
          request.question,
          deadlineFallback,
          request,
          additionalContext,
        ),
        dashboardContextPatch: buildDashboardContextPatch(
          request,
          additionalContext,
        ),
        debug: {
          usedMock: this.answerGenerator.name === "mock",
          tableauContextProvider: additionalContext.provider,
          ...(config.tableau.mcp.debugLogResults
            ? {
                mcpExecutionDebug: additionalContext.mcpExecutionDebug,
                mcpObservations: additionalContext.mcpObservations,
                agentExecutionDebug: agentLoopResult.debug,
              }
            : {}),
        },
      });
    }
    await progressReporter.report({
      stage: "generating_answer",
      message: "回答を生成中...",
      debug: {
        sessionId,
        messageId,
      },
    });
    const prompt = buildPrompt(
      request,
      additionalContext,
      recentHistory,
      agentLoopResult.promptContext,
    );
    const answer = await this.answerGenerator.generate({
      request,
      prompt,
      additionalContext,
    });
    const finalAnswer = resolveFinalUserFacingAnswer(
      answer,
      request,
      additionalContext,
    );
    const sanitizedAnswer = finalAnswer.answer;
    logDebug("chat.final_answer.resolved", {
      sessionId,
      messageId,
      requestedMetricIntent:
        additionalContext.questionInterpretation?.metricIntent ?? "unknown",
      requestedMetricText:
        additionalContext.questionInterpretation?.requestedMetricText ?? null,
      selectedMetricField: finalAnswer.selectedMetricField ?? null,
      metricMatchConfidence: finalAnswer.metricMatchConfidence ?? null,
      rankingTarget:
        additionalContext.questionInterpretation?.rankingTarget ?? "unknown",
      selectedDimensionField: finalAnswer.selectedDimensionField ?? null,
      selectedGroupingField: finalAnswer.selectedDimensionField ?? null,
      dimensionMatchConfidence: finalAnswer.dimensionMatchConfidence ?? null,
      queryInsightUsedForFinalAnswer:
        finalAnswer.queryInsightUsedForFinalAnswer,
      answerHasActualQueryResult:
        finalAnswer.finalAnswerSource === "query_insight_template",
      finalAnswerSource: finalAnswer.finalAnswerSource,
      markdownValidationPassed: finalAnswer.markdownValidationPassed,
    });
    const notionPostIdeaDraft = buildNotionDraft(
      request.question,
      sanitizedAnswer,
      request,
      additionalContext,
    );
    logDebug("chat.message.output_debug", {
      sessionId,
      messageId,
      answerLength: sanitizedAnswer.length,
      answer: clipForDebugLog(sanitizedAnswer),
    });
    if (notionPostIdeaDraft) {
      logDebug("chat.notion_draft.generated", {
        sessionId,
        messageId,
        draftKind: notionPostIdeaDraft.draftKind ?? "post_idea",
        titleLength: notionPostIdeaDraft.title.length,
        summaryLength: notionPostIdeaDraft.summary?.length ?? 0,
        analysisBodyLength: notionPostIdeaDraft.analysisBody?.length ?? 0,
      });
    }
    const dashboardContextPatch = buildDashboardContextPatch(
      request,
      additionalContext,
    );
    await progressReporter.report({
      stage: "finalizing",
      message: "最終結果を保存中...",
      debug: {
        sessionId,
        messageId,
      },
    });
    if (dashboardContextPatch?.workbookName) {
      logInfo("chat.service.dashboard_context_patch.created", {
        provider: additionalContext.provider,
        sessionId,
        messageId,
        patchedFields: ["workbookName"],
      });
    }
    const createdAt = new Date().toISOString();
    return this.persistAndBuildResponse({
      sessionId,
      messageId,
      ownerUserId,
      request,
      answer: sanitizedAnswer,
      notionPostIdeaDraft,
      dashboardContextPatch,
      debug: {
        usedMock: this.answerGenerator.name === "mock",
        tableauContextProvider: additionalContext.provider,
        ...(config.tableau.mcp.debugLogResults
          ? {
              mcpExecutionDebug: additionalContext.mcpExecutionDebug,
              mcpObservations: additionalContext.mcpObservations,
              agentExecutionDebug: agentLoopResult.debug,
            }
          : {}),
      },
      createdAt,
    });
  }

  async getDashboardContextPatch(
    request: ContextRequest,
    authenticatedUser?: AuthenticatedUser,
  ): Promise<ContextResponse> {
    const tableauAuth = resolveTableauDirectTrustAuthContext({
      authenticatedUser,
    });
    const tableauSubject = tableauAuth.subject;
    logInfo("chat.service.context_patch.started", {
      provider: this.contextProvider.name,
      dashboardName: request.dashboardContext.dashboardName,
      workbookNamePresent: Boolean(request.dashboardContext.workbookName),
      worksheetCount: request.dashboardContext.worksheets.length,
      authenticated: Boolean(authenticatedUser),
      authTokenUse: authenticatedUser?.tokenUse,
      hasAuthenticatedEmail: Boolean(authenticatedUser?.email),
      tableauSubjectHash: safeHash(tableauSubject),
    });

    const additionalContext = await this.contextProvider.getAdditionalContext({
      dashboardContext: request.dashboardContext,
      question: "Resolve dashboard context for Tableau Assistant UI.",
      authenticatedUser,
      tableauSubject,
      tableauAuth,
    });
    const dashboardContextPatch = buildDashboardContextPatch(
      request,
      additionalContext,
    );

    logInfo("chat.service.context_patch.completed", {
      provider: additionalContext.provider,
      patchedFields: dashboardContextPatch?.workbookName
        ? ["workbookName"]
        : [],
      warningCount: additionalContext.warnings?.length ?? 0,
    });

    return {
      dashboardContextPatch,
      debug: {
        tableauContextProvider: additionalContext.provider,
      },
    };
  }

  private async persistAndBuildResponse(input: {
    sessionId: string;
    messageId: string;
    ownerUserId?: string;
    request: ChatRequest;
    answer: string;
    notionPostIdeaDraft?: ChatResponse["notionPostIdeaDraft"];
    dashboardContextPatch?: ChatResponse["dashboardContextPatch"];
    debug?: ChatResponse["debug"];
    createdAt?: string;
  }): Promise<ChatResponse> {
    await this.repository.save({
      sessionId: input.sessionId,
      messageId: input.messageId,
      ownerUserId: input.ownerUserId ?? null,
      question: input.request.question,
      answer: input.answer,
      dashboardName: input.request.dashboardContext.dashboardName,
      workbookName: input.request.dashboardContext.workbookName ?? null,
      worksheetNames: input.request.dashboardContext.worksheets.map(
        (worksheet) => worksheet.name,
      ),
      createdAt: input.createdAt ?? new Date().toISOString(),
      source: input.request.clientContext?.source,
    });

    return {
      answer: input.answer,
      sessionId: input.sessionId,
      messageId: input.messageId,
      notionPostIdeaDraft: input.notionPostIdeaDraft,
      dashboardContextPatch: input.dashboardContextPatch,
      debug: input.debug,
    };
  }
}

function buildNotionDraft(
  question: string,
  answer: string,
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): ChatResponse["notionPostIdeaDraft"] | undefined {
  const shouldBuildDraft = /(notion|保存|記録|登録|メモ|残して|残す)/i.test(
    question,
  );
  if (!shouldBuildDraft) {
    return undefined;
  }

  const draftKind = detectNotionDraftKind(question);
  const compactAnswer = answer.replace(/\s+/g, " ").trim();

  if (draftKind === "post_idea") {
    const reason =
      compactAnswer.slice(0, 260) || "Tableau MCP analysis based suggestion.";
    const titleSeed = question.replace(/[「」"']/g, "").trim();
    const title =
      titleSeed.length > 80
        ? `${titleSeed.slice(0, 80)}...`
        : titleSeed || "Tableau MCP 分析メモ";

    return {
      draftKind,
      title,
      reason,
      suggestedPostText: compactAnswer.slice(0, 1000),
      summary: compactAnswer.slice(0, 220),
      source: "Tableau MCP",
      tags: ["Tableau", "MCP", "X Analytics"],
    };
  }

  const datasourceName =
    additionalContext.normalizedContext?.datasources?.[0]?.name ??
    request.dashboardContext.dataSources?.[0]?.name;
  const periodLabel = additionalContext.questionInterpretation?.period?.label;
  const title = buildAnalysisMemoTitle({
    question,
    answer,
    periodLabel,
    datasourceName,
    dashboardName: request.dashboardContext.dashboardName,
  });
  const summary = buildAnalysisMemoSummary(answer, datasourceName);

  return {
    draftKind,
    title,
    reason: datasourceName
      ? `データソース「${datasourceName}」をもとに集計した分析結果を記録します。`
      : "Tableau MCP で取得した分析結果を記録します。",
    suggestedPostText: summary,
    summary,
    analysisBody: answer,
    datasourceName,
    periodLabel,
    rankingItems: extractRankingItems(answer),
    source: "Tableau MCP",
    tags: ["Tableau", "MCP", "Analysis Memo"],
  };
}

function detectNotionDraftKind(
  question: string,
): "analysis_memo" | "post_idea" {
  if (
    /(投稿案|投稿アイデア|ポスト案|推奨投稿文|x投稿|post idea|tweet)/i.test(
      question,
    )
  ) {
    return "post_idea";
  }

  return "analysis_memo";
}

function buildAnalysisMemoTitle(input: {
  question: string;
  answer: string;
  periodLabel?: string;
  datasourceName?: string;
  dashboardName?: string;
}): string {
  const firstSentence = input.answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const normalizedFirstSentence = firstSentence
    ?.replace(/^[-*]\s*/, "")
    .replace(/です。?$/, "")
    .replace(/でした。?$/, "")
    .trim();
  if (
    normalizedFirstSentence &&
    normalizedFirstSentence.length <= 80 &&
    !/(notion|保存|記録|登録)/i.test(normalizedFirstSentence)
  ) {
    return normalizedFirstSentence;
  }

  const strippedQuestion = input.question
    .replace(
      /では、?\s*これらの結果をNotionに(保存|記録|登録)してください。?/gi,
      "",
    )
    .replace(/notionに?(保存|記録|登録)(してください|したい|したいです)?/gi, "")
    .replace(/[「」"']/g, "")
    .trim();
  if (strippedQuestion && strippedQuestion.length <= 80) {
    return strippedQuestion;
  }

  if (input.periodLabel && /favorite/i.test(input.answer)) {
    return `${input.periodLabel} Favorite数ランキング`;
  }
  if (input.periodLabel && /view/i.test(input.answer)) {
    return `${input.periodLabel} View数ランキング`;
  }
  if (input.dashboardName) {
    return `${input.dashboardName} の分析メモ`;
  }

  return "Tableau MCP 分析メモ";
}

function buildAnalysisMemoSummary(
  answer: string,
  datasourceName?: string,
): string {
  const lines = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rankingLineIndex = lines.findIndex((line) => /^\d+\.\s+/.test(line));
  const summaryLines =
    rankingLineIndex >= 0
      ? lines.slice(0, rankingLineIndex)
      : lines.slice(0, 2);
  const summary = summaryLines.join(" ").replace(/\s+/g, " ").trim();
  if (summary) {
    return summary.length > 240 ? `${summary.slice(0, 240)}…` : summary;
  }

  if (datasourceName) {
    return `データソース「${datasourceName}」の分析結果メモです。`;
  }

  return "Tableau MCP の分析結果メモです。";
}

function extractRankingItems(answer: string): NotionRankingItem[] {
  const items: NotionRankingItem[] = [];
  for (const line of answer.split(/\r?\n/).map((value) => value.trim())) {
    const match = line.match(/^\d+\.\s+(.+?):\s+(.+)$/);
    if (!match) {
      continue;
    }

    items.push({
      label: match[1].trim(),
      value: match[2].trim(),
    });
  }

  return items;
}

function clipForDebugLog(value: string): string {
  const maxChars = Math.max(
    200,
    Number(process.env.CHAT_DEBUG_MAX_CHARS ?? 12000),
  );
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}

export function sanitizeUserFacingAnswer(
  answer: string,
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string {
  const answerAfterFieldValidation = sanitizeHallucinatedFieldMentions(
    answer,
    request,
    additionalContext,
  );
  const queryExecutionMissing =
    additionalContext.mcpExecutionDebug?.intent === "data_analysis" &&
    !hasSuccessfulDatasourceQuery(additionalContext);
  const looksLikeManualQueryInstruction =
    /```sql|select\s+.+\s+from|datasource query|クエリを実行|query\s+to\s+run|以下のクエリ|execute the query/i.test(
      answerAfterFieldValidation,
    );
  if (queryExecutionMissing && looksLikeManualQueryInstruction) {
    const datasourceNames =
      additionalContext.normalizedContext?.datasources
        ?.map((datasource) => datasource.name)
        .filter(Boolean) ??
      request.dashboardContext.dataSources
        ?.map((datasource) => datasource.name)
        .filter(Boolean) ??
      [];
    const datasourceText = datasourceNames.length
      ? datasourceNames.join("、")
      : "対象データソース";
    return [
      `このダッシュボードで確認できているデータソースは ${datasourceText} です。`,
      "ただし、今回の処理では安全制約により集計クエリを実行できなかったため、最終的なランキング結果までは確定できませんでした。",
      "次は、開発者向けの確認として安全制約で除外されたフィールド判定（機微情報判定）が厳しすぎないかを確認するのがよいです。",
    ].join("");
  }

  const containsInternalToolInstruction =
    /(get-datasource-metadata|query-datasource|datasource-id|datasource id)/i.test(
      answerAfterFieldValidation,
    );
  if (!containsInternalToolInstruction) {
    return answerAfterFieldValidation;
  }

  const isMetadataLookup =
    additionalContext.mcpExecutionDebug?.intent === "metadata_lookup";
  const metadataResolved = hasResolvedMetadata(additionalContext);
  if (!isMetadataLookup || metadataResolved) {
    return answerAfterFieldValidation
      .replace(/get-datasource-metadata/gi, "datasource metadata lookup")
      .replace(/query-datasource/gi, "datasource query")
      .replace(/datasource-id/gi, "datasource identifier");
  }

  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];
  const datasourceText = datasourceNames.length
    ? datasourceNames.join("、")
    : "対象データソース";

  return [
    `このダッシュボードで確認できているデータソースは ${datasourceText} です。`,
    "ただし、フィールド一覧を取得するために必要な Tableau Cloud 上の datasource id / luid / contentUrl をアプリ側で特定できなかったため、現時点ではフィールド一覧までは説明できません。",
    "次は、開発者向けの確認として list-datasources または search-content の結果に datasource identifier が含まれているかを確認するのがよいです。",
  ].join("");
}

export function finalizeUserFacingAnswer(
  answer: string,
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string {
  return resolveFinalUserFacingAnswer(answer, request, additionalContext)
    .answer;
}

type FinalAnswerSource =
  | "bedrock"
  | "query_insight_template"
  | "fast_path"
  | "fallback";

type FinalAnswerResolution = {
  answer: string;
  finalAnswerSource: FinalAnswerSource;
  queryInsightUsedForFinalAnswer: boolean;
  markdownValidationPassed: boolean;
  selectedMetricField?: string;
  metricMatchConfidence?: number;
  selectedDimensionField?: string;
  dimensionMatchConfidence?: number;
};

function resolveFinalUserFacingAnswer(
  answer: string,
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): FinalAnswerResolution {
  const datasourceInventoryAnswer = buildDatasourceInventoryAnswerFromContext(
    request,
    additionalContext,
  );
  if (datasourceInventoryAnswer) {
    return finalizeMarkdownAnswer({
      answer: datasourceInventoryAnswer,
      finalAnswerSource: "fast_path",
      queryInsightUsedForFinalAnswer: false,
    });
  }

  const fieldInventoryAnswer = buildFieldInventoryAnswerFromContext(
    request,
    additionalContext,
  );
  if (fieldInventoryAnswer) {
    return finalizeMarkdownAnswer({
      answer: fieldInventoryAnswer,
      finalAnswerSource: "fast_path",
      queryInsightUsedForFinalAnswer: false,
    });
  }

  const mcpFailureAnswer = buildMcpConnectionFailureAnswer(
    request,
    additionalContext,
  );
  if (mcpFailureAnswer) {
    return finalizeMarkdownAnswer({
      answer: mcpFailureAnswer,
      finalAnswerSource: "fallback",
      queryInsightUsedForFinalAnswer: false,
    });
  }

  const structuredAnswer = buildStructuredDataAnalysisAnswer(
    request,
    additionalContext,
  );
  if (structuredAnswer) {
    const selectedInsight = selectBestValidatedQueryInsight(
      additionalContext.queryInsights ?? [],
      additionalContext.questionInterpretation,
      request.question,
    );
    return finalizeMarkdownAnswer({
      answer: structuredAnswer,
      finalAnswerSource: "query_insight_template",
      queryInsightUsedForFinalAnswer: true,
      selectedMetricField: selectedInsight?.insight.metricField,
      metricMatchConfidence: selectedInsight?.metricMatchConfidence,
      selectedDimensionField: selectedInsight?.insight.dimensionField,
      dimensionMatchConfidence: selectedInsight?.dimensionMatchConfidence,
    });
  }

  const axisConfirmationFallback = buildAxisConfirmationFallback(
    request,
    additionalContext,
  );
  if (axisConfirmationFallback) {
    return finalizeMarkdownAnswer({
      answer: axisConfirmationFallback,
      finalAnswerSource: "fallback",
      queryInsightUsedForFinalAnswer: false,
    });
  }

  const groupedTrendFallback = buildGroupedTrendAnalysisFallback(
    request,
    additionalContext,
  );
  if (groupedTrendFallback) {
    return finalizeMarkdownAnswer({
      answer: groupedTrendFallback,
      finalAnswerSource: "fallback",
      queryInsightUsedForFinalAnswer: false,
    });
  }

  const noValidatedRankingFallback = buildNoValidatedRankingFallback(
    request,
    additionalContext,
  );
  if (noValidatedRankingFallback) {
    return finalizeMarkdownAnswer({
      answer: noValidatedRankingFallback,
      finalAnswerSource: "fallback",
      queryInsightUsedForFinalAnswer: false,
    });
  }

  const safeDataAnalysisFallback = buildSafeDataAnalysisFallback(
    request,
    additionalContext,
  );
  if (safeDataAnalysisFallback) {
    return finalizeMarkdownAnswer({
      answer: safeDataAnalysisFallback,
      finalAnswerSource: "fallback",
      queryInsightUsedForFinalAnswer: false,
    });
  }

  return finalizeMarkdownAnswer({
    answer: sanitizeUserFacingAnswer(answer, request, additionalContext),
    finalAnswerSource: "bedrock",
    queryInsightUsedForFinalAnswer: false,
  });
}

function finalizeMarkdownAnswer(input: {
  answer: string;
  finalAnswerSource: FinalAnswerSource;
  queryInsightUsedForFinalAnswer: boolean;
  selectedMetricField?: string;
  metricMatchConfidence?: number;
  selectedDimensionField?: string;
  dimensionMatchConfidence?: number;
}): FinalAnswerResolution {
  const markdownAnswer = ensureMarkdownDocument(input.answer);
  return {
    answer: markdownAnswer.answer,
    finalAnswerSource: input.finalAnswerSource,
    queryInsightUsedForFinalAnswer: input.queryInsightUsedForFinalAnswer,
    markdownValidationPassed: markdownAnswer.passed,
    selectedMetricField: input.selectedMetricField,
    metricMatchConfidence: input.metricMatchConfidence,
    selectedDimensionField: input.selectedDimensionField,
    dimensionMatchConfidence: input.dimensionMatchConfidence,
  };
}

function ensureMarkdownDocument(answer: string): {
  answer: string;
  passed: boolean;
} {
  const trimmed = answer.trim();
  if (!trimmed) {
    return {
      answer: "## 回答\n\n回答を生成できませんでした。",
      passed: true,
    };
  }

  if (looksLikeMarkdownDocument(trimmed)) {
    return { answer: trimmed, passed: true };
  }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    answer: ["## 回答", "", ...paragraphs].join("\n"),
    passed: true,
  };
}

function looksLikeMarkdownDocument(answer: string): boolean {
  return (
    /(^|\n)#{1,6}\s+\S/.test(answer) ||
    /(^|\n)(-|\*|\d+\.)\s+\S/.test(answer) ||
    /\n\|.+\|/.test(answer) ||
    /```/.test(answer) ||
    />\s+\S/.test(answer)
  );
}

function sanitizeHallucinatedFieldMentions(
  answer: string,
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string {
  if (additionalContext.provider !== "tableau-mcp") {
    return answer;
  }

  if (additionalContext.mcpExecutionDebug?.intent !== "metadata_lookup") {
    return answer;
  }

  const fieldProfiles = additionalContext.datasourceFieldProfiles ?? [];
  if (!fieldProfiles.length) {
    return answer;
  }

  const knownFieldNameSet = new Set(
    fieldProfiles
      .flatMap((profile) => profile.fieldNames)
      .map((fieldName) => normalizeFieldToken(fieldName))
      .filter(Boolean),
  );
  if (!knownFieldNameSet.size) {
    return answer;
  }

  const mentionedFieldCandidates = extractMentionedFieldCandidates(answer);
  const unknownMentionedFields = mentionedFieldCandidates.filter(
    (field) => !knownFieldNameSet.has(normalizeFieldToken(field)),
  );
  if (!unknownMentionedFields.length) {
    return answer;
  }

  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];

  return buildStrictFieldAnswerFromProfiles(fieldProfiles, datasourceNames);
}

function extractMentionedFieldCandidates(answer: string): string[] {
  const candidates = new Set<string>();

  for (const match of answer.matchAll(/`([^`\n]{2,120})`/g)) {
    const value = match[1]?.trim();
    if (looksLikeFieldToken(value)) {
      candidates.add(value);
    }
  }

  for (const line of answer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      continue;
    }
    const firstCell = trimmed.split("|")[1]?.trim();
    if (!firstCell || /^-+$/.test(firstCell)) {
      continue;
    }
    if (looksLikeFieldToken(firstCell)) {
      candidates.add(firstCell);
    }
  }

  return [...candidates];
}

function looksLikeFieldToken(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed || /^[\d\-_.]+$/.test(trimmed)) {
    return false;
  }

  return /[A-Za-z_]/.test(trimmed) && !/\s{2,}/.test(trimmed);
}

function normalizeFieldToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function buildStrictFieldAnswerFromProfiles(
  profiles: DatasourceFieldProfile[],
  datasourceNames: string[],
): string {
  const lines: string[] = [];
  const uniqueDatasourceNames = [...new Set(datasourceNames)];
  const headerDatasource = uniqueDatasourceNames.length
    ? uniqueDatasourceNames.join("、")
    : profiles.map((profile) => profile.datasourceName).join("、");
  lines.push(
    `このダッシュボードで確認できているデータソースは ${headerDatasource} です。`,
  );
  lines.push(
    "取得できたTableau Cloudのメタデータに基づくフィールド一覧は次のとおりです。",
  );

  for (const profile of profiles) {
    lines.push(`- ${profile.datasourceName}（${profile.fieldCount}件）`);
    lines.push(`  ${profile.fieldNames.join("、")}`);
  }

  lines.push(
    "上記以外のフィールド名は、今回取得できたメタデータでは確認できませんでした。",
  );
  return lines.join("\n");
}
function hasResolvedMetadata(
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): boolean {
  if (additionalContext.provider === "tableau-mcp") {
    const metadata = additionalContext.metadata as
      | Record<string, unknown>
      | undefined;
    if (typeof metadata?.hasMetadata === "boolean") {
      return metadata.hasMetadata;
    }

    return (
      additionalContext.mcpToolResults?.some(
        (result) =>
          result.toolName === "get-datasource-metadata" &&
          result.status === "success",
      ) ?? false
    );
  }

  return Boolean(additionalContext.metadata);
}

function hasSuccessfulDatasourceQuery(
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): boolean {
  return (
    additionalContext.mcpToolResults?.some(
      (result) =>
        result.toolName === "query-datasource" && result.status === "success",
    ) ?? false
  );
}

export function buildStructuredDataAnalysisAnswer(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string | undefined {
  if (additionalContext.mcpExecutionDebug?.intent !== "data_analysis") {
    return undefined;
  }

  const interpretation = additionalContext.questionInterpretation;
  const selection = selectBestValidatedQueryInsight(
    additionalContext.queryInsights ?? [],
    interpretation,
    request.question,
  );
  if (!selection) {
    return undefined;
  }

  const insight = selection.insight;

  const rows = insight.rows.filter((row) => row.label || row.value !== null);
  if (!rows.length) {
    return undefined;
  }
  if (!rows.some((row) => isMeaningfulInsightLabel(row.label))) {
    return undefined;
  }

  if (isGroupedTrendAnalysis(interpretation, request.question)) {
    return buildGroupedTrendAnswer({
      request,
      interpretation,
      insight,
      rows,
    });
  }

  const periodLabel = interpretation?.period?.label;
  const metricLabel =
    interpretation && interpretation.metricIntent !== "unknown"
      ? metricIntentLabel(interpretation.metricIntent)
      : describeMetricField(insight.metricField);
  const isRankingQuestion = isRankingLikeRequest(
    interpretation,
    request.question,
  );
  const requestedTopN = interpretation?.topN ?? 10;
  const rankingTargetLabel = getRankingTargetLabel(
    interpretation?.rankingTarget ?? "unknown",
  );
  const visibleRows = rows.slice(
    0,
    isRankingQuestion
      ? Math.min(requestedTopN, rows.length)
      : Math.min(3, rows.length),
  );
  const intro = isRankingQuestion
    ? rankingTargetLabel === "ポスト" && requestedTopN === 1
      ? `${periodLabel ? `${periodLabel}に` : ""}最も${metricLabel}が多かった${rankingTargetLabel}は以下です。`
      : `${periodLabel ? `${periodLabel}の` : ""}${rankingTargetLabel}の${metricLabel}ランキングです。`
    : `${periodLabel ? `${periodLabel}の` : ""}${metricLabel}が高い${rankingTargetLabel}です。`;
  const tableHeader = isRankingQuestion
    ? `| 順位 | ${rankingTargetLabel} | ${metricLabel} |`
    : `| ${rankingTargetLabel} | ${metricLabel} |`;
  const tableSeparator = isRankingQuestion ? "|---:|---|---:|" : "|---|---:|";
  const bodyRows = visibleRows.map((row, index) => {
    const label = escapeMarkdownTableCell(row.label ?? "名称不明");
    const value = formatMetricValue(row.value);
    return isRankingQuestion
      ? `| ${index + 1} | ${label} | ${value} |`
      : `| ${label} | ${value} |`;
  });

  return [
    "## 結論",
    "",
    intro,
    "",
    tableHeader,
    tableSeparator,
    ...bodyRows,
    ...(isRankingQuestion && rows.length < requestedTopN
      ? ["", `取得できたランキング件数は ${rows.length} 件です。`]
      : []),
    "",
    "## 集計条件",
    "",
    `- データソース: \`${insight.datasourceName}\``,
    periodLabel ? `- 期間: \`${periodLabel}\`` : undefined,
    `- 指標: \`${metricLabel}\``,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractStringFromRawRow(
  raw: Record<string, unknown>,
  candidates: Array<string | undefined>,
): string | undefined {
  for (const candidate of candidates) {
    const normalizedCandidate = candidate?.trim();
    if (!normalizedCandidate) {
      continue;
    }
    const value = raw[normalizedCandidate];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function extractNumericFromRawRow(
  raw: Record<string, unknown>,
  candidates: Array<string | undefined>,
): number | null | undefined {
  for (const candidate of candidates) {
    const normalizedCandidate = candidate?.trim();
    if (!normalizedCandidate) {
      continue;
    }
    const value = raw[normalizedCandidate];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function formatPercentageValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "値なし";
  }

  const ratio = value <= 1 ? value * 100 : value;
  return `${ratio.toFixed(ratio < 10 ? 2 : 1)}%`;
}

function buildGroupedTrendAnalysisFallback(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string | undefined {
  const interpretation = additionalContext.questionInterpretation;
  if (!isGroupedTrendAnalysis(interpretation, request.question)) {
    return undefined;
  }

  const selectedInsight = selectBestQueryInsight(
    additionalContext.queryInsights ?? [],
    interpretation,
    request.question,
  );
  const queryExecuted = hasSuccessfulDatasourceQuery(additionalContext);
  if (
    selectedInsight &&
    selectedInsight.rows.some((row) => isMeaningfulInsightLabel(row.label))
  ) {
    return undefined;
  }

  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];
  const datasourceText = datasourceNames.length
    ? datasourceNames.join("、")
    : "対象データソース";
  const metricLabel =
    interpretation && interpretation.metricIntent !== "unknown"
      ? metricIntentLabel(interpretation.metricIntent)
      : "指標";
  const groupingLabel =
    interpretation?.groupingFieldHint?.[0] ?? "Hashtag Normalized";

  return [
    "## 回答できなかった理由",
    "",
    `ハッシュタグ別の${metricLabel}傾向を出すには、\`${groupingLabel}\` と \`${metricLabel}\` の集計が必要ですが、今回は query-datasource の実行結果を有効な形で取得できませんでした。`,
    "",
    "## 確認できたこと",
    "",
    `- データソース候補: \`${datasourceText}\``,
    `- 必要なフィールド候補: \`${groupingLabel}\`, \`エンゲージメント\`, \`インプレッション数\``,
    queryExecuted
      ? "- 集計クエリは実行されましたが、ハッシュタグ別の明確な行ラベルを確認できませんでした。"
      : "- 集計クエリまで到達できませんでした。",
  ].join("\n");
}

function isGroupedTrendAnalysis(
  interpretation: QuestionInterpretation | undefined,
  question: string,
): boolean {
  if (!interpretation) {
    return false;
  }

  if (interpretation.analysisIntent === "grouped_trend") {
    return true;
  }

  return Boolean(
    interpretation.groupingIntent === "hashtag" &&
    /傾向|洗い出し|比較|ランキング|高い|低い|ごと|別|hashtag|hash tag|#/i.test(
      question,
    ),
  );
}

function buildGroupedTrendAnswer(input: {
  request: ChatRequest;
  interpretation: QuestionInterpretation | undefined;
  insight: QueryDatasourceInsight;
  rows: Array<{
    label?: string;
    value: number | null;
    raw?: Record<string, unknown>;
  }>;
}): string {
  const { request, interpretation, insight, rows } = input;
  const periodLabel = interpretation?.period?.label;
  const datasourceName = insight.datasourceName;
  const metricLabel =
    interpretation && interpretation.metricIntent !== "unknown"
      ? metricIntentLabel(interpretation.metricIntent)
      : describeMetricField(insight.metricField);
  const conclusionMetricLabel = metricLabel;
  const visibleRows = [...rows];
  const queryFieldSpecs = insight.queryFields ?? [];
  const queryFieldCandidates = queryFieldSpecs
    .flatMap((spec) => [spec.fieldAlias, spec.fieldCaption, spec.function])
    .filter((value): value is string => Boolean(value && value.trim()));
  const rowLabelCandidates = [
    insight.dimensionField,
    "rank_label",
    "Hashtag Normalized",
    "Hashtag",
    "rank_label",
    ...queryFieldCandidates,
  ];
  const postCountCandidates = ["post_count", "Post Count", "投稿数", "COUNT"];
  const engagementCandidates = [
    "engagement_total",
    "エンゲージメント",
    "Engagement",
    "engagement",
    "SUM(エンゲージメント)",
  ];
  const impressionCandidates = [
    "impression_total",
    "インプレッション数",
    "Impressions",
    "impressions",
    "SUM(インプレッション数)",
  ];
  const sortedRows =
    interpretation?.metricIntent === "engagement_rate"
      ? [...visibleRows].sort((left, right) => {
          const leftRaw = left.raw ?? {};
          const rightRaw = right.raw ?? {};
          const leftEngagement =
            extractNumericFromRawRow(leftRaw, engagementCandidates) ?? null;
          const leftImpression =
            extractNumericFromRawRow(leftRaw, impressionCandidates) ?? null;
          const rightEngagement =
            extractNumericFromRawRow(rightRaw, engagementCandidates) ?? null;
          const rightImpression =
            extractNumericFromRawRow(rightRaw, impressionCandidates) ?? null;
          const leftRate =
            leftEngagement !== null &&
            leftImpression !== null &&
            leftImpression !== 0
              ? leftEngagement / leftImpression
              : -1;
          const rightRate =
            rightEngagement !== null &&
            rightImpression !== null &&
            rightImpression !== 0
              ? rightEngagement / rightImpression
              : -1;
          if (rightRate !== leftRate) {
            return rightRate - leftRate;
          }
          return (right.value ?? -1) - (left.value ?? -1);
        })
      : visibleRows;
  const summaryRows = sortedRows.slice(0, 3);

  const tableRows = sortedRows
    .slice(0, Math.min(sortedRows.length, 10))
    .map((row) => {
      const raw = row.raw ?? {};
      const hashtag =
        extractStringFromRawRow(raw, rowLabelCandidates) ?? row.label;
      const postCount = extractNumericFromRawRow(raw, postCountCandidates);
      const engagementTotal =
        extractNumericFromRawRow(raw, engagementCandidates) ?? null;
      const impressionTotal =
        extractNumericFromRawRow(raw, impressionCandidates) ?? null;
      const engagementRate =
        engagementTotal !== null &&
        impressionTotal !== null &&
        impressionTotal !== 0
          ? engagementTotal / impressionTotal
          : null;
      return {
        hashtag: hashtag ?? "名称不明",
        postCount: formatMetricValue(postCount ?? null),
        engagementTotal: formatMetricValue(engagementTotal ?? null),
        impressionTotal: formatMetricValue(impressionTotal ?? null),
        engagementRate: formatPercentageValue(engagementRate),
      };
    });

  const trendBullets = summaryRows.map((row, index) => {
    const raw = row.raw ?? {};
    const hashtag =
      extractStringFromRawRow(raw, rowLabelCandidates) ??
      row.label ??
      "名称不明";
    const engagementTotal = extractNumericFromRawRow(raw, engagementCandidates);
    const impressionTotal =
      extractNumericFromRawRow(raw, impressionCandidates) ?? null;
    const engagementTotalValue = engagementTotal ?? null;
    const rate =
      engagementTotalValue !== null &&
      impressionTotal !== null &&
      impressionTotal !== 0
        ? engagementTotalValue / impressionTotal
        : null;
    return `- ${index + 1}位は \`${escapeMarkdownTableCell(hashtag)}\` で、${formatPercentageValue(rate)} でした。`;
  });

  return [
    "## 結論",
    "",
    `${conclusionMetricLabel}が高い傾向にあるハッシュタグは、主に以下です。`,
    "",
    "| ハッシュタグ | 投稿数 | 合計エンゲージメント | 合計インプレッション | エンゲージメント率 |",
    "|---|---:|---:|---:|---:|",
    ...tableRows.map(
      (row) =>
        `| ${escapeMarkdownTableCell(row.hashtag)} | ${row.postCount} | ${row.engagementTotal} | ${row.impressionTotal} | ${row.engagementRate} |`,
    ),
    "",
    "## 傾向",
    "",
    ...(trendBullets.length
      ? trendBullets
      : [
          "- 集計結果が取得できた範囲では、ハッシュタグ別の差分を確認できました。",
        ]),
    "",
    "## 集計条件",
    "",
    `- データソース: \`${datasourceName}\``,
    `- グループ: \`${interpretation?.groupingFieldHint?.[0] ?? "Hashtag Normalized"}\``,
    `- 指標: \`${interpretation?.derivedMetricFormula ?? "SUM([エンゲージメント]) / SUM([インプレッション数])"}\``,
    periodLabel ? `- 期間: \`${periodLabel}\`` : undefined,
    request.dashboardContext.workbookName
      ? `- ワークブック: \`${request.dashboardContext.workbookName}\``
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSafeDataAnalysisFallback(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string | undefined {
  if (
    additionalContext.mcpExecutionDebug?.intent !== "data_analysis" ||
    !hasSuccessfulDatasourceQuery(additionalContext) ||
    Boolean(
      selectBestQueryInsight(
        additionalContext.queryInsights ?? [],
        additionalContext.questionInterpretation,
        request.question,
      ),
    )
  ) {
    return undefined;
  }

  const interpretation = additionalContext.questionInterpretation;
  const periodLabel = interpretation?.period?.label;
  const metricLabel =
    interpretation && interpretation.metricIntent !== "unknown"
      ? metricIntentLabel(interpretation.metricIntent)
      : "集計値";
  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];
  const datasourceText = datasourceNames.length
    ? datasourceNames.join("、")
    : "対象データソース";

  return [
    "## 回答",
    "",
    `${
      periodLabel ? `${periodLabel}の` : ""
    }${metricLabel}を安全に確定できませんでした。`,
    "",
    `このダッシュボードの現在のフィルター範囲でのデータソース「${datasourceText}」に対する集計クエリ自体は実行しましたが、返却結果が要求した期間や指標と一致していることを確認できなかったため、誤ったランキングは返さないようにしています。`,
    "",
    "これはデータソース全体にデータがないことを意味しません。次は、要求した指標名に対応するフィールドの有無と、query-datasource の返却列名を確認するのがよいです。",
  ].join("\n");
}

function buildAxisConfirmationFallback(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string | undefined {
  if (additionalContext.mcpExecutionDebug?.intent !== "data_analysis") {
    return undefined;
  }

  const answerContext = readAnswerContext(additionalContext.metadata);
  if (!answerContext?.groupingNeedsConfirmation) {
    return undefined;
  }

  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];
  const datasourceText = datasourceNames.length
    ? datasourceNames.join("、")
    : "対象データソース";
  const metricNeedsClarification = Boolean(
    !answerContext.metricSpecified &&
    !answerContext.requestedMetricText &&
    answerContext.metricIntent === "unknown",
  );

  return [
    "## 回答",
    "",
    `このダッシュボードの「${datasourceText}」では、どの軸で比較するかの確認が必要です。`,
    "",
    "現在の情報だけでは、比較軸を安全に決めきれないため、集計クエリは実行していません。",
    metricNeedsClarification ? "また、指標名も明示されていません。" : undefined,
    "",
    "たとえば、投稿タイプ、著者、ハッシュタグ、日付など、どの切り口で見たいかを教えてください。",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function readAnswerContext(metadata: unknown):
  | {
      metricSpecified?: boolean;
      metricIntent?: string;
      requestedMetricText?: string | null;
      groupingIntent?: string;
      groupingNeedsConfirmation?: boolean;
      metricExplicitlyMissing?: boolean;
    }
  | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const answerContext = (metadata as Record<string, unknown>).answerContext;
  if (
    !answerContext ||
    typeof answerContext !== "object" ||
    Array.isArray(answerContext)
  ) {
    return undefined;
  }

  return answerContext as {
    metricSpecified?: boolean;
    metricIntent?: string;
    requestedMetricText?: string | null;
    groupingIntent?: string;
    groupingNeedsConfirmation?: boolean;
    metricExplicitlyMissing?: boolean;
  };
}

function buildNoValidatedRankingFallback(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string | undefined {
  if (additionalContext.mcpExecutionDebug?.intent !== "data_analysis") {
    return undefined;
  }

  const interpretation = additionalContext.questionInterpretation;
  const rankingRequested = isRankingLikeRequest(
    interpretation,
    request.question,
  );
  if (!rankingRequested) {
    return undefined;
  }

  const hasValidatedInsight = Boolean(
    selectBestQueryInsight(
      additionalContext.queryInsights ?? [],
      interpretation,
      request.question,
    ),
  );
  if (hasValidatedInsight) {
    return undefined;
  }

  const queryExecuted = hasSuccessfulDatasourceQuery(additionalContext);
  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];
  const datasourceText = datasourceNames.length
    ? datasourceNames.join("、")
    : "対象データソース";
  const periodLabel = interpretation?.period?.label;
  const metricLabel =
    interpretation && interpretation.metricIntent !== "unknown"
      ? metricIntentLabel(interpretation.metricIntent)
      : "指標";

  return queryExecuted
    ? [
        "## 回答",
        "",
        `${periodLabel ? `${periodLabel}の` : ""}${metricLabel}ランキングを安全に確定できませんでした。`,
        "",
        `このダッシュボードの現在のフィルター範囲でのデータソース「${datasourceText}」への集計クエリは実行しましたが、返却結果が要求した指標・件数と一致していることを確認できませんでした。`,
        "",
        "誤ったランキングを返さないため、結果の提示は保留しています。これはデータソース全体が空という意味ではありません。次は query-datasource の返却行数と列名を確認するのがよいです。",
      ].join("\n")
    : [
        "## 回答",
        "",
        `${periodLabel ? `${periodLabel}の` : ""}${metricLabel}ランキングをまだ確定できませんでした。`,
        "",
        `このダッシュボードの現在のフィルター範囲でのデータソース「${datasourceText}」に対して、要求した指標に一致する集計クエリまで到達できていません。`,
        "",
        "誤ったランキング表を返さないため、結果の提示は保留しています。これはデータソース全体が空という意味ではありません。次は要求した指標に対応する集計フィールドを確認するのがよいです。",
      ].join("\n");
}

function buildMcpConnectionFailureAnswer(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string | undefined {
  if (
    additionalContext.provider !== "tableau-mcp" ||
    !additionalContext.mcpConnectionFailed ||
    additionalContext.mcpExecutionDebug?.intent !== "data_analysis"
  ) {
    return undefined;
  }

  const interpretation = additionalContext.questionInterpretation;
  const periodLabel = interpretation?.period?.label;
  const metricLabel =
    interpretation && interpretation.metricIntent !== "unknown"
      ? metricIntentLabel(interpretation.metricIntent)
      : "集計値";
  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];
  const datasourceText = datasourceNames.length
    ? datasourceNames.join("、")
    : "対象データソース";

  return [
    "## 回答",
    "",
    `Tableau MCP への接続に失敗したため、${periodLabel ? `${periodLabel}の` : ""}${metricLabel}について実データに基づく分析結果を確定できませんでした。`,
    "",
    `現在のダッシュボードのフィルター範囲で対象だったデータソースは「${datasourceText}」ですが、MCP が起動段階で失敗しており、ランキングや合計値を裏付ける観測値は取得できていません。`,
    "",
    "これはデータソース全体にデータがないことを意味しません。接続が回復したら再実行すると、実データに基づく分析ができます。",
  ].join("\n");
}

function buildDatasourceInventoryFastPathAnswer(
  request: ChatRequest,
  interpretation: QuestionInterpretation,
): string | undefined {
  if (!isStrongDatasourceInventoryRequest(interpretation)) {
    return undefined;
  }

  const datasourceNames =
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name?.trim())
      .filter((name): name is string => Boolean(name)) ?? [];
  if (!datasourceNames.length) {
    return undefined;
  }

  const uniqueDatasourceNames = [...new Set(datasourceNames)];
  const lines = [
    "## データソース概要",
    "",
    `このダッシュボードで使用されているデータソースは ${uniqueDatasourceNames.join("、")} です。`,
  ];
  if (request.dashboardContext.workbookName) {
    lines.push(
      "",
      `- ワークブック: \`${request.dashboardContext.workbookName}\``,
    );
  }
  lines.push(
    "",
    "より詳しいフィールド構成が必要な場合は、このデータソースのフィールド一覧まで確認できます。",
  );
  return lines.join("\n");
}

function buildDeadlineAwareDeterministicAnswer(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string {
  const datasourceInventoryAnswer = buildDatasourceInventoryAnswerFromContext(
    request,
    additionalContext,
  );
  if (datasourceInventoryAnswer) {
    return datasourceInventoryAnswer;
  }

  const fieldInventoryAnswer = buildFieldInventoryAnswerFromContext(
    request,
    additionalContext,
  );
  if (fieldInventoryAnswer) {
    return fieldInventoryAnswer;
  }

  const structuredAnswer = buildStructuredDataAnalysisAnswer(
    request,
    additionalContext,
  );
  if (structuredAnswer) {
    return structuredAnswer;
  }

  const workbookName =
    request.dashboardContext.workbookName ??
    additionalContext.normalizedContext?.workbook?.name;
  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];
  const warningText = additionalContext.warnings?.length
    ? additionalContext.warnings.join(" ")
    : undefined;

  return [
    "## 回答",
    "",
    `このダッシュボード「${request.dashboardContext.dashboardName}」の確認結果です。`,
    workbookName ? `- ワークブック: \`${workbookName}\`` : undefined,
    datasourceNames.length
      ? `- データソース: \`${[...new Set(datasourceNames)].join("、")}\``
      : undefined,
    warningText ? `- 補足: ${warningText}` : undefined,
    "",
    "取得できたTableau情報をもとに回答しています。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDatasourceInventoryAnswerFromContext(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string | undefined {
  const interpretation = additionalContext.questionInterpretation;
  if (!interpretation || !isStrongDatasourceInventoryRequest(interpretation)) {
    return undefined;
  }

  const datasourceNames =
    additionalContext.normalizedContext?.datasources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    request.dashboardContext.dataSources
      ?.map((datasource) => datasource.name)
      .filter(Boolean) ??
    [];
  if (!datasourceNames.length) {
    return undefined;
  }

  return [
    "## データソース概要",
    "",
    `このダッシュボードで使用されているデータソースは ${[...new Set(datasourceNames)].join("、")} です。`,
    additionalContext.normalizedContext?.workbook?.name
      ? `- ワークブック: \`${additionalContext.normalizedContext.workbook.name}\``
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFieldInventoryAnswerFromContext(
  request: ChatRequest,
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): string | undefined {
  const interpretation = additionalContext.questionInterpretation;
  if (!interpretation || !isStrongFieldInventoryRequest(interpretation)) {
    return undefined;
  }

  const fieldProfiles = additionalContext.datasourceFieldProfiles ?? [];
  if (!fieldProfiles.length) {
    return undefined;
  }

  const preferredDatasourceName = interpretation.datasourceName?.trim();
  const selectedProfiles = preferredDatasourceName
    ? fieldProfiles.filter(
        (profile) =>
          profile.datasourceName.trim().toLowerCase() ===
          preferredDatasourceName.toLowerCase(),
      )
    : fieldProfiles;
  const profilesToRender = selectedProfiles.length
    ? selectedProfiles
    : fieldProfiles;
  if (!profilesToRender.length) {
    return undefined;
  }

  const datasourceNames = [
    ...new Set(profilesToRender.map((p) => p.datasourceName)),
  ];
  const lines = [
    "## フィールド一覧",
    "",
    `データソース ${datasourceNames.join("、")} で確認できたフィールド一覧です。`,
  ];
  if (additionalContext.normalizedContext?.workbook?.name) {
    lines.push(
      `- ワークブック: \`${additionalContext.normalizedContext.workbook.name}\``,
    );
  }

  for (const profile of profilesToRender) {
    lines.push(`### ${profile.datasourceName}`);
    lines.push(`- フィールド数: ${profile.fieldCount}件`);
    const details: Array<{
      name: string;
      dataType?: string;
      role?: string;
      semanticRole?: string;
    }> = profile.fields.length
      ? profile.fields
      : profile.fieldNames.map((fieldName) => ({
          name: fieldName,
          dataType: undefined,
          role: undefined,
          semanticRole: undefined,
        }));
    lines.push(
      ...details.slice(0, 20).map((fieldDetail) => {
        const annotations = [
          fieldDetail.dataType,
          fieldDetail.role,
          fieldDetail.semanticRole,
        ].filter(Boolean);
        return annotations.length
          ? `  - ${fieldDetail.name} [${annotations.join(" / ")}]`
          : `  - ${fieldDetail.name}`;
      }),
    );
    if (details.length > 20) {
      lines.push(`- ...ほか ${details.length - 20} 件`);
    }
  }

  lines.push(
    "",
    "必要であれば、この中の特定フィールドが何を表すかも続けて説明できます。",
  );

  return lines.join("\n");
}

function describeMetricField(fieldName: string): string {
  const normalized = fieldName.toLowerCase();
  if (/favorite|favourite/.test(normalized)) {
    return "Favorite数";
  }
  if (/view/.test(normalized)) {
    return "View数";
  }
  if (/love/.test(normalized)) {
    return "Love数";
  }
  if (/bookmark/.test(normalized)) {
    return "Bookmark数";
  }
  return fieldName;
}

function formatMetricValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "値なし";
  }

  return new Intl.NumberFormat("ja-JP").format(value);
}

function getRankingTargetLabel(
  target: NonNullable<QuestionInterpretation["rankingTarget"]>,
): string {
  switch (target) {
    case "post":
      return "ポスト";
    case "viz":
      return "Viz";
    case "author":
      return "著者";
    case "datasource":
      return "データソース";
    default:
      return "項目";
  }
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

type QueryInsightSelection = {
  insight: QueryDatasourceInsight;
  score: number;
  reasons: string[];
  metricMatchConfidence: number;
  dimensionMatchConfidence: number;
  validationReasons: string[];
};

type QueryInsightEvaluation = {
  score: number;
  reasons: string[];
  metricMatchConfidence: number;
  dimensionMatchConfidence: number;
  validationReasons: string[];
  isValid: boolean;
};

function selectBestValidatedQueryInsight(
  insights: QueryDatasourceInsight[],
  interpretation: QuestionInterpretation | undefined,
  question: string,
): QueryInsightSelection | undefined {
  if (
    interpretation?.requestType === "field_inventory" ||
    interpretation?.requestType === "datasource_inventory"
  ) {
    logDebug("chat.query_insight.selected", {
      requestType: interpretation.requestType,
      selectedMetricField: undefined,
      selectedDimensionField: undefined,
      selectedGroupingField: undefined,
      selectedDatasourceName: undefined,
      selectedRowCount: 0,
      selectedScore: undefined,
      metricMatchConfidence: undefined,
      dimensionMatchConfidence: undefined,
      queryInsightUsedForFinalAnswer: false,
      selectedReasons: ["request_type_blocks_query_insights"],
      candidateCount: insights.length,
    });
    return undefined;
  }

  const candidates = insights
    .map((insight, index) => ({
      insight,
      evaluation: assessQueryInsight(insight, interpretation, question, index),
      index,
    }))
    .filter(
      (candidate) =>
        candidate.insight.rows.length > 0 && candidate.evaluation.isValid,
    )
    .sort((left, right) => {
      if (right.evaluation.score !== left.evaluation.score) {
        return right.evaluation.score - left.evaluation.score;
      }
      return right.index - left.index;
    });

  const selected =
    candidates[0] && candidates[0].evaluation.score > 0
      ? candidates[0]
      : undefined;
  logDebug("chat.query_insight.selected", {
    selectedMetricField: selected?.insight.metricField,
    selectedDimensionField: selected?.insight.dimensionField,
    selectedGroupingField: selected?.insight.dimensionField,
    selectedDatasourceName: selected?.insight.datasourceName,
    selectedRowCount: selected?.insight.rows.length,
    selectedScore: selected?.evaluation.score,
    selectedReasons: selected?.evaluation.reasons,
    requestedMetricIntent: interpretation?.metricIntent ?? "unknown",
    requestedMetricText: interpretation?.requestedMetricText ?? null,
    rankingTarget: interpretation?.rankingTarget ?? "unknown",
    metricMatchConfidence: selected?.evaluation.metricMatchConfidence,
    dimensionMatchConfidence: selected?.evaluation.dimensionMatchConfidence,
    queryInsightUsedForFinalAnswer: Boolean(selected),
    candidateCount: candidates.length,
    queryInsightCandidateCount: candidates.length,
  });
  if (candidates.length) {
    logDebug("chat.query_insight.rejected", {
      rejected: candidates
        .filter((candidate) => candidate !== selected)
        .slice(0, 5)
        .map((candidate) => ({
          metricField: candidate.insight.metricField,
          dimensionField: candidate.insight.dimensionField,
          datasourceName: candidate.insight.datasourceName,
          rowCount: candidate.insight.rows.length,
          score: candidate.evaluation.score,
          reasons: candidate.evaluation.reasons,
          validationReasons: candidate.evaluation.validationReasons,
          metricMatchConfidence: candidate.evaluation.metricMatchConfidence,
          dimensionMatchConfidence:
            candidate.evaluation.dimensionMatchConfidence,
        })),
    });
  }

  return selected
    ? {
        insight: selected.insight,
        score: selected.evaluation.score,
        reasons: selected.evaluation.reasons,
        metricMatchConfidence: selected.evaluation.metricMatchConfidence,
        dimensionMatchConfidence: selected.evaluation.dimensionMatchConfidence,
        validationReasons: selected.evaluation.validationReasons,
      }
    : undefined;
}

function selectBestQueryInsight(
  insights: QueryDatasourceInsight[],
  interpretation: QuestionInterpretation | undefined,
  question: string,
): QueryDatasourceInsight | undefined {
  return selectBestValidatedQueryInsight(insights, interpretation, question)
    ?.insight;
}

function assessQueryInsight(
  insight: QueryDatasourceInsight,
  interpretation: QuestionInterpretation | undefined,
  question: string,
  index: number,
): QueryInsightEvaluation {
  let score = index;
  const reasons: string[] = ["later_pass_preference"];
  const validationReasons: string[] = [];
  const derivedMetricSatisfied = Boolean(
    interpretation?.metricIntent === "engagement_rate" &&
    insight.queryDebug?.derivedMetricsComputedInApp?.includes(
      "engagement_rate",
    ),
  );

  if (insight.rows.length > 0) {
    score += 10;
    reasons.push("has_rows");
  }

  const rankingRequested = isRankingLikeRequest(interpretation, question);
  if (rankingRequested) {
    score += 20;
    reasons.push("ranking_requested");
    if (insight.rows.length > 1) {
      score += 30;
      reasons.push("multiple_rows");
    }
    if ((insight.requestedTopN ?? 0) > 1 || (interpretation?.topN ?? 1) > 1) {
      score += 25;
      reasons.push("topn_requested");
    }
    score += Math.min(insight.rows.length, interpretation?.topN ?? 10);
    if (insight.fulfillsRankingRequest === false) {
      score -= 90;
      reasons.push("ranking_request_not_fulfilled");
    }
  }

  const metricMatchConfidence = computeMetricMatchConfidence(
    insight.metricField,
    interpretation,
  );
  const metricExplicitMatch = metricMatchConfidence >= 0.8;
  if (interpretation?.requestedMetricText) {
    reasons.push(
      metricExplicitMatch
        ? "requested_metric_text_match"
        : "metric_text_mismatch",
    );
  }
  if (
    interpretation?.metricIntent &&
    interpretation.metricIntent !== "unknown"
  ) {
    if (insight.requestedMetricIntent === interpretation.metricIntent) {
      score += 120;
      reasons.push("requested_metric_exact_match");
    } else if (derivedMetricSatisfied) {
      score += 90;
      reasons.push("derived_metric_computed_in_app");
    } else if (
      matchesMetricFieldIntent(insight.metricField, interpretation.metricIntent)
    ) {
      score += 80;
      reasons.push("metric_field_name_match");
    } else {
      score -= 260;
      reasons.push("metric_mismatch");
    }
  } else if (interpretation?.requestedMetricText) {
    if (metricExplicitMatch) {
      score += 95;
      reasons.push("requested_metric_text_match");
    } else {
      score -= 180;
      reasons.push("metric_text_mismatch");
    }
  }

  const dimensionMatchConfidence = computeDimensionMatchConfidence(
    insight.dimensionField,
    interpretation,
    question,
    insight.rows,
  );
  const meaningfulRowLabels = insight.rows.some((row) =>
    isMeaningfulInsightLabel(row.label),
  );

  if (
    interpretation?.period &&
    insight.requestedPeriodStart === interpretation.period.startDate &&
    insight.requestedPeriodEnd === interpretation.period.endDate
  ) {
    score += 40;
    reasons.push("period_exact_match");
  } else if (interpretation?.period) {
    score -= 60;
    reasons.push("period_mismatch");
  }

  if (insight.fulfillsMetricRequest === false) {
    score -= 200;
    reasons.push("fulfills_metric_false");
  }

  if (
    rankingRequested &&
    interpretation?.topN &&
    interpretation.topN > 1 &&
    insight.rows.length < Math.min(interpretation.topN, 10)
  ) {
    score -= 50;
    reasons.push("insufficient_rows_for_requested_topn");
  }

  const fulfillsMetricRequest =
    interpretation?.metricIntent && interpretation.metricIntent !== "unknown"
      ? insight.requestedMetricIntent === interpretation.metricIntent ||
        derivedMetricSatisfied ||
        matchesMetricFieldIntent(
          insight.metricField,
          interpretation.metricIntent,
        )
      : interpretation?.requestedMetricText
        ? metricExplicitMatch
        : insight.fulfillsMetricRequest !== false;
  const fulfillsRankingRequest = rankingRequested
    ? insight.fulfillsRankingRequest !== false
    : true;
  const fulfillsPeriodRequest = Boolean(insight.fulfillsPeriodRequest ?? true);
  const dimensionMatches =
    !rankingRequested ||
    dimensionMatchConfidence >= 0.8 ||
    interpretation?.rankingTarget === "unknown";
  const isValid =
    meaningfulRowLabels &&
    fulfillsMetricRequest &&
    fulfillsRankingRequest &&
    fulfillsPeriodRequest &&
    metricMatchConfidence >= 0.8 &&
    dimensionMatches;
  if (!meaningfulRowLabels) {
    validationReasons.push("insufficient_row_labels");
  }
  if (!fulfillsMetricRequest) {
    validationReasons.push("metric_request_not_fulfilled");
  }
  if (!fulfillsRankingRequest) {
    validationReasons.push("ranking_request_not_fulfilled");
  }
  if (!fulfillsPeriodRequest) {
    validationReasons.push("period_request_not_fulfilled");
  }
  if (metricMatchConfidence < 0.8) {
    validationReasons.push("metric_match_confidence_low");
  }
  if (!dimensionMatches) {
    validationReasons.push("dimension_match_confidence_low");
  }

  return {
    score,
    reasons,
    metricMatchConfidence,
    dimensionMatchConfidence,
    validationReasons,
    isValid,
  };
}

function computeMetricMatchConfidence(
  metricField: string,
  interpretation: QuestionInterpretation | undefined,
): number {
  if (
    !interpretation ||
    (interpretation.metricIntent === "unknown" &&
      !interpretation.requestedMetricText)
  ) {
    return 0.5;
  }

  if (
    interpretation.metricIntent !== "unknown" &&
    matchesMetricFieldIntent(metricField, interpretation.metricIntent)
  ) {
    return 1;
  }

  if (
    interpretation.requestedMetricText &&
    matchesRequestedMetricText(metricField, interpretation.requestedMetricText)
  ) {
    return 0.95;
  }

  if (interpretation.metricIntent !== "unknown") {
    return 0;
  }

  return 0.2;
}

function computeDimensionMatchConfidence(
  dimensionField: string | undefined,
  interpretation: QuestionInterpretation | undefined,
  question: string,
  rows: Array<{ label?: string; value: number | null }>,
): number {
  if (!dimensionField) {
    return 0;
  }

  if (
    interpretation?.rankingTarget === "post" &&
    isPostDimensionField(dimensionField)
  ) {
    return hasMeaningfulRowLabels(rows) ? 1 : 0.7;
  }

  if (
    interpretation?.rankingTarget &&
    interpretation.rankingTarget !== "unknown" &&
    isDimensionFieldAlignedWithRankingTarget(dimensionField, interpretation)
  ) {
    return hasMeaningfulRowLabels(rows) ? 0.95 : 0.7;
  }

  if (question && isMeaningfulInsightLabel(dimensionField)) {
    return 0.8;
  }

  return 0.2;
}

function matchesRequestedMetricText(
  fieldName: string,
  requestedMetricText: string,
): boolean {
  const normalizedField = normalizeFieldToken(fieldName);
  const normalizedRequested = normalizeFieldToken(requestedMetricText);
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

  const normalized = label.trim().toLowerCase();
  return (
    normalized !== "(value)" &&
    normalized !== "名称不明" &&
    normalized !== "unknown" &&
    normalized !== "n/a"
  );
}

function isPostDimensionField(fieldName: string): boolean {
  return /ポスト本文|ポストのリンク|ポストid|ポストID|post id|post.*link|url|permalink|tweet id|tweet url|tweet/i.test(
    fieldName,
  );
}

function isDimensionFieldAlignedWithRankingTarget(
  fieldName: string,
  interpretation: QuestionInterpretation,
): boolean {
  switch (interpretation.rankingTarget) {
    case "post":
      return isPostDimensionField(fieldName);
    case "viz":
      return /viz|title|name|workbook|dashboard/i.test(fieldName);
    case "author":
      return /author|creator|user|profile|poster/i.test(fieldName);
    case "datasource":
      return /datasource|data source/i.test(fieldName);
    default:
      return false;
  }
}

function isRankingLikeRequest(
  interpretation: QuestionInterpretation | undefined,
  question: string,
): boolean {
  return Boolean(
    interpretation?.asksForRanking ||
    (interpretation?.topN ?? 1) > 1 ||
    detectRankingIntent(question),
  );
}

function isStrongDatasourceInventoryRequest(
  interpretation: QuestionInterpretation,
): boolean {
  return (
    interpretation.requestType === "datasource_inventory" &&
    (interpretation.requestTypeConfidence ?? 0) >= 0.9 &&
    interpretation.metricIntent === "unknown" &&
    !interpretation.asksForRanking &&
    interpretation.topN <= 1 &&
    !interpretation.period &&
    !interpretation.requestTypeSignals?.includes("analysis_like_signal")
  );
}

function isStrongFieldInventoryRequest(
  interpretation: QuestionInterpretation,
): boolean {
  return (
    interpretation.requestType === "field_inventory" &&
    (interpretation.requestTypeConfidence ?? 0) >= 0.9 &&
    interpretation.metricIntent === "unknown" &&
    !interpretation.asksForRanking &&
    interpretation.topN <= 1 &&
    !interpretation.period &&
    !interpretation.requestTypeSignals?.includes("analysis_like_signal")
  );
}

function buildDashboardContextPatch(
  request: { dashboardContext: DashboardContext },
  additionalContext: Awaited<
    ReturnType<TableauContextProvider["getAdditionalContext"]>
  >,
): ChatResponse["dashboardContextPatch"] {
  if (request.dashboardContext.workbookName) {
    return undefined;
  }

  const workbookName =
    extractName(additionalContext.workbook) ??
    extractWorkbookNameFromMetadata(additionalContext.metadata);
  if (
    !workbookName ||
    isLikelyDashboardOrWorksheetName(workbookName, request.dashboardContext)
  ) {
    return undefined;
  }

  return { workbookName };
}

function isLikelyDashboardOrWorksheetName(
  workbookName: string,
  dashboardContext: DashboardContext,
): boolean {
  const normalizedWorkbookName = workbookName.trim().toLowerCase();
  if (!normalizedWorkbookName) {
    return true;
  }

  const knownNonWorkbookNames = [
    dashboardContext.dashboardName,
    ...dashboardContext.worksheets.map((worksheet) => worksheet.name),
  ].map((value) => value.trim().toLowerCase());

  return knownNonWorkbookNames.includes(normalizedWorkbookName);
}

function extractWorkbookNameFromMetadata(value: unknown): string | undefined {
  const dashboards = findArraysByKey(value, "dashboards").flat();
  for (const dashboard of dashboards) {
    if (!dashboard || typeof dashboard !== "object") {
      continue;
    }

    const workbookName = extractName(
      (dashboard as Record<string, unknown>).workbook,
    );
    if (workbookName) {
      return workbookName;
    }
  }

  const workbooks = findArraysByKey(value, "workbooks").flat();
  for (const workbook of workbooks) {
    const workbookName = extractName(workbook);
    if (workbookName) {
      return workbookName;
    }
  }

  return undefined;
}

function findArraysByKey(value: unknown, key: string): unknown[][] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => findArraysByKey(item, key));
  }

  const record = value as Record<string, unknown>;
  const direct = Array.isArray(record[key]) ? [record[key] as unknown[]] : [];
  return [
    ...direct,
    ...Object.values(record).flatMap((item) => findArraysByKey(item, key)),
  ];
}

function extractName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

export function createChatService(): ChatService {
  const config = getConfig();
  const provider = createContextProvider(config.tableau.contextProvider);
  const answerGenerator = createAnswerGenerator(config.model.provider);
  const chatAgent = createChatAgent(config.model.provider);

  return new ChatService(
    provider,
    answerGenerator,
    createChatHistoryRepository(),
    chatAgent,
  );
}

function createAnswerGenerator(
  providerName: ReturnType<typeof getConfig>["model"]["provider"],
): AnswerGenerator {
  switch (providerName) {
    case "bedrock":
      return new BedrockAnswerGenerator();
    case "mock":
    default:
      return new MockAnswerGenerator();
  }
}

function createChatAgent(
  providerName: ReturnType<typeof getConfig>["model"]["provider"],
): ChatAgent {
  switch (providerName) {
    case "bedrock":
      return new BedrockChatAgent();
    case "mock":
    default:
      return new NoopChatAgent();
  }
}

function createContextProvider(
  providerName: ReturnType<typeof getConfig>["tableau"]["contextProvider"],
): TableauContextProvider {
  switch (providerName) {
    case "direct-api":
      return new DirectTableauApiContextProvider();
    case "mcp":
      return new TableauMcpContextProvider();
    case "mock":
    default:
      return new MockTableauContextProvider();
  }
}
