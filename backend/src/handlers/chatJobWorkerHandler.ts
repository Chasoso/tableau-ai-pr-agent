import { logError, logInfo, safeErrorDetails } from "../logging";
import { ChatJobService } from "../services/chatJobService";
import type { LambdaExecutionContext } from "../types/api";

const chatJobService = new ChatJobService();

type ChatJobWorkerEvent = {
  jobId?: string;
};

export async function handler(
  event: ChatJobWorkerEvent,
  context?: LambdaExecutionContext,
): Promise<{ statusCode: number; body: string }> {
  const jobId = event.jobId?.trim();
  if (!jobId) {
    throw new Error("jobId is required.");
  }

  logInfo("chat.job.worker.received", {
    jobId,
    remainingTimeMs: context?.getRemainingTimeInMillis?.(),
  });

  try {
    await chatJobService.processChatJob(
      {
        jobId,
        getRemainingTimeInMillis: context?.getRemainingTimeInMillis,
      },
      undefined,
    );
    logInfo("chat.job.worker.completed", { jobId });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, jobId }),
    };
  } catch (error) {
    logError("chat.job.worker.failed", {
      jobId,
      ...safeErrorDetails(error),
    });
    throw error;
  }
}
