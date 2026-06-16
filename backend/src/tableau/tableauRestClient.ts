import { getConfig } from "../config";
import { getTableauConnectedAppSecrets } from "../aws/secrets";
import { logInfo, logWarn } from "../logging";
import { buildTableauConnectedAppJwt } from "./tableauAuth";
import {
  buildTableauDirectTrustAuthLog,
  resolveTableauDirectTrustAuthContext,
  type TableauDirectTrustAuthContext,
} from "./tableauDirectTrustAuth";
import { TableauRequestError } from "./tableauErrors";

export type TableauSession = {
  token: string;
  siteId: string;
  userId: string;
};

export type TableauRestClientOptions = {
  serverUrl?: string;
  siteContentUrl?: string;
  apiVersion?: string;
  subject?: string;
  scopes?: string[];
  authContext?: TableauDirectTrustAuthContext;
};

export class TableauRestClient {
  private readonly serverUrl: string;
  private readonly siteContentUrl: string;
  private readonly apiVersion: string;
  private readonly subject: string;
  private readonly scopes: string[];
  private readonly authContext: TableauDirectTrustAuthContext;

  constructor(options: TableauRestClientOptions = {}) {
    const config = getConfig();
    this.serverUrl = trimTrailingSlash(
      options.serverUrl ?? config.tableau.serverUrl,
    );
    this.siteContentUrl =
      options.siteContentUrl ?? config.tableau.siteContentUrl;
    this.apiVersion = options.apiVersion ?? config.tableau.apiVersion;
    this.authContext =
      options.authContext ??
      resolveTableauDirectTrustAuthContext({
        subjectOverride: options.subject,
      });
    this.subject = options.subject ?? this.authContext.subject;
    this.scopes = options.scopes ?? config.tableau.scopes;
  }

  async signInWithJwt(): Promise<TableauSession> {
    if (!this.serverUrl || !this.subject) {
      throw new Error("Tableau server URL and subject must be configured.");
    }

    const connectedApp = await getTableauConnectedAppSecrets();
    const jwt = buildTableauConnectedAppJwt({
      connectedApp,
      subject: this.subject,
      scopes: this.scopes,
    });
    logInfo(
      "tableau.rest.sign_in.configuration",
      buildTableauDirectTrustAuthLog({
        authContext: this.authContext,
        connectedApp,
        serverUrl: this.serverUrl,
        siteContentUrl: this.siteContentUrl,
        apiVersion: this.apiVersion,
        jwtPayload: jwt.payload,
      }),
    );
    const token = jwt.token;

    const response = await fetch(
      `${this.serverUrl}/api/${this.apiVersion}/auth/signin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          credentials: {
            jwt: token,
            site: {
              contentUrl: this.siteContentUrl,
            },
          },
        }),
      },
    );

    if (!response.ok) {
      const tableauError = await readTableauError(response);
      logWarn("tableau.rest.sign_in.failed", {
        status: response.status,
        tableauErrorCode: tableauError.tableauErrorCode,
        tableauErrorSummary: tableauError.tableauErrorSummary,
        tableauErrorDetail: tableauError.tableauErrorDetail,
        hints: buildSigninFailureHints({
          status: response.status,
          tableauErrorCode: tableauError.tableauErrorCode,
        }),
      });
      throw new TableauRequestError(
        `Tableau sign in failed with status ${response.status}.`,
        {
          operation: "signin",
          status: response.status,
          path: `/api/${this.apiVersion}/auth/signin`,
          ...tableauError,
        },
      );
    }

    const body = (await response.json()) as {
      credentials?: {
        token?: string;
        site?: { id?: string };
        user?: { id?: string };
      };
    };

    const credentials = body.credentials;
    if (!credentials?.token || !credentials.site?.id || !credentials.user?.id) {
      throw new Error(
        "Tableau sign in response did not include required credentials.",
      );
    }

    return {
      token: credentials.token,
      siteId: credentials.site.id,
      userId: credentials.user.id,
    };
  }

  async signOut(session: TableauSession): Promise<void> {
    await this.makeAuthenticatedRequest(session, `/auth/signout`, {
      method: "POST",
    });
  }

  async getWorkbook(
    session: TableauSession,
    workbookId: string,
  ): Promise<unknown> {
    return this.makeAuthenticatedRequest(
      session,
      `/sites/${session.siteId}/workbooks/${workbookId}`,
    );
  }

  async getWorkbookConnections(
    session: TableauSession,
    workbookId: string,
  ): Promise<unknown> {
    return this.makeAuthenticatedRequest(
      session,
      `/sites/${session.siteId}/workbooks/${workbookId}/connections`,
    );
  }

  async listDatasources(session: TableauSession): Promise<unknown> {
    return this.makeAuthenticatedRequest(
      session,
      `/sites/${session.siteId}/datasources`,
    );
  }

  async makeAuthenticatedRequest<T = unknown>(
    session: TableauSession,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(
      `${this.serverUrl}/api/${this.apiVersion}${path}`,
      {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers ?? {}),
          "X-Tableau-Auth": session.token,
        },
      },
    );

    if (!response.ok) {
      const tableauError = await readTableauError(response);
      throw new TableauRequestError(
        `Tableau REST API request failed with status ${response.status}.`,
        {
          operation: "rest",
          status: response.status,
          path,
          ...tableauError,
        },
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

async function readTableauError(response: Response): Promise<{
  tableauErrorCode?: string;
  tableauErrorSummary?: string;
  tableauErrorDetail?: string;
}> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    const body = (await response.clone().json()) as {
      error?: {
        code?: string;
        summary?: string;
        detail?: string;
      };
    };

    return {
      tableauErrorCode: body.error?.code,
      tableauErrorSummary: body.error?.summary,
      tableauErrorDetail: body.error?.detail,
    };
  } catch {
    return {};
  }
}

function buildSigninFailureHints(input: {
  status: number;
  tableauErrorCode?: string;
}): string[] {
  if (input.status !== 401 && input.tableauErrorCode !== "401001") {
    return [];
  }

  return [
    "Confirm the subject matches the Tableau Cloud user name for the target site.",
    "Confirm the subject user belongs to the target Tableau site.",
    "Confirm the Connected App clientId / secretId / secretValue combination is correct.",
    "Confirm Direct Trust is enabled on the Connected App.",
    "Confirm the MCP stdio subject and REST sign-in subject are identical.",
  ];
}
