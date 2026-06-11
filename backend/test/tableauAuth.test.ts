import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { generateTableauConnectedAppJwt } from "../src/tableau/tableauAuth";

describe("generateTableauConnectedAppJwt", () => {
  it("includes required Tableau Connected Apps claims and header", () => {
    const token = generateTableauConnectedAppJwt({
      connectedApp: {
        clientId: "client-id",
        secretId: "secret-id",
        secretValue: "secret-value",
      },
      subject: "user@example.com",
      scopes: ["tableau:content:read"],
      expirationSeconds: 300,
    });

    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe("HS256");
    expect(decoded?.header.kid).toBe("secret-id");
    expect(decoded?.payload).toMatchObject({
      iss: "client-id",
      sub: "user@example.com",
      aud: "tableau",
      scp: ["tableau:content:read"],
    });
    expect((decoded?.payload as { jti?: string }).jti).toBeTruthy();
    expect((decoded?.payload as { exp?: number }).exp).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
  });
});
