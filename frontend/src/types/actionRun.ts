import type {
  ChatJobProgressMessage,
  ChatJobStage,
  ChatJobStatus,
} from "./chat";
import type { DashboardContext } from "./tableau";

export type ClientContext = {
  source?: string;
  appVersion?: string;
  photo?: {
    fileName?: string;
    sizeLabel?: string;
    mode?: "image" | "none";
    mimeType?: string;
    objectKey?: string;
    contentType?: string;
    byteLength?: number;
    width?: number;
    height?: number;
    source?: "uploaded_image" | "existing_object" | "none";
    dataUrl?: string;
  };
};

export type ActionRunInputImage = {
  source: "camera" | "library" | "upload";
  objectKey?: string;
  contentType: string;
  bytes?: number;
  width?: number;
  height?: number;
  originalFileName?: string;
  fileId?: string;
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
  eventUrl?: string;
  eventSource?: "resolved" | "fallback";
  venueMemo?: string;
  techplayUrl: string;
  currentSituation: string;
  dashboardContext: DashboardContext;
  inputImage?: ActionRunInputImage;
  clientContext?: ClientContext;
};

export type ActionRunPhotoContext = NonNullable<
  NonNullable<ActionRunRequest["clientContext"]>["photo"]
> & {
  objectKey?: string;
  contentType?: string;
  byteLength?: number;
  width?: number;
  height?: number;
  source?: "uploaded_image" | "existing_object" | "none";
};

export type ActionRunResult = {
  summary: string;
  suggestedSlackPostText: string;
  hashtags: string[];
  evidence: string[];
  checks: string[];
  imageCaption?: string;
  generatedPostSuggestion?: GeneratedPostSuggestion;
  evidencePack?: PostGenerationEvidencePack;
  canGeneratePost?: boolean;
  generationBlockers?: string[];
  analysisSections?: ActionRunAnalysisSection[];
  debug?: {
    source?: "stub";
    requestEcho?: Pick<
      ActionRunRequest,
      "postType" | "eventName" | "techplayUrl" | "currentSituation"
    >;
  };
};

export type InsightSection = {
  available: boolean;
  sourceStatus: "queried" | "metadata_only" | "skipped" | "failed";
  datasourceKey: string;
  summary?: string;
  keyFindings?: string[];
  evidenceRows?: unknown[];
  skippedReason?: string;
  failedReason?: string;
};

export type PostGenerationEvidencePack = {
  photoContext: {
    available: boolean;
    source: "actual_image" | "missing_image" | "fallback";
    summary?: string;
    detectedTopics?: string[];
    visibleText?: string[];
    skippedReason?: string;
  };
  surveyInsight: InsightSection;
  postPerformanceInsight: InsightSection;
  accountOverviewInsight: InsightSection;
  canGeneratePost: boolean;
  generationBlockers: string[];
};

export type GeneratedPostSuggestion = {
  text: string;
  rationale: string;
  usedEvidence: {
    photo: boolean;
    survey: boolean;
    postPerformance: boolean;
    accountOverview: boolean;
  };
  warnings: string[];
};

export type ActionRunAnalysisSection = {
  key:
    | "post_type_distribution"
    | "keyword_tendency"
    | "weekday_time_tendency"
    | "image_presence_tendency"
    | "photo_context"
    | "survey_insight"
    | "post_performance_insight"
    | "account_overview_insight"
    | "evidence_pack";
  title: string;
  question: string;
  summary: string;
  rows: Array<{
    label: string;
    value: number | null;
  }>;
  details?: {
    observedItems?: string[];
    ocrText?: string;
    sceneInference?: string;
    eventFeel?: string;
    postableElements?: string[];
    subjectCandidates?: string[];
  };
  datasourceName?: string;
  dimensionField?: string;
  metricField?: string;
  warnings?: string[];
  sourceStatus?:
    | "image_queried"
    | "tableau_queried"
    | "metadata_only"
    | "skipped"
    | "failed";
  skippedReason?: string;
  failedReason?: string;
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
  inputImageObjectKey?: string;
  inputImageContentType?: string;
  inputImageBytes?: number;
  inputImageWidth?: number;
  inputImageHeight?: number;
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
