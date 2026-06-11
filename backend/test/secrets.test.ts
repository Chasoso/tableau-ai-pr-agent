import { afterEach, describe, expect, it } from "vitest";
import { getTableauConnectedAppSecretsFromEnv } from "../src/aws/secrets";

describe("aws secrets helpers", () => {
  const originalClientId = process.env.TABLEAU_CONNECTED_APP_CLIENT_ID;
  const originalSecretId = process.env.TABLEAU_CONNECTED_APP_SECRET_ID;
  const originalSecretValue = process.env.TABLEAU_CONNECTED_APP_SECRET_VALUE;

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env.TABLEAU_CONNECTED_APP_CLIENT_ID;
    } else {
      process.env.TABLEAU_CONNECTED_APP_CLIENT_ID = originalClientId;
    }

    if (originalSecretId === undefined) {
      delete process.env.TABLEAU_CONNECTED_APP_SECRET_ID;
    } else {
      process.env.TABLEAU_CONNECTED_APP_SECRET_ID = originalSecretId;
    }

    if (originalSecretValue === undefined) {
      delete process.env.TABLEAU_CONNECTED_APP_SECRET_VALUE;
    } else {
      process.env.TABLEAU_CONNECTED_APP_SECRET_VALUE = originalSecretValue;
    }
  });

  it("returns configured connected app secrets from environment", () => {
    process.env.TABLEAU_CONNECTED_APP_CLIENT_ID = "client-id";
    process.env.TABLEAU_CONNECTED_APP_SECRET_ID = "secret-id";
    process.env.TABLEAU_CONNECTED_APP_SECRET_VALUE = "secret-value";

    expect(getTableauConnectedAppSecretsFromEnv()).toEqual({
      clientId: "client-id",
      secretId: "secret-id",
      secretValue: "secret-value",
    });
  });

  it("throws when connected app secrets are missing", () => {
    delete process.env.TABLEAU_CONNECTED_APP_CLIENT_ID;
    delete process.env.TABLEAU_CONNECTED_APP_SECRET_ID;
    delete process.env.TABLEAU_CONNECTED_APP_SECRET_VALUE;

    expect(() => getTableauConnectedAppSecretsFromEnv()).toThrow(
      "Tableau Connected App environment variables are not configured.",
    );
  });
});
