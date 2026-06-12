import type { ChatJobProgressMessage } from "../services/chatProgress";
import type { ChatJobRecord } from "./chatJob";
import type { ClientContext } from "./chat";
import type { DashboardContext } from "./tableau";

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

export type ActionRunRecord = Omit<ChatJobRecord, "request" | "result"> & {
  jobType: "action_run";
  request: ActionRunRequest;
  result?: ActionRunResult;
};

export type ActionRunCreateResponse = {
  actionRunId: string;
  jobType: "action_run";
  status: ChatJobRecord["status"];
  stage: ChatJobRecord["stage"];
  pollUrl: string;
  retryAfterMs: number;
  ownerToken?: string;
};

export type ActionRunGetResponse = {
  actionRunId: string;
  jobType: "action_run";
  status: ChatJobRecord["status"];
  stage: ChatJobRecord["stage"];
  progressMessages: ChatJobProgressMessage[];
  result?: ActionRunResult;
  error?: ChatJobRecord["error"];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: number;
  ownerType: ChatJobRecord["ownerType"];
};
