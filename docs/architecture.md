# Architecture / アーキチE��チャ

## English

```mermaid
flowchart TD
  A[Tableau Cloud Dashboard] --> B[Dashboard Extension]
  B --> C[React Chat UI]
  C --> D[CloudFront / API Gateway]
  D --> E[AWS Lambda]
  E --> F[Cognito JWT Verification]
  F --> G[ChatService]
  G --> P[Lightweight Agent Loop]
  P --> H[TableauContextProvider]
  H --> I[Mock Provider]
  H --> J[Direct Tableau REST API / Metadata API]
  H --> K[Tableau MCP stdio child process]
  K --> L[Tableau Cloud]
  J --> L
  G --> M[Bedrock Nova Lite]
  G --> N[DynamoDB Chat History]
  E --> O[Lambda encrypted environment variables]
  O --> J
  O --> K
```

### Runtime Flow

1. Tableau loads the `.trex` manifest and opens the React app as a Dashboard Extension.
2. The React app initializes the Tableau Extensions API and captures dashboard metadata.
3. If authentication is required, the user signs in with Cognito Hosted UI.
4. The frontend sends `POST /chat-jobs` with dashboard context and a Cognito token, then polls `GET /chat-jobs/{jobId}` until completion.
5. Lambda verifies the Cognito JWT and derives the Tableau subject from the verified email claim.
6. The job starter writes a DynamoDB record, returns `jobId` immediately, and dispatches a worker Lambda asynchronously.
7. The worker runs `ChatService`, which optionally runs a lightweight agent loop that rewrites ambiguous questions into a clearer investigation question, then evaluates whether one more context pass is needed.
8. `mock` returns local test context, `direct-api` calls Tableau REST / Metadata API, and `mcp` launches Tableau MCP over stdio.
9. The Tableau MCP provider still enforces the allowlist, timeout, and identifier guardrails for actual tool execution.
10. `AnswerGenerator` either returns a deterministic context answer or calls Bedrock Nova Lite.
11. Chat history and job progress are saved to DynamoDB.

### Key Abstractions

- `TableauContextProvider`: hides whether Tableau context came from REST API, Metadata API, MCP, or mocks.
- `Lightweight Agent Loop`: adds question normalization, evidence sufficiency evaluation, and at most one extra context retrieval pass without introducing a large framework.
- `AnswerGenerator`: hides whether answers come from deterministic mock logic or Bedrock.
- `ChatHistoryRepository`: hides whether history is saved in DynamoDB or memory.

## 日本誁E

```mermaid
flowchart TD
  A[Tableau Cloud Dashboard] --> B[Dashboard Extension]
  B --> C[React Chat UI]
  C --> D[CloudFront / API Gateway]
  D --> E[AWS Lambda]
  E --> F[Cognito JWT Verification]
  F --> G[ChatService]
  G --> H[TableauContextProvider]
  H --> I[Mock Provider]
  H --> J[Direct Tableau REST API / Metadata API]
  H --> K[Tableau MCP stdio child process]
  K --> L[Tableau Cloud]
  J --> L
  G --> M[Bedrock Nova Lite]
  G --> N[DynamoDB Chat History]
  E --> O[Lambda encrypted environment variables]
  O --> J
  O --> K
```

### 実行時の流れ

1. Tableau ぁE`.trex` manifest を読み込み、React アプリめEDashboard Extension として開きます、E
2. React アプリぁETableau Extensions API を�E期化し、ダチE��ュボ�EドメタチE�Eタを取得します、E
3. 認証が忁E��な場合、ユーザーは Cognito Hosted UI でサインインします、E
4. フロントエンドが dashboard context と Cognito token を付けて `POST /chat-jobs` を呼びます、E
5. Lambda ぁECognito JWT を検証し、検証済み email claim から Tableau subject を決定します、E
6. `ChatService` が選択された `TableauContextProvider` に追加コンチE��スト取得を依頼します、E
7. `mock` はローカル用コンチE��ストを返し、`direct-api` は Tableau REST / Metadata API を呼び、`mcp` は Tableau MCP めEstdio で起動します、E
8. `AnswerGenerator` が決定的なコンチE��スト回答、また�E Bedrock Nova Lite による回答を返します、E
9. チャチE��履歴めEDynamoDB に保存します、E

### 主要な抽象匁E

- `TableauContextProvider`: Tableau コンチE��スト取得�EぁEREST API、Metadata API、MCP、mock のどれかを隠蔽します、E
- `AnswerGenerator`: 回答生成�EぁEmock ロジチE��ぁEBedrock かを隠蔽します、E
- `ChatHistoryRepository`: 履歴保存�EぁEDynamoDB かメモリかを隠蔽します、E
