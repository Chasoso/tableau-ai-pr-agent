import { getConfig } from "../config";
import { logWarn, safeHash } from "../logging";
import type { TableauConnectedAppSecrets } from "../aws/secrets";
import type { AuthenticatedUser } from "../types/auth";

export type TableauDirectTrustSubjectSource =
  | "authenticated-user.tableauSubject"
  | "authenticated-user.email"
  | "provided-subject"
  | "TABLEAU_DEFAULT_SUBJECT"
  | "TABLEAU_SUBJECT"
  | "unconfigured";

export type TableauDirectTrustAuthSource =
  | "authenticated-user"
  | "provided-subject"
  | "environment"
  | "unconfigured";

export type TableauDirectTrustAuthContext = {
  subject: string;
  subjectSource: TableauDirectTrustSubjectSource;
  authConfigSource: TableauDirectTrustAuthSource;
  subjectHash?: string;
  authenticatedUserSubjectHash?: string;
  authenticatedUserEmailHash?: string;
  envDefaultSubjectHash?: string;
  envLegacySubjectHash?: string;
  mcpSubjectHash?: string;
  restSubjectHash?: string;
  subjectHashesMatch: boolean;
  subjectConfigured: boolean;
};

export type TableauDirectTrustJwtPreview = {
  iss: string;
  sub: string;
  aud: string;
  expRemainingSeconds: number;
  scp: string[];
};

let warnedSubjectEnvMismatch = false;

export function resetTableauDirectTrustAuthState(): void {
  warnedSubjectEnvMismatch = false;
}

export function resolveTableauDirectTrustAuthContext(
  input: {
    authenticatedUser?: AuthenticatedUser;
    subjectOverride?: string;
  } = {},
): TableauDirectTrustAuthContext {
  const config = getConfig();
  const authenticatedUserSubject =
    input.authenticatedUser?.tableauSubject?.trim() ?? "";
  const authenticatedUserEmail = input.authenticatedUser?.email?.trim() ?? "";
  const providedSubject = input.subjectOverride?.trim() ?? "";
  const envDefaultSubject = config.tableau.defaultSubject.trim();
  const envLegacySubject = process.env.TABLEAU_SUBJECT?.trim() ?? "";

  const subjectSource = authenticatedUserSubject
    ? "authenticated-user.tableauSubject"
    : authenticatedUserEmail
      ? "authenticated-user.email"
      : providedSubject
        ? "provided-subject"
        : envDefaultSubject
          ? "TABLEAU_DEFAULT_SUBJECT"
          : envLegacySubject
            ? "TABLEAU_SUBJECT"
            : "unconfigured";

  const authConfigSource: TableauDirectTrustAuthSource =
    subjectSource.startsWith("authenticated-user")
      ? "authenticated-user"
      : subjectSource === "provided-subject"
        ? "provided-subject"
        : subjectSource === "unconfigured"
          ? "unconfigured"
          : "environment";

  const subject =
    authenticatedUserSubject ||
    authenticatedUserEmail ||
    providedSubject ||
    envDefaultSubject ||
    envLegacySubject ||
    "";

  const subjectHash = safeHash(subject);
  const authenticatedUserSubjectHash = safeHash(authenticatedUserSubject);
  const authenticatedUserEmailHash = safeHash(authenticatedUserEmail);
  const envDefaultSubjectHash = safeHash(envDefaultSubject);
  const envLegacySubjectHash = safeHash(envLegacySubject);
  const configuredHashes = [
    authenticatedUserSubjectHash,
    authenticatedUserEmailHash,
    envDefaultSubjectHash,
    envLegacySubjectHash,
  ].filter((value): value is string => Boolean(value));

  const subjectHashesMatch =
    configuredHashes.length <= 1 || new Set(configuredHashes).size === 1;

  if (
    !warnedSubjectEnvMismatch &&
    envDefaultSubject &&
    envLegacySubject &&
    envDefaultSubject !== envLegacySubject
  ) {
    warnedSubjectEnvMismatch = true;
    logWarn("tableau.auth.subject.configuration_mismatch", {
      authConfigSource,
      subjectSource,
      subjectHash,
      envDefaultSubjectHash,
      envLegacySubjectHash,
      subjectHashesMatch: false,
      warning:
        "TABLEAU_DEFAULT_SUBJECT and TABLEAU_SUBJECT are both configured with different values. TABLEAU_DEFAULT_SUBJECT is treated as the canonical subject.",
    });
  }

  return {
    subject,
    subjectSource,
    authConfigSource,
    subjectHash,
    authenticatedUserSubjectHash,
    authenticatedUserEmailHash,
    envDefaultSubjectHash,
    envLegacySubjectHash,
    mcpSubjectHash: subjectHash,
    restSubjectHash: subjectHash,
    subjectHashesMatch,
    subjectConfigured: Boolean(subject),
  };
}

export function buildTableauDirectTrustAuthLog(input: {
  authContext: TableauDirectTrustAuthContext;
  connectedApp?: Pick<TableauConnectedAppSecrets, "clientId" | "secretId">;
  serverUrl?: string;
  siteContentUrl?: string;
  apiVersion?: string;
  jwtPayload?: TableauDirectTrustJwtPreview;
  mcpSubjectHash?: string;
  restSubjectHash?: string;
}): Record<string, unknown> {
  const subjectHash = input.authContext.subjectHash;
  const mcpSubjectHash =
    input.mcpSubjectHash ?? input.authContext.mcpSubjectHash;
  const restSubjectHash =
    input.restSubjectHash ?? input.authContext.restSubjectHash;
  const subjectHashesMatch =
    Boolean(mcpSubjectHash) &&
    Boolean(restSubjectHash) &&
    mcpSubjectHash === restSubjectHash;

  return {
    authConfigSource: input.authContext.authConfigSource,
    subjectHash,
    subjectSource: input.authContext.subjectSource,
    mcpSubjectHash,
    restSubjectHash,
    subjectHashesMatch,
    subjectConfigured: input.authContext.subjectConfigured,
    connectedAppClientIdHash: safeHash(input.connectedApp?.clientId),
    connectedAppSecretIdHash: safeHash(input.connectedApp?.secretId),
    siteContentUrlHash: safeHash(input.siteContentUrl?.trim()),
    serverHost: safeHost(input.serverUrl),
    apiVersion: input.apiVersion,
    jwtPayload: input.jwtPayload
      ? {
          issHash: safeHash(input.jwtPayload.iss),
          subHash: safeHash(input.jwtPayload.sub),
          aud: input.jwtPayload.aud,
          expRemainingSeconds: input.jwtPayload.expRemainingSeconds,
          scp: input.jwtPayload.scp,
        }
      : undefined,
  };
}

function safeHost(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}
