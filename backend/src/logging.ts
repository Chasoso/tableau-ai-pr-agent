import { createHash } from "node:crypto";

type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function logInfo(
  event: string,
  details: Record<string, unknown> = {},
): void {
  writeLog("info", event, details);
}

export function logDebug(
  event: string,
  details: Record<string, unknown> = {},
): void {
  writeLog("debug", event, details);
}

export function logWarn(
  event: string,
  details: Record<string, unknown> = {},
): void {
  writeLog("warn", event, details);
}

export function logError(
  event: string,
  details: Record<string, unknown> = {},
): void {
  writeLog("error", event, details);
}

export function safeHash(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownError" };
  }

  const maybeDetails =
    "details" in error && typeof error.details === "object"
      ? error.details
      : undefined;

  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(maybeDetails ? { details: maybeDetails } : {}),
  };
}

function writeLog(
  level: LogLevel,
  event: string,
  details: Record<string, unknown>,
): void {
  if (!shouldLog(level)) {
    return;
  }

  const payload = JSON.stringify({
    level,
    event,
    ...details,
  });

  if (level === "error") {
    console.error(payload);
    return;
  }

  if (level === "warn") {
    console.warn(payload);
    return;
  }

  console.log(payload);
}

function shouldLog(level: LogLevel): boolean {
  const configuredLevel = resolveLogLevel(process.env.LOG_LEVEL);
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLevel];
}

function resolveLogLevel(value: string | undefined): LogLevel {
  if (!value) {
    return "info";
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }

  return "info";
}
