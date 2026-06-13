# Security Notes / セキュリティメモ

## 日本語補足: 低コスト Secret 管理

低コストPoCでは、Secrets Manager の月額固定費を避けるため、Connected App の値を Lambda の暗号化済み環境変数に保存します。Lambda 関数設定を読める IAM 権限は機密権限として扱ってください。本番では SSM Parameter Store SecureString または Secrets Manager を検討してください。

## English

### Secrets

- Do not put Connected App secret values, JWTs, Bedrock credentials, MCP credentials, or access tokens in frontend code, Vite env files, browser storage, or the `.trex` manifest.
- Generate Tableau Connected Apps JWTs only in the backend.
- Store production secrets in AWS Secrets Manager or SSM Parameter Store.
- This low-cost PoC stores Connected App values in Lambda encrypted environment variables to avoid Secrets Manager fixed monthly cost. Treat Lambda function configuration read access as sensitive.
- Do not log JWTs, access tokens, refresh tokens, cookies, authorization headers, or secret values.

### User Identity

When `AUTH_REQUIRED=true`, the backend verifies the Cognito JWT and derives the Tableau subject from the verified Cognito `email` claim.

Do not trust a browser-provided username, email, role, permission, or Tableau subject. Frontend values can be modified by the user and are only useful for display.

For this PoC, Cognito `email` is treated as the Tableau Cloud username. This works only if the email exactly matches the Tableau username. Production should use federated IdP configuration or a server-side user mapping table.

### Tableau Permission Boundary

The intended production direction is:

1. Verify the application user with Cognito or a federated IdP.
2. Resolve the Tableau subject on the backend.
3. Use Connected Apps Direct Trust, OAuth, or another supported Tableau delegation model.
4. Execute REST API, Metadata API, or MCP calls as that subject.

Avoid using a broad service-account PAT for all users. If a PAT is used temporarily in a PoC, the results reflect the service account's Tableau permissions, not the current user's permissions.

### MCP

The Lambda-local MCP provider starts a child process with backend-only environment variables. The provider masks logs and returns safe warnings on failure.

For production:

- Use `TABLEAU_MCP_ALLOWED_TOOLS` to restrict callable tools.
- Keep `TABLEAU_MCP_ARG_SANITIZE_MODE=drop` for strict mode, or use `mask` only when preserving planner argument shape is required.
- Keep `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE=false` in production. Enable it only for short PoC debugging windows because prompts/responses may contain user and dashboard context text.
- Keep `LOG_LEVEL=info` (or higher) in production. `LOG_LEVEL=debug` logs chat question/answer text (`chat.message.input_debug`, `chat.message.output_debug`) and should be enabled only for short PoC debugging windows.
- Keep MCP timeouts short.
- Log tool names and high-level status only.
- Do not log tool payloads or row-level query results.
- Confirm that MCP authentication enforces the same Tableau user permission boundary as direct Tableau API calls.
- Keep metadata cache scoped by user permission boundary (`tableauSubject` or equivalent auth scope) and use short TTL.
- For `query-datasource`, enforce aggregate-only patterns, small limits, and sensitive-field blocking.

### Bedrock and LLM Data Minimization

The PoC uses `MODEL_PROVIDER=bedrock` with Nova 2 Lite, typically `BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0` and `BEDROCK_FOUNDATION_MODEL_ID=amazon.nova-2-lite-v1:0` in `us-east-1`, when enabled.

Before sending data to an LLM:

- Send only metadata needed for the user's question.
- Prefer workbook, dashboard, worksheet, field, filter, parameter, and datasource names.
- Avoid row-level data unless governance approval exists.
- Do not send personal data, secrets, raw extracts, or confidential business data by default.
- Redact sensitive keys such as token, secret, password, JWT, authorization, credential, and cookie.
- Add audit logging for what categories of data were sent, without logging the raw prompt.

### CORS and API Protection

- Deployed API Gateway and Lambda CORS should restrict origins to the approved frontend / extension host.
- `AUTH_REQUIRED=true` rejects missing or invalid `Authorization` headers.
- Return `401` for unauthenticated requests and `403` for authenticated-but-not-allowed requests.
- Error messages should be safe and should not expose internal tokens, secrets, or provider payloads.

### Notion MCP Draft Preview Flow

- Keep Notion OAuth flow and token refresh on backend only.
- Do not expose Notion access token, refresh token, OAuth authorization code, PKCE code_verifier, or encryption keys to frontend.
- Encrypt Notion tokens before DynamoDB persistence using AES-256-GCM.
- Load encryption key from SSM Parameter Store SecureString (`NOTION_TOKEN_ENCRYPTION_KEY_PARAM`) with decryption in Lambda runtime memory only.
- Keep Notion MCP tool allowlist minimal (`notion-create-pages`, `notion-fetch`) until stronger governance is added.
- Only produce draft preview output after explicit user approval.
- Do not create or publish Notion pages from the current flow.

## 日本語

### Secret

- Connected App secret、JWT、Bedrock認証情報、MCP認証情報、アクセストークンをフロントエンド、Vite env、ブラウザストレージ、`.trex` に置かないでください。
- Tableau Connected Apps JWT はバックエンドだけで生成します。
- 本番 Secret は AWS Secrets Manager または SSM Parameter Store に保存します。
- JWT、アクセストークン、リフレッシュトークン、Cookie、Authorizationヘッダー、Secret値をログに出しません。

### ユーザーID

`AUTH_REQUIRED=true` の場合、バックエンドが Cognito JWT を検証し、検証済みの Cognito `email` claim から Tableau subject を決定します。

ブラウザから送られた username、email、role、permission、Tableau subject は信用しません。ユーザーが改変できるため、表示上のヒント以上には使わないでください。

このPoCでは Cognito `email` を Tableau Cloud username として扱います。これは email と Tableau username が完全一致する場合だけ成立します。本番では IdP 連携またはサーバー側のユーザーマッピングテーブルを使ってください。

### Tableau 権限境界

本番の基本方針は以下です。

1. Cognito または federated IdP でアプリユーザーを検証する。
2. バックエンドで Tableau subject を決定する。
3. Connected Apps Direct Trust、OAuth、または Tableau がサポートする委任方式を使う。
4. REST API、Metadata API、MCP をその subject として実行する。

広い権限のサービスアカウントPATですべてのユーザーの処理を代行する方式は避けてください。一時的にPoCで使う場合、取得結果は現在のユーザーではなくサービスアカウントの Tableau 権限に依存します。

### MCP

Lambda 内 MCP provider は、バックエンド限定の環境変数を渡して子プロセスを起動します。失敗時は安全な warning を返し、Secret はログに出しません。

本番では以下を守ってください。

- `TABLEAU_MCP_ALLOWED_TOOLS` で呼び出し可能 tool を制限する。
- planner 引数の安全性は `TABLEAU_MCP_ARG_SANITIZE_MODE` で管理する。厳格運用は `drop`、構造維持が必要な場合のみ `mask` を使う。
- 本番では `BEDROCK_DEBUG_LOG_PROMPT_EXCHANGE=false` を維持する。PoCの短時間調査時のみ有効化し、終了後は必ず無効に戻す。
- 本番では `LOG_LEVEL=info` 以上を維持する。`LOG_LEVEL=debug` はチャットの質問文/回答文（`chat.message.input_debug`, `chat.message.output_debug`）をログ出力するため、PoCの短時間調査時のみ有効化する。
- MCP timeout を短く保つ。
- ログには tool 名と大まかなステータスだけを出す。
- business data を含む可能性がある payload はログに出さない。
- MCP 認証が直接 Tableau API 呼び出しと同じユーザー権限境界を守れることを確認する。

### Bedrock と LLM へのデータ最小化

有効化時は `MODEL_PROVIDER=bedrock` とし、`us-east-1` の Nova 2 Lite を使う方針です。通常は `BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0`、`BEDROCK_FOUNDATION_MODEL_ID=amazon.nova-2-lite-v1:0` を設定します。

LLMへ送る前に以下を守ります。

- 質問回答に必要なメタデータだけを送る。
- workbook、dashboard、worksheet、field、filter、parameter、datasource 名を優先する。
- ガバナンス承認がない限り行レベルデータを送らない。
- 個人情報、Secret、生データ抽出、機密業務データをデフォルトで送らない。
- token、secret、password、JWT、authorization、credential、cookie などのキーを redaction する。
- 生プロンプトではなく、送信したデータカテゴリを監査ログに残す。

### CORS と API 保護

- デプロイ環境では API Gateway / Lambda CORS を承認済み frontend / extension host に制限します。
- `AUTH_REQUIRED=true` の場合、Authorizationヘッダーなし、または検証失敗のリクエストを拒否します。
- 未認証は `401`、認証済みだが許可されない場合は `403` を返します。
- エラー応答には token、Secret、provider payload を含めません。
