import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BedrockChatAgent,
  runLightweightAgentLoop,
} from "../src/services/chatAgent";
import type { ChatRequest } from "../src/types/chat";
import type { AgentEvaluation } from "../src/types/agent";
import type {
  GetAdditionalContextInput,
  TableauContextProvider,
} from "../src/tableau/contextProvider";

const sendMock = vi.fn();

const request: ChatRequest = {
  question: "Show the datasource metadata",
  dashboardContext: {
    dashboardName: "Statistics",
    workbookName: "Tableau Public Insights",
    worksheets: [{ name: "Views" }],
    filters: [],
    parameters: [],
    capturedAt: "2026-06-04T00:00:00.000Z",
  },
};

function setChatAgentEnv(values: Record<string, string>): void {
  process.env.CHAT_AGENT_ENABLED = values.CHAT_AGENT_ENABLED;
  process.env.MODEL_PROVIDER = values.MODEL_PROVIDER;
  process.env.CHAT_AGENT_MAX_CONTEXT_PASSES =
    values.CHAT_AGENT_MAX_CONTEXT_PASSES;
}

afterEach(() => {
  sendMock.mockReset();
  delete process.env.CHAT_AGENT_ENABLED;
  delete process.env.MODEL_PROVIDER;
  delete process.env.CHAT_AGENT_MAX_CONTEXT_PASSES;
});

describe("BedrockChatAgent", () => {
  it("runs only when bedrock mode is enabled and the question is non-empty", () => {
    setChatAgentEnv({
      CHAT_AGENT_ENABLED: "true",
      MODEL_PROVIDER: "bedrock",
      CHAT_AGENT_MAX_CONTEXT_PASSES: "2",
    });

    const agent = new BedrockChatAgent({ send: sendMock } as never);

    expect(
      agent.shouldRun({
        request,
        contextProvider: { name: "tableau-mcp" } as TableauContextProvider,
      }),
    ).toBe(true);
    expect(
      agent.shouldRun({
        request: { ...request, question: "   " },
        contextProvider: { name: "tableau-mcp" } as TableauContextProvider,
      }),
    ).toBe(false);
    expect(
      agent.shouldRun({
        request,
        contextProvider: { name: "mock" } as TableauContextProvider,
      }),
    ).toBe(false);
  });

  it("parses a plan response from Bedrock", async () => {
    setChatAgentEnv({
      CHAT_AGENT_ENABLED: "true",
      MODEL_PROVIDER: "bedrock",
      CHAT_AGENT_MAX_CONTEXT_PASSES: "2",
    });

    sendMock.mockResolvedValue({
      output: {
        message: {
          content: [
            {
              text: JSON.stringify({
                intent: "metadata_lookup",
                confidence: 0.9,
                normalizedQuestion: "Resolve the datasource schema",
                needsMcp: true,
                answerStyle: "summary",
                reasonBrief: "Need datasource metadata first.",
                requiredEvidence: ["datasource metadata", "field list"],
              }),
            },
          ],
        },
      },
    });

    const agent = new BedrockChatAgent({ send: sendMock } as never);
    const result = await agent.createPlan({
      request,
      recentHistory: [],
      contextProvider: { name: "tableau-mcp" } as TableauContextProvider,
    });

    expect(result.source).toBe("bedrock");
    expect(result.plan.intent).toBe("metadata_lookup");
    expect(result.plan.normalizedQuestion).toBe(
      "Resolve the datasource schema",
    );
    expect(result.plan.requiredEvidence).toEqual([
      "datasource metadata",
      "field list",
    ]);
  });

  it("falls back to a heuristic plan when Bedrock fails", async () => {
    setChatAgentEnv({
      CHAT_AGENT_ENABLED: "true",
      MODEL_PROVIDER: "bedrock",
      CHAT_AGENT_MAX_CONTEXT_PASSES: "2",
    });

    sendMock.mockRejectedValue(new Error("bedrock unavailable"));

    const agent = new BedrockChatAgent({ send: sendMock } as never);
    const result = await agent.createPlan({
      request,
      recentHistory: [],
      contextProvider: { name: "tableau-mcp" } as TableauContextProvider,
    });

    expect(result.source).toBe("heuristic");
    expect(result.plan.normalizedQuestion).toBe(request.question.trim());
  });

  it("returns an evaluation when heuristics request another pass", async () => {
    setChatAgentEnv({
      CHAT_AGENT_ENABLED: "true",
      MODEL_PROVIDER: "bedrock",
      CHAT_AGENT_MAX_CONTEXT_PASSES: "2",
    });

    sendMock.mockResolvedValue({
      output: {
        message: {
          content: [
            {
              text: JSON.stringify({
                isSufficient: false,
                confidence: 0.75,
                reasonBrief: "Need one more datasource field.",
                missingEvidence: ["datasource metadata"],
                followUpQuestion: "Which datasource should I inspect?",
              }),
            },
          ],
        },
      },
    });

    const agent = new BedrockChatAgent({ send: sendMock } as never);
    const evaluation = await agent.evaluateContext({
      request,
      recentHistory: [],
      plan: {
        intent: "metadata_lookup",
        confidence: 0.9,
        normalizedQuestion: "Inspect datasource fields",
        needsMcp: true,
        answerStyle: "summary",
        reasonBrief: "Need datasource metadata first.",
        requiredEvidence: ["datasource metadata", "field list"],
      },
      additionalContext: {
        provider: "tableau-mcp",
        warnings: ["metadata missing"],
      },
      contextPass: 0,
    });

    expect(evaluation).toEqual({
      isSufficient: false,
      confidence: 0.75,
      reasonBrief: "Need one more datasource field.",
      missingEvidence: ["datasource metadata"],
      followUpQuestion: "Which datasource should I inspect?",
    } satisfies AgentEvaluation);
  });

  it("skips evaluation once the maximum number of context passes is reached", async () => {
    setChatAgentEnv({
      CHAT_AGENT_ENABLED: "true",
      MODEL_PROVIDER: "bedrock",
      CHAT_AGENT_MAX_CONTEXT_PASSES: "1",
    });

    const agent = new BedrockChatAgent({ send: sendMock } as never);
    const evaluation = await agent.evaluateContext({
      request,
      recentHistory: [],
      plan: {
        intent: "metadata_lookup",
        confidence: 0.9,
        normalizedQuestion: "Inspect datasource fields",
        needsMcp: true,
        answerStyle: "summary",
        reasonBrief: "Need datasource metadata first.",
        requiredEvidence: ["datasource metadata", "field list"],
      },
      additionalContext: {
        provider: "tableau-mcp",
        warnings: ["metadata missing"],
      },
      contextPass: 0,
    });

    expect(evaluation).toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("runLightweightAgentLoop", () => {
  it("skips planning when the agent decides not to run", async () => {
    const contextProvider: TableauContextProvider = {
      name: "mock",
      async getAdditionalContext(input: GetAdditionalContextInput) {
        return {
          provider: "mock",
          warnings: [`context for ${input.question}`],
        };
      },
    };

    const agent = {
      name: "stub-agent",
      shouldRun() {
        return false;
      },
      async createPlan() {
        throw new Error("not expected");
      },
      async evaluateContext() {
        throw new Error("not expected");
      },
    };

    const result = await runLightweightAgentLoop({
      agent,
      contextProvider,
      request,
      recentHistory: [],
    });

    expect(result.promptContext).toEqual({});
    expect(result.debug).toBeUndefined();
    expect(result.additionalContext.warnings).toEqual([
      `context for ${request.question}`,
    ]);
  });
});
