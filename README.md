# tableau-ai-pr-agent

Tableau のダッシュボード拡張として動く PR 支援エージェントです。  
会場写真、Google Calendar や TechPlay のイベント文脈、Tableau MCP で取得したアンケートや投稿実績データを使って、SNS 投稿文の候補を生成し、必要に応じて Slack と Bluesky に投稿します。

## 何をするアプリか

- Tableau ダッシュボード内で動くチャット / 投稿支援 UI を提供します
- 会場写真をアップロードして、投稿用の文脈と草案を作ります
- Google Calendar からイベント文脈を取得します
- Tableau MCP または Tableau REST / Metadata API から分析用データを取得します
- 生成した投稿文を Slack に承認投稿し、必要なら Bluesky にも投稿します
- 画像は S3 に保存し、投稿文生成と投稿に再利用します

## 主な利用シナリオ

1. イベント会場で写真をアップロードします
2. Google Calendar やイベント情報から、その場の文脈を取得します
3. Tableau MCP でアンケートや過去投稿実績のデータを取得します
4. 生成 AI で投稿文候補を作成します
5. Slack で確認・承認して投稿し、必要なら Bluesky にも投稿します

## 主な機能

- イベント情報取得
- 画像解析
- Tableau MCP 連携
- 投稿文生成
- Slack 投稿
- Bluesky 投稿
- S3 への画像保存
- 必要に応じた承認フロー

## 技術構成

- フロントエンド: React + Vite
- バックエンド: Node.js + Lambda 相当の HTTP API
- AWS: API Gateway, Lambda, DynamoDB, S3, CloudFront, CloudFormation, SSM
- 認証: Cognito
- 外部連携: Google Calendar, Slack, Bluesky, Tableau, Notion
- 生成 AI: Amazon Bedrock
- Tableau 連携: Tableau Connected Apps / Tableau MCP

## ディレクトリ構成

- `frontend/`: React UI、Tableau 拡張、各種 API クライアント
- `backend/`: API ハンドラ、認証、Tableau / Calendar / Slack / Bluesky / Notion 連携
- `infra/`: CloudFormation テンプレートとデプロイ関連
- `docs/`: 現在の実装に合わせた運用・構成・設定ドキュメント

## ローカル実行

### 1. 依存関係のインストール

```bash
npm ci --prefix backend
npm ci --prefix frontend
cd frontend && npx playwright install --with-deps chromium
```

### 2. 起動

```bash
npm --prefix backend run dev
npm --prefix frontend run dev
```

デフォルトでは以下で起動します。

- フロントエンド: `http://localhost:5173`
- バックエンド: `http://localhost:3001`

### 3. 最小構成のローカル設定例

```bash
VITE_USE_MOCK_TABLEAU=true
VITE_API_BASE_URL=http://localhost:3001
TABLEAU_CONTEXT_PROVIDER=mock
MODEL_PROVIDER=mock
GOOGLE_CALENDAR_PROVIDER=mock
USE_IN_MEMORY_REPOSITORY=true
```

### 4. 動作確認

- `GET http://localhost:3001/health`
- Tableau 拡張として開く場合は、`frontend/public/tableau-ai-pr-agent.trex` を使うか、デプロイ済みの frontend URL に差し替えた `.trex` を使用します
- 追加で全体チェックを走らせるなら root で `npm run ci` を実行します
- 詳細な確認手順は [docs/operations.md](docs/operations.md) を参照してください

## 必要な環境変数

主要な設定は [docs/configuration.md](docs/configuration.md) に集約しています。  
ローカルでまず試すなら、次の 4 つを起点にすると把握しやすいです。

- `TABLEAU_CONTEXT_PROVIDER`
- `MODEL_PROVIDER`
- `AUTH_REQUIRED`
- `GOOGLE_CALENDAR_PROVIDER`

外部サービスを有効化する場合は、Slack / Bluesky / Tableau / Cognito / Google Calendar / Notion / Bedrock / S3 の項目を追加してください。

## デプロイ概要

詳細は [docs/deployment.md](docs/deployment.md) に分離しています。  
要点だけ書くと、GitHub Actions が `infra/cloudformation.yaml` を使って AWS にデプロイし、CloudFront 配下の frontend と API Gateway + Lambda の backend を更新します。

## 関連ドキュメント

- [docs/architecture.md](docs/architecture.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/operations.md](docs/operations.md)
- [docs/archive/README.md](docs/archive/README.md)
