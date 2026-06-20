# 運用

このドキュメントは、デモ当日や再セットアップ時に迷いやすい手順だけをまとめています。

## デモ当日の手順

1. `GET /health` が通ることを確認します
2. Tableau 拡張を開き、Dashboard context が読めることを確認します
3. 必要なら Cognito / Google Calendar / Notion に接続します
4. 投稿種別を選びます
5. 会場写真をアップロードします
6. 必要なら Calendar から候補を選び、TechPlay URL を補完します
7. 生成された投稿案を確認します
8. Slack 承認で投稿し、必要なら Bluesky にも投稿します

## 画像アップロードから投稿文生成まで

### 1. 投稿種別の選択

- `PrPostAgentPanel` でイベント投稿の種別を選びます
- 選択結果によって、必要な入力が変わります

### 2. 画像のアップロード

- 画像は `POST /action-run-input-images` に送られます
- バックエンドは画像を S3 に保存し、公開 URL を返します
- 画像は投稿案の生成と最終投稿で再利用されます

### 3. イベント文脈の取得

- Google Calendar が有効なら、接続済みアカウントから候補を引きます
- 候補が複数ある場合は UI で選択します
- Calendar に TechPlay URL がない場合は、手動で入力します

### 4. 投稿案の生成

- `POST /action-runs` で分析ジョブを作成します
- 画像、イベント文脈、Tableau 文脈、テキスト入力をまとめて分析します
- 結果として Slack 用の候補文、必要なら Bluesky 用候補が返ります

### 5. Slack 承認

- 承認バーで文面を最終調整します
- `POST /action-runs/{actionRunId}/approval` を呼ぶと Slack に送信されます
- 承認しない限り、Slack には投稿されません

### 6. Bluesky 投稿

- Slack 承認後に Bluesky 承認バーが表示されます
- `POST /action-runs/{actionRunId}/bluesky-post` を呼ぶと Bluesky に投稿されます
- 投稿しない場合はキャンセルできます

## Slack 投稿の流れ

1. Slack Incoming Webhook を設定します
2. 投稿案を確認します
3. 編集後のテキストを承認します
4. バックエンドが webhook に投稿します
5. 投稿結果は UI に表示されます

## Bluesky 投稿の流れ

1. `BLUESKY_IDENTIFIER` と `BLUESKY_APP_PASSWORD` を設定します
2. Slack 承認後に Bluesky の承認バーを開きます
3. 同じ草案を使うか、必要なら文面を調整します
4. `POST /action-runs/{actionRunId}/bluesky-post` で投稿します

## 失敗時の確認ポイント

### 画像アップロードが失敗する

- `PR_ACTION_IMAGE_BUCKET_NAME` が正しいか
- `PR_ACTION_IMAGE_PUBLIC_BASE_URL` が設定されているか
- 画像の形式とサイズが許容範囲か
- S3 の権限と CloudFront / public URL の設定が合っているか

### Calendar 候補が出ない

- `GOOGLE_CALENDAR_PROVIDER` が `google` か `mock` かを確認します
- Google 接続済みかを確認します
- `GOOGLE_CALENDAR_CALENDAR_ID` と OAuth 設定を確認します

### Tableau 文脈が空になる

- `TABLEAU_CONTEXT_PROVIDER` を確認します
- `TABLEAU_SERVER_URL` / `TABLEAU_SITE_CONTENT_URL` を確認します
- `TABLEAU_DEFAULT_SUBJECT` と Connected App の値を確認します
- `TABLEAU_MCP_ALLOWED_TOOLS` が厳しすぎないか確認します

### Slack 投稿に失敗する

- `SLACK_INCOMING_WEBHOOK_URL` を確認します
- 承認前に `approved=true` になっているか確認します
- CloudWatch Logs で webhook エラーを確認します

### Bluesky 投稿に失敗する

- `BLUESKY_IDENTIFIER` と `BLUESKY_APP_PASSWORD` を確認します
- `BLUESKY_SERVICE_URL` を確認します
- 投稿文が長すぎないか確認します

### 認証で止まる

- `AUTH_REQUIRED` と Cognito の frontend / backend 設定を確認します
- popup callback URL が合っているか確認します
- 追加で `COGNITO_AUTH_TRANSACTION_KEY_PARAM` の SSM 鍵があるか確認します

### Notion 接続で止まる

- `NOTION_MCP_ENABLED` が有効かを確認します
- `NOTION_REDIRECT_URI` と `NOTION_TOKEN_ENCRYPTION_KEY_PARAM` を確認します
- 接続済みでも保存先がない場合は `NOTION_DEFAULT_TARGET_PARENT_PAGE_ID` か `NOTION_DEFAULT_TARGET_DATABASE_ID` を設定します

## 典型的なトラブルシュート

1. まず `/health` を確認します
2. 次に backend の CloudWatch Logs を確認します
3. その後、`TABLEAU_*`, `GOOGLE_CALENDAR_*`, `SLACK_*`, `BLUESKY_*`, `AUTH_REQUIRED`, `MODEL_PROVIDER` の順で見直します
4. ローカルでは `TABLEAU_CONTEXT_PROVIDER=mock` と `MODEL_PROVIDER=mock` に戻して切り分けます
5. 画像系の問題は S3 と public base URL を疑います
6. 連携系の問題は OAuth / webhook / secret / SSM パラメータを疑います

## 参考

- 詳細な変数一覧: [docs/configuration.md](docs/configuration.md)
- アーキテクチャ: [docs/architecture.md](docs/architecture.md)
- デプロイ: [docs/deployment.md](docs/deployment.md)
