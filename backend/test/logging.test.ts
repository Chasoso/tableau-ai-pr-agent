import { afterEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../src/logging";

describe("logging sanitization", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    vi.restoreAllMocks();
  });

  it("redacts common secret-like values from structured logs", () => {
    process.env.LOG_LEVEL = "warn";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // noop
    });

    logWarn("security.test", {
      awsAccountId: "123456789012",
      slackWebhookUrl: "https://hooks.slack.com/services/T000/B000/SECRET",
      errorMessage: "secret-token should not reach the user",
      nested: {
        accessToken: "xoxb-123456789012-abcdef",
        clientSecret: "super-secret-value",
        keep: "safe",
      },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as {
      awsAccountId: string;
      slackWebhookUrl: string;
      errorMessage: string;
      nested: {
        accessToken: string;
        clientSecret: string;
        keep: string;
      };
    };
    expect(payload.awsAccountId).toBe("[REDACTED_AWS_ACCOUNT]");
    expect(payload.slackWebhookUrl).toBe("[REDACTED]");
    expect(payload.errorMessage).toBe("[REDACTED]");
    expect(payload.nested.accessToken).toBe("[REDACTED]");
    expect(payload.nested.clientSecret).toBe("[REDACTED]");
    expect(payload.nested.keep).toBe("safe");
  });
});
