# Phase 15 Operations Runbook

`tableau-ai-pr-agent` をセットアップ、デモ、トラブルシュート、削除まで一通り運用するための手順です。
実装変更は前提にせず、現状のコードとデプロイ設定に合わせて整理しています。

## 1. 目的

- Tableau ダッシュボード内で AI 広報アクションを安定して動かす
- Slack 送信や画像保存を含む運用を、手順ベースで再現できるようにする
- デモ時に失敗しやすい箇所を事前に切り分ける
- Secrets や AWS 資源を安全に扱い、削除手順まで明確にする

## 2. 前提

- リポジトリ: `Chasoso/tableau-ai-pr-agent`
- アプリ名: `tableau-ai-pr-agent`
- 旧アプリ名は互換コードや名残が残っていても、運用文書上の主語は新アプリに揃える
- 変更しないもの: frontend / backend / infra / GitHub Actions の実装そのもの

## 3. ローカルセットアップ

### 必須ツール

- Node.js
- npm
- Git
- Tableau Cloud で利用する拡張機能 URL

### インストール

```bash
cd backend
npm ci

cd ..\frontend
npm ci
```

### 起動

```bash
cd backend
npm run dev
```

```bash
cd frontend
npm run dev
```

### ローカル確認でよく使う値

- `VITE_API_BASE_URL=http://localhost:3001`
- `VITE_USE_MOCK_TABLEAU=true`
- `TABLEAU_CONTEXT_PROVIDER=mock`
- `MODEL_PROVIDER=mock`
- `DEMO_MODE=true` はデモ再現性を上げたいときに使う

## 4. Secrets / Environment Variables

### 運用ルール

- 秘密情報は `.env` に置いても Git へは commit しない
- README / docs / ログ / サンプル値に AWS アカウント ID や secret value を入れない
- 可能な限り GitHub Secrets / GitHub Variables / AWS SSM Parameter Store を使い分ける
- 旧 `CHAT_JOB_*` は互換 fallback として残るが、新規運用は `ACTION_RUN_*` を使う

### フロントエンド

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | API のベース URL | ローカルは `http://localhost:3001`、本番は通常 `/api` |
| `VITE_AUTH_REQUIRED` | 認証有効化 | `true` で Cognito を使う |
| `VITE_USE_MOCK_TABLEAU` | Tableau のモック切替 | ローカル確認向け |
| `VITE_COGNITO_USER_POOL_ID` | Cognito user pool | 公開してよいのは ID だけ |
| `VITE_COGNITO_CLIENT_ID` | Cognito client | 秘密ではないが、docs にサンプル値を固定しない |
| `VITE_COGNITO_REGION` | Cognito region |  |
| `VITE_COGNITO_DOMAIN` | Hosted UI domain |  |
| `VITE_COGNITO_REDIRECT_URI` | fallback callback URL |  |
| `VITE_COGNITO_LOGOUT_URI` | logout URL |  |
| `VITE_PR_ACTION_IMAGE_PUBLIC_BASE_URL` | 画像公開 URL | S3 直公開または CloudFront 配下 |
| `VITE_PR_ACTION_IMAGE_OBJECT_KEY_PREFIX` | 画像 key prefix | 既定は `action-runs` |

### バックエンド共通

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `DEMO_MODE` | デモモード | 外部依存の失敗時に固定出力へ寄せたいときに有効化 |
| `LOG_LEVEL` | ログレベル | 本番は `info` 以上を推奨 |
| `CORS_ALLOWED_ORIGIN` | CORS 許可元 | CloudFront / extension host に合わせる |
| `USE_IN_MEMORY_REPOSITORY` | メモリリポジトリ | ローカルでは `true` が便利 |
| `CHAT_HISTORY_TABLE_NAME` | 互換用履歴テーブル | 旧 chat 系の名残 |
| `CHAT_JOBS_TABLE_NAME` | 共有ジョブテーブル | action-run と chat-job の両方で使われる |
| `CHAT_MEMORY_MESSAGE_LIMIT` | 履歴保持数 |  |

### Action Run

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `ACTION_RUN_WORKER_FUNCTION_NAME` | 非同期 worker | `CHAT_JOB_WORKER_FUNCTION_NAME` が fallback |
| `ACTION_RUN_TTL_SECONDS` | TTL | 完了 / 失敗後の保持時間 |
| `ACTION_RUN_LEASE_SECONDS` | lease | claim / retry 保護 |
| `ACTION_RUN_PROGRESS_MESSAGE_LIMIT` | progress 件数上限 | ログ肥大化対策 |
| `ACTION_RUN_OWNER_TOKEN_HEADER_NAME` | 匿名 owner header | polling で使用 |

### Tableau

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `TABLEAU_SERVER_URL` | Tableau Cloud / Server URL |  |
| `TABLEAU_SITE_CONTENT_URL` | site content URL |  |
| `TABLEAU_API_VERSION` | REST API version | 既定は `3.25` |
| `TABLEAU_CONNECTED_APP_CLIENT_ID` | Connected App client ID |  |
| `TABLEAU_CONNECTED_APP_SECRET_ID` | Connected App secret ID |  |
| `TABLEAU_CONNECTED_APP_SECRET_VALUE` | Connected App secret value | 秘密情報 |
| `TABLEAU_DEFAULT_SUBJECT` | Tableau subject | PoC では email 相当を使うことが多い |
| `TABLEAU_SCOPES` | Connected App scopes | 最小権限で運用 |
| `TABLEAU_CONTEXT_PROVIDER` | Tableau 接続方式 | `mock` / `direct-api` / `mcp` |
| `TABLEAU_MCP_*` | MCP 調整用 | allowlist, timeout, cache, planning など |

### Cognito

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 認証要否 | `true` で backend 認証を有効化 |
| `COGNITO_USER_POOL_ID` | user pool |  |
| `COGNITO_CLIENT_ID` | app client |  |
| `COGNITO_REGION` | region |  |
| `COGNITO_DOMAIN` | Hosted UI domain |  |
| `COGNITO_POPUP_REDIRECT_URI` | popup callback | `/api/auth/cognito/callback` に向ける |
| `COGNITO_AUTH_TRANSACTION_KEY_PARAM` | SSM key param | popup auth の AES key |
| `COGNITO_AUTH_TRANSACTION_TTL_SECONDS` | transaction TTL |  |

### Slack

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `SLACK_INCOMING_WEBHOOK_URL` | Slack Incoming Webhook | 秘密情報。docs には実値を書かない |

### S3 / 画像

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `PR_ACTION_IMAGE_BUCKET_NAME` | 画像保存先 bucket |  |
| `PR_ACTION_IMAGE_PUBLIC_BASE_URL` | 公開 URL base | Slack から参照可能な URL を返す |
| `PR_ACTION_IMAGE_OBJECT_KEY_PREFIX` | object key prefix | 既定は `action-runs` |

### Bedrock / Model

| 変数 | 用途 | 備考 |
| --- | --- | --- |
| `MODEL_PROVIDER` | `mock` / `bedrock` | デモは `mock` が安定 |
| `BEDROCK_REGION` | Bedrock region |  |
| `BEDROCK_MODEL_ID` | model or inference profile |  |
| `BEDROCK_FOUNDATION_MODEL_ID` | foundation model |  |
| `BEDROCK_MAX_OUTPUT_TOKENS` | 最大出力 token |  |
| `BEDROCK_TEMPERATURE` | 温度 |  |
| `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE` | プロンプトログ | 本番では `false` |
| `BEDROCK_DEBUG_MAX_CHARS` | ログ文字数上限 |  |

### Google Drive

- 現時点では Google Drive OAuth / Drive API の本格連携は運用対象に入れていない
- UI 上は `sample_markdown` / `pasted_markdown` / `none` の参照モードで代替できる
- 将来 Drive 連携を入れる場合のみ、Google 側の OAuth 設定と秘密情報を追加する

### GitHub Secrets / Variables

#### Secrets に入れるもの

- `AWS_GHA_DEPLOY_ROLE_ARN`
- `AWS_CFN_EXECUTION_ROLE_ARN`
- `AWS_CFN_STACK_NAME`
- `AWS_ARTIFACT_BUCKET`
- `FRONTEND_BUCKET_NAME`
- `TABLEAU_CONNECTED_APP_SECRET_VALUE`
- `SLACK_INCOMING_WEBHOOK_URL`
- `COGNITO_*` のうち機密扱いにしたい値
- `TABLEAU_MCP_COMMAND` / `TABLEAU_MCP_ARGS` を secret として持たせる構成ならそれら

#### Variables に入れるもの

- `AWS_REGION`
- `TABLEAU_API_VERSION`
- `TABLEAU_SCOPES`
- `TABLEAU_CONTEXT_PROVIDER`
- `AUTH_REQUIRED`
- `MODEL_PROVIDER`
- `BEDROCK_*`
- `LOG_LEVEL`
- `ACTION_RUN_*`

## 5. AWS 構成

### 現行の役割分担

- CloudFront: フロントエンド配信
- API Gateway: backend API の入口
- Lambda: 認証、Tableau 参照、Action Run、Slack 送信、画像生成の制御
- DynamoDB: 認証トランザクション、ジョブ状態、履歴
- S3: 投稿用画像の保存
- Cognito: ユーザー認証
- Bedrock: 文章生成 / 評価補助
- Tableau Cloud / Server: 分析ソース

### データの流れ

1. Tableau 拡張機能が入力を受け取る
2. backend が Action Run を作成する
3. Tableau コンテキストと TechPlay 情報を集める
4. 固定分析と生成を行う
5. 画像を S3 に保存する
6. 人間確認を挟んで Slack に送る

### 運用上の注意

- 画像やログは長期保存しすぎない
- 90 日削除などのライフサイクルは bucket 側で必ず維持する
- 生成系のコストを抑えたい場合は `DEMO_MODE=true` と `MODEL_PROVIDER=mock` を使う

## 6. Cognito 設定

### 目的

- extension 利用者を識別する
- `AUTH_REQUIRED=true` のときに backend で JWT を検証する

### 確認項目

- `VITE_COGNITO_*` と `COGNITO_*` が対で設定されている
- `COGNITO_POPUP_REDIRECT_URI` が backend の callback に一致している
- `VITE_COGNITO_LOGOUT_URI` が CloudFront 上の実 URL に一致している
- browser から渡された user name を信用しない

### よくある失敗

- callback URL の不一致
- user pool / client ID の不一致
- `AUTH_REQUIRED=true` なのに backend 側の JWT 検証設定が不足

## 7. Slack 設定

### 目的

- 投稿案、根拠、確認ポイントを人間レビュー用に送る
- 完全自動投稿にはしない

### 確認項目

- `SLACK_INCOMING_WEBHOOK_URL` が設定されている
- 送信先チャンネルは固定化するか、運用ルールで明示する
- 送信前レビューをスキップしない
- 画像 URL は Slack から読める形になっている

### 失敗時の扱い

- Webhook が無い場合は、送信せずドラフトを UI でコピー可能にする
- Slack 側が 4xx / 5xx を返したら、ドラフトとエラーだけを残す

## 8. Tableau 設定

### Connected App

- Direct Trust を使う
- Scope は最小権限にする
- `TABLEAU_DEFAULT_SUBJECT` は対象サイトの既存ユーザー名に一致させる

### MCP

- `TABLEAU_CONTEXT_PROVIDER=mcp` は worker 側で Tableau MCP を使う構成
- `TABLEAU_MCP_ALLOWED_TOOLS` で許可 tool を絞る
- `TABLEAU_MCP_TIMEOUT_MS` は短めに保つ
- `TABLEAU_MCP_METADATA_CACHE_ENABLED=true` で再取得コストを抑える

### 運用上の見方

- Tableau 失敗時は、まず subject / scope / site URL / context provider を確認する
- 分析結果が本文に反映されていない場合は、MCP 取得よりも生成プロンプト側を疑う

## 9. Google Drive 設定

### 現状

- 本番 OAuth / Drive API はまだ運用対象外
- UI の `Drive brief` は Markdown 入力の代替として使う

### 運用指針

- まだ Drive の秘密情報を作らない
- 将来の実装時のみ、Google Cloud 側の OAuth 設定を別紙で追加する
- 既存のデモでは sample Markdown を使ってもよい

## 10. デモ手順

### デモ前

1. `git status` で余計な変更がないことを確認する
2. `DEMO_MODE=true` を検討する
3. `MODEL_PROVIDER=mock` または stable な `bedrock` を選ぶ
4. `SLACK_INCOMING_WEBHOOK_URL` を使うか、送信しないデモかを決める
5. `PR_ACTION_IMAGE_PUBLIC_BASE_URL` が正しいか確認する
6. Tableau / Cognito の callback URL を再確認する

### デモ中

1. Tableau ダッシュボードで AI 広報アクションを開く
2. 投稿タイプ、イベント名、TechPlay URL、現在の状況を入力する
3. 必要なら会場写真や Drive brief を入れる
4. 生成されたドラフトを確認する
5. 人間確認後に Slack 送信する

### デモ後

1. 失敗した run の `runId` を控える
2. CloudWatch / Lambda logs を確認する
3. Slack 実送信をしたか、デモモードだったかを記録する

## 11. トラブルシュート

| 症状 | まず見る場所 | 対応 |
| --- | --- | --- |
| Tableau 情報が空 | `TABLEAU_CONTEXT_PROVIDER`, `TABLEAU_SERVER_URL`, `TABLEAU_SITE_CONTENT_URL`, `TABLEAU_DEFAULT_SUBJECT` | subject / scope / site の不一致を直す |
| Slack 送信失敗 | `SLACK_INCOMING_WEBHOOK_URL`, approval フロー | webhook 再設定、送信前確認を維持 |
| 画像 URL が出ない | `PR_ACTION_IMAGE_BUCKET_NAME`, `PR_ACTION_IMAGE_PUBLIC_BASE_URL` | bucket と公開 URL を確認 |
| 認証が通らない | `AUTH_REQUIRED`, `COGNITO_*` | callback / logout URL を確認 |
| デモで外部依存が落ちる | `DEMO_MODE`, `MODEL_PROVIDER`, `TABLEAU_CONTEXT_PROVIDER` | mock / fixed output へ切り替える |
| ログに秘密情報が出る | `LOG_LEVEL`, logger 実装 | ログを止め、赤色化ルールを再確認 |

## 12. AWS リソース削除手順

### 推奨順

1. Slack の送信経路を無効化する
2. Cognito app / connected app の利用停止を確認する
3. S3 bucket の画像を削除する
4. DynamoDB テーブルを削除する
5. CloudFormation stack を削除する
6. GitHub Secrets / Variables を削除または無効化する
7. SSM Parameter Store の関連キーを削除する
8. 使っていた CloudWatch Logs を必要に応じて整理する

### 注意

- S3 bucket は中身が残っていると削除できない
- CloudFormation の削除前に、外部に残したい画像やログの扱いを決める
- 旧 `chat` や `notion` の互換設定が残っている場合は、削除前に依存を確認する

## 13. すぐ見返す最短版

- まず `DEMO_MODE` と `MODEL_PROVIDER` を確認する
- 次に Tableau / Cognito / Slack / S3 の設定を確認する
- Google Drive は現時点では Markdown 代替で十分
- 送信前の人間確認を外さない
- 変更後は `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:unit` を確認する

