import { z } from "zod";
import { getConfig } from "../config";
import { logInfo, logWarn, safeErrorDetails } from "../logging";
import type {
  ActionRunAnalysisSection,
  ActionRunRequest,
} from "../types/actionRun";
import type { TechPlayPreviewResponse } from "../types/techplay";
import { PR_SYSTEM_PROMPT } from "./prompts/prSystemPrompt";
import {
  buildPrDraftOutput,
  createPrTools,
  type PrDraftOutput,
} from "./tools/prTools";

type StrandsModule = typeof import("@strands-agents/sdk");

let strandsSdkPromise: Promise<StrandsModule> | undefined;

const strandsPrDraftOutputSchema = z.object({
  sourceInfo: z.object({
    postType: z.string(),
    eventName: z.string(),
    techplayUrl: z.string(),
    currentSituation: z.string(),
    dashboardName: z.string(),
    workbookName: z.string().optional(),
    worksheetNames: z.array(z.string()),
    capturedAt: z.string(),
    techplayEventName: z.string().optional(),
    techplayEventDateText: z.string().optional(),
    techplaySummary: z.string().optional(),
    analysisHighlights: z.array(z.string()),
    missingFields: z.array(z.string()),
  }),
  summary: z.string(),
  announcementDraft: z.string(),
  socialPostDraft: z.string(),
  drafts: z.object({
    x: z.string(),
    linkedin: z.string(),
    email: z.string(),
    notion: z.string(),
  }),
  review: z.object({
    status: z.enum(["pass", "needs_info", "needs_review"]),
    riskLevel: z.enum(["low", "medium", "high"]),
    missingFields: z.array(z.string()),
    issues: z.array(z.string()),
    checklist: z.array(z.string()),
    notes: z.array(z.string()),
  }),
  evidence: z.array(z.string()),
  checks: z.array(z.string()),
  hashtags: z.array(z.string()),
  imageCaption: z.string(),
  missingFields: z.array(z.string()),
});

export async function createPrAgent(): Promise<{
  invoke: (input: string) => Promise<{ structuredOutput?: PrDraftOutput }>;
  toolNames: string[];
}> {
  const strands = await loadStrandsSdk();
  const config = getConfig();
  const model = new strands.BedrockModel({
    region: config.model.bedrock.region,
    modelId: config.model.bedrock.modelId,
    maxTokens: Math.max(400, config.model.bedrock.maxOutputTokens),
    temperature: Math.min(0.3, Math.max(0, config.model.bedrock.temperature)),
  });

  const tools = createPrTools(strands.tool);
  const agent = new strands.Agent({
    name: "tableau-ai-pr-agent",
    id: "tableau-ai-pr-agent",
    description:
      "Draft-only PR agent that turns Tableau and TechPlay context into reviewable copy.",
    model,
    tools,
    printer: false,
    toolExecutor: "sequential",
    structuredOutputSchema: strandsPrDraftOutputSchema,
    systemPrompt: PR_SYSTEM_PROMPT,
  });

  return {
    invoke: async (input: string) => {
      const result = await agent.invoke(input);
      return {
        structuredOutput: result.structuredOutput as PrDraftOutput | undefined,
      };
    },
    toolNames: tools.map((tool) => tool.name),
  };
}

export async function runPrDraftAgent(input: {
  request: ActionRunRequest;
  techplayPreview?: TechPlayPreviewResponse;
  analysisSections: ActionRunAnalysisSection[];
}): Promise<PrDraftOutput> {
  const config = getConfig();
  if (!config.prAgent.useStrandsAgent) {
    return buildPrDraftOutput(input);
  }

  const agent = await createPrAgent();
  const startedAt = Date.now();
  logInfo("pr.agent.started", {
    modelProvider: config.model.provider,
    toolNames: agent.toolNames,
    eventName: input.request.eventName,
  });

  try {
    const result = await agent.invoke(buildPrAgentPrompt(input));
    if (!result.structuredOutput) {
      throw new Error("Strands agent returned no structured output.");
    }

    logInfo("pr.agent.completed", {
      durationMs: Date.now() - startedAt,
      missingFieldCount: result.structuredOutput.missingFields.length,
      reviewStatus: result.structuredOutput.review.status,
    });
    return result.structuredOutput;
  } catch (error) {
    logWarn("pr.agent.failed", {
      durationMs: Date.now() - startedAt,
      ...safeErrorDetails(error),
    });
    return buildPrDraftOutput(input);
  }
}

export function buildPrAgentPrompt(input: {
  request: ActionRunRequest;
  techplayPreview?: TechPlayPreviewResponse;
  analysisSections: ActionRunAnalysisSection[];
}): string {
  return [
    "Create a draft-only PR package from the JSON input below.",
    "Use the tools in this order: collectPrSourceInfo, summarizePrSourceInfo, generateAnnouncementDraft, generateSocialPostDraft for x, generateSocialPostDraft for linkedin, reviewPrDraft, createDraftOutput.",
    "Never publish, send, post, schedule, or mutate anything external.",
    "If any information is missing, surface it in missingFields and do not invent it.",
    "Return the final structured output only.",
    "",
    JSON.stringify(
      {
        request: input.request,
        techplayPreview: input.techplayPreview,
        analysisSections: input.analysisSections,
        constraints: {
          draftOnly: true,
          allowedOutputs: ["x", "linkedin", "email", "notion"],
          noExternalWrites: true,
        },
      },
      null,
      2,
    ),
  ].join("\n");
}

async function loadStrandsSdk(): Promise<StrandsModule> {
  strandsSdkPromise ??= import("@strands-agents/sdk");
  return strandsSdkPromise;
}
