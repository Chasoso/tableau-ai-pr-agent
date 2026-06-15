import { ChatJobRepository } from "../repositories/chatJobRepository";
import { logError, logInfo, safeErrorDetails } from "../logging";
import { ActionRunService } from "../services/actionRunService";
import { ChatJobService } from "../services/chatJobService";
import { runTableauConnectivityDiagnostics } from "../services/tableauConnectivityDiagnostics";
import type { LambdaExecutionContext } from "../types/api";

const chatJobRepository = new ChatJobRepository();
const chatJobService = new ChatJobService();
const actionRunService = new ActionRunService();

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

  const record = await chatJobRepository.get(jobId);
  if (!record) {
    throw new Error("Job not found.");
  }

  logInfo("chat.job.worker.received", {
    jobId,
    jobType: record.jobType ?? "chat",
    remainingTimeMs: context?.getRemainingTimeInMillis?.(),
  });

  try {
    if (record.jobType === "action_run") {
      await actionRunService.processActionRun(
        {
          actionRunId: jobId,
          getRemainingTimeInMillis: context?.getRemainingTimeInMillis,
        },
        undefined,
      );
      logInfo("action_run.worker.completed", { jobId });
    } else {
      await chatJobService.processChatJob(
        {
          jobId,
          getRemainingTimeInMillis: context?.getRemainingTimeInMillis,
        },
        undefined,
      );
      logInfo("chat.job.worker.completed", { jobId });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        jobId,
        jobType: record.jobType ?? "chat",
      }),
    };
  } catch (error) {
    const tableauDiagnostics = await buildTableauFailureDiagnostics();
    logError("chat.job.worker.failed", {
      jobId,
      jobType: record.jobType ?? "chat",
      ...safeErrorDetails(error),
      ...(tableauDiagnostics ? { tableauDiagnostics } : {}),
    });
    throw error;
  }
}

async function buildTableauFailureDiagnostics():
  Promise<unknown | undefined> {
  try {
    return await runTableauConnectivityDiagnostics();
  } catch (error) {
    return {
      enabled: true,
      reachability: {
        ok: false,
        error: safeErrorDetails(error),
      },
      authentication: {
        ok: false,
        error: safeErrorDetails(error),
      },
    };
  }
}
