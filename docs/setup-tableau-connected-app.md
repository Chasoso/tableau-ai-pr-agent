# Tableau Connected App Direct Trust Setup / Tableau Connected App Direct Trust セットアップ

## English

This PoC keeps all Connected App secrets on the backend. The browser never receives the secret value and never generates JWTs.

### Steps

1. In Tableau Cloud, open the site settings or admin area where Connected Apps are managed.
2. Create a new Connected App.
3. Select Direct Trust as the trust model.
4. Record the Connected App Client ID.
5. Create or reveal a secret and record the Secret ID.
6. Copy the Secret Value once and store it in a backend-only secret store.
7. Configure allowed domains / domain allowlist for the frontend host that will load the extension.
8. Set the backend environment variables described in `README.md`.

### JWT Settings

The backend creates a short-lived HS256 JWT with:

- `iss`: Connected App Client ID
- `sub`: Tableau Cloud user name, usually the user's email address
- `aud`: `tableau`
- `exp`: 10 minutes or less
- `jti`: random UUID
- `scp`: Tableau scopes
- header `kid`: Connected App Secret ID

For the PoC, use `TABLEAU_DEFAULT_SUBJECT` for `sub`. In most Tableau Cloud sites this must match an existing Tableau user name, commonly the email address.

### Scopes

Start with:

- `tableau:content:read`

Add narrower or additional scopes only when a new API call requires them. Keep scopes minimal so the JWT cannot do more than the extension needs.

### Domain Allowlist Notes

Local development uses `http://localhost:5173`. Production should use HTTPS and a stable host name. Tableau Cloud / Server administration may also require allowing network-enabled extensions and approving the extension URL.

### Confirmation Items

- Confirm the exact scopes required for each REST API and Metadata API call in your Tableau Cloud version.
- Confirm whether the Connected App is configured for site-level access that matches `TABLEAU_SITE_CONTENT_URL`.
- Confirm whether production should map authenticated application users to Tableau subjects rather than using `TABLEAU_DEFAULT_SUBJECT`.

## 日本語

この PoC では Connected App の Secret をすべてバックエンド側に保持します。ブラウザは Secret Value を受け取らず、JWT も生成しません。

### 手順

1. Tableau Cloud で Connected Apps を管理するサイト設定または管理画面を開きます。
2. 新しい Connected App を作成します。
3. Trust model として Direct Trust を選択します。
4. Connected App Client ID を控えます。
5. Secret を作成または表示し、Secret ID を控えます。
6. Secret Value を一度だけコピーし、バックエンド専用のSecretストアに保存します。
7. Extension を読み込むフロントエンドホストについて、allowed domains / domain allowlist を設定します。
8. `README.md` に記載されているバックエンド環境変数を設定します。

### JWT設定

バックエンドは以下を含む短命の HS256 JWT を生成します。

- `iss`: Connected App Client ID
- `sub`: Tableau Cloud ユーザー名。通常はユーザーのメールアドレス
- `aud`: `tableau`
- `exp`: 10分以内
- `jti`: ランダムUUID
- `scp`: Tableau scope
- header `kid`: Connected App Secret ID

PoC では `sub` に `TABLEAU_DEFAULT_SUBJECT` を使います。多くの Tableau Cloud サイトでは、既存の Tableau ユーザー名、一般的にはメールアドレスと一致している必要があります。

### Scopes

まずは以下から始めます。

- `tableau:content:read`

新しい API 呼び出しで必要になった場合のみ、より狭い scope または追加 scope を付与します。JWT が Extension の必要以上の権限を持たないよう、scope は最小限にしてください。

### ドメイン許可リストの考え方

ローカル開発では `http://localhost:5173` を使います。本番では HTTPS かつ安定したホスト名を使ってください。Tableau Cloud / Server の管理設定で、Network-enabled Extension の許可や Extension URL の承認が必要な場合があります。

### 確認事項

- 利用する Tableau Cloud バージョンで、各 REST API / Metadata API 呼び出しに必要な正確な scope を確認してください。
- Connected App が `TABLEAU_SITE_CONTENT_URL` と一致するサイトアクセス用に設定されているか確認してください。
- 本番では `TABLEAU_DEFAULT_SUBJECT` 固定ではなく、認証済みアプリユーザーと Tableau subject を対応付けるべきか確認してください。

