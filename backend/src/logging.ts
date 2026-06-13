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
    ...sanitizeLogDetails(details),
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

function sanitizeLogDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = sanitizeValue(details, undefined);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }

  return details;
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitizeValue(childValue, childKey);
    }
    return output;
  }

  if (typeof value !== "string") {
    return value;
  }

  if (key && isSensitiveKey(key)) {
    return "[REDACTED]";
  }

  return redactSensitiveString(value);
}

function isSensitiveKey(key: string): boolean {
  return /(^|_)(secret|token|password|credential|verifier|webhook|cookie|authorization|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|account[_-]?id)($|_)/i.test(
    key,
  );
}

function redactSensitiveString(value: string): string {
  if (
    /\b(secret|token|password|credential|verifier|authorization)\b/i.test(
      value,
    ) &&
    value.length >= 12
  ) {
    return "[REDACTED]";
  }

  return value
    .replace(
      /https:\/\/hooks\.slack\.com\/services\/[^\s"'<>]+/gi,
      "[REDACTED_SLACK_WEBHOOK_URL]",
    )
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/ASIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{10,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{10,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b\d{12}\b/g, "[REDACTED_AWS_ACCOUNT]");
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
