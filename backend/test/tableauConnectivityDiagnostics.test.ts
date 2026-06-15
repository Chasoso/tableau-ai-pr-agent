import { afterEach, describe, expect, it, vi } from "vitest";
import { runTableauConnectivityDiagnostics } from "../src/services/tableauConnectivityDiagnostics";

const originalEnv = {
  TABLEAU_SERVER_URL: process.env.TABLEAU_SERVER_URL,
  TABLEAU_SITE_CONTENT_URL: process.env.TABLEAU_SITE_CONTENT_URL,
  TABLEAU_API_VERSION: process.env.TABLEAU_API_VERSION,
  TABLEAU_DEFAULT_SUBJECT: process.env.TABLEAU_DEFAULT_SUBJECT,
  TABLEAU_SCOPES: process.env.TABLEAU_SCOPES,
  TABLEAU_CONNECTED_APP_CLIENT_ID: process.env.TABLEAU_CONNECTED_APP_CLIENT_ID,
  TABLEAU_CONNECTED_APP_SECRET_ID: process.env.TABLEAU_CONNECTED_APP_SECRET_ID,
  TABLEAU_CONNECTED_APP_SECRET_VALUE:
    process.env.TABLEAU_CONNECTED_APP_SECRET_VALUE,
};

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv("TABLEAU_SERVER_URL", originalEnv.TABLEAU_SERVER_URL);
  restoreEnv("TABLEAU_SITE_CONTENT_URL", originalEnv.TABLEAU_SITE_CONTENT_URL);
  restoreEnv("TABLEAU_API_VERSION", originalEnv.TABLEAU_API_VERSION);
  restoreEnv("TABLEAU_DEFAULT_SUBJECT", originalEnv.TABLEAU_DEFAULT_SUBJECT);
  restoreEnv("TABLEAU_SCOPES", originalEnv.TABLEAU_SCOPES);
  restoreEnv(
    "TABLEAU_CONNECTED_APP_CLIENT_ID",
    originalEnv.TABLEAU_CONNECTED_APP_CLIENT_ID,
  );
  restoreEnv(
    "TABLEAU_CONNECTED_APP_SECRET_ID",
    originalEnv.TABLEAU_CONNECTED_APP_SECRET_ID,
  );
  restoreEnv(
    "TABLEAU_CONNECTED_APP_SECRET_VALUE",
    originalEnv.TABLEAU_CONNECTED_APP_SECRET_VALUE,
  );
});

describe("runTableauConnectivityDiagnostics", () => {
  it("reports reachability and authentication success", async () => {
    process.env.TABLEAU_SERVER_URL = "https://tableau.example.com";
    process.env.TABLEAU_SITE_CONTENT_URL = "site";
    process.env.TABLEAU_API_VERSION = "3.25";
    process.env.TABLEAU_DEFAULT_SUBJECT = "user@example.com";
    process.env.TABLEAU_SCOPES = "tableau:content:read";
    process.env.TABLEAU_CONNECTED_APP_CLIENT_ID = "client-id";
    process.env.TABLEAU_CONNECTED_APP_SECRET_ID = "secret-id";
    process.env.TABLEAU_CONNECTED_APP_SECRET_VALUE = "secret-value";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "3.25" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            credentials: {
              token: "tableau-token",
              site: { id: "site-123" },
              user: { id: "user-456" },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await runTableauConnectivityDiagnostics();

    expect(result.reachability.ok).toBe(true);
    expect(result.reachability.status).toBe(200);
    expect(result.authentication.ok).toBe(true);
    expect(result.authentication.siteIdHash).toBeTruthy();
    expect(result.authentication.userIdHash).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
