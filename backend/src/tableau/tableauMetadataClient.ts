import type { TableauSession } from "./tableauRestClient";
import { TableauRequestError } from "./tableauErrors";

export type TableauMetadataClientOptions = {
  serverUrl: string;
};

export class TableauMetadataClient {
  private readonly serverUrl: string;

  constructor(options: TableauMetadataClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
  }

  async query<T = unknown>(
    session: TableauSession,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${this.serverUrl}/api/metadata/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Tableau-Auth": session.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new TableauRequestError(
        `Tableau Metadata API request failed with status ${response.status}.`,
        {
          operation: "metadata",
          status: response.status,
          path: "/api/metadata/graphql",
        },
      );
    }

    return response.json() as Promise<T>;
  }

  async getBasicWorkbookMetadata(
    session: TableauSession,
    workbookNameOrId: string,
  ): Promise<unknown> {
    const query = `
      query BasicWorkbookMetadata($name: String!) {
        workbooks(filter: { name: $name }) {
          id
          name
          dashboards {
            id
            name
            sheets {
              id
              name
            }
          }
        }
      }
    `;

    // TODO: Confirm whether the caller will pass workbook name, LUID, or GraphQL ID.
    return this.query(session, query, { name: workbookNameOrId });
  }

  async getBasicDashboardMetadata(
    session: TableauSession,
    dashboardName: string,
  ): Promise<unknown> {
    const query = `
      query BasicDashboardMetadata($name: String!) {
        dashboards(filter: { name: $name }) {
          id
          name
          workbook {
            id
            name
          }
          sheets {
            id
            name
          }
        }
      }
    `;

    // TODO: Confirm field availability across Tableau Cloud Metadata API versions.
    return this.query(session, query, { name: dashboardName });
  }
}
