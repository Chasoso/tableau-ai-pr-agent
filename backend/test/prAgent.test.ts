import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentInvokeMock = vi.hoisted(() => vi.fn());
const agentCtorMock = vi.hoisted(() => vi.fn());
const toolFactoryMock = vi.hoisted(() => vi.fn());
const bedrockModelCtorMock = vi.hoisted(() => vi.fn());

vi.mock("@strands-agents/sdk", () => ({
  Agent: agentCtorMock.mockImplementation((config) => {
    return {
      config,
      invoke: agentInvokeMock,
    };
  }),
  BedrockModel: bedrockModelCtorMock,
  tool: toolFactoryMock.mockImplementation((config) => ({
    name: config.name,
    config,
  })),
}));

describe("prAgent", () => {
  const originalUseStrandsAgent = process.env.USE_STRANDS_AGENT;
  const originalModelProvider = process.env.MODEL_PROVIDER;

  beforeEach(() => {
    process.env.USE_STRANDS_AGENT = "true";
    process.env.MODEL_PROVIDER = "bedrock";
    agentCtorMock.mockReset();
    agentInvokeMock.mockReset();
    toolFactoryMock.mockReset();
    bedrockModelCtorMock.mockReset();
  });

  it("initializes a Strands agent with draft-only tools", async () => {
    const { createPrAgent } = await import("../src/agents/prAgent");

    const agent = await createPrAgent();

    expect(bedrockModelCtorMock).toHaveBeenCalledTimes(1);
    expect(toolFactoryMock).toHaveBeenCalledTimes(6);
    expect(agentCtorMock).toHaveBeenCalledTimes(1);
    expect(agent.toolNames).toEqual([
      "collectPrSourceInfo",
      "summarizePrSourceInfo",
      "generateAnnouncementDraft",
      "generateSocialPostDraft",
      "reviewPrDraft",
      "createDraftOutput",
    ]);
  });

  afterEach(() => {
    if (originalUseStrandsAgent === undefined) {
      delete process.env.USE_STRANDS_AGENT;
    } else {
      process.env.USE_STRANDS_AGENT = originalUseStrandsAgent;
    }

    if (originalModelProvider === undefined) {
      delete process.env.MODEL_PROVIDER;
    } else {
      process.env.MODEL_PROVIDER = originalModelProvider;
    }
  });
});
