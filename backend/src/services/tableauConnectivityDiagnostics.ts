import { getConfig } from "../config";
import { getTableauConnectedAppSecrets } from "../aws/secrets";
import { logInfo, safeErrorDetails, safeHash } from "../logging";
import {
  buildTableauDirectTrustAuthLog,
  resolveTableauDirectTrustAuthContext,
} from "../tableau/tableauDirectTrustAuth";
import { TableauRestClient } from "../tableau/tableauRestClient";

export type TableauConnectivityDiagnostics = {
  enabled: true;
  config: {
    serverUrlConfigured: boolean;
    siteContentUrlConfigured: boolean;
    apiVersion: string;
    subjectConfigured: boolean;
    scopesConfigured: string[];
    connectedAppConfigured: {
      clientId: boolean;
      secretId: boolean;
      secretValue: boolean;
    };
  };
  reachability: {
    ok: boolean;
    status?: number;
    durationMs?: number;
    error?: Record<string, unknown>;
  };
  authentication: {
    ok: boolean;
    signedIn?: boolean;
    status?: number;
    userIdHash?: string;
    siteIdHash?: string;
    likelyCause?: string;
    error?: Record<string, unknown>;
  };
};

export async function runTableauConnectivityDiagnostics(): Promise<TableauConnectivityDiagnostics> {
  return runTableauConnectivityDiagnosticsWithAuthContext();
}

export async function runTableauConnectivityDiagnosticsWithAuthContext(input?: {
  authenticatedUser?: import("../types/auth").AuthenticatedUser;
}): Promise<TableauConnectivityDiagnostics> {
  const config = getConfig();
  const connectedApp = await getTableauConnectedAppSecrets();
  const serverUrl = config.tableau.serverUrl.trim();
  const siteContentUrl = config.tableau.siteContentUrl.trim();
  const apiVersion = config.tableau.apiVersion;
  const authContext = resolveTableauDirectTrustAuthContext({
    authenticatedUser: input?.authenticatedUser,
  });

  const diagnostics: TableauConnectivityDiagnostics = {
    enabled: true,
    config: {
      serverUrlConfigured: Boolean(serverUrl),
      siteContentUrlConfigured: Boolean(siteContentUrl),
      apiVersion,
      subjectConfigured: authContext.subjectConfigured,
      scopesConfigured: config.tableau.scopes,
      connectedAppConfigured: {
        clientId: Boolean(connectedApp.clientId.trim()),
        secretId: Boolean(connectedApp.secretId.trim()),
        secretValue: Boolean(connectedApp.secretValue.trim()),
      },
    },
    reachability: {
      ok: false,
    },
    authentication: {
      ok: false,
    },
  };

  if (!serverUrl) {
    diagnostics.reachability.error = {
      errorName: "ConfigurationError",
      errorMessage: "TABLEAU_SERVER_URL is not configured.",
    };
    return diagnostics;
  }

  const reachabilityStartedAt = Date.now();
  try {
    const response = await fetch(`${serverUrl}/api/${apiVersion}/serverinfo`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    diagnostics.reachability = {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - reachabilityStartedAt,
      ...(response.ok
        ? {}
        : {
            error: {
              errorName: "TableauServerInfoError",
              errorMessage: `Tableau serverinfo returned HTTP ${response.status}.`,
            },
          }),
    };
  } catch (error) {
    diagnostics.reachability = {
      ok: false,
      durationMs: Date.now() - reachabilityStartedAt,
      error: safeErrorDetails(error),
    };
  }

  if (!authContext.subject) {
    diagnostics.authentication.error = {
      errorName: "ConfigurationError",
      errorMessage: "TABLEAU_DEFAULT_SUBJECT is not configured.",
    };
    return diagnostics;
  }

  const client = new TableauRestClient({
    serverUrl,
    siteContentUrl,
    apiVersion,
    subject: authContext.subject,
    authContext,
    scopes: config.tableau.scopes,
  });

  logInfo(
    "tableau.connectivity_diagnostics.configuration",
    buildTableauDirectTrustAuthLog({
      authContext,
      connectedApp,
      serverUrl,
      siteContentUrl,
      apiVersion,
    }),
  );
  logInfo("tableau.connectivity_diagnostics.auth_context", {
    diagnosticsAuthConfigSource: authContext.authConfigSource,
    diagnosticsSubjectHash: safeHash(authContext.subject),
    runtimeSubjectHash: safeHash(authContext.subject),
    diagnosticsSubjectMatchesRuntime: true,
    diagnosticsAuthFallback:
      authContext.authConfigSource === "environment" &&
      !input?.authenticatedUser,
  });

  try {
    const session = await client.signInWithJwt();
    diagnostics.authentication = {
      ok: true,
      signedIn: true,
      siteIdHash: safeHash(session.siteId),
      userIdHash: safeHash(session.userId),
    };
    await client.signOut(session);
  } catch (error) {
    diagnostics.authentication = {
      ok: false,
      signedIn: false,
      likelyCause: inferAuthenticationLikelyCause(error),
      error: safeErrorDetails(error),
    };
  }

  return diagnostics;
}

function inferAuthenticationLikelyCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const details =
    "details" in error && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : undefined;
  const status =
    details && typeof details.status === "number" ? details.status : undefined;
  const tableauErrorCode =
    typeof details?.tableauErrorCode === "string"
      ? details.tableauErrorCode
      : undefined;

  if (status === 401 || tableauErrorCode === "401001") {
    return [
      "Tableau rejected the Connected App JWT sign-in.",
      "Check TABLEAU_DEFAULT_SUBJECT, Connected App trust settings, and whether the subject user exists and can sign in to the target site.",
    ].join(" ");
  }

  return undefined;
}
