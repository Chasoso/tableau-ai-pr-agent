export type NotionConnectionStatus =
  | "connected"
  | "disconnected"
  | "refresh_failed";

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

export type NotionConnectionRecord = {
  userId: string;
  connectionId: string;
  notionWorkspaceId?: string;
  notionWorkspaceName?: string;
  notionBotId?: string;
  notionUserId?: string;
  accessTokenCiphertext: string;
  accessTokenIv: string;
  accessTokenAuthTag: string;
  refreshTokenCiphertext?: string;
  refreshTokenIv?: string;
  refreshTokenAuthTag?: string;
  oauthClientId?: string;
  oauthClientSecretCiphertext?: string;
  oauthClientSecretIv?: string;
  oauthClientSecretAuthTag?: string;
  oauthTokenEndpoint?: string;
  oauthAuthorizationEndpoint?: string;
  oauthTokenEndpointAuthMethod?:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
  oauthResource?: string;
  expiresAt?: number;
  scopes?: string[];
  targetParentPageId?: string;
  targetDatabaseId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  status: NotionConnectionStatus;
};

export type NotionOAuthStateRecord = {
  state: string;
  userId: string;
  codeVerifier: string;
  oauthClientId?: string;
  oauthClientSecretCiphertext?: string;
  oauthClientSecretIv?: string;
  oauthClientSecretAuthTag?: string;
  oauthTokenEndpoint?: string;
  oauthAuthorizationEndpoint?: string;
  oauthTokenEndpointAuthMethod?:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
  oauthResource?: string;
  redirectAfter?: string;
  createdAt: string;
  expiresAt: number;
};

export type NotionStatusResponse = {
  connected: boolean;
  workspaceName?: string;
  status?: NotionConnectionStatus;
  targetParentPageIdConfigured: boolean;
  targetDatabaseIdConfigured: boolean;
};

export type NotionDraftKind = "analysis_memo" | "post_idea";

export type NotionMetricSummary = {
  impressions?: number;
  engagementRate?: number;
  bookmarkRate?: number;
  profileVisitRate?: number;
};

export type NotionRankingItem = {
  label: string;
  value?: string | number | null;
};

export type CreateNotionPostIdeaRequest = {
  title: string;
  draftKind?: NotionDraftKind;
  reason: string;
  suggestedPostText: string;
  summary?: string;
  analysisBody?: string;
  datasourceName?: string;
  periodLabel?: string;
  rankingItems?: NotionRankingItem[];
  metricSummary?: NotionMetricSummary;
  referencePostUrl?: string;
  source?: string;
  tags?: string[];
};

export type NotionPostIdeaSaveResponse = {
  ok: true;
  pageUrl?: string;
  pageTitle: string;
  draftMarkdown?: string;
};
