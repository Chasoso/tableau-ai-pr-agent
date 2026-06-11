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

export type ChatProgressUpdate = {
  stage: ChatJobStage;
  message: string;
  toolName?: string;
  debug?: Record<string, unknown>;
};

export interface ChatProgressReporter {
  report(update: ChatProgressUpdate): Promise<void>;
}

export function createNoopChatProgressReporter(): ChatProgressReporter {
  return {
    async report(): Promise<void> {
      return;
    },
  };
}
