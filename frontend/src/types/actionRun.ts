import type {
  ChatJobProgressMessage,
  ChatJobStage,
  ChatJobStatus,
} from "./chat";
import type { DashboardContext } from "./tableau";

export type ClientContext = {
  source?: string;
  appVersion?: string;
};

export type ActionRunPostType =
  | "\u4e8b\u524d\u544a\u77e5"
  | "\u958b\u50ac\u76f4\u524d\u30ea\u30de\u30a4\u30f3\u30c9"
  | "\u958b\u50ac\u4e2d\u306e\u5b9f\u6cc1"
  | "\u958b\u50ac\u5f8c\u306e\u304a\u793c\u30fb\u30ec\u30dd\u30fc\u30c8"
  | "\u6b21\u56de\u53c2\u52a0\u306e\u547c\u3073\u304b\u3051";

export type ActionRunRequest = {
  postType: ActionRunPostType;
  eventName: string;
  techplayUrl: string;
  currentSituation: string;
  dashboardContext: DashboardContext;
  clientContext?: ClientContext;
};

export type ActionRunResult = {
  summary: string;
  suggestedSlackPostText: string;
  hashtags: string[];
  evidence: string[];
  checks: string[];
  imageCaption?: string;
  debug?: {
    source?: "stub";
    requestEcho?: Pick<
      ActionRunRequest,
      "postType" | "eventName" | "techplayUrl" | "currentSituation"
    >;
  };
};

export type ActionRunApprovalRequest = {
  approved: boolean;
  reviewerNote?: string;
};

export type ActionRunApprovalResponse = ActionRunGetResponse & {
  slackWebhook: {
    sent: boolean;
    skipped: boolean;
    statusCode?: number;
    error?: string;
  };
};

export type ActionRunCreateResponse = {
  actionRunId: string;
  jobType: "action_run";
  status: ChatJobStatus;
  stage: ChatJobStage;
  pollUrl: string;
  retryAfterMs: number;
  ownerToken?: string;
};

export type ActionRunGetResponse = {
  actionRunId: string;
  jobType: "action_run";
  status: ChatJobStatus;
  stage: ChatJobStage;
  progressMessages: ChatJobProgressMessage[];
  result?: ActionRunResult;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: number;
  ownerType: "authenticated" | "anonymous";
};
