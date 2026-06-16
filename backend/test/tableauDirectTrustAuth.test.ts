import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetTableauDirectTrustAuthState,
  resolveTableauDirectTrustAuthContext,
} from "../src/tableau/tableauDirectTrustAuth";

afterEach(() => {
  resetTableauDirectTrustAuthState();
  vi.restoreAllMocks();
  delete process.env.TABLEAU_DEFAULT_SUBJECT;
  delete process.env.TABLEAU_SUBJECT;
});

describe("resolveTableauDirectTrustAuthContext", () => {
  it("prefers TABLEAU_DEFAULT_SUBJECT over TABLEAU_SUBJECT and warns on mismatch", () => {
    process.env.TABLEAU_DEFAULT_SUBJECT = "default@example.com";
    process.env.TABLEAU_SUBJECT = "legacy@example.com";

    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const context = resolveTableauDirectTrustAuthContext();

    expect(context.subject).toBe("default@example.com");
    expect(context.subjectSource).toBe("TABLEAU_DEFAULT_SUBJECT");
    expect(context.authConfigSource).toBe("environment");
    expect(context.subjectConfigured).toBe(true);
    expect(context.subjectHashesMatch).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(String(warnSpy.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({
      event: "tableau.auth.subject.configuration_mismatch",
      authConfigSource: "environment",
      subjectSource: "TABLEAU_DEFAULT_SUBJECT",
      subjectHashesMatch: false,
    });
  });

  it("prefers the verified user subject over environment fallbacks", () => {
    process.env.TABLEAU_DEFAULT_SUBJECT = "default@example.com";
    process.env.TABLEAU_SUBJECT = "legacy@example.com";

    const context = resolveTableauDirectTrustAuthContext({
      authenticatedUser: {
        userId: "user-1",
        email: "user@example.com",
        tableauSubject: "tableau-user@example.com",
      },
    });

    expect(context.subject).toBe("tableau-user@example.com");
    expect(context.subjectSource).toBe("authenticated-user.tableauSubject");
    expect(context.authConfigSource).toBe("authenticated-user");
  });
});
