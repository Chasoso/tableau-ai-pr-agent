# 設定

このドキュメントは、現在の実装で参照されている環境変数をまとめたものです。  
ローカル、AWS 本番、デモの差分もここで整理します。

## フロントエンドの環境変数

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | API のベース URL |
| `VITE_PR_ACTION_IMAGE_PUBLIC_BASE_URL` | `""` | 投稿画像の公開ベース URL |
| `VITE_PR_ACTION_IMAGE_OBJECT_KEY_PREFIX` | `action-runs` | 画像オブジェクトキーの接頭辞 |
| `VITE_USE_MOCK_TABLEAU` | `false` | Tableau 拡張をモックで起動するか |
| `VITE_AUTH_REQUIRED` | `false` | Cognito 認証を有効にするか |
| `VITE_COGNITO_USER_POOL_ID` | `""` | Cognito User Pool ID |
| `VITE_COGNITO_CLIENT_ID` | `""` | Cognito App Client ID |
| `VITE_COGNITO_REGION` | `""` | Cognito Region |
| `VITE_COGNITO_DOMAIN` | `""` | Cognito Hosted UI Domain |
| `VITE_COGNITO_REDIRECT_URI` | `""` | フルページ認証の戻り先 |
| `VITE_COGNITO_LOGOUT_URI` | `""` | ログアウト後の戻り先 |

## バックエンド共通

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `PORT` | `3001` | `backend/src/localServer.ts` の待受ポート |
| `DEMO_MODE` | `false` | デモ用の挙動切り替え |
| `USE_IN_MEMORY_REPOSITORY` | `true` | ローカル向けのメモリ実装を使うか |
| `CORS_ALLOWED_ORIGIN` | `*` | API の CORS 許可オリジン |
| `LOG_LEVEL` | `info` | ログレベル |
| `CHAT_HISTORY_TABLE_NAME` | なし | チャット履歴 DynamoDB テーブル名 |
| `CHAT_JOBS_TABLE_NAME` | なし | chat job / action run で共有する DynamoDB テーブル名 |
| `CHAT_MEMORY_MESSAGE_LIMIT` | `10` | 保持する会話メッセージ数 |
| `CHAT_JOB_TTL_SECONDS` | `86400` | chat job の TTL |
| `CHAT_JOB_LEASE_SECONDS` | `120` | chat job の lease 秒数 |
| `CHAT_JOB_PROGRESS_MESSAGE_LIMIT` | `12` | progress message の保持数 |
| `CHAT_JOB_WORKER_FUNCTION_NAME` | `""` | async worker Lambda 名 |
| `CHAT_JOB_OWNER_TOKEN_HEADER_NAME` | `x-chat-owner-token` | 匿名閲覧用 owner token ヘッダ |
| `ACTION_RUN_TTL_SECONDS` | `CHAT_JOB_TTL_SECONDS` の fallback | action run の TTL |
| `ACTION_RUN_LEASE_SECONDS` | `CHAT_JOB_LEASE_SECONDS` の fallback | action run の lease 秒数 |
| `ACTION_RUN_PROGRESS_MESSAGE_LIMIT` | `CHAT_JOB_PROGRESS_MESSAGE_LIMIT` の fallback | action run の progress message 数 |
| `ACTION_RUN_WORKER_FUNCTION_NAME` | `CHAT_JOB_WORKER_FUNCTION_NAME` の fallback | action run worker Lambda 名 |
| `ACTION_RUN_OWNER_TOKEN_HEADER_NAME` | `x-action-run-owner-token` | action run 用 owner token ヘッダ |
| `USE_STRANDS_AGENT` | `false` | PR draft agent に Strands を使うか |

## 画像 / S3

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `PR_ACTION_IMAGE_BUCKET_NAME` | `""` | 投稿画像を置く S3 バケット名 |
| `PR_ACTION_IMAGE_PUBLIC_BASE_URL` | `""` | 画像配信用の public base URL |
| `PR_ACTION_IMAGE_OBJECT_KEY_PREFIX` | `action-runs` | 画像オブジェクトキーの接頭辞 |

## 投稿連携

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `SLACK_INCOMING_WEBHOOK_URL` | `""` | Slack Incoming Webhook |
| `BLUESKY_IDENTIFIER` | `""` | Bluesky handle または email |
| `BLUESKY_APP_PASSWORD` | `""` | Bluesky App Password |
| `BLUESKY_SERVICE_URL` | `https://bsky.social` | Bluesky PDS の URL |

## 生成 AI / 画像解析

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `CHAT_AGENT_ENABLED` | `true` | 軽量エージェントループを有効化 |
| `CHAT_AGENT_MAX_CONTEXT_PASSES` | `2` | 追加の文脈取得回数上限 |
| `CHAT_AGENT_PLAN_MAX_OUTPUT_TOKENS` | `400` | 計画生成の token 上限 |
| `CHAT_AGENT_EVAL_MAX_OUTPUT_TOKENS` | `300` | 評価生成の token 上限 |
| `CHAT_AGENT_DEBUG_LOG_PROMPT_EXCHANGE` | `false` | プロンプト / 応答のデバッグログ |
| `CHAT_AGENT_DEBUG_MAX_CHARS` | `8000` | デバッグログの最大文字数 |
| `MODEL_PROVIDER` | `mock` | `mock` か `bedrock` |
| `VISION_PROVIDER` | `MODEL_PROVIDER` の互換入力 | `mock` か `bedrock` |
| `IMAGE_ANALYSIS_PROVIDER` | `MODEL_PROVIDER` の互換入力 | `mock` か `bedrock` |
| `ENABLE_IMAGE_ANALYSIS` | `MODEL_PROVIDER` の互換入力 | `true` / `false` の互換入力 |
| `BEDROCK_REGION` | `us-east-1` | Bedrock の Region |
| `BEDROCK_MODEL_ID` | `us.amazon.nova-2-lite-v1:0` | Bedrock モデル ID |
| `BEDROCK_FOUNDATION_MODEL_ID` | `amazon.nova-2-lite-v1:0` | 互換用 foundation model ID |
| `BEDROCK_MAX_OUTPUT_TOKENS` | `2400` | 出力 token 上限 |
| `BEDROCK_TEMPERATURE` | `0.2` | 生成温度 |
| `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE` | `false` | Bedrock の入出力デバッグログ |
| `BEDROCK_DEBUG_MAX_CHARS` | `12000` | Bedrock デバッグログの最大文字数 |

## Cognito 認証

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `AUTH_REQUIRED` | `false` | API / UI で Cognito 認証を必須にするか |
| `COGNITO_USER_POOL_ID` | `""` | Cognito User Pool ID |
| `COGNITO_CLIENT_ID` | `""` | Cognito App Client ID |
| `COGNITO_REGION` | `""` | Cognito Region |
| `COGNITO_DOMAIN` | `""` | Hosted UI Domain |
| `COGNITO_POPUP_REDIRECT_URI` | `""` | popup callback URL |
| `COGNITO_AUTH_TRANSACTIONS_TABLE` | なし | popup auth の transaction テーブル |
| `COGNITO_AUTH_TRANSACTION_KEY_PARAM` | `"/tableau-ai-pr-agent/cognito/popup-auth-key"` | popup auth の暗号鍵 SSM パラメータ名 |
| `COGNITO_AUTH_TRANSACTION_TTL_SECONDS` | `600` | popup auth transaction の TTL |

## Tableau

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `TABLEAU_SERVER_URL` | `""` | Tableau Cloud / Server の URL |
| `TABLEAU_SITE_CONTENT_URL` | `""` | site content URL |
| `TABLEAU_API_VERSION` | `3.25` | REST API version |
| `TABLEAU_DEFAULT_SUBJECT` | `""` | Direct Trust の subject |
| `TABLEAU_SUBJECT` | 互換用のみ | 旧 subject 変数。`TABLEAU_DEFAULT_SUBJECT` を優先 |
| `TABLEAU_SCOPES` | `tableau:content:read` | Connected App scopes |
| `TABLEAU_CONTEXT_PROVIDER` | `mock` | `mock` / `direct-api` / `mcp` |
| `TABLEAU_CONNECTIVITY_DIAGNOSTICS` | `false` | `/health` に Tableau の診断を含めるか |
| `TABLEAU_CONNECTED_APP_CLIENT_ID` | なし | Connected App client ID |
| `TABLEAU_CONNECTED_APP_SECRET_ID` | なし | Connected App secret ID |
| `TABLEAU_CONNECTED_APP_SECRET_VALUE` | なし | Connected App secret value |

### Tableau MCP

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `TABLEAU_MCP_SERVER_URL` | `""` | HTTP モードの MCP server URL |
| `TABLEAU_MCP_TRANSPORT` | `stdio` | `stdio` / `http` などの transport |
| `TABLEAU_MCP_AUTH_MODE` | `direct-trust` | MCP の認証モード |
| `TABLEAU_MCP_TIMEOUT_MS` | `5000` | MCP 呼び出しタイムアウト |
| `TABLEAU_MCP_COMMAND` | `""` | `@tableau/mcp-server` 以外の起動コマンド |
| `TABLEAU_MCP_ARGS` | `[]` | MCP コマンド引数 |
| `TABLEAU_MCP_ALLOWED_TOOLS` | `[]` | allowlist。未設定なら live tool list を使う |
| `TABLEAU_MCP_MAX_TOOL_CALLS` | `3` | 1 リクエストあたりの tool call 上限 |
| `TABLEAU_MCP_DEBUG_LOG_RESULTS` | `false` | MCP 結果のデバッグログ |
| `TABLEAU_MCP_TOOL_PLANNING_ENABLED` | `false` | Bedrock に tool plan を作らせるか |
| `TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS` | `600` | planner の token 上限 |
| `TABLEAU_MCP_INTENT_TOOL_FILTER_MODE` | `strict` | `strict` / `soft` / `off` |
| `TABLEAU_MCP_INTENT_CLASSIFIER_MODE` | `heuristic` | `heuristic` / `hybrid` |
| `TABLEAU_MCP_ARG_SANITIZE_MODE` | `drop` | `drop` / `mask` |
| `TABLEAU_MCP_ARG_MAX_DEPTH` | `5` | 引数サニタイズ深さ上限 |
| `TABLEAU_MCP_ARG_MAX_ARRAY` | `50` | 配列長の上限 |
| `TABLEAU_MCP_ARG_MAX_OBJECT_KEYS` | `30` | オブジェクト key 数の上限 |
| `TABLEAU_MCP_METADATA_CACHE_ENABLED` | `true` | メタデータキャッシュを使うか |
| `TABLEAU_MCP_METADATA_CACHE_TTL_MS` | `30000` | メタデータキャッシュ TTL |
| `TABLEAU_MCP_METADATA_CACHE_TABLE_NAME` | なし | DynamoDB バックの cache table |
| `TABLEAU_MCP_QUERY_MAX_LIMIT` | `50` | `query-datasource` の limit 上限 |
| `TABLEAU_MCP_QUERY_MAX_FIELDS` | `6` | `query-datasource` の field 上限 |

## Notion

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `NOTION_MCP_ENABLED` | `false` | Notion 連携を有効にするか |
| `NOTION_MCP_URL` | `https://mcp.notion.com/mcp` | Notion MCP URL |
| `NOTION_REDIRECT_URI` | `""` | Notion OAuth callback URL |
| `NOTION_CONNECTIONS_TABLE` | なし | 接続情報の DynamoDB テーブル |
| `NOTION_OAUTH_STATES_TABLE` | なし | OAuth state の DynamoDB テーブル |
| `NOTION_TOKEN_ENCRYPTION_KEY_PARAM` | なし | Notion トークン暗号鍵の SSM パラメータ名 |
| `NOTION_MCP_ALLOWED_TOOLS` | `notion-create-pages,notion-fetch` | Notion MCP allowlist |
| `NOTION_DEFAULT_TARGET_PARENT_PAGE_ID` | なし | 既定の親ページ |
| `NOTION_DEFAULT_TARGET_DATABASE_ID` | なし | 既定のデータベース / data source |
| `NOTION_LOCAL_DEV_USER_ID` | `local-dev-user` | auth 無効時のローカル user ID |
| `NOTION_OAUTH_CLIENT_ID` | なし | DCR 不可時の static client ID |
| `NOTION_OAUTH_CLIENT_SECRET` | なし | DCR 不可時の static client secret |
| `NOTION_OAUTH_AUTHORIZE_URL` | `https://api.notion.com/v1/oauth/authorize` | OAuth authorize URL |
| `NOTION_OAUTH_TOKEN_URL` | `https://api.notion.com/v1/oauth/token` | OAuth token URL |
| `NOTION_OAUTH_STATE_TTL_SECONDS` | `600` | OAuth state TTL |

## Google Calendar

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `GOOGLE_CALENDAR_PROVIDER` | `mock` | `mock` / `google` |
| `GOOGLE_CALENDAR_CALENDAR_ID` | `""` | 参照する calendar ID |
| `GOOGLE_CALENDAR_CLIENT_ID` | `""` | OAuth client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | `""` | OAuth client secret |
| `GOOGLE_CALENDAR_REDIRECT_URI` | `""` | OAuth callback URL |
| `GOOGLE_CALENDAR_CONNECTIONS_TABLE` | なし | 接続情報の DynamoDB テーブル |
| `GOOGLE_CALENDAR_OAUTH_STATES_TABLE` | なし | OAuth state の DynamoDB テーブル |
| `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY_PARAM` | なし | トークン暗号鍵の SSM パラメータ名 |
| `GOOGLE_CALENDAR_SCOPES` | CloudFormation では `https://www.googleapis.com/auth/calendar.readonly` | OAuth scopes |

## ローカル / 本番 / デモのおすすめ値

### ローカル

- `USE_IN_MEMORY_REPOSITORY=true`
- `TABLEAU_CONTEXT_PROVIDER=mock`
- `MODEL_PROVIDER=mock`
- `GOOGLE_CALENDAR_PROVIDER=mock`
- `NOTION_MCP_ENABLED=false`
- `AUTH_REQUIRED=false`
- `VITE_USE_MOCK_TABLEAU=true`

### 本番

- `USE_IN_MEMORY_REPOSITORY=false`
- `TABLEAU_CONTEXT_PROVIDER=direct-api` または `mcp`
- `MODEL_PROVIDER=bedrock`
- `AUTH_REQUIRED=true`
- `TABLEAU_MCP_ALLOWED_TOOLS` を明示的に設定
- `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE=false`
- `LOG_LEVEL=info`

### デモ

- 本番と同じ AWS 構成を使いつつ、必要な連携だけ有効化するのが基本です
- Google Calendar は `mock` でも運用できます
- Slack と Bluesky は最終承認の直前でだけ有効化すると安全です

## 補足

- AWS CloudFormation では、`CHAT_JOBS_TABLE_NAME` などの値はスタック側で自動的に設定されます
- 逆に、ローカルでは必要なものだけを `env` で入れる想定です
- 不明な項目や未使用に見える項目は、実装側で参照箇所を確認したうえで `TODO: 確認が必要` と追記してください
