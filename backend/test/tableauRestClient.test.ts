import { afterEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { TableauRestClient } from "../src/tableau/tableauRestClient";
import { resolveTableauDirectTrustAuthContext } from "../src/tableau/tableauDirectTrustAuth";

const mocks = vi.hoisted(() => ({
  getTableauConnectedAppSecrets: vi.fn(),
}));

vi.mock("../src/aws/secrets", () => ({
  getTableauConnectedAppSecrets: mocks.getTableauConnectedAppSecrets,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TABLEAU_SERVER_URL;
  delete process.env.TABLEAU_SITE_CONTENT_URL;
  delete process.env.TABLEAU_API_VERSION;
  delete process.env.TABLEAU_DEFAULT_SUBJECT;
  delete process.env.TABLEAU_SUBJECT;
});

describe("TableauRestClient", () => {
  it("logs the same auth context and JWT payload used for Direct Trust sign in", async () => {
    process.env.TABLEAU_SERVER_URL = "https://tableau.example.com";
    process.env.TABLEAU_SITE_CONTENT_URL = "site";
    process.env.TABLEAU_API_VERSION = "3.25";

    mocks.getTableauConnectedAppSecrets.mockResolvedValue({
      clientId: "client-id",
      secretId: "secret-id",
      secretValue: "secret-value",
    });

    const authContext = resolveTableauDirectTrustAuthContext({
      authenticatedUser: {
        userId: "user-1",
        email: "user@example.com",
        tableauSubject: "user@example.com",
      },
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(
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
    );
    vi.stubGlobal("fetch", fetchMock);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const client = new TableauRestClient({
      serverUrl: "https://tableau.example.com",
      siteContentUrl: "site",
      apiVersion: "3.25",
      subject: authContext.subject,
      authContext,
      scopes: ["tableau:content:read"],
    });

    await client.signInWithJwt();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      credentials: { jwt: string };
    };
    const decoded = jwt.decode(requestBody.credentials.jwt, {
      complete: true,
    }) as {
      payload?: {
        iss?: string;
        sub?: string;
        aud?: string;
        scp?: string[];
      };
    };
    expect(decoded.payload?.sub).toBe("user@example.com");
    expect(decoded.payload?.iss).toBe("client-id");
    expect(decoded.payload?.aud).toBe("tableau");
    expect(decoded.payload?.scp).toEqual(["tableau:content:read"]);

    const configLog = logSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0]));
        } catch {
          return undefined;
        }
      })
      .find((entry) => entry?.event === "tableau.rest.sign_in.configuration");

    expect(configLog).toMatchObject({
      event: "tableau.rest.sign_in.configuration",
      authConfigSource: "authenticated-user",
      subjectSource: "authenticated-user.tableauSubject",
      subjectHashesMatch: true,
      serverHost: "tableau.example.com",
      apiVersion: "3.25",
      connectedAppClientIdHash: expect.any(String),
      connectedAppSecretIdHash: expect.any(String),
      siteContentUrlHash: expect.any(String),
      jwtPayload: {
        issHash: expect.any(String),
        subHash: expect.any(String),
        aud: "tableau",
        expRemainingSeconds: 300,
        scp: ["tableau:content:read"],
      },
    });
  });
});
