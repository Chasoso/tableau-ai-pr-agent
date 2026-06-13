# Tableau Extension Setup / Tableau Extension セットアップ

## English

### Local Development

1. Start the backend:

```bash
cd backend
npm install
npm run dev
```

2. Start the frontend:

```bash
cd frontend
npm install
npm run dev
```

3. In Tableau Desktop or Tableau Cloud dashboard authoring, add an Extension object.
4. Select `frontend/public/tableau-ai-pr-agent.trex`.
5. The extension loads `http://localhost:5173/`.

### Mock Mode Outside Tableau

For normal browser development, set:

```bash
VITE_USE_MOCK_TABLEAU=true
VITE_API_BASE_URL=http://localhost:3001
```

When `VITE_USE_MOCK_TABLEAU=true`, the frontend skips `tableau.extensions.initializeAsync()` and returns mock dashboard context.

### Tableau Cloud / Server Settings

Depending on your site settings, an administrator may need to:

- Enable dashboard extensions.
- Allow network-enabled extensions.
- Add the extension domain to an allowlist.
- Review extension permissions, especially data access permissions.

### Production URL

For production:

1. Build and host the frontend on HTTPS.
2. Update `frontend/public/tableau-ai-pr-agent.trex`.
3. Replace the local `source-location` URL with the production URL.
4. Update Tableau allowed domains and backend CORS to the same production origin.

## 日本語

### ローカル開発

1. バックエンドを起動します。

```bash
cd backend
npm install
npm run dev
```

2. フロントエンドを起動します。

```bash
cd frontend
npm install
npm run dev
```

3. Tableau Desktop または Tableau Cloud のダッシュボード編集画面で Extension オブジェクトを追加します。
4. `frontend/public/tableau-ai-pr-agent.trex` を選択します。
5. Extension は `http://localhost:5173/` を読み込みます。

### Tableau 外でのモックモード

通常のブラウザ開発では、以下を設定します。

```bash
VITE_USE_MOCK_TABLEAU=true
VITE_API_BASE_URL=http://localhost:3001
```

`VITE_USE_MOCK_TABLEAU=true` の場合、フロントエンドは `tableau.extensions.initializeAsync()` を実行せず、モックのダッシュボードコンテキストを返します。

### Tableau Cloud / Server 側の設定

サイト設定によっては、管理者が以下を行う必要があります。

- Dashboard Extension を有効化する。
- Network-enabled Extension を許可する。
- Extension のドメインを許可リストへ追加する。
- Extension の権限、特にデータアクセス権限を確認する。

### 本番URL

本番では以下を行います。

1. フロントエンドをビルドし、HTTPS でホストします。
2. `frontend/public/tableau-ai-pr-agent.trex` を更新します。
3. ローカル用の `source-location` URL を本番URLへ置き換えます。
4. Tableau の許可ドメインとバックエンド CORS を同じ本番 Origin に更新します。

