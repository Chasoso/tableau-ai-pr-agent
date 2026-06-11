import type { QuestionIntent, TableauAdditionalContext } from "./tableau";

export type AgentAnswerStyle = "direct" | "ranking" | "summary";

export type AgentPlan = {
  intent: QuestionIntent;
  confidence: number;
  normalizedQuestion: string;
  needsMcp: boolean;
  answerStyle: AgentAnswerStyle;
  reasonBrief: string;
  requiredEvidence: string[];
};

export type AgentEvaluation = {
  isSufficient: boolean;
  confidence: number;
  reasonBrief: string;
  missingEvidence: string[];
  followUpQuestion?: string;
};

export type AgentExecutionPassDebug = {
  planningQuestion: string;
  provider: TableauAdditionalContext["provider"];
  warningCount: number;
  hasMetadata: boolean;
  hasQueryInsight: boolean;
  evaluation?: AgentEvaluation;
};

export type AgentExecutionDebug = {
  enabled: boolean;
  planSource: "bedrock" | "heuristic";
  passCount: number;
  plan?: AgentPlan;
  passes: AgentExecutionPassDebug[];
  fallbackReason?: string;
};
