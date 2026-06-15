# AWS Infrastructure Plan

## English

This PoC includes a CloudFormation template at `infra/cloudformation.yaml` and a GitHub Actions workflow at `.github/workflows/deploy-aws.yml`.

The deployed architecture includes:

- S3 + CloudFront for the React frontend
- CloudFront `/api/*` proxy to API Gateway
- API Gateway HTTP API for `/chat`, `/context`, and `/health`
- Lambda for backend handlers
- DynamoDB for chat history
- Lambda environment variables for Tableau Connected App values in this low-cost PoC
- Optional Lambda-local Tableau MCP over stdio
- Optional Amazon Bedrock Nova Lite answer generation
- CloudWatch Logs with secret and token redaction discipline

Connected App values are passed directly to Lambda environment variables to avoid Secrets Manager fixed monthly cost. For production, consider SSM Parameter Store SecureString or Secrets Manager.

The template intentionally does not output API Gateway URLs, CloudFront domains, bucket names, distribution IDs, role ARNs, or account-specific identifiers.

### Key Lambda Environment Variables

- `TABLEAU_CONTEXT_PROVIDER`: `mock`, `direct-api`, or `mcp`
- `MODEL_PROVIDER`: `mock` or `bedrock`
- `BEDROCK_REGION`: default `us-east-1`
- `BEDROCK_MODEL_ID`: default `us.amazon.nova-2-lite-v1:0`
- `BEDROCK_FOUNDATION_MODEL_ID`: default `amazon.nova-2-lite-v1:0`
- `TABLEAU_MCP_TRANSPORT`: default `stdio`
- `TABLEAU_MCP_AUTH_MODE`: default `direct-trust`
- `TABLEAU_CONNECTIVITY_DIAGNOSTICS`: set `true` to include Tableau reachability and sign-in checks in `/health`
- `TABLEAU_MCP_ALLOWED_TOOLS`: optional allowlist
- `LOG_LEVEL`: default `info` (`debug` / `info` / `warn` / `error`)
- `CHAT_DEBUG_MAX_CHARS`: default `12000` for debug chat message log truncation
- `NOTION_MCP_ENABLED`: default `false` to keep Notion integration disabled unless explicitly enabled
- `NOTION_TOKEN_ENCRYPTION_KEY_PARAM`: SSM SecureString parameter name for Notion token AES key

## 日本語

このPoCでは `infra/cloudformation.yaml` と `.github/workflows/deploy-aws.yml` を使って AWS にデプロイします。

構成要素は以下です。

- React frontend 用の S3 + CloudFront
- CloudFront `/api/*` から API Gateway への proxy
- `/chat`、`/context`、`/health` 用の API Gateway HTTP API
- backend handler 用 Lambda
- chat history 用 DynamoDB
- 低コストPoCとして Tableau Connected App 値を渡す Lambda 環境変数
- 任意の Lambda 内 Tableau MCP stdio 実行
- 任意の Amazon Bedrock Nova Lite 回答生成
- Secret と token を出さない CloudWatch Logs 運用

テンプレートは API Gateway URL、CloudFront domain、bucket名、distribution ID、role ARN、AWSアカウント固有IDを Outputs に出しません。

### 主な Lambda 環境変数

- `TABLEAU_CONTEXT_PROVIDER`: `mock`, `direct-api`, `mcp`
- `MODEL_PROVIDER`: `mock`, `bedrock`
- `BEDROCK_REGION`: default `us-east-1`
- `BEDROCK_MODEL_ID`: default `us.amazon.nova-2-lite-v1:0`
- `BEDROCK_FOUNDATION_MODEL_ID`: default `amazon.nova-2-lite-v1:0`
- `TABLEAU_MCP_TRANSPORT`: default `stdio`
- `TABLEAU_MCP_AUTH_MODE`: default `direct-trust`
- `TABLEAU_CONNECTIVITY_DIAGNOSTICS`: `true` にすると `/health` に Tableau の到達性とサインイン診断を含める
- `TABLEAU_MCP_ALLOWED_TOOLS`: 任意の allowlist
