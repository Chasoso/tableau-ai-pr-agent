# GitHub Actions AWS Deployment / GitHub Actions AWSデプロイ

## English

`.github/workflows/ci.yml` runs the repository quality gates for `pull_request` and `push` to `main` or `develop`, and `.github/workflows/deploy-aws.yml` deploys the backend, frontend, and AWS resources only after a successful `push` to `main`.

The workflow intentionally avoids printing AWS account IDs, ARNs, bucket names, CloudFront/API URLs, Tableau URLs, Connected App secrets, Cognito identifiers, JWTs, or access tokens.

### Flow

1. `ci.yml` installs dependencies, runs lint, typecheck, unit tests, build checks, and Playwright E2E with mocked APIs.
2. `push` to `develop` runs CI only.
3. Pull Requests to `main` or `develop` run CI only.
4. `deploy-aws.yml` runs the same quality gates in its `ci` job on `push` to `main`.
5. The `deploy` job starts only after `needs: ci`.
6. The backend is bundled with `esbuild`.
7. A Lambda package is created with production `node_modules` so Lambda can launch `@tableau/mcp-server`.
8. The frontend is built and `.trex` is rewritten with `TABLEAU_AI_PR_AGENT_EXTENSION_SOURCE_URL` or `EXTENSION_SOURCE_URL`.
9. GitHub OIDC deploy role is assumed.
10. The backend artifact is uploaded to the private artifact bucket.
11. `infra/cloudformation.yaml` is deployed.
12. `frontend/dist` is synced to the private frontend S3 bucket.
13. CloudFront is invalidated.

The current PR Assistant demo flow is calendar-first and draft-only. Google Calendar resolution is implemented in the backend and can run in mock mode by default or live mode when the Google credentials are configured. Set `GOOGLE_CALENDAR_PROVIDER=google` in the backend environment only when you want the deployment to use the live Google Calendar API.

The frontend upload keeps hashed files under `assets/` as append-only objects with long-lived cache headers, while `index.html` and `.trex` are uploaded with `no-cache`. This avoids a CloudFront/S3 race where an older cached `index.html` points at a hashed JS file that has already been deleted.

### Cognito Popup Auth Flow

The Tableau Cloud extension now uses backend transaction polling for popup sign-in:

1. The frontend opens a popup immediately from the user click.
2. `POST /auth/cognito/popup/start` creates a short-lived DynamoDB transaction and returns the Cognito authorization URL.
3. Cognito redirects to `COGNITO_POPUP_REDIRECT_URI`, which must point to `/api/auth/cognito/callback`.
4. The backend exchanges the authorization code and stores an encrypted short-lived session payload.
5. The parent iframe polls `GET /auth/cognito/popup/status` with `X-Auth-Poll-Token` until the session is completed.

This avoids depending on fragile popup-to-iframe `postMessage` timing inside Tableau Cloud.

### GitHub Secrets

Store these as GitHub Secrets:

| Name | Purpose |
| --- | --- |
| `AWS_CFN_STACK_NAME` | CloudFormation stack name. |
| `AWS_GHA_DEPLOY_ROLE_ARN` | GitHub OIDC deploy role ARN. |
| `AWS_CFN_EXECUTION_ROLE_ARN` | CloudFormation execution role ARN. |
| `AWS_ARTIFACT_BUCKET` | Private S3 bucket for Lambda artifacts. |
| `FRONTEND_BUCKET_NAME` | Private S3 bucket for frontend hosting. |
| `VITE_API_BASE_URL` | Usually `/api` when using the CloudFront proxy behavior. |
| `TABLEAU_AI_PR_AGENT_EXTENSION_SOURCE_URL` | Deployed HTTPS frontend URL for `.trex`. Preferred app-specific env var. |
| `EXTENSION_SOURCE_URL` | Backward-compatible fallback HTTPS frontend URL for `.trex`. |
| `CORS_ALLOWED_ORIGIN` | Allowed frontend origin. |
| `TABLEAU_SERVER_URL` | Tableau Cloud / Server URL. |
| `TABLEAU_SITE_CONTENT_URL` | Tableau site content URL. |
| `TABLEAU_CONNECTED_APP_CLIENT_ID` | Connected App client ID. |
| `TABLEAU_CONNECTED_APP_SECRET_ID` | Connected App secret ID. |
| `TABLEAU_CONNECTED_APP_SECRET_VALUE` | Connected App secret value. |
| `TABLEAU_DEFAULT_SUBJECT` | PoC fallback Tableau subject. |
| `COGNITO_USER_POOL_ID` | Required when auth is enabled. |
| `COGNITO_CLIENT_ID` | Required when auth is enabled. |
| `VITE_COGNITO_DOMAIN` | Cognito Hosted UI domain. |
| `VITE_COGNITO_REDIRECT_URI` | Optional full-page fallback callback URL. |
| `VITE_COGNITO_LOGOUT_URI` | Exact sign-out URL. |
| `COGNITO_POPUP_REDIRECT_URI` | Backend popup callback URL, for example `https://<cloudfront-domain>/api/auth/cognito/callback`. |
| `TABLEAU_MCP_SERVER_URL` | Optional only for HTTP MCP mode. |
| `TABLEAU_MCP_COMMAND` | Optional override for MCP command. Usually empty. |
| `TABLEAU_MCP_ARGS` | Optional override for MCP args. Usually empty. |
| `GOOGLE_CALENDAR_CLIENT_ID` | Google Calendar OAuth client ID for live mode. |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Google Calendar OAuth client secret for live mode. |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | Google Calendar refresh token for live mode. |
| `CHAT_JOBS_TABLE_NAME` | DynamoDB table for shared job state and progress. |
| `ACTION_RUN_WORKER_FUNCTION_NAME` | Async worker Lambda name invoked by the action-run starter. `CHAT_JOB_WORKER_FUNCTION_NAME` remains a compatibility fallback. |
| `TABLEAU_MCP_METADATA_CACHE_TABLE_NAME` | Optional DynamoDB table for Tableau MCP metadata cache. |
| `NOTION_REDIRECT_URI` | Notion OAuth callback URL (`/notion/callback`). |
| `NOTION_DEFAULT_TARGET_PARENT_PAGE_ID` | Optional default Notion parent page for page creation. |
| `NOTION_DEFAULT_TARGET_DATABASE_ID` | Optional default Notion database/data source ID. |
| `NOTION_OAUTH_CLIENT_ID` | Optional static Notion OAuth client ID fallback when Dynamic Client Registration is unavailable. |
| `NOTION_OAUTH_CLIENT_SECRET` | Optional static Notion OAuth client secret fallback. |

### GitHub Variables

These can be repository Variables if acceptable:

| Name | Default | Purpose |
| --- | --- | --- |
| `AWS_REGION` | none | Main AWS deployment region. |
| `TABLEAU_API_VERSION` | `3.25` | Tableau REST API version. |
| `TABLEAU_SCOPES` | `tableau:content:read` | Connected App scopes. |
| `TABLEAU_CONTEXT_PROVIDER` | `mock` | `mock`, `direct-api`, or `mcp`. |
| `GOOGLE_CALENDAR_PROVIDER` | `mock` | Calendar context provider used by the PR Assistant demo flow. |
| `GOOGLE_CALENDAR_CALENDAR_ID` | none | Calendar ID to query in live Google mode. |
| `GOOGLE_CALENDAR_SCOPES` | `https://www.googleapis.com/auth/calendar.readonly` | Optional override for the Google Calendar scope list. |
| `AUTH_REQUIRED` | `false` | Enables Cognito JWT verification. |
| `COGNITO_REGION` | none | Cognito region. |
| `COGNITO_AUTH_TRANSACTION_KEY_PARAM` | `/tableau-ai-pr-agent/cognito/popup-auth-key` | SSM SecureString parameter name for popup auth AES key. |
| `COGNITO_AUTH_TRANSACTION_TTL_SECONDS` | `600` | Popup auth transaction TTL in seconds. |
| `TABLEAU_MCP_TRANSPORT` | `stdio` | Recommended MCP transport for low-cost Lambda PoC. |
| `TABLEAU_MCP_AUTH_MODE` | `direct-trust` | MCP authentication mode. |
| `TABLEAU_MCP_TIMEOUT_MS` | `5000` | MCP timeout. |
| `TABLEAU_MCP_ALLOWED_TOOLS` | empty | Optional comma-separated MCP tool allowlist. |
| `TABLEAU_MCP_MAX_TOOL_CALLS` | `3` | Maximum MCP tool calls per request. |
| `TABLEAU_MCP_DEBUG_LOG_RESULTS` | `false` | Temporarily set to `true` to log sanitized MCP tool result shapes and short snippets to CloudWatch. Disable after diagnosis. |
| `TABLEAU_MCP_TOOL_PLANNING_ENABLED` | `false` | Enables Bedrock-based JSON planning for MCP tool calls. |
| `TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS` | `600` | Max output tokens for the planning call. |
| `ACTION_RUN_TTL_SECONDS` | `86400` | TTL for completed/failed action runs. `CHAT_JOB_TTL_SECONDS` remains a compatibility fallback. |
| `ACTION_RUN_LEASE_SECONDS` | `120` | Worker lease duration for action-run claiming. `CHAT_JOB_LEASE_SECONDS` remains a compatibility fallback. |
| `ACTION_RUN_PROGRESS_MESSAGE_LIMIT` | `12` | Maximum number of progress messages retained per action-run record. `CHAT_JOB_PROGRESS_MESSAGE_LIMIT` remains a compatibility fallback. |
| `ACTION_RUN_OWNER_TOKEN_HEADER_NAME` | `x-action-run-owner-token` | Anonymous owner boundary header used for polling. `CHAT_JOB_OWNER_TOKEN_HEADER_NAME` remains a compatibility fallback. |
| `MODEL_PROVIDER` | `mock` | `mock` or `bedrock`. |
| `BEDROCK_REGION` | `us-east-1` | Bedrock model region. |
| `BEDROCK_MODEL_ID` | `us.amazon.nova-2-lite-v1:0` | Bedrock model ID or inference profile ID. |
| `BEDROCK_FOUNDATION_MODEL_ID` | `amazon.nova-2-lite-v1:0` | Foundation model ID that backs the inference profile. |
| `BEDROCK_MAX_OUTPUT_TOKENS` | `2400` | Max generated tokens. |
| `BEDROCK_TEMPERATURE` | `0.2` | Generation temperature. |
| `CHAT_MEMORY_MESSAGE_LIMIT` | `10` | Number of recent same-session messages injected into the prompt for the same authenticated user. |
| `LOG_LEVEL` | `info` | Backend log threshold (`debug`, `info`, `warn`, `error`). |
| `CHAT_DEBUG_MAX_CHARS` | `12000` | Max characters for debug-level chat input/output logs. |
| `NOTION_MCP_ENABLED` | `false` | Enable backend Notion MCP integration routes. |
| `NOTION_MCP_URL` | `https://mcp.notion.com/mcp` | Notion MCP endpoint. |
| `NOTION_TOKEN_ENCRYPTION_KEY_PARAM` | `/tableau-ai-pr-agent/notion/token-encryption-key` | SSM SecureString parameter name for AES key. |
| `NOTION_MCP_ALLOWED_TOOLS` | `notion-create-pages,notion-fetch` | Allowed Notion MCP tools. |
| `NOTION_LOCAL_DEV_USER_ID` | `local-dev-user` | Local fallback user id when auth is disabled. |

### CloudFormation Execution Role Additions

The CloudFormation execution role needs the existing permissions for Lambda, API Gateway, CloudFront, S3, DynamoDB, Logs, and IAM. Secrets Manager permissions are not required for the low-cost PoC deployment because Connected App values are passed directly to Lambda environment variables.

For Bedrock, add:

```json
{
  "Sid": "AllowBackendRoleToInvokeConfiguredBedrockModel",
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream"
  ],
  "Resource": [
    "arn:aws:bedrock:<bedrock-region>::foundation-model/<foundation-model-id>",
    "arn:aws:bedrock:us-east-1::foundation-model/<foundation-model-id>",
    "arn:aws:bedrock:us-east-2::foundation-model/<foundation-model-id>",
    "arn:aws:bedrock:us-west-2::foundation-model/<foundation-model-id>",
    "arn:aws:bedrock:<bedrock-region>:<account-id>:inference-profile/<model-id>",
    "arn:aws:bedrock:<bedrock-region>::inference-profile/<model-id>"
  ]
}
```

When `BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0`, Bedrock can route requests to US destination Regions such as `us-east-1`, `us-east-2`, and `us-west-2`. The Lambda runtime role therefore needs permission for the destination foundation model ARNs, not only the source Region inference profile.

This permission is attached by the CloudFormation template to the Lambda backend role. The CloudFormation execution role must also be allowed to create/update that inline IAM policy.

Connected App values are still stored as GitHub Secrets and passed as `NoEcho` CloudFormation parameters. They are then set as Lambda environment variables. This avoids Secrets Manager monthly fixed cost, but users with permission to read Lambda function configuration may be able to view the values. For production, consider SSM Parameter Store SecureString or Secrets Manager.

Google Calendar live-mode credentials follow the same pattern:

- Keep `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, and `GOOGLE_CALENDAR_REFRESH_TOKEN` in GitHub Secrets.
- Pass `GOOGLE_CALENDAR_PROVIDER=mock` for demo deployments that should not call Google.
- Switch to `GOOGLE_CALENDAR_PROVIDER=google` only for the environment that is meant to query the live calendar.
- Do not expose the Google refresh token in frontend code, logs, or artifact output.

One-time migration note: if the stack was previously deployed with the managed `TableauConnectedAppSecret` resource, the CloudFormation execution role may need temporary `secretsmanager:DeleteSecret` and `secretsmanager:DescribeSecret` permissions for `arn:aws:secretsmanager:<region>:<account-id>:secret:<stack-name>/tableau-connected-app-*` so CloudFormation can remove the old secret. Remove those permissions after the update succeeds.

### Artifact Size Note

The Lambda package now includes production `node_modules` because the MCP provider launches `@tableau/mcp-server` at runtime. If the package becomes too large or cold starts are too slow, move MCP dependencies into a Lambda Layer or a Lambda container image.

### Frontend Cache Note

- Do not delete older hashed frontend assets during deploys.
- Upload `assets/` with long cache headers such as `public, max-age=31536000, immutable`.
- Upload `index.html` and `tableau-ai-pr-agent.trex` with `no-cache`.
- Avoid CloudFront `404/403 -> /index.html` fallback for all paths, because missing JS/CSS files can otherwise return HTML and break the extension with module MIME errors.

### Logging Rules

- Do not use `set -x`.
- Do not print stack outputs.
- Do not print `aws sts get-caller-identity`.
- Keep `mask-aws-account-id: true`.
- Use `--only-show-errors` and `--no-progress` for S3 commands.
- Mask physical resource IDs before using them.
- Keep failure event output sanitized.
- Lambda log groups are not managed by CloudFormation; Lambda creates them automatically.

## 日本語

`.github/workflows/deploy-aws.yml` は、バックエンド、フロントエンド、AWSリソースをデプロイします。

Actionsログには AWSアカウントID、ARN、バケット名、CloudFront/API URL、Tableau URL、Connected App secret、Cognito識別子、JWT、アクセストークンを出さない方針です。

### 処理の流れ

1. バックエンドを install / typecheck / test する。
2. `esbuild` で Lambda handler を bundle する。
3. Lambda 内で `@tableau/mcp-server` を起動できるように production `node_modules` を含めて zip 化する。
4. フロントエンドを install / typecheck / build する。
5. build済み `.trex` のURLを `TABLEAU_AI_PR_AGENT_EXTENSION_SOURCE_URL` で書き換える。未設定時のみ `EXTENSION_SOURCE_URL` を使う。
6. GitHub OIDC deploy role を Assume する。
7. backend artifact を private artifact bucket にアップロードする。
8. `infra/cloudformation.yaml` をデプロイする。
9. `frontend/dist` を private frontend bucket に同期する。
10. CloudFront invalidation を実行する。

### GitHub Secrets

以下は Secrets に保存してください。

| Name | 用途 |
| --- | --- |
| `AWS_CFN_STACK_NAME` | CloudFormation stack名 |
| `AWS_GHA_DEPLOY_ROLE_ARN` | GitHub OIDC deploy role ARN |
| `AWS_CFN_EXECUTION_ROLE_ARN` | CloudFormation execution role ARN |
| `AWS_ARTIFACT_BUCKET` | Lambda artifact用private S3 bucket |
| `FRONTEND_BUCKET_NAME` | frontend hosting用private S3 bucket |
| `VITE_API_BASE_URL` | 通常は CloudFront proxy を使うため `/api` |
| `TABLEAU_AI_PR_AGENT_EXTENSION_SOURCE_URL` | `.trex` に埋め込む HTTPS frontend URL |
| `EXTENSION_SOURCE_URL` | 互換用の HTTPS frontend URL |
| `CORS_ALLOWED_ORIGIN` | 許可するfrontend origin |
| `TABLEAU_SERVER_URL` | Tableau Cloud / Server URL |
| `TABLEAU_SITE_CONTENT_URL` | Tableau site content URL |
| `TABLEAU_CONNECTED_APP_CLIENT_ID` | Connected App client ID |
| `TABLEAU_CONNECTED_APP_SECRET_ID` | Connected App secret ID |
| `TABLEAU_CONNECTED_APP_SECRET_VALUE` | Connected App secret value |
| `TABLEAU_DEFAULT_SUBJECT` | PoC用 fallback Tableau subject |
| `COGNITO_USER_POOL_ID` | 認証有効時に必要 |
| `COGNITO_CLIENT_ID` | 認証有効時に必要 |
| `VITE_COGNITO_DOMAIN` | Cognito Hosted UI domain |
| `VITE_COGNITO_REDIRECT_URI` | Cognito callback URL |
| `VITE_COGNITO_LOGOUT_URI` | Cognito sign-out URL |
| `TABLEAU_MCP_SERVER_URL` | HTTP MCP mode の場合のみ任意 |
| `TABLEAU_MCP_COMMAND` | MCP command override。通常は空 |
| `TABLEAU_MCP_ARGS` | MCP args override。通常は空 |

### GitHub Variables

以下は組織上問題なければ Variables に保存できます。

| Name | Default | 用途 |
| --- | --- | --- |
| `AWS_REGION` | なし | メインAWSリージョン |
| `TABLEAU_API_VERSION` | `3.25` | Tableau REST API version |
| `TABLEAU_SCOPES` | `tableau:content:read` | Connected App scopes |
| `TABLEAU_CONTEXT_PROVIDER` | `mock` | `mock`, `direct-api`, `mcp` |
| `GOOGLE_CALENDAR_PROVIDER` | `mock` | PR Assistant demo calendar provider |
| `AUTH_REQUIRED` | `false` | Cognito JWT検証を有効化 |
| `COGNITO_REGION` | なし | Cognito region |
| `TABLEAU_MCP_TRANSPORT` | `stdio` | 低コストPoCの推奨MCP transport |
| `TABLEAU_MCP_AUTH_MODE` | `direct-trust` | MCP認証方式 |
| `TABLEAU_MCP_TIMEOUT_MS` | `5000` | MCP timeout |
| `TABLEAU_MCP_ALLOWED_TOOLS` | 空 | MCP tool allowlist |
| `TABLEAU_MCP_MAX_TOOL_CALLS` | `3` | 1リクエストあたりの最大MCP tool呼び出し数 |
| `TABLEAU_MCP_DEBUG_LOG_RESULTS` | `false` | 一時的に `true` にすると、MCP tool の返却構造と短いスニペットを CloudWatch に出します。調査後は `false` に戻してください。 |
| `TABLEAU_MCP_TOOL_PLANNING_ENABLED` | `false` | Bedrock による MCP tool 実行計画 JSON を有効化します。 |
| `TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS` | `600` | planning 呼び出しの最大出力 token 数 |
| `MODEL_PROVIDER` | `mock` | `mock` または `bedrock` |
| `BEDROCK_REGION` | `us-east-1` | Bedrock model region |
| `BEDROCK_MODEL_ID` | `us.amazon.nova-2-lite-v1:0` | Bedrock model ID または inference profile ID |
| `BEDROCK_FOUNDATION_MODEL_ID` | `amazon.nova-2-lite-v1:0` | inference profile の背後にある foundation model ID |
| `BEDROCK_MAX_OUTPUT_TOKENS` | `2400` | 最大生成token数 |
| `BEDROCK_TEMPERATURE` | `0.2` | temperature |
| `CHAT_MEMORY_MESSAGE_LIMIT` | `10` | 同一認証ユーザーの同一セッションからプロンプトへ注入する直近会話件数 |
| `LOG_LEVEL` | `info` | バックエンドログレベル（`debug` / `info` / `warn` / `error`） |
| `CHAT_DEBUG_MAX_CHARS` | `12000` | debugログで出すチャット本文の最大文字数 |

### CloudFormation Execution Role の追加権限

CloudFormation execution role には、既存の Lambda、API Gateway、CloudFront、S3、DynamoDB、Logs、IAM 権限が必要です。低コストPoCでは Connected App 値を Lambda 環境変数に直接設定するため、Secrets Manager 権限は不要です。

Bedrock利用のため、Lambda backend role に `bedrock:InvokeModel` と `bedrock:InvokeModelWithResponseStream` を付与します。CloudFormation execution role は、その inline IAM policy を作成・更新できる必要があります。

`BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0` の場合、Bedrock は US の destination Region、たとえば `us-east-1`、`us-east-2`、`us-west-2` にリクエストをルーティングできます。そのため、Lambda実行ロールには source Region の inference profile だけでなく、destination Region の foundation model ARN も許可する必要があります。

Connected App 値は GitHub Secrets に保存し、`NoEcho` CloudFormation パラメーターとして渡した後、Lambda 環境変数に設定します。これにより Secrets Manager の月額固定費を避けられます。ただし、Lambda 関数設定を読める IAM 権限を持つユーザーには値が見え得るため、本番では SSM Parameter Store SecureString または Secrets Manager を検討してください。

移行時の注意: 以前のテンプレートで `TableauConnectedAppSecret` が作成済みの場合、今回の更新で CloudFormation が古い Secret を削除します。その1回だけ、CloudFormation execution role に `arn:aws:secretsmanager:<region>:<account-id>:secret:<stack-name>/tableau-connected-app-*` への `secretsmanager:DeleteSecret` と `secretsmanager:DescribeSecret` を一時的に付与してください。更新成功後は削除できます。

### Artifact サイズ

MCP provider が Lambda 実行時に `@tableau/mcp-server` を起動するため、Lambda zip に production `node_modules` を含めています。サイズやコールドスタートが問題になった場合は、Lambda Layer または Lambda container image に分離してください。

### ログルール

- `set -x` を使わない。
- stack outputs を出さない。
- `aws sts get-caller-identity` を実行しない。
- `mask-aws-account-id: true` を維持する。
- S3コマンドでは `--only-show-errors` と `--no-progress` を使う。
- physical resource ID は使用前に mask する。
- CloudFormation 失敗イベントは sanitize して出す。
