export type AppConfig = {
  chatHistoryTableName?: string;
  chatJobsTableName?: string;
  useInMemoryRepository: boolean;
  chatMemoryMessageLimit: number;
  corsAllowedOrigin: string;
  chatJob: {
    ttlSeconds: number;
    leaseSeconds: number;
    progressMessageLimit: number;
    workerFunctionName: string;
    ownerTokenHeaderName: string;
  };
  slack: {
    incomingWebhookUrl: string;
  };
  s3: {
    actionImageBucketName: string;
    actionImagePublicBaseUrl: string;
    actionImageObjectKeyPrefix: string;
  };
  agent: {
    enabled: boolean;
    maxContextPasses: number;
    planMaxOutputTokens: number;
    evaluationMaxOutputTokens: number;
    debugLogPromptExchange: boolean;
    debugMaxChars: number;
  };
  model: {
    provider: "mock" | "bedrock";
    bedrock: {
      region: string;
      modelId: string;
      maxOutputTokens: number;
      temperature: number;
      debugLogPromptExchange: boolean;
      debugMaxChars: number;
    };
  };
  auth: {
    required: boolean;
    cognitoUserPoolId: string;
    cognitoClientId: string;
    cognitoRegion: string;
    cognitoDomain: string;
    popup: {
      redirectUri: string;
      transactionsTableName?: string;
      transactionKeyParam?: string;
      transactionTtlSeconds: number;
    };
  };
  tableau: {
    serverUrl: string;
    siteContentUrl: string;
    apiVersion: string;
    authMode: "connected-app";
    defaultSubject: string;
    scopes: string[];
    contextProvider: "mock" | "direct-api" | "mcp";
    mcp: {
      serverUrl: string;
      transport: string;
      authMode: string;
      timeoutMs: number;
      command: string;
      args: string[];
      allowedTools: string[];
      maxToolCalls: number;
      debugLogResults: boolean;
      toolPlanningEnabled: boolean;
      plannerMaxOutputTokens: number;
      intentToolFilterMode: "strict" | "soft" | "off";
      intentClassifierMode: "heuristic" | "hybrid";
      argSanitizeMode: "drop" | "mask";
      argMaxDepth: number;
      argMaxArrayLength: number;
      argMaxObjectKeys: number;
      metadataCacheEnabled: boolean;
      metadataCacheTtlMs: number;
      metadataCacheTableName?: string;
      queryDatasourceMaxLimit: number;
      queryDatasourceMaxFields: number;
    };
  };
  notion: {
    enabled: boolean;
    mcpUrl: string;
    redirectUri: string;
    connectionsTableName?: string;
    oauthStatesTableName?: string;
    tokenEncryptionKeyParam?: string;
    allowedTools: string[];
    defaultTargetParentPageId?: string;
    defaultTargetDatabaseId?: string;
    localDevUserId: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthAuthorizeUrl: string;
    oauthTokenUrl: string;
    oauthStateTtlSeconds: number;
  };
};

export function getConfig(): AppConfig {
  const notionAllowedTools = parseCsv(process.env.NOTION_MCP_ALLOWED_TOOLS);
  return {
    chatHistoryTableName: process.env.CHAT_HISTORY_TABLE_NAME,
    chatJobsTableName: process.env.CHAT_JOBS_TABLE_NAME,
    useInMemoryRepository: process.env.USE_IN_MEMORY_REPOSITORY !== "false",
    chatMemoryMessageLimit: Number(process.env.CHAT_MEMORY_MESSAGE_LIMIT ?? 10),
    corsAllowedOrigin: process.env.CORS_ALLOWED_ORIGIN ?? "*",
    chatJob: {
      ttlSeconds: parsePositiveInt(
        process.env.CHAT_JOB_TTL_SECONDS,
        60 * 60 * 24,
      ),
      leaseSeconds: parsePositiveInt(process.env.CHAT_JOB_LEASE_SECONDS, 120),
      progressMessageLimit: parsePositiveInt(
        process.env.CHAT_JOB_PROGRESS_MESSAGE_LIMIT,
        12,
      ),
      workerFunctionName: process.env.CHAT_JOB_WORKER_FUNCTION_NAME ?? "",
      ownerTokenHeaderName:
        process.env.CHAT_JOB_OWNER_TOKEN_HEADER_NAME ?? "x-chat-owner-token",
    },
    slack: {
      incomingWebhookUrl: process.env.SLACK_INCOMING_WEBHOOK_URL ?? "",
    },
    s3: {
      actionImageBucketName: process.env.PR_ACTION_IMAGE_BUCKET_NAME ?? "",
      actionImagePublicBaseUrl:
        process.env.PR_ACTION_IMAGE_PUBLIC_BASE_URL ?? "",
      actionImageObjectKeyPrefix:
        process.env.PR_ACTION_IMAGE_OBJECT_KEY_PREFIX ?? "action-runs",
    },
    agent: {
      enabled: process.env.CHAT_AGENT_ENABLED !== "false",
      maxContextPasses: parsePositiveInt(
        process.env.CHAT_AGENT_MAX_CONTEXT_PASSES,
        2,
      ),
      planMaxOutputTokens: parsePositiveInt(
        process.env.CHAT_AGENT_PLAN_MAX_OUTPUT_TOKENS,
        400,
      ),
      evaluationMaxOutputTokens: parsePositiveInt(
        process.env.CHAT_AGENT_EVAL_MAX_OUTPUT_TOKENS,
        300,
      ),
      debugLogPromptExchange:
        process.env.CHAT_AGENT_DEBUG_LOG_PROMPT_EXCHANGE === "true",
      debugMaxChars: parsePositiveInt(
        process.env.CHAT_AGENT_DEBUG_MAX_CHARS,
        8000,
      ),
    },
    model: {
      provider: parseModelProvider(process.env.MODEL_PROVIDER),
      bedrock: {
        region: process.env.BEDROCK_REGION ?? "us-east-1",
        modelId: process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-2-lite-v1:0",
        maxOutputTokens: Number(process.env.BEDROCK_MAX_OUTPUT_TOKENS ?? 2400),
        temperature: Number(process.env.BEDROCK_TEMPERATURE ?? 0.2),
        debugLogPromptExchange:
          process.env.BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE === "true",
        debugMaxChars: parsePositiveInt(
          process.env.BEDROCK_DEBUG_MAX_CHARS,
          12000,
        ),
      },
    },
    auth: {
      required: process.env.AUTH_REQUIRED === "true",
      cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
      cognitoClientId: process.env.COGNITO_CLIENT_ID ?? "",
      cognitoRegion: process.env.COGNITO_REGION ?? "",
      cognitoDomain: process.env.COGNITO_DOMAIN ?? "",
      popup: {
        redirectUri: process.env.COGNITO_POPUP_REDIRECT_URI ?? "",
        transactionsTableName: process.env.COGNITO_AUTH_TRANSACTIONS_TABLE,
        transactionKeyParam: process.env.COGNITO_AUTH_TRANSACTION_KEY_PARAM,
        transactionTtlSeconds: parsePositiveInt(
          process.env.COGNITO_AUTH_TRANSACTION_TTL_SECONDS,
          600,
        ),
      },
    },
    tableau: {
      serverUrl: process.env.TABLEAU_SERVER_URL ?? "",
      siteContentUrl: process.env.TABLEAU_SITE_CONTENT_URL ?? "",
      apiVersion: process.env.TABLEAU_API_VERSION ?? "3.25",
      authMode: "connected-app",
      defaultSubject: process.env.TABLEAU_DEFAULT_SUBJECT ?? "",
      scopes: parseScopes(process.env.TABLEAU_SCOPES),
      contextProvider: parseContextProvider(
        process.env.TABLEAU_CONTEXT_PROVIDER,
      ),
      mcp: {
        serverUrl: process.env.TABLEAU_MCP_SERVER_URL ?? "",
        transport: process.env.TABLEAU_MCP_TRANSPORT ?? "stdio",
        authMode: process.env.TABLEAU_MCP_AUTH_MODE ?? "direct-trust",
        timeoutMs: Number(process.env.TABLEAU_MCP_TIMEOUT_MS ?? 5000),
        command: process.env.TABLEAU_MCP_COMMAND ?? "",
        args: parseCsv(process.env.TABLEAU_MCP_ARGS),
        allowedTools: parseCsv(process.env.TABLEAU_MCP_ALLOWED_TOOLS),
        maxToolCalls: Number(process.env.TABLEAU_MCP_MAX_TOOL_CALLS ?? 3),
        debugLogResults: process.env.TABLEAU_MCP_DEBUG_LOG_RESULTS === "true",
        toolPlanningEnabled:
          process.env.TABLEAU_MCP_TOOL_PLANNING_ENABLED === "true",
        plannerMaxOutputTokens: Number(
          process.env.TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS ?? 600,
        ),
        intentToolFilterMode: parseIntentToolFilterMode(
          process.env.TABLEAU_MCP_INTENT_TOOL_FILTER_MODE,
        ),
        intentClassifierMode: parseIntentClassifierMode(
          process.env.TABLEAU_MCP_INTENT_CLASSIFIER_MODE,
        ),
        argSanitizeMode: parseArgSanitizeMode(
          process.env.TABLEAU_MCP_ARG_SANITIZE_MODE,
        ),
        argMaxDepth: parsePositiveInt(process.env.TABLEAU_MCP_ARG_MAX_DEPTH, 5),
        argMaxArrayLength: parsePositiveInt(
          process.env.TABLEAU_MCP_ARG_MAX_ARRAY,
          50,
        ),
        argMaxObjectKeys: parsePositiveInt(
          process.env.TABLEAU_MCP_ARG_MAX_OBJECT_KEYS,
          30,
        ),
        metadataCacheEnabled:
          process.env.TABLEAU_MCP_METADATA_CACHE_ENABLED !== "false",
        metadataCacheTtlMs: Number(
          process.env.TABLEAU_MCP_METADATA_CACHE_TTL_MS ?? 30000,
        ),
        metadataCacheTableName:
          process.env.TABLEAU_MCP_METADATA_CACHE_TABLE_NAME,
        queryDatasourceMaxLimit: Number(
          process.env.TABLEAU_MCP_QUERY_MAX_LIMIT ?? 50,
        ),
        queryDatasourceMaxFields: Number(
          process.env.TABLEAU_MCP_QUERY_MAX_FIELDS ?? 6,
        ),
      },
    },
    notion: {
      enabled: process.env.NOTION_MCP_ENABLED === "true",
      mcpUrl: process.env.NOTION_MCP_URL ?? "https://mcp.notion.com/mcp",
      redirectUri: process.env.NOTION_REDIRECT_URI ?? "",
      connectionsTableName: process.env.NOTION_CONNECTIONS_TABLE,
      oauthStatesTableName: process.env.NOTION_OAUTH_STATES_TABLE,
      tokenEncryptionKeyParam: process.env.NOTION_TOKEN_ENCRYPTION_KEY_PARAM,
      allowedTools: notionAllowedTools.length
        ? notionAllowedTools
        : ["notion-create-pages", "notion-fetch"],
      defaultTargetParentPageId:
        process.env.NOTION_DEFAULT_TARGET_PARENT_PAGE_ID,
      defaultTargetDatabaseId: process.env.NOTION_DEFAULT_TARGET_DATABASE_ID,
      localDevUserId: process.env.NOTION_LOCAL_DEV_USER_ID || "local-dev-user",
      oauthClientId: process.env.NOTION_OAUTH_CLIENT_ID,
      oauthClientSecret: process.env.NOTION_OAUTH_CLIENT_SECRET,
      oauthAuthorizeUrl:
        process.env.NOTION_OAUTH_AUTHORIZE_URL ??
        "https://api.notion.com/v1/oauth/authorize",
      oauthTokenUrl:
        process.env.NOTION_OAUTH_TOKEN_URL ??
        "https://api.notion.com/v1/oauth/token",
      oauthStateTtlSeconds: parsePositiveInt(
        process.env.NOTION_OAUTH_STATE_TTL_SECONDS,
        600,
      ),
    },
  };
}

function parseModelProvider(
  value: string | undefined,
): AppConfig["model"]["provider"] {
  if (value === "bedrock") {
    return "bedrock";
  }

  return "mock";
}

function parseScopes(value: string | undefined): string[] {
  if (!value) {
    return ["tableau:content:read"];
  }

  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseContextProvider(
  value: string | undefined,
): AppConfig["tableau"]["contextProvider"] {
  if (value === "direct-api" || value === "direct") {
    return "direct-api";
  }

  if (value === "mcp") {
    return "mcp";
  }

  return "mock";
}

function parseIntentToolFilterMode(
  value: string | undefined,
): AppConfig["tableau"]["mcp"]["intentToolFilterMode"] {
  if (value === "soft" || value === "off") {
    return value;
  }

  return "strict";
}

function parseIntentClassifierMode(
  value: string | undefined,
): AppConfig["tableau"]["mcp"]["intentClassifierMode"] {
  if (value === "hybrid") {
    return value;
  }

  return "heuristic";
}

function parseArgSanitizeMode(
  value: string | undefined,
): AppConfig["tableau"]["mcp"]["argSanitizeMode"] {
  if (value === "mask") {
    return value;
  }

  return "drop";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.floor(parsed);
}
