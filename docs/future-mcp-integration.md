# Future Tableau MCP Integration / 将来の Tableau MCP 統合

## English

### Current Direction

The backend now has three `TableauContextProvider` implementations:

- `MockTableauContextProvider`
- `DirectTableauApiContextProvider`
- `TableauMcpContextProvider`

`ChatService` depends only on the provider interface, so it does not need to know whether Tableau context comes from REST API, Metadata API, MCP tools, or mock data.

### Lambda-local stdio MCP

The first MCP implementation uses stdio transport and launches `@tableau/mcp-server` inside the Lambda invocation. This avoids the baseline cost of always-on ECS or App Runner for a low-usage PoC.

Configuration:

- `TABLEAU_CONTEXT_PROVIDER=mcp`
- `TABLEAU_MCP_TRANSPORT=stdio`
- `TABLEAU_MCP_AUTH_MODE=direct-trust`
- `TABLEAU_MCP_TIMEOUT_MS=5000`
- `TABLEAU_MCP_ALLOWED_TOOLS`: optional comma-separated tool allowlist (if omitted, all tools returned by `listTools` are considered)
- `TABLEAU_MCP_MAX_TOOL_CALLS=3`
- `TABLEAU_MCP_TOOL_PLANNING_ENABLED=false`: set to `true` to let Bedrock plan MCP tool calls from the user's question.
- `TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS=600`
- `TABLEAU_MCP_INTENT_TOOL_FILTER_MODE=strict`: `soft` keeps tool freedom while providing intent tool preferences.
- `TABLEAU_MCP_INTENT_CLASSIFIER_MODE=heuristic`: `hybrid` allows Bedrock to revise intent in uncertain cases.
- `TABLEAU_MCP_ARG_SANITIZE_MODE=drop`: `mask` keeps argument structure and redacts sensitive values.
- `TABLEAU_MCP_ARG_MAX_DEPTH=5`
- `TABLEAU_MCP_ARG_MAX_ARRAY=50`
- `TABLEAU_MCP_ARG_MAX_OBJECT_KEYS=30`
- `TABLEAU_MCP_METADATA_CACHE_ENABLED=true`
- `TABLEAU_MCP_METADATA_CACHE_TTL_MS=30000`
- `TABLEAU_MCP_QUERY_MAX_LIMIT=50`
- `TABLEAU_MCP_QUERY_MAX_FIELDS=6`

If `TABLEAU_MCP_COMMAND` and `TABLEAU_MCP_ARGS` are omitted, the backend resolves the installed `@tableau/mcp-server` package and runs it with the Lambda Node.js runtime.

### Cost Considerations

For low traffic, Lambda-local stdio is usually cheaper than running ECS Fargate or App Runner continuously. The tradeoff is cold start and package size. If MCP startup becomes too slow or the deployment package becomes too large, consider:

- Lambda Layer for MCP runtime dependencies
- Lambda container image
- App Runner with scale-to-low settings
- ECS Fargate only when long-lived sessions or predictable warm capacity are required

### Authentication and Permission Boundary

The PoC passes the verified Cognito email as the Tableau subject for Connected Apps Direct Trust. The MCP child process receives:

- `SERVER`
- `SITE_NAME`
- `AUTH=direct-trust`
- `JWT_SUB_CLAIM`
- Connected App client ID, secret ID, and secret value

These values are backend-only and are not logged.

The goal is that MCP calls execute as the verified Tableau subject, not as a broad service account. Production must verify that the selected Tableau MCP server and Tableau Cloud configuration enforce the same per-user permissions as Tableau itself.

Avoid using a service-account PAT for all users in production. If a PAT is used temporarily, all returned Tableau context reflects the service account's permissions, not the user's permissions.

### Tool Selection

The provider supports an explicit `TABLEAU_MCP_ALLOWED_TOOLS` allowlist. This should be used in production. Without an allowlist, the PoC uses the live MCP tool catalog returned by `listTools` and still applies argument validation, preconditions, and query safety checks before execution.

### LLM-Planned Tool Execution (Limited Agent)

The next MCP step is now implemented behind `TABLEAU_MCP_TOOL_PLANNING_ENABLED=true`. In this mode, the backend asks Bedrock for a compact JSON plan such as `list-datasources`, `get-datasource-metadata`, or `query-datasource` before it executes MCP tools.

The planner operates with an explicit question intent classification:

- `dashboard_explanation`
- `filter_or_selection_state`
- `metadata_lookup`
- `data_analysis`
- `content_search`
- `how_to_use_tableau`
- `unsupported`

The plan is treated as untrusted input. The backend intersects requested tools with `TABLEAU_MCP_ALLOWED_TOOLS` (or the live MCP tool list when unset), validates required arguments, applies intent-specific max tool call limits, allows at most one replan for data-analysis flows, blocks unsafe `query-datasource` calls, and logs only sanitized diagnostics.

For observability, logs should distinguish allowlist source:
- `allowlistSource="configured"` when `TABLEAU_MCP_ALLOWED_TOOLS` is explicitly set
- `allowlistSource="dynamic_mcp"` when live MCP tool discovery is used

Observed tool outputs are recorded as MCP observations (`tool`, `purpose`, `argsSummary`, `success`, `resultSummary`, `errorMessage`) and are passed to final answer generation so the response can clearly state evidence scope and missing information.

Cost note: tool planning adds a Bedrock planning call, and data-oriented questions may use one follow-up planning pass after datasource metadata is observed. Keep planner responses short with `TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS`, use aggregate queries, and raise `TABLEAU_MCP_MAX_TOOL_CALLS` only when the question genuinely requires datasource metadata or query execution.

### Bedrock Prompt/Response Debug (PoC)

For PoC investigation, you can log Bedrock prompt/response previews to CloudWatch:

- `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE=true`
- `BEDROCK_DEBUG_MAX_CHARS=12000`

When enabled, the backend logs:

- `answer.bedrock.prompt_debug`
- `answer.bedrock.response_debug`
- `tableau.mcp.tool_planner.prompt_debug`
- `tableau.mcp.tool_planner.response_debug`

Keep this disabled in production because prompts may include user-entered text and dashboard context details.
If you also need chat input/output text, set `LOG_LEVEL=debug`. This enables `chat.message.input_debug` and `chat.message.output_debug` logs (truncated by `CHAT_DEBUG_MAX_CHARS`).

### Notion MCP PoC Extension

Phase 2 adds backend-managed Notion MCP integration:

- OAuth Authorization Code + PKCE with temporary `state` storage in DynamoDB (`NotionOAuthStates`).
- Encrypted Notion token storage in DynamoDB (`NotionConnections`) using AES-256-GCM.
- Encryption key from SSM SecureString to reduce fixed monthly cost versus Secrets Manager in this PoC.
- Tool allowlist by default: `notion-create-pages`, `notion-fetch`.
- Explicit user approval flow: chat creates preview first, then user presses save button to create Notion page.

TODO:

- Decide the exact MCP tools to allow for workbook, dashboard, datasource, and metadata lookup.
- Add screenshot capture and multimodal prompt construction.
- Add per-tool audit logging without logging credentials or data payloads.
- Evaluate package size and cold start after MCP dependencies are included.

## 日本語

### 現在の方針

バックエンドには以下の `TableauContextProvider` があります。

- `MockTableauContextProvider`
- `DirectTableauApiContextProvider`
- `TableauMcpContextProvider`

`ChatService` はこのインターフェースだけに依存します。そのため、Tableau 情報の取得元が REST API、Metadata API、MCP、mock のどれであっても、チャット処理側の構造は変えません。

### Lambda 内 stdio MCP

最初の MCP 実装では、Lambda の実行中に `@tableau/mcp-server` を stdio transport で子プロセス起動します。利用頻度が低いPoCでは、常時起動の ECS Fargate や App Runner よりコストを抑えやすい構成です。

主な設定:

- `TABLEAU_CONTEXT_PROVIDER=mcp`
- `TABLEAU_MCP_TRANSPORT=stdio`
- `TABLEAU_MCP_AUTH_MODE=direct-trust`
- `TABLEAU_MCP_TIMEOUT_MS=5000`
- `TABLEAU_MCP_ALLOWED_TOOLS`: 呼び出しを許可する tool 名のカンマ区切り
- `TABLEAU_MCP_MAX_TOOL_CALLS=3`
- `TABLEAU_MCP_TOOL_PLANNING_ENABLED=false`: `true` にすると、Bedrock がユーザー質問から MCP tool 実行計画を作ります。
- `TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS=600`
- `TABLEAU_MCP_INTENT_TOOL_FILTER_MODE=strict`: `soft` にすると allowlist は維持したまま、intent による強制絞り込みを緩和します。
- `TABLEAU_MCP_INTENT_CLASSIFIER_MODE=heuristic`: `hybrid` にすると、分類が不確実な場合に Bedrock planner 側で intent 補正を許可します。
- `TABLEAU_MCP_ARG_SANITIZE_MODE=drop`: `mask` は機密キー値を伏字化しつつ引数構造を維持します。
- `TABLEAU_MCP_ARG_MAX_DEPTH=5`
- `TABLEAU_MCP_ARG_MAX_ARRAY=50`
- `TABLEAU_MCP_ARG_MAX_OBJECT_KEYS=30`

`TABLEAU_MCP_COMMAND` と `TABLEAU_MCP_ARGS` を省略した場合は、Lambda に同梱された `@tableau/mcp-server` を Node.js ランタイムで起動します。

### コスト観点

低頻度利用では、Lambda 内 stdio MCP がもっとも安価になりやすいです。一方で、コールドスタートとパッケージサイズが課題になります。問題が出た場合は以下を検討します。

- MCP 依存を Lambda Layer に分離する
- Lambda コンテナイメージにする
- App Runner の低スケール構成を使う
- 長時間セッションや常時ウォームが必要な場合のみ ECS Fargate を使う

### 認証と権限境界

PoCでは、検証済み Cognito email を Tableau subject として Connected Apps Direct Trust に使います。MCP 子プロセスには以下を渡します。

- `SERVER`
- `SITE_NAME`
- `AUTH=direct-trust`
- `JWT_SUB_CLAIM`
- Connected App client ID、secret ID、secret value

これらはバックエンド内だけで扱い、ログには出しません。

目標は、MCP呼び出しが広い権限のサービスアカウントではなく、検証済み Tableau subject の権限で実行されることです。本番では、選択した Tableau MCP サーバーと Tableau Cloud 設定がユーザーごとの Tableau 権限を正しく反映することを検証してください。

サービスアカウント PAT ですべてのユーザーの MCP 呼び出しを代行する方式は、本番では避けます。その場合、取得結果はユーザー本人ではなくサービスアカウントの権限になります。

### Tool 選択

本番では `TABLEAU_MCP_ALLOWED_TOOLS` で明示的に tool を allowlist 化してください。未指定時のPoC実装では、メタデータ系と推測できる tool を少数だけ試し、必要引数を安全に推測できない tool はスキップします。

### LLM による Tool 実行計画

`TABLEAU_MCP_TOOL_PLANNING_ENABLED=true` の場合、バックエンドは Bedrock に MCP tool の実行計画 JSON を作らせます。たとえば、質問がデータ値・ランキング・月次推移に関する場合は `list-datasources`、`get-datasource-metadata`、`query-datasource` などが候補になります。

LLMの計画は信用しすぎず、バックエンド側で allowlist、必須引数、`query-datasource` の集計・limit 条件を検証します。コスト面では、初回 planning に加えて、データ系質問では datasource metadata 取得後に最大1回だけ再計画する場合があります。planner の token 上限を小さくし、必要な場合だけ `TABLEAU_MCP_MAX_TOOL_CALLS` を `5` から `8` 程度に増やしてください。

### Bedrock プロンプト/レスポンスのDebug出力（PoC向け）

PoCで挙動を検証する場合は、以下を有効にすると CloudWatch に Bedrock 入出力プレビューを出せます。

- `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE=true`
- `BEDROCK_DEBUG_MAX_CHARS=12000`

主なログイベント:

- `answer.bedrock.prompt_debug`
- `answer.bedrock.response_debug`
- `tableau.mcp.tool_planner.prompt_debug`
- `tableau.mcp.tool_planner.response_debug`

この設定は本番では無効化してください。プロンプトにはユーザー入力やダッシュボード文脈が含まれる可能性があります。
チャットの質問文/回答文も確認したい場合は `LOG_LEVEL=debug` を使います（`chat.message.input_debug`, `chat.message.output_debug`。`CHAT_DEBUG_MAX_CHARS` で切り詰め）。

TODO:

- workbook、dashboard、datasource、metadata 取得に使う正式な MCP tool を決める
- スクリーンショット取得とマルチモーダルプロンプトを追加する
- credential や data payload を出さない範囲で tool 実行監査ログを追加する
- MCP 依存を含めた Lambda サイズとコールドスタートを評価する
