import { afterEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/healthHandler";

const mocks = vi.hoisted(() => ({
  runTableauConnectivityDiagnostics: vi.fn(),
}));

vi.mock("../src/services/tableauConnectivityDiagnostics", () => ({
  runTableauConnectivityDiagnostics: mocks.runTableauConnectivityDiagnostics,
}));

describe("healthHandler", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns a simple ok response", async () => {
    const response = await handler();

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  it("includes tableau diagnostics when enabled", async () => {
    vi.stubEnv("TABLEAU_CONNECTIVITY_DIAGNOSTICS", "true");
    mocks.runTableauConnectivityDiagnostics.mockResolvedValue({
      enabled: true,
      config: {
        serverUrlConfigured: true,
        siteContentUrlConfigured: true,
        apiVersion: "3.25",
        subjectConfigured: true,
        scopesConfigured: ["tableau:content:read"],
        connectedAppConfigured: {
          clientId: true,
          secretId: true,
          secretValue: true,
        },
      },
      reachability: { ok: true, status: 200, durationMs: 12 },
      authentication: { ok: true, signedIn: true, siteIdHash: "site", userIdHash: "user" },
    });

    const response = await handler({
      queryStringParameters: { tableau: "1" },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "ok",
      tableau: expect.objectContaining({
        enabled: true,
        reachability: expect.objectContaining({ ok: true }),
        authentication: expect.objectContaining({ ok: true }),
      }),
    });
    expect(mocks.runTableauConnectivityDiagnostics).toHaveBeenCalledTimes(1);
  });
});
