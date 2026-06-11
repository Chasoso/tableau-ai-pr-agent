import type { DashboardContext } from "./tableau";

export type ChatJobStatus =
  | "queued"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancel_requested";

export type ChatJobStage =
  | "queued"
  | "loading_history"
  | "loading_dashboard_context"
  | "planning"
  | "running_mcp_tools"
  | "generating_answer"
  | "finalizing"
  | "completed"
  | "failed";

export type ChatJobProgressMessage = {
  at: string;
  stage: ChatJobStage;
  message: string;
  toolName?: string;
  debug?: Record<string, unknown>;
};

export type ChatJobError = {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ChatJobResult = {
  answer: string;
  sessionId: string;
  messageId: string;
  notionPostIdeaDraft?: ChatResponse["notionPostIdeaDraft"];
  dashboardContextPatch?: ChatResponse["dashboardContextPatch"];
  debug?: {
    usedMock?: boolean;
    tableauContextProvider?: string;
    mcpExecutionDebug?: Record<string, unknown>;
    mcpObservations?: Record<string, unknown>[];
    agentExecutionDebug?: Record<string, unknown>;
  };
};

export type ChatJobCreateResponse = {
  jobId: string;
  status: ChatJobStatus;
  stage: ChatJobStage;
  pollUrl: string;
  retryAfterMs: number;
  ownerToken?: string;
};

export type ChatJobGetResponse = {
  jobId: string;
  status: ChatJobStatus;
  stage: ChatJobStage;
  progressMessages: ChatJobProgressMessage[];
  result?: ChatJobResult;
  error?: ChatJobError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: number;
  ownerType: "authenticated" | "anonymous";
};

export type ChatJobDisplayState = {
  status: ChatJobStatus;
  stage: ChatJobStage;
  progressMessages: ChatJobProgressMessage[];
  error?: ChatJobError;
};

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

export type ChatRequest = {
  question: string;
  dashboardContext: DashboardContext;
  clientContext: {
    source: "tableau-extension";
    appVersion: string;
  };
  sessionId?: string;
};

export type ContextRequest = {
  dashboardContext: DashboardContext;
  clientContext: {
    source: "tableau-extension";
    appVersion: string;
  };
};

export type DashboardContextPatch = Partial<
  Pick<DashboardContext, "workbookName">
>;

export type ChatResponse = {
  answer: string;
  sessionId: string;
  messageId: string;
  notionPostIdeaDraft?: {
    title: string;
    draftKind?: "analysis_memo" | "post_idea";
    reason: string;
    suggestedPostText: string;
    summary?: string;
    analysisBody?: string;
    datasourceName?: string;
    periodLabel?: string;
    rankingItems?: Array<{
      label: string;
      value?: string | number | null;
    }>;
    metricSummary?: {
      impressions?: number;
      engagementRate?: number;
      bookmarkRate?: number;
      profileVisitRate?: number;
    };
    referencePostUrl?: string;
    source?: string;
    tags?: string[];
  };
  dashboardContextPatch?: DashboardContextPatch;
  debug?: {
    usedMock?: boolean;
    tableauContextProvider?: string;
    agentExecutionDebug?: {
      enabled: boolean;
      planSource: "bedrock" | "heuristic";
      passCount: number;
    };
  };
};

export type ContextResponse = {
  dashboardContextPatch?: DashboardContextPatch;
  debug?: {
    tableauContextProvider?: string;
  };
};
