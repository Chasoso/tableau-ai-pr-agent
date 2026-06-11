import { describe, expect, it, vi } from "vitest";
import { BedrockAnswerGenerator } from "../src/services/answerGenerator";
import type { ChatRequest } from "../src/types/chat";

const request: ChatRequest = {
  question: "What is this dashboard?",
  dashboardContext: {
    dashboardName: "Mock Dashboard",
    workbookName: "Mock Workbook",
    worksheets: [{ name: "Sheet 1" }],
    filters: [],
    parameters: [],
    capturedAt: "2026-06-04T00:00:00.000Z",
  },
  clientContext: {
    source: "tableau-extension",
  },
};

describe("BedrockAnswerGenerator", () => {
  it("falls back to a deterministic answer when Bedrock returns no text", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        output: {
          message: {
            content: [],
          },
        },
      }),
    };
    const generator = new BedrockAnswerGenerator(client as never);

    const answer = await generator.generate({
      request,
      prompt: "Prompt text",
      additionalContext: {
        provider: "mock",
      },
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(answer).toContain("Mock Dashboard");
    expect(answer).toContain("Mock Workbook");
  });

  it("returns a safe fallback answer when the Bedrock client throws", async () => {
    const client = {
      send: vi
        .fn()
        .mockRejectedValue(new Error("secret-token should not reach the user")),
    };
    const generator = new BedrockAnswerGenerator(client as never);

    const answer = await generator.generate({
      request,
      prompt: "Prompt text",
      additionalContext: {
        provider: "mock",
      },
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(answer).toContain("Mock Dashboard");
    expect(answer).not.toContain("secret-token");
  });

  it("appends a truncation notice when Bedrock stops at max tokens", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        output: {
          message: {
            content: [
              {
                text: "## 結論\n\nこれは途中までの回答です。",
              },
            ],
          },
        },
        stopReason: "max_tokens",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
      }),
    };
    const generator = new BedrockAnswerGenerator(client as never);

    const answer = await generator.generate({
      request,
      prompt: "Prompt text",
      additionalContext: {
        provider: "mock",
      },
    });

    expect(answer).toContain("## 結論");
    expect(answer.split("\n").length).toBeGreaterThan(3);
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});
