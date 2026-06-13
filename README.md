# Tableau AI PR Agent Extension Migration Scaffold

## English

This repository is being prepared as the base for `tableau-ai-pr-agent`, a Tableau Dashboard Extension for AI-assisted PR and social publishing workflows. The current code still contains the chat-oriented PoC implementation, but the naming and deployment scaffold are being aligned for the new app.

The backend keeps Tableau access and secrets server-side. It can switch context providers with `TABLEAU_CONTEXT_PROVIDER`:

- `mock`: local-safe fallback with no Tableau call.
- `direct-api`: uses Tableau Connected Apps Direct Trust JWT to call Tableau REST API / Metadata API.
- `mcp`: launches Tableau MCP from the backend. The low-cost PoC path uses stdio transport inside Lambda instead of always-on ECS.

Answer generation can switch with `MODEL_PROVIDER`:

- `mock`: deterministic context-based answer.
- `bedrock`: Amazon Bedrock Converse API. The recommended visual-capable model for this PoC is Nova 2 Lite via `us.amazon.nova-2-lite-v1:0` in `us-east-1`.

### Architecture

```mermaid
flowchart LR
  A[Tableau Cloud Dashboard] --> B[Dashboard Extension]
  B --> C[React Chat UI]
  C --> D[API Gateway / CloudFront /api]
  D --> E[Lambda Handler]
  E --> F[Cognito JWT Verification]
  F --> G[ChatService]
  G --> H[TableauContextProvider]
  H --> I[Mock Provider]
  H --> J[Direct Tableau REST / Metadata API]
  H --> K[Tableau MCP over stdio]
  K --> L[Tableau Cloud with Connected Apps JWT]
  G --> M[Bedrock Nova 2 Lite]
  G --> N[DynamoDB Chat History]
```

### Local Development

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Backend:

```bash
cd backend
npm install
npm run dev
```

Useful local defaults:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`
- Chat job API: `POST http://localhost:3001/chat-jobs`
- Chat job poll API: `GET http://localhost:3001/chat-jobs/{jobId}`
- Legacy chat API: `POST http://localhost:3001/chat` (kept for compatibility while migrating)
- Health API: `GET http://localhost:3001/health`
- `LOG_LEVEL=info`: backend log threshold (`debug`, `info`, `warn`, `error`)
- `CHAT_DEBUG_MAX_CHARS=12000`: max characters for debug-level chat input/output message logs.

The recommended path for long-running analysis is the async chat job flow:

1. `POST /chat-jobs` to create a job and get `jobId` immediately.
2. Poll `GET /chat-jobs/{jobId}` until the status becomes `completed` or `failed`.
3. Use the returned `X-Chat-Owner-Token` for anonymous polling so a user only sees their own jobs.

For browser-only mock development outside Tableau:

```bash
VITE_USE_MOCK_TABLEAU=true
VITE_API_BASE_URL=http://localhost:3001
TABLEAU_CONTEXT_PROVIDER=mock
MODEL_PROVIDER=mock
```

### Quality Gates

After installing dependencies in both packages, run the repository-level checks from the root directory:

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run test:unit
npm run test:e2e
npm run build
npm run ci
```

Install commands:

```bash
npm ci --prefix backend
npm ci --prefix frontend
cd frontend && npx playwright install --with-deps chromium
```

`npm run ci` executes:

1. `npm run lint`
2. `npm run typecheck`
3. `npm run test:coverage`
4. `npm run build`
5. `npm run test:e2e`

Notes:

- Frontend E2E tests use Playwright route mocks and do not call Bedrock, Tableau Cloud, Notion, or MCP endpoints.
- Backend unit tests use mocks/stubs and do not require AWS credentials.
- Coverage is powered by Vitest (`@vitest/coverage-v8`).
- Current initial thresholds:
  - Backend: Statements 45%, Branches 60%, Functions 55%, Lines 45%
  - Frontend: Statements 6%, Branches 50%, Functions 45%, Lines 6%
- Long-term target thresholds are still 60% / 50% / 60% / 60% for the main unit-test surface.
- Coverage output is written to `backend/coverage/` and `frontend/coverage/` and uploaded by GitHub Actions as a build artifact.
- CI runs coverage on pull requests to `main`, pushes to `develop`, and pushes to `main` before build and Playwright E2E.
- The coverage report is a signal, not a guarantee: passing thresholds does not by itself prove the app is safe or complete.
- Coverage excludes generated output, package build output, test reports, config files, type-only files, and local entrypoints such as `frontend/src/main.tsx` and `backend/src/localServer.ts`.
- Playwright artifacts are uploaded only when CI fails.

### Tableau Extension

Use `frontend/public/tableau-chat-extension.trex` for local development, or the built `.trex` from `frontend/dist` after deployment.

The manifest `source-location` must point to the deployed HTTPS frontend URL. Tableau Cloud may require an administrator to allow network-enabled extensions and approve the extension domain.

### Authentication

Authentication is optional for local development and enabled with:

- Frontend: `VITE_AUTH_REQUIRED=true`
- Backend: `AUTH_REQUIRED=true`

Cognito frontend settings:

- `VITE_COGNITO_USER_POOL_ID`
- `VITE_COGNITO_CLIENT_ID`
- `VITE_COGNITO_REGION`
- `VITE_COGNITO_DOMAIN`
- `VITE_COGNITO_REDIRECT_URI` (optional full-page fallback callback)
- `VITE_COGNITO_LOGOUT_URI`

Cognito backend settings:

- `COGNITO_USER_POOL_ID`
- `COGNITO_CLIENT_ID`
- `COGNITO_REGION`
- `COGNITO_DOMAIN`
- `COGNITO_POPUP_REDIRECT_URI`
- `COGNITO_AUTH_TRANSACTION_KEY_PARAM`
- `COGNITO_AUTH_TRANSACTION_TTL_SECONDS`

The backend verifies the Cognito JWT and derives the Tableau subject from the verified `email` claim. It does not trust a username sent by the frontend.

Popup sign-in for Tableau Cloud now uses a backend transaction + polling flow instead of relying on popup-to-iframe `postMessage` timing:

1. Frontend opens a blank popup immediately from the user click.
2. Frontend calls `POST /auth/cognito/popup/start`.
3. Backend creates a short-lived auth transaction in DynamoDB, stores the encrypted PKCE verifier, and returns the Cognito authorization URL.
4. Frontend navigates the popup to Cognito Hosted UI.
5. Cognito redirects to backend `GET /auth/cognito/callback`.
6. Backend exchanges the code, stores an encrypted short-lived session payload, and marks the transaction as completed.
7. Parent iframe polls `GET /auth/cognito/popup/status` until it receives the completed session.

This avoids fragile popup close detection inside Tableau Cloud iframes.

### Tableau Connected App Settings

The backend needs these values. Never put them in frontend code:

- `TABLEAU_SERVER_URL`
- `TABLEAU_SITE_CONTENT_URL`
- `TABLEAU_API_VERSION`
- `TABLEAU_CONNECTED_APP_CLIENT_ID`
- `TABLEAU_CONNECTED_APP_SECRET_ID`
- `TABLEAU_CONNECTED_APP_SECRET_VALUE`
- `TABLEAU_DEFAULT_SUBJECT`
- `TABLEAU_SCOPES`

In the low-cost AWS PoC deployment, the CloudFormation template passes Connected App values directly to Lambda environment variables. This avoids Secrets Manager fixed monthly cost, but anyone with permission to read Lambda function configuration may be able to view these values. For production, prefer SSM Parameter Store SecureString or Secrets Manager.

### MCP Settings

For Lambda-local Tableau MCP:

- `TABLEAU_CONTEXT_PROVIDER=mcp`
- `TABLEAU_MCP_TRANSPORT=stdio`
- `TABLEAU_MCP_AUTH_MODE=direct-trust`
- `TABLEAU_MCP_TIMEOUT_MS=5000`
- `TABLEAU_MCP_ALLOWED_TOOLS`: optional comma-separated allowlist of MCP tools to call. If omitted, the backend uses the live tool list returned by `client.listTools()`.
- `TABLEAU_MCP_MAX_TOOL_CALLS=3`: increase to `5`-`8` when tool planning is enabled and datasource metadata/query tools are needed.
- `TABLEAU_MCP_DEBUG_LOG_RESULTS=false`: set to `true` only while diagnosing MCP result shapes in CloudWatch.
- `TABLEAU_MCP_TOOL_PLANNING_ENABLED=false`: set to `true` to let Bedrock create a small JSON MCP tool plan before tool execution.
- `TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS=600`: token cap for the planning call.
- `TABLEAU_MCP_INTENT_TOOL_FILTER_MODE=strict`: `strict` keeps legacy intent-based tool filtering, `soft` keeps all allowlisted tools but adds intent tool preferences to the prompt, `off` disables intent tool filtering entirely. When `TABLEAU_MCP_ALLOWED_TOOLS` is unset, intent filtering is automatically relaxed to `off` so new MCP tools can still be considered.
- `TABLEAU_MCP_INTENT_CLASSIFIER_MODE=heuristic`: `hybrid` allows Bedrock planner to revise intent when classifier confidence is low.
- `TABLEAU_MCP_ARG_SANITIZE_MODE=drop`: `drop` removes sensitive-like keys, `mask` preserves argument shape while redacting sensitive values.
- `TABLEAU_MCP_ARG_MAX_DEPTH=5`, `TABLEAU_MCP_ARG_MAX_ARRAY=50`, `TABLEAU_MCP_ARG_MAX_OBJECT_KEYS=30`: JSON argument safety caps for planner output.
- `TABLEAU_MCP_METADATA_CACHE_ENABLED=true`: enables short-lived in-memory metadata caching per user boundary.
- `TABLEAU_MCP_METADATA_CACHE_TTL_MS=30000`: metadata cache TTL in milliseconds.
- `TABLEAU_MCP_METADATA_CACHE_TABLE_NAME=<dynamodb table name>`: optional DynamoDB-backed metadata cache for cold-start and cross-invocation reuse.
- `TABLEAU_MCP_QUERY_MAX_LIMIT=50`: hard cap for `query-datasource` limit.
- `TABLEAU_MCP_QUERY_MAX_FIELDS=6`: hard cap for `query-datasource` field count.
- `TABLEAU_MCP_COMMAND` and `TABLEAU_MCP_ARGS`: optional override. If omitted, Lambda runs the installed `@tableau/mcp-server` package with Node.js.

Action run settings:

- `CHAT_JOBS_TABLE_NAME=<dynamodb table name>`: shared job state table used by `POST /action-runs` and `GET /action-runs/{actionRunId}`. Existing chat job flows still use the same table.
- `ACTION_RUN_WORKER_FUNCTION_NAME=<lambda function name>`: async worker Lambda name for action-run execution. `CHAT_JOB_WORKER_FUNCTION_NAME` is still accepted as a compatibility fallback.
- `ACTION_RUN_TTL_SECONDS=86400`: TTL for completed / failed action runs. `CHAT_JOB_TTL_SECONDS` is still accepted as a compatibility fallback.
- `ACTION_RUN_LEASE_SECONDS=120`: worker lease duration for claim / retry protection. `CHAT_JOB_LEASE_SECONDS` is still accepted as a compatibility fallback.
- `ACTION_RUN_PROGRESS_MESSAGE_LIMIT=12`: max progress messages retained per action-run record. `CHAT_JOB_PROGRESS_MESSAGE_LIMIT` is still accepted as a compatibility fallback.
- `ACTION_RUN_OWNER_TOKEN_HEADER_NAME=x-action-run-owner-token`: anonymous action-run ownership header used for polling and history continuity. `CHAT_JOB_OWNER_TOKEN_HEADER_NAME` is still accepted as a compatibility fallback.

Recommended limited-agent settings:

```bash
TABLEAU_CONTEXT_PROVIDER=mcp
TABLEAU_MCP_TRANSPORT=stdio
TABLEAU_MCP_AUTH_MODE=direct-trust
TABLEAU_MCP_TOOL_PLANNING_ENABLED=true
TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS=400
TABLEAU_MCP_MAX_TOOL_CALLS=5
TABLEAU_MCP_ALLOWED_TOOLS=list-workbooks,get-workbook,list-views,list-datasources,get-datasource-metadata,search-content,query-datasource
TABLEAU_MCP_INTENT_TOOL_FILTER_MODE=soft
TABLEAU_MCP_INTENT_CLASSIFIER_MODE=hybrid
TABLEAU_MCP_ARG_SANITIZE_MODE=mask
TABLEAU_MCP_ARG_MAX_DEPTH=6
TABLEAU_MCP_ARG_MAX_ARRAY=80
TABLEAU_MCP_ARG_MAX_OBJECT_KEYS=40
TABLEAU_MCP_DEBUG_LOG_RESULTS=false
TABLEAU_MCP_METADATA_CACHE_ENABLED=true
TABLEAU_MCP_METADATA_CACHE_TTL_MS=30000
TABLEAU_MCP_QUERY_MAX_LIMIT=50
TABLEAU_MCP_QUERY_MAX_FIELDS=6
```

Use `query-datasource` only with the safety guardrails enabled. The backend blocks row-level broad queries and enforces aggregated queries with small limits.

The MCP child process receives Connected App credentials only through backend environment variables. These values are not logged.

When MCP tool planning is enabled, the backend runs as a limited agent:
- It first classifies the user question intent.
- It sets intent-specific tool-call limits.
- It plans only allowlisted tools.
- It performs at most one follow-up replan for data analysis questions.
- It stores MCP observations (purpose, args summary, result summary, errors) and passes them to final answer generation.
- It blocks unsafe `query-datasource` calls (broad/non-aggregate/sensitive-field style queries).

### Bedrock Settings

For the selected PoC model:

- `MODEL_PROVIDER=bedrock`
- `BEDROCK_REGION=us-east-1`
- `BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0`
- `BEDROCK_FOUNDATION_MODEL_ID=amazon.nova-2-lite-v1:0`
- `BEDROCK_MAX_OUTPUT_TOKENS=2400`
- `BEDROCK_TEMPERATURE=0.2`
- `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE=false`: set to `true` only in PoC debugging to log Bedrock raw prompt/response previews to CloudWatch.
- `BEDROCK_DEBUG_MAX_CHARS=12000`: max characters logged for each Bedrock prompt/response preview.
- `CHAT_MEMORY_MESSAGE_LIMIT=10`

The current implementation sends text context to Bedrock. Screenshot/image input is the next step because Nova 2 Lite supports multimodal use cases, but the first implementation keeps data minimized.

### Notion MCP PoC (Phase 2)

This PoC adds a backend-managed Notion integration for low-cost small-team usage.

- OAuth and token handling stay in Lambda only.
- Frontend receives only status, workspace name, and saved page URL.
- Notion access/refresh tokens are encrypted with AES-256-GCM before DynamoDB storage.
- Encryption key is loaded from SSM Parameter Store SecureString at runtime.
- No AWS Secrets Manager dependency in this phase.

#### Notion Environment Variables

- `NOTION_MCP_ENABLED=true|false`
- `NOTION_MCP_URL=https://mcp.notion.com/mcp`
- `NOTION_REDIRECT_URI=<https callback URL to /notion/callback>`
- `NOTION_CONNECTIONS_TABLE=<dynamodb table name>`
- `NOTION_OAUTH_STATES_TABLE=<dynamodb table name>`
- `NOTION_TOKEN_ENCRYPTION_KEY_PARAM=/tableau-chat-extension/notion/token-encryption-key`
- `NOTION_MCP_ALLOWED_TOOLS=notion-create-pages,notion-fetch`
- `NOTION_DEFAULT_TARGET_PARENT_PAGE_ID=<optional default parent page>`
- `NOTION_DEFAULT_TARGET_DATABASE_ID=<optional default database>`
- `NOTION_LOCAL_DEV_USER_ID=local-dev-user`
- `NOTION_OAUTH_CLIENT_ID=<optional static oauth client id fallback>`
- `NOTION_OAUTH_CLIENT_SECRET=<optional static oauth client secret fallback>`

Notion MCP OAuth now uses Dynamic Client Registration (DCR) by default.  
If DCR succeeds, static `NOTION_OAUTH_CLIENT_ID/SECRET` are not required.

#### New Notion APIs

- `GET /notion/status`
- `POST /notion/connect`
- `GET /notion/callback`
- `POST /notion/disconnect`
- `POST /notion/settings`
- `POST /notion/create-post-idea`

#### Authentication and User Boundary

- With Cognito enabled, Notion connection records are keyed by Cognito `sub`.
- With Cognito disabled (`AUTH_REQUIRED=false`), fallback user id is `NOTION_LOCAL_DEV_USER_ID` (default `local-dev-user`) for local PoC.

#### Required AWS Setup (Low-Cost Pattern)

1. Create SSM SecureString key (32-byte key recommended, base64 encoded):

```bash
openssl rand -base64 32
aws ssm put-parameter \
  --name /tableau-chat-extension/notion/token-encryption-key \
  --type SecureString \
  --value "<base64-key>" \
  --overwrite
```

2. Provision DynamoDB tables for Notion connections and OAuth states.
   - Connections table key: `userId` (PK), `connectionId` (SK).
   - OAuth states table key: `state` (PK), with TTL on `expiresAt`.

3. Grant Lambda IAM:
   - `ssm:GetParameter` only for `NOTION_TOKEN_ENCRYPTION_KEY_PARAM`
   - `dynamodb:GetItem|PutItem|UpdateItem|DeleteItem` on Notion tables

#### Chat UX (Two-Step Save)

1. Chat generates analysis answer and `notionPostIdeaDraft` preview.
2. Only when user clicks `Notionに保存`, frontend calls `POST /notion/create-post-idea`.

The app never writes to Notion directly from a plain chat question without explicit user approval.

#### Security Notes (PoC)

- Never log access token, refresh token, OAuth code, PKCE verifier, or encryption key.
- Never return token values from API.
- Never store token values in frontend localStorage/sessionStorage.
- Restrict Notion MCP tools with allowlist (`notion-create-pages`, `notion-fetch`).

PoC note:
"This PoC prioritizes low cost by using SSM Parameter Store Standard SecureString and DynamoDB instead of Secrets Manager. Notion OAuth tokens are stored in DynamoDB only after backend AES-256-GCM encryption. For production, add stronger key management, auditing, and permission controls."

#### Manual Test Checklist (Notion)

1. `GET /notion/status` before connect returns `connected=false`.
2. `POST /notion/connect` returns `authorizationUrl`.
3. Complete OAuth and confirm callback creates one item in `NotionConnections`.
4. Verify DynamoDB token fields are ciphertext/iv/authTag and not plaintext token.
5. `GET /notion/status` after connect returns `connected=true` and `workspaceName`.
6. Chat a request that includes Notion save intent and confirm preview appears in UI.
7. Click `Notionに保存` and confirm `pageUrl` is returned and link opens.
8. `POST /notion/disconnect` removes connection and `status` becomes disconnected.
9. Force expired token and verify refresh path runs; on refresh failure, status becomes `refresh_failed`.

### AWS Deployment

`.github/workflows/deploy-aws.yml` builds the backend and frontend, deploys `infra/cloudformation.yaml`, uploads frontend assets to S3, and invalidates CloudFront. Sensitive values should be stored in GitHub Secrets or repository Variables, and the workflow masks account-specific IDs and URLs in logs.
Lambda log groups are not managed by CloudFormation; Lambda creates them automatically.

CI now runs in `.github/workflows/ci.yml` for pull requests to `main` and pushes to `develop` and `main`. The deployment workflow also has its own `ci` job, and the deploy job runs only after those quality gates succeed.

Deployment rules:

- `pull_request` to `main`: run CI only, do not deploy
- `push` to `develop`: run CI only, do not deploy
- `push` to `main`: run CI, then deploy to AWS

### Branch Strategy And Protection

- `main` is the stable branch and the AWS deployment target.
- `develop` is the day-to-day development branch.
- Do not push directly to `main`.
- Create a Pull Request from `develop` to `main` when you want to release.
- Merge to `main` only after the required CI status check succeeds.
- After `main` is updated, GitHub Actions deploys to AWS automatically.

Branch protection is not fully configurable from code. The following protection rule must be set manually in the GitHub UI.

GitHub UI steps:

1. Open the repository on GitHub.
2. Go to `Settings` -> `Branches`.
3. In `Branch protection rules`, click `Add rule` or `Add branch protection rule`.
4. Set `Branch name pattern` to `main`.
5. Enable `Require a pull request before merging`.
6. Enable `Require status checks to pass before merging`.
7. Select the CI status check for this repository. Use the check created by `.github/workflows/ci.yml`, typically `Quality Gates`.
8. Enable `Require branches to be up to date before merging`.
9. Disable bypass by enabling `Do not allow bypassing the above settings`.
10. Block force pushes by leaving force pushes disabled.
11. Restrict deletions by enabling the deletion protection option.
12. Save the rule.

Recommended optional settings for a small personal project:

- `Require approvals`: optional
- `Require review from Code Owners`: optional
- `Require signed commits`: optional
- `Require linear history`: optional

If CI fails on a Pull Request:

1. Open the failed workflow run from the PR checks tab.
2. Read the failing step and fix the branch locally.
3. Re-run `npm run ci` locally when possible.
4. Push the fix to the PR branch and wait for CI to pass before merging.

Emergency exception guidance:

- If you temporarily relax branch protection in GitHub UI, record who changed it, why it was needed, and when it must be restored.
- Restore the protection rule immediately after the emergency change is merged.
- Avoid using temporary exceptions for routine fixes.

Required GitHub secrets and variables for deployment remain documented in [docs/github-actions-deployment.md](docs/github-actions-deployment.md).

See [docs/github-actions-deployment.md](docs/github-actions-deployment.md).

### What Works

- Tableau Dashboard Extension UI with mock fallback.
- Cognito-protected chat API.
- Async chat jobs with polling, per-job progress updates, and owner-based isolation.
- Per-user Tableau subject derived from verified Cognito email.
- Direct Tableau REST / Metadata context lookup.
- Lambda-local Tableau MCP stdio provider.
- Bedrock Nova 2 Lite answer generator.
- DynamoDB chat history.
- GitHub Actions deployment to AWS.

### Not Production Ready Yet

- The legacy synchronous `POST /chat` endpoint still exists for compatibility, but long-running analysis should use the async job flow.
- MCP tool selection can use all MCP-advertised tools when no explicit allowlist is set; production should still harden this with an explicit tool allowlist.
- Screenshot analysis is not wired into the prompt yet.
- Cognito email equals Tableau username is a PoC assumption.
- Production user mapping, IdP federation, audit logging, WAF, custom domains, and data governance need additional design.
- The Lambda artifact includes MCP runtime dependencies directly. A Lambda Layer or container image may be better if package size grows.

## 日本語

このPoCは、Tableau Cloud のダッシュボード内で動くチャット型 Dashboard Extension です。React フロントエンドが Tableau Extensions API でダッシュボード情報を取得し、必要に応じて Cognito でユーザー認証したうえで、API Gateway + Lambda 相当のバックエンドへ質問を送ります。

Tableau の Secret、JWT、MCP 認証情報、Bedrock 呼び出しはすべてバックエンド側で扱います。フロントエンドには置きません。

`TABLEAU_CONTEXT_PROVIDER` で Tableau コンテキスト取得方式を切り替えます。

- `mock`: Tableau API を呼ばないローカル開発向けの安全なフォールバックです。
- `direct-api`: Tableau Connected Apps Direct Trust JWT で REST API / Metadata API を呼びます。
- `mcp`: バックエンドから Tableau MCP を呼びます。PoCではコストを抑えるため、常時起動の ECS ではなく Lambda 内 stdio transport を優先します。

`MODEL_PROVIDER` で回答生成方式を切り替えます。

- `mock`: 取得済みコンテキストだけで決定的な回答を返します。
- `bedrock`: Amazon Bedrock Converse API を使います。今回の推奨は `us-east-1` の Nova 2 Lite inference profile `us.amazon.nova-2-lite-v1:0` です。

### ローカル起動

フロントエンド:

```bash
cd frontend
npm install
npm run dev
```

バックエンド:

```bash
cd backend
npm install
npm run dev
```

必要に応じて `LOG_LEVEL` で出力レベルを制御できます（`debug` / `info` / `warn` / `error`、未指定時は `info`）。
`LOG_LEVEL=debug` の場合、チャット質問文と最終回答文を `chat.message.input_debug` / `chat.message.output_debug` として CloudWatch に出力します。長文は `CHAT_DEBUG_MAX_CHARS` で切り詰めます。

Tableau 外のブラウザでモック起動する場合:

```bash
VITE_USE_MOCK_TABLEAU=true
VITE_API_BASE_URL=http://localhost:3001
TABLEAU_CONTEXT_PROVIDER=mock
MODEL_PROVIDER=mock
```

### Tableau への配置

ローカルでは `frontend/public/tableau-chat-extension.trex` を使います。デプロイ後は `frontend/dist` に出力された `.trex` を使います。

`.trex` の `source-location` は HTTPS の本番フロントエンドURLに合わせる必要があります。Tableau Cloud 側で Network-enabled Extension の許可やドメイン許可が必要な場合があります。

### 認証

ローカル開発では認証なしでも動かせます。本番寄りにする場合は以下を有効にします。

- Frontend: `VITE_AUTH_REQUIRED=true`
- Backend: `AUTH_REQUIRED=true`

バックエンドは Cognito JWT を検証し、検証済みの `email` claim から Tableau subject を決定します。フロントエンドから送られたユーザー名は信用しません。

### Tableau MCP

Lambda 内で Tableau MCP を stdio 起動する場合の主な設定です。

- `TABLEAU_CONTEXT_PROVIDER=mcp`
- `TABLEAU_MCP_TRANSPORT=stdio`
- `TABLEAU_MCP_AUTH_MODE=direct-trust`
- `TABLEAU_MCP_TIMEOUT_MS=5000`
- `TABLEAU_MCP_ALLOWED_TOOLS`: 呼び出しを許可するMCP tool名のカンマ区切り。未指定時は安全に推測できる範囲だけ呼びます。
- `TABLEAU_MCP_MAX_TOOL_CALLS=3`
- `TABLEAU_MCP_DEBUG_LOG_RESULTS=false`: MCP の返却構造を CloudWatch で調査するときだけ `true` にします。
- `TABLEAU_MCP_INTENT_TOOL_FILTER_MODE=strict`: `strict` は従来どおり intent ごとの tool 強制絞り込み、`soft` は allowlist を維持しつつ prompt 上の優先ヒントに切り替え、`off` は intent 由来の絞り込みを無効化します。
- `TABLEAU_MCP_INTENT_CLASSIFIER_MODE=heuristic`: `hybrid` にすると、分類信頼度が低いケースで Bedrock planner が intent を補正できます。
- `TABLEAU_MCP_ARG_SANITIZE_MODE=drop`: `drop` は機密キーを除去、`mask` は引数構造を残して値だけ伏字にします。
- `TABLEAU_MCP_ARG_MAX_DEPTH=5`, `TABLEAU_MCP_ARG_MAX_ARRAY=50`, `TABLEAU_MCP_ARG_MAX_OBJECT_KEYS=30`: planner 返却引数の安全上限です。

MCP 子プロセスには、バックエンドで検証済みの Tableau subject と Lambda 環境変数から取得した Connected App 情報だけを渡します。SecretやJWTはログに出しません。本番では SSM Parameter Store SecureString または Secrets Manager への移行を検討してください。

### Bedrock

今回の方針では、コストとスクリーンショット分析への拡張性を考えて以下を使います。

- `MODEL_PROVIDER=bedrock`
- `BEDROCK_REGION=us-east-1`
- `BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0`
- `BEDROCK_FOUNDATION_MODEL_ID=amazon.nova-2-lite-v1:0`
- `BEDROCK_MAX_OUTPUT_TOKENS=2400`
- `BEDROCK_TEMPERATURE=0.2`
- `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE=false`: PoC デバッグ時のみ `true`。CloudWatch に Bedrock のプロンプト/レスポンス本文プレビューを出します。
- `BEDROCK_DEBUG_MAX_CHARS=12000`: Bedrock プロンプト/レスポンスのログ最大文字数です。
- `CHAT_MEMORY_MESSAGE_LIMIT=10`

現時点ではテキスト化した Tableau コンテキストだけを送ります。スクリーンショット画像をBedrockへ渡す処理は次段階です。

### 現在できること

- Tableau Dashboard Extension UI の表示
- Cognito 認証付き chat API
- Cognito email を Tableau username とみなす PoC 方針
- REST / Metadata API による追加コンテキスト取得
- Lambda 内 stdio による Tableau MCP 呼び出し
- Bedrock Nova 2 Lite による回答生成
- DynamoDB へのチャット履歴保存
- GitHub Actions による AWS 自動デプロイ

### まだ本番利用できない理由

- Cognito email と Tableau username の一致はPoC前提です。本番ではIdP連携やユーザーマッピングが必要です。
- MCP tool の許可範囲は、明示的な allowlist でさらに絞る必要があります。
- スクリーンショット分析は未実装です。
- 監査ログ、WAF、独自ドメイン、データ最小化ルール、LLM利用ガードレールは追加設計が必要です。
- Lambda zip に MCP 実行依存を直接含めています。サイズが大きくなる場合は Lambda Layer またはコンテナ化を検討します。

詳しくは [docs/security-notes.md](docs/security-notes.md) と [docs/future-mcp-integration.md](docs/future-mcp-integration.md) を参照してください。

### 日本語追記: MCP Tool Planning

`TABLEAU_MCP_TOOL_PLANNING_ENABLED=true` にすると、チャット質問ごとに Bedrock が MCP tool の実行計画を JSON で作成します。バックエンドは、その計画をそのまま信用せず、`TABLEAU_MCP_ALLOWED_TOOLS` と引数検証を通過した tool だけを実行します。

データソースの中身や集計値を答えたい場合は、`TABLEAU_MCP_MAX_TOOL_CALLS` を `5` から `8` 程度に増やすことを推奨します。データ系の質問では datasource metadata 取得後に最大1回だけ再計画するため、計画用の Bedrock 呼び出しが増える場合があります。`TABLEAU_MCP_PLANNER_MAX_OUTPUT_TOKENS=600` 程度に抑え、広範な行レベルデータ取得は避けてください。
