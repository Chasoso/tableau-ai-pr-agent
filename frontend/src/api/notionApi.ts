import { env } from "../env";

export type NotionStatusResponse = {
  connected: boolean;
  workspaceName?: string;
  status?: "connected" | "disconnected" | "refresh_failed";
  targetParentPageIdConfigured: boolean;
  targetDatabaseIdConfigured: boolean;
};

export type NotionPostIdeaDraft = {
  title: string;
  draftKind?: "analysis_memo" | "post_idea";
  reason: string;
  suggestedPostText: string;
  summary?: string;
  analysisBody?: string;
  datasourceName?: string;
  periodLabel?: string;
  rankingItems?: Array<{
    label: string;
    value?: string | number | null;
  }>;
  metricSummary?: {
    impressions?: number;
    engagementRate?: number;
    bookmarkRate?: number;
    profileVisitRate?: number;
  };
  referencePostUrl?: string;
  source?: string;
  tags?: string[];
};

export async function getNotionStatus(
  accessToken?: string,
): Promise<NotionStatusResponse> {
  const response = await fetch(
    `${env.apiBaseUrl.replace(/\/$/, "")}/notion/status`,
    {
      method: "GET",
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    },
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response.json() as Promise<NotionStatusResponse>;
}

export async function startNotionConnect(
  input: { redirectAfter?: string },
  accessToken?: string,
): Promise<string> {
  const response = await fetch(
    `${env.apiBaseUrl.replace(/\/$/, "")}/notion/connect`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  const data = (await response.json()) as { authorizationUrl: string };
  return data.authorizationUrl;
}

export async function disconnectNotion(accessToken?: string): Promise<void> {
  const response = await fetch(
    `${env.apiBaseUrl.replace(/\/$/, "")}/notion/disconnect`,
    {
      method: "POST",
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    },
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
}

export async function savePostIdeaToNotion(
  draft: NotionPostIdeaDraft,
  accessToken?: string,
): Promise<{ pageUrl?: string }> {
  const response = await fetch(
    `${env.apiBaseUrl.replace(/\/$/, "")}/notion/create-post-idea`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(draft),
    },
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response.json() as Promise<{ pageUrl?: string }>;
}

async function toApiError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({
    message: `Request failed with status ${response.status}`,
  }))) as { message?: string };
  return new Error(
    body.message ?? `Request failed with status ${response.status}`,
  );
}
