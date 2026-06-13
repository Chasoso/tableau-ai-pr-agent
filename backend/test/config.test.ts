import { afterEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/config";

describe("config aliases", () => {
  const originals = {
    actionRunTtl: process.env.ACTION_RUN_TTL_SECONDS,
    actionRunLease: process.env.ACTION_RUN_LEASE_SECONDS,
    actionRunProgress: process.env.ACTION_RUN_PROGRESS_MESSAGE_LIMIT,
    actionRunWorker: process.env.ACTION_RUN_WORKER_FUNCTION_NAME,
    actionRunHeader: process.env.ACTION_RUN_OWNER_TOKEN_HEADER_NAME,
    chatJobTtl: process.env.CHAT_JOB_TTL_SECONDS,
    chatJobLease: process.env.CHAT_JOB_LEASE_SECONDS,
    chatJobProgress: process.env.CHAT_JOB_PROGRESS_MESSAGE_LIMIT,
    chatJobWorker: process.env.CHAT_JOB_WORKER_FUNCTION_NAME,
    chatJobHeader: process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME,
    useStrandsAgent: process.env.USE_STRANDS_AGENT,
  };

  afterEach(() => {
    restoreEnv("ACTION_RUN_TTL_SECONDS", originals.actionRunTtl);
    restoreEnv("ACTION_RUN_LEASE_SECONDS", originals.actionRunLease);
    restoreEnv(
      "ACTION_RUN_PROGRESS_MESSAGE_LIMIT",
      originals.actionRunProgress,
    );
    restoreEnv("ACTION_RUN_WORKER_FUNCTION_NAME", originals.actionRunWorker);
    restoreEnv("ACTION_RUN_OWNER_TOKEN_HEADER_NAME", originals.actionRunHeader);
    restoreEnv("CHAT_JOB_TTL_SECONDS", originals.chatJobTtl);
    restoreEnv("CHAT_JOB_LEASE_SECONDS", originals.chatJobLease);
    restoreEnv("CHAT_JOB_PROGRESS_MESSAGE_LIMIT", originals.chatJobProgress);
    restoreEnv("CHAT_JOB_WORKER_FUNCTION_NAME", originals.chatJobWorker);
    restoreEnv("CHAT_JOB_OWNER_TOKEN_HEADER_NAME", originals.chatJobHeader);
    restoreEnv("USE_STRANDS_AGENT", originals.useStrandsAgent);
  });

  it("prefers action run env names and keeps chat job env names as fallback", () => {
    process.env.ACTION_RUN_TTL_SECONDS = "90000";
    process.env.ACTION_RUN_LEASE_SECONDS = "180";
    process.env.ACTION_RUN_PROGRESS_MESSAGE_LIMIT = "7";
    process.env.ACTION_RUN_WORKER_FUNCTION_NAME = "action-run-worker";
    process.env.ACTION_RUN_OWNER_TOKEN_HEADER_NAME = "x-action-run-owner-token";
    process.env.CHAT_JOB_TTL_SECONDS = "86400";
    process.env.CHAT_JOB_LEASE_SECONDS = "120";
    process.env.CHAT_JOB_PROGRESS_MESSAGE_LIMIT = "12";
    process.env.CHAT_JOB_WORKER_FUNCTION_NAME = "chat-job-worker";
    process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME = "x-chat-owner-token";

    const config = getConfig();

    expect(config.actionRun).toEqual({
      ttlSeconds: 90000,
      leaseSeconds: 180,
      progressMessageLimit: 7,
      workerFunctionName: "action-run-worker",
      ownerTokenHeaderName: "x-action-run-owner-token",
    });
    expect(config.chatJob).toEqual({
      ttlSeconds: 86400,
      leaseSeconds: 120,
      progressMessageLimit: 12,
      workerFunctionName: "chat-job-worker",
      ownerTokenHeaderName: "x-chat-owner-token",
    });
    expect(config.prAgent).toEqual({
      useStrandsAgent: false,
    });
  });

  it("enables the strands agent flag when requested", () => {
    process.env.USE_STRANDS_AGENT = "true";

    const config = getConfig();

    expect(config.prAgent.useStrandsAgent).toBe(true);
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
