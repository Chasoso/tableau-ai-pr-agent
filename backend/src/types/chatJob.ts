import type { ChatRequest, ChatResponse } from "./chat";
import type {
  ChatJobProgressMessage,
  ChatJobStage,
} from "../services/chatProgress";

export type ChatJobStatus =
  | "queued"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancel_requested";

export type ChatJobOwnerType = "authenticated" | "anonymous";

export type ChatJobAuthSnapshot = {
  userId: string;
  email?: string;
  tableauSubject?: string;
  tokenUse?: string;
};

export type ChatJobResult = {
  answer: string;
  sessionId: string;
  messageId: string;
  notionPostIdeaDraft?: ChatResponse["notionPostIdeaDraft"];
  dashboardContextPatch?: ChatResponse["dashboardContextPatch"];
  debug?: {
    usedMock?: boolean;
    tableauContextProvider?: NonNullable<
      ChatResponse["debug"]
    >["tableauContextProvider"];
    mcpExecutionDebug?: {
      intent?: string;
      intentConfidence?: number;
      answerableFromDashboardContext?: boolean;
      needsMcp?: boolean;
      maxToolCalls?: number;
      toolCallCount?: number;
      replanUsed?: boolean;
      timingMs?: {
        planning: number;
        execution: number;
      };
      fallbackReason?: string;
    };
    agentExecutionDebug?: {
      enabled: boolean;
      planSource: "bedrock" | "heuristic";
      passCount: number;
      fallbackReason?: string;
    };
  };
};

export type ChatJobRecord = {
  jobId: string;
  ownerKey: string;
  ownerType: ChatJobOwnerType;
  ownerUserId?: string | null;
  authContextSnapshot?: ChatJobAuthSnapshot;
  status: ChatJobStatus;
  stage: ChatJobStage;
  progressMessages: ChatJobProgressMessage[];
  request: ChatRequest;
  result?: ChatJobResult;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  workerId?: string;
  leaseExpiresAt?: string;
  attemptCount?: number;
  expiresAt: number;
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
  error?: ChatJobRecord["error"];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: number;
  ownerType: ChatJobOwnerType;
};
