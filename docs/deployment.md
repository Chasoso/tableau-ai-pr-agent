# デプロイ

このリポジトリは GitHub Actions から AWS にデプロイします。  
実体は `infra/cloudformation.yaml` で、frontend は CloudFront + S3、backend は API Gateway + Lambda で公開します。

## AWS 構成

- CloudFront: frontend 配信、`/api/*` を API Gateway にルーティング
- S3: frontend 配信バケット、投稿画像用バケット
- API Gateway HTTP API: `/chat`, `/context`, `/action-runs`, `/calendar/resolve`, `/notion/*`, `/auth/*`, `/health`
- Lambda: chat / action-run / health のハンドラ
- DynamoDB: chat history, chat jobs, action-run 関連状態, OAuth 状態, 連携トークンの保存
- SSM Parameter Store: Cognito / Google Calendar / Notion の暗号鍵
- CloudFormation: インフラ全体の定義

## GitHub Actions

### `ci.yml`

- `pull_request` の `main` 向け
- `push` の `develop` と `main` 向け
- `npm run lint`
- `npm run typecheck`
- `npm run test:coverage`
- `npm run build`
- `npm run test:e2e`

### `deploy-aws.yml`

- `push` の `main` でのみデプロイ
- 先に同じ品質ゲートを通します
- backend を `esbuild` でバンドルし、production 依存込みで Lambda 用 zip を作ります
- frontend をビルドし、`frontend/scripts/update-trex-url.mjs` で `.trex` の参照先を更新します
- AWS OIDC ロールで認証し、S3 に backend artifact と frontend assets を配置します
- CloudFormation を適用し、CloudFront を invalidation します

## 初回セットアップ

1. GitHub の OIDC 用 IAM ロールを用意します
2. `AWS_GHA_DEPLOY_ROLE_ARN` と `AWS_CFN_EXECUTION_ROLE_ARN` を設定します
3. `AWS_ARTIFACT_BUCKET` と `FRONTEND_BUCKET_NAME` を用意します
4. Tableau Connected App の値を GitHub Secrets または Variables に設定します
5. `TABLEAU_AI_PR_AGENT_EXTENSION_SOURCE_URL` か `EXTENSION_SOURCE_URL` に、デプロイ済み frontend の HTTPS URL を設定します
6. Cognito / Google Calendar / Notion を使うなら、それぞれの OAuth 設定と SSM 鍵を用意します
7. 必要な `AWS_REGION` と Stack 名を設定します
8. `main` に push してデプロイします

## 必要な GitHub Secrets / Variables

最小構成で必須になりやすいもの:

- `AWS_REGION`
- `AWS_CFN_STACK_NAME` または `STACK_NAME`
- `AWS_GHA_DEPLOY_ROLE_ARN`
- `AWS_CFN_EXECUTION_ROLE_ARN`
- `AWS_ARTIFACT_BUCKET`
- `FRONTEND_BUCKET_NAME`
- `TABLEAU_SERVER_URL`
- `TABLEAU_CONNECTED_APP_CLIENT_ID`
- `TABLEAU_CONNECTED_APP_SECRET_ID`
- `TABLEAU_CONNECTED_APP_SECRET_VALUE`
- `TABLEAU_DEFAULT_SUBJECT`
- `BLUESKY_IDENTIFIER`
- `BLUESKY_APP_PASSWORD`

用途に応じて追加:

- `TABLEAU_SITE_CONTENT_URL`
- `TABLEAU_API_VERSION`
- `TABLEAU_SCOPES`
- `TABLEAU_CONTEXT_PROVIDER`
- `TABLEAU_MCP_*`
- `AUTH_REQUIRED`
- `COGNITO_*`
- `GOOGLE_CALENDAR_*`
- `SLACK_INCOMING_WEBHOOK_URL`
- `NOTION_*`
- `MODEL_PROVIDER`, `VISION_PROVIDER`, `IMAGE_ANALYSIS_PROVIDER`, `ENABLE_IMAGE_ANALYSIS`
- `BEDROCK_*`
- `VITE_*` の frontend 向け公開設定
- `PR_ACTION_IMAGE_PUBLIC_BASE_URL`
- `PR_ACTION_IMAGE_OBJECT_KEY_PREFIX`

## デプロイ後の確認

1. CloudFront の frontend URL を開きます
2. `GET /health` が 200 で返ることを確認します
3. Tableau 拡張が起動し、ダッシュボード文脈が読み込まれることを確認します
4. 認証を有効にした場合は Cognito ポップアップが開くことを確認します
5. Google Calendar を有効にした場合は接続状態が反映されることを確認します
6. Slack 承認を通して、投稿の確認ができることを確認します
7. Bluesky を有効にした場合は、Slack 承認後に Bluesky 投稿ができることを確認します

## 補足

- `TABLEAU_CONTEXT_PROVIDER=mcp` を使う場合、Lambda から Tableau MCP を起動できる設定が必要です
- `MODEL_PROVIDER=bedrock` を使う場合、Bedrock の権限とモデル ID を確認してください
- `USE_IN_MEMORY_REPOSITORY=false` が AWS 本番向けの前提です
- 詳細な変数一覧は [docs/configuration.md](docs/configuration.md) を参照してください
