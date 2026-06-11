import { getConfig } from "../config";
import {
  logError,
  logInfo,
  logWarn,
  safeErrorDetails,
  safeHash,
} from "../logging";
import type { TableauAdditionalContext } from "../types/tableau";
import type {
  GetAdditionalContextInput,
  TableauContextProvider,
} from "./contextProvider";
import { TableauMetadataClient } from "./tableauMetadataClient";
import { TableauRestClient, type TableauSession } from "./tableauRestClient";

export class DirectTableauApiContextProvider implements TableauContextProvider {
  readonly name = "direct-api" as const;

  constructor(
    private readonly restClient = new TableauRestClient(),
    private readonly metadataClient = new TableauMetadataClient({
      serverUrl: getConfig().tableau.serverUrl,
    }),
  ) {}

  async getAdditionalContext(
    input: GetAdditionalContextInput,
  ): Promise<TableauAdditionalContext> {
    const warnings: string[] = [];
    let session: TableauSession | undefined;
    const restClient = input.tableauSubject
      ? new TableauRestClient({ subject: input.tableauSubject })
      : this.restClient;

    try {
      logInfo("tableau.direct.sign_in.started", {
        tableauSubjectHash: safeHash(input.tableauSubject),
        dashboardName: input.dashboardContext.dashboardName,
        workbookName: input.dashboardContext.workbookName ?? undefined,
      });
      session = await restClient.signInWithJwt();
      logInfo("tableau.direct.sign_in.completed", {
        tableauSubjectHash: safeHash(input.tableauSubject),
        siteIdHash: safeHash(session.siteId),
        userIdHash: safeHash(session.userId),
      });
      const [datasourcesResult, metadataResult] = await Promise.allSettled([
        restClient.listDatasources(session),
        input.dashboardContext.workbookName
          ? this.metadataClient.getBasicWorkbookMetadata(
              session,
              input.dashboardContext.workbookName,
            )
          : this.metadataClient.getBasicDashboardMetadata(
              session,
              input.dashboardContext.dashboardName,
            ),
      ]);

      if (datasourcesResult.status === "rejected") {
        warnings.push("Datasource lookup failed.");
        logWarn(
          "tableau.direct.datasources.failed",
          safeErrorDetails(datasourcesResult.reason),
        );
      } else {
        logInfo("tableau.direct.datasources.completed", {
          resultType: typeof datasourcesResult.value,
        });
      }

      if (metadataResult.status === "rejected") {
        warnings.push("Metadata lookup failed.");
        logWarn(
          "tableau.direct.metadata.failed",
          safeErrorDetails(metadataResult.reason),
        );
      } else {
        logInfo("tableau.direct.metadata.completed", {
          hasMetadata: Boolean(metadataResult.value),
        });
      }

      return {
        provider: this.name,
        workbook:
          metadataResult.status === "fulfilled"
            ? extractWorkbookFromMetadata(metadataResult.value)
            : undefined,
        datasources:
          datasourcesResult.status === "fulfilled"
            ? [datasourcesResult.value]
            : [],
        metadata:
          metadataResult.status === "fulfilled" ? metadataResult.value : null,
        warnings,
      };
    } catch (error) {
      logError("tableau.direct.lookup.failed", safeErrorDetails(error));
      return {
        provider: this.name,
        warnings: [buildSafeLookupWarning(error)],
      };
    } finally {
      if (session) {
        await restClient
          .signOut(session)
          .then(() => {
            logInfo("tableau.direct.sign_out.completed", {
              siteIdHash: safeHash(session?.siteId),
              userIdHash: safeHash(session?.userId),
            });
          })
          .catch((error) => {
            logWarn("tableau.direct.sign_out.failed", safeErrorDetails(error));
          });
      }
    }
  }
}

function extractWorkbookFromMetadata(value: unknown): unknown {
  const dashboards = findArraysByKey(value, "dashboards").flat();
  for (const dashboard of dashboards) {
    if (!dashboard || typeof dashboard !== "object") {
      continue;
    }

    const workbook = (dashboard as Record<string, unknown>).workbook;
    if (workbook && typeof workbook === "object") {
      return workbook;
    }
  }

  const workbooks = findArraysByKey(value, "workbooks").flat();
  return workbooks.find((workbook) => workbook && typeof workbook === "object");
}

function findArraysByKey(value: unknown, key: string): unknown[][] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => findArraysByKey(item, key));
  }

  const record = value as Record<string, unknown>;
  const direct = Array.isArray(record[key]) ? [record[key] as unknown[]] : [];
  return [
    ...direct,
    ...Object.values(record).flatMap((item) => findArraysByKey(item, key)),
  ];
}

function buildSafeLookupWarning(error: unknown): string {
  const details =
    error instanceof Error &&
    "details" in error &&
    typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : undefined;
  const status =
    typeof details?.status === "number"
      ? `status ${details.status}`
      : undefined;
  const tableauCode =
    typeof details?.tableauErrorCode === "string"
      ? `Tableau error ${details.tableauErrorCode}`
      : undefined;
  const tableauSummary =
    typeof details?.tableauErrorSummary === "string"
      ? `summary: ${details.tableauErrorSummary}`
      : undefined;
  const reason = [status, tableauCode, tableauSummary]
    .filter(Boolean)
    .join(", ");

  return reason
    ? `Direct Tableau API context lookup failed (${reason}). Falling back to frontend dashboard context only.`
    : "Direct Tableau API context lookup failed. Falling back to frontend dashboard context only.";
}
