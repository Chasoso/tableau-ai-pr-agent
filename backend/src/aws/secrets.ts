export type TableauConnectedAppSecrets = {
  clientId: string;
  secretId: string;
  secretValue: string;
};

export function getTableauConnectedAppSecretsFromEnv(): TableauConnectedAppSecrets {
  const clientId = process.env.TABLEAU_CONNECTED_APP_CLIENT_ID;
  const secretId = process.env.TABLEAU_CONNECTED_APP_SECRET_ID;
  const secretValue = process.env.TABLEAU_CONNECTED_APP_SECRET_VALUE;

  if (!clientId || !secretId || !secretValue) {
    throw new Error(
      "Tableau Connected App environment variables are not configured.",
    );
  }

  return {
    clientId,
    secretId,
    secretValue,
  };
}

export function getTableauConnectedAppSecrets(): TableauConnectedAppSecrets {
  return getTableauConnectedAppSecretsFromEnv();
}
