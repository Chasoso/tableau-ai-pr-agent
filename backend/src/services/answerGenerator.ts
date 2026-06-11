import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { getConfig } from "../config";
import { logError, logInfo, logWarn, safeErrorDetails } from "../logging";
import type { ChatRequest } from "../types/chat";
import type { TableauAdditionalContext } from "../types/tableau";
import { compressDashboardContext } from "./contextCompressor";

export interface AnswerGenerator {
  readonly name: string;
  generate(input: {
    request: ChatRequest;
    prompt: string;
    additionalContext: TableauAdditionalContext;
  }): Promise<string>;
}

export class MockAnswerGenerator implements AnswerGenerator {
  readonly name = "mock";

  async generate(input: {
    request: ChatRequest;
    prompt: string;
    additionalContext: TableauAdditionalContext;
  }): Promise<string> {
    return buildDeterministicAnswer(input.request, input.additionalContext);
  }
}

export class BedrockAnswerGenerator implements AnswerGenerator {
  readonly name = "bedrock";

  constructor(
    private readonly client = new BedrockRuntimeClient({
      region: getConfig().model.bedrock.region,
    }),
  ) {}

  async generate(input: {
    request: ChatRequest;
    prompt: string;
    additionalContext: TableauAdditionalContext;
  }): Promise<string> {
    const config = getConfig().model.bedrock;
    const startedAt = Date.now();

    try {
      logInfo("answer.bedrock.started", {
        region: config.region,
        modelId: config.modelId,
        promptLength: input.prompt.length,
      });
      if (config.debugLogPromptExchange) {
        const promptSnapshot = clipForDebugLog(
          input.prompt,
          config.debugMaxChars,
        );
        logInfo("answer.bedrock.prompt_debug", {
          region: config.region,
          modelId: config.modelId,
          promptLength: input.prompt.length,
          promptPreviewLength: promptSnapshot.text.length,
          promptPreviewTruncated: promptSnapshot.truncated,
          promptPreview: promptSnapshot.text,
        });
      }

      const response = await this.client.send(
        new ConverseCommand({
          modelId: config.modelId,
          messages: [
            {
              role: "user",
              content: [{ text: input.prompt }],
            },
          ],
          inferenceConfig: {
            maxTokens: config.maxOutputTokens,
            temperature: config.temperature,
          },
        }),
      );

      const answer = response.output?.message?.content
        ?.map((content) => ("text" in content ? content.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (config.debugLogPromptExchange) {
        const responseSnapshot = clipForDebugLog(
          answer ?? "",
          config.debugMaxChars,
        );
        logInfo("answer.bedrock.response_debug", {
          region: config.region,
          modelId: config.modelId,
          responseLength: answer?.length ?? 0,
          responsePreviewLength: responseSnapshot.text.length,
          responsePreviewTruncated: responseSnapshot.truncated,
          responsePreview: responseSnapshot.text,
        });
      }

      if (!answer) {
        logInfo("answer.bedrock.empty_response", {
          region: config.region,
          modelId: config.modelId,
          durationMs: Date.now() - startedAt,
        });
        return buildDeterministicAnswer(input.request, input.additionalContext);
      }

      const finalAnswer =
        response.stopReason === "max_tokens"
          ? appendTruncationNotice(answer)
          : answer;

      if (response.stopReason === "max_tokens") {
        logWarn("answer.bedrock.truncated", {
          region: config.region,
          modelId: config.modelId,
          maxOutputTokens: config.maxOutputTokens,
          answerLength: answer.length,
          outputTokens: response.usage?.outputTokens,
          durationMs: Date.now() - startedAt,
        });
      }

      logInfo("answer.bedrock.completed", {
        region: config.region,
        modelId: config.modelId,
        answerLength: finalAnswer.length,
        stopReason: response.stopReason,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        totalTokens: response.usage?.totalTokens,
        durationMs: Date.now() - startedAt,
      });
      return finalAnswer;
    } catch (error) {
      logError("answer.bedrock.failed", {
        ...safeErrorDetails(error),
        durationMs: Date.now() - startedAt,
      });
      return [
        "Bedrockでの回答生成に失敗したため、取得済みのTableauコンテキストだけで回答します。",
        "",
        buildDeterministicAnswer(input.request, input.additionalContext),
      ].join("\n");
    }
  }
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

function appendTruncationNotice(answer: string): string {
  return [
    answer.trimEnd(),
    "",
    "（回答が長くなったため、ここで一度区切りました。続きを確認したい場合は「続き」と入力してください。）",
  ].join("\n");
}

function buildDeterministicAnswer(
  request: ChatRequest,
  additionalContext: TableauAdditionalContext,
): string {
  const context = compressDashboardContext(request, additionalContext);

  return [
    `質問「${request.question}」について、取得済みのTableauコンテキストから分かる範囲で回答します。`,
    "",
    `このダッシュボードは「${context.dashboardName}」です。ワークブックは「${context.workbookName}」です。`,
    context.worksheets.length
      ? `含まれるワークシートは ${context.worksheets.length} 個です: ${context.worksheets.join(", ")}。`
      : "ワークシート情報は取得できていません。",
    context.filters.length
      ? `現在確認できるフィルターは ${context.filters.join("; ")} です。`
      : "現在確認できるフィルターはありません。",
    context.parameters.length
      ? `パラメーターは ${context.parameters.join("; ")} です。`
      : "パラメーター情報は取得できていません。",
    context.dataSources.length
      ? `関連するデータソース候補は ${context.dataSources.join(", ")} です。`
      : "関連するデータソース名は取得できていません。",
    context.mcpToolResults.length
      ? `MCPから取得した補足情報: ${context.mcpToolResults.join(" / ")}`
      : "",
    `追加コンテキストは ${context.provider} プロバイダーから取得しました。`,
    context.warnings.length ? `注意: ${context.warnings.join(" ")}` : "",
    "この回答は取得済みメタデータに基づく要約です。行レベルの詳細、画面上に表示されていない値、未取得の計算式や権限外の情報は断定できません。",
  ]
    .filter(Boolean)
    .join("\n");
}
